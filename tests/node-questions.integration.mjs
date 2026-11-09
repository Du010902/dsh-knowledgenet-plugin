import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { handleApiRequest, registerApi } from "../src/host/api.ts";
import { readQuestionIndex } from "../src/host/node-question-file.ts";
import { readLibrary, readNodeRelations } from "../src/host/v3/store.ts";
import { makeV3Fixture, cleanupFixtures } from "./support/v3-fixture.mjs";

after(cleanupFixtures);

function requester(fixture, sessions = {}) {
  const ctx = { sessions: { get: (id) => sessions[id] ? { header: { cwd: sessions[id] } } : undefined } };
  return async (payload) => (await handleApiRequest(ctx, {}, {
    url: "http://dsh.local/api",
    method: "POST",
    json: async () => ({ root: fixture.root, ...payload }),
  })).body;
}

test("question writes serialize, are idempotent, and isolate node and library", async () => {
  const first = await makeV3Fixture({ nodes: ["A", "B"] });
  const other = await makeV3Fixture({ nodes: ["A"] });
  const request = requester(first);
  const nodeId = first.nodes.A.id;
  const before = await readFile(join(first.root, first.nodes.A.relativePath), "utf8");
  const list = (overrides = {}) => request({ kind: "list-node-questions", nodeId, ...overrides });
  assert.deepEqual((await list()).questions, []);
  const add = (questionId) => request({ kind: "add-node-question", nodeId, questionId, title: "   名称 " });
  assert.ok((await Promise.all([add("one"), add("two"), add("one")])).every((item) => item.ok));
  const saved = (await list()).questions;
  assert.deepEqual(saved.map((item) => item.id).sort(), ["one", "two"]);
  assert.ok(saved.every((item) => item.title === "名称" && item.processed === false));
  assert.deepEqual((await list({ nodeId: first.nodes.B.id })).questions, []);
  assert.equal((await list({ root: other.root })).ok, false);
  const set = (processed) => request({ kind: "set-node-question-processed", nodeId, questionId: "one", processed });
  assert.equal((await set(true)).questions.find((item) => item.id === "one").processed, true);
  assert.equal((await set(false)).questions.find((item) => item.id === "one").processed, false);
  const remove = () => request({ kind: "delete-node-question", nodeId, questionId: "one" });
  assert.deepEqual((await remove()).questions, (await remove()).questions);
  assert.equal((await readQuestionIndex(first.root))[nodeId].length, 1);
  assert.equal(await readFile(join(first.root, first.nodes.A.relativePath), "utf8"), before);
});

test("capture uses the conversation owner and validates real workspace file paths", async () => {
  const fixture = await makeV3Fixture({ nodes: ["A"] });
  const other = await makeV3Fixture({ nodes: ["Other"] });
  const request = requester(fixture, { chat: fixture.workspace, elsewhere: other.workspace });
  const nodeId = fixture.nodes.A.id;
  const file = join(fixture.workspace, "资料.txt");
  const foreign = join(other.workspace, "private.txt");
  await writeFile(file, "source", "utf8");
  await writeFile(foreign, "outside", "utf8");
  assert.equal((await request({ kind: "record-node-conversation", nodeId, conversationId: "chat" })).ok, true);
  const capture = await request({ kind: "list-node-questions", root: undefined, sessionId: "chat" });
  assert.equal(capture.ownerNodeId, nodeId);
  assert.deepEqual(capture.nodes, [{ id: nodeId, title: "A" }]);
  const add = (questionId, source) => request({ kind: "add-node-question", nodeId, questionId, title: "来源", source });
  assert.equal((await add("cross", { kind: "chat", sessionId: "elsewhere", messageKey: "key" })).ok, false);
  assert.equal((await add("escape", { kind: "file", sessionId: "chat", absolutePath: foreign })).ok, false);
  const fileQuestion = await add("file", { kind: "file", sessionId: "chat", absolutePath: file, line: 2 });
  assert.deepEqual(fileQuestion.questions[0].source, { kind: "file", sessionId: "chat", path: "资料.txt", line: 2 });
  const locate = () => request({ kind: "list-node-questions", nodeId, questionId: "file" });
  assert.equal((await locate()).ok, true);
  await rename(file, join(fixture.workspace, "moved.txt"));
  assert.equal((await locate()).error.code, "bad_source");
});

test("a registered route can resolve the workspace of an unmounted conversation", async () => {
  const fixture = await makeV3Fixture({ nodes: ["A"] });
  let endpoint;
  const ctx = { connection: { fetch: { register: (route) => { endpoint = route.fetch; } } } };
  const registration = registerApi(ctx, {}, undefined, () => ({
    stat: async (id) => id === "history" ? { header: { cwd: fixture.workspace } } : undefined,
  }));
  assert.equal(registration.registered, true);
  const response = await endpoint(new Request("http://dsh.local/api/knowledgenet.graph", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "list-node-questions", sessionId: "history" }),
  }));
  assert.deepEqual((await response.json()).nodes, [{ id: fixture.nodes.A.id, title: "A" }]);
});

test("ordinary Markdown adoption copies questions and points note sources at the formal identity", async () => {
  const fixture = await makeV3Fixture();
  const request = requester(fixture);
  await writeFile(join(fixture.root, "Nodes", "普通笔记.md"), "原文", "utf8");
  const adopted = (await readLibrary(fixture.root)).nodes.find((node) => node.title === "普通笔记");
  assert.ok(adopted?.id.startsWith("adopted-"));
  const source = { kind: "note", nodeId: adopted.id, excerpt: "原文", block: 0 };
  assert.equal((await request({ kind: "add-node-question", nodeId: adopted.id, questionId: "one", title: "疑问", source })).ok, true);
  const read = await request({ kind: "read-node-document", nodeId: adopted.id });
  const saved = await request({ kind: "save-node-document", nodeId: adopted.id, hash: read.document.hash, text: "原文\n\n附记" });
  assert.equal(saved.ok, true);
  assert.notEqual(saved.document.nodeId, adopted.id);
  const listed = await request({ kind: "list-node-questions", nodeId: saved.document.nodeId });
  assert.deepEqual(listed.questions[0].source, { ...source, nodeId: saved.document.nodeId });
});

test("concurrent promotion reuses the same prerequisite and deletion touches only the list", async () => {
  const fixture = await makeV3Fixture({ nodes: ["A"] });
  const request = requester(fixture);
  const nodeId = fixture.nodes.A.id;
  const title = "前置 B";
  assert.equal((await request({ kind: "add-node-question", nodeId, questionId: "one", title })).ok, true);
  const promote = () => request({ kind: "add-prerequisite", fromId: nodeId, title, create: true });
  const outcomes = await Promise.all([promote(), promote()]);
  assert.ok(outcomes.every((outcome) => outcome.ok));
  assert.equal(outcomes[0].added.node.id, outcomes[1].added.node.id);
  assert.equal((await request({ kind: "delete-node-question", nodeId, questionId: "one" })).questions.length, 0);
  assert.deepEqual((await readNodeRelations(fixture.root, nodeId)).prerequisites.map((edge) => [edge.fromId, edge.toId]), [[nodeId, outcomes[0].added.node.id]]);
});
