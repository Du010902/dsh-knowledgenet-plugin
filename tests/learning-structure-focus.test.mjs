import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LearningState } from "../src/host/learning-state.ts";
import { handleApiRequest } from "../src/host/api.ts";
import { structurePage } from "../src/host/structure-page.ts";
import { __internal } from "../index.js";
import { makeV3Fixture, cleanupFixtures } from "./support/v3-fixture.mjs";
after(cleanupFixtures);
const tools = (config, state) => Object.fromEntries(__internal.createTools(config, state).map(tool => [tool.name, tool]));
const exec = (f, id = "chat", events = []) => ({ agent: { id, session: { id, header: { cwd: f.workspace }, snapshotEvents: () => events } } });
const request = body => ({ url: "http://dsh.local/api", method: "POST", json: async () => body });
const readEvent = id => [{ type: "tool/call", data: { callId: "c", name: "kn_read_node" } }, { type: "tool/result", data: { message: { source: { callId: "c" }, content: [{ type: "text", text: JSON.stringify({ ok: true, node: { id } }) }] } } }];

test("complete maps contain metadata and independent self-marks, never bodies", async () => {
  const f = await makeV3Fixture({ nodes: ["A", "B", "C"], edges: [["A", "B"]] });
  await writeFile(join(f.root, "understanding.json"), JSON.stringify({ version: 1, nodes: { [f.nodes.A.id]: true, [f.nodes.B.id]: false } }));
  const r = await tools({ modelMaxNodes: 1 }).kn_list_graph.execute({ mode: "overview" }, exec(f));
  assert.equal(r.ok, true); assert.equal(r.nodes.length, 3); assert.equal(r.truncated, false);
  assert.deepEqual(r.nodes.map(n => [n.title, n.understood, n.understandingMarked]).sort(), [["A", true, true], ["B", false, true], ["C", false, false]]);
  assert.ok(r.nodes.every(n => Array.isArray(n.aliases)));
  assert.equal(r.edges[0].fromId, f.nodes.A.id); assert.equal(r.edges[0].toId, f.nodes.B.id);
  assert.equal(JSON.stringify(r).includes("的笔记"), false); assert.equal("relation" in r.edges[0], false);
});

test("character-bound independent streams page without losing nodes or edges", () => {
  const nodes = Array.from({ length: 7 }, (_, i) => ({ id: String(i), title: "长标题".repeat(8), aliases: [], understood: false }));
  const edges = Array.from({ length: 13 }, (_, i) => ({ id: String(i), fromId: "0", toId: String(i % 7), relationType: "prerequisite" }));
  let offset = 0, edgeOffset = 0; const seenNodes = [], seenEdges = [];
  for (let page = 0; page < 30; page++) {
    const r = structurePage({ nodes, edges, offset, edgeOffset, maxNodes: 200, maxEdges: 400, maxChars: 850, library: { name: "库" }, revision: 1 });
    assert.equal(r.ok, true); assert.ok(JSON.stringify(r).length <= 850);
    seenNodes.push(...r.nodes); seenEdges.push(...r.edges);
    if (r.nextOffset === null && r.nextEdgeOffset === null) break;
    const nextNode = r.nextOffset ?? r.counts.nodes, nextEdge = r.nextEdgeOffset ?? r.counts.edges;
    assert.ok(nextNode > offset || nextEdge > edgeOffset);
    offset = nextNode; edgeOffset = nextEdge;
  }
  assert.deepEqual(seenNodes, nodes); assert.deepEqual(seenEdges, edges);
  assert.equal(structurePage({ nodes, edges, offset: 0, edgeOffset: 0, maxNodes: 1, maxEdges: 1, maxChars: 10, library: {}, revision: 1 }).ok, false);
});

test("focus leases isolate scopes, reject stale packets and do not change activity on heartbeat", () => {
  let now = 10; const s = new LearningState(50, () => now);
  const input = { sessionId: "chat", root: "/library", viewId: "v1", sequence: 1, nodeId: "A", source: "editor", active: true, claim: true };
  s.update(input); assert.equal(s.focus("chat", "/library").nodeId, "A");
  assert.equal(s.focus("other", "/library"), undefined); assert.equal(s.focus("chat", "/foreign"), undefined);
  s.update({ ...input, viewId: "v2", nodeId: "B" });
  s.update({ ...input, sequence: 2, claim: false }); assert.equal(s.focus("chat", "/library").nodeId, "B");
  s.update({ ...input, viewId: "v2", sequence: 3, active: false });
  s.update({ ...input, viewId: "v2", sequence: 2, nodeId: "stale" }); assert.equal(s.focus("chat", "/library").nodeId, "A");
  now = 61; assert.equal(s.focus("chat", "/library"), undefined); s.dispose();
});

test("current target prefers live UI then entry then history; explicit history ignores UI", async () => {
  const f = await makeV3Fixture({ nodes: ["A", "B", "C"] }); const s = new LearningState();
  const t = tools({}, s); const events = [{ type: "turn/start", data: { turn: 1 } }, ...readEvent(f.nodes.C.id)];
  s.enter("chat", f.root, f.nodes.B.id);
  s.update({ sessionId: "chat", root: f.root, viewId: "v", sequence: 1, active: true, nodeId: f.nodes.A.id, source: "editor" });
  const current = () => t.kn_current_node.execute({}, exec(f, "chat", events));
  const ui = await current(); assert.equal(ui.source, "ui"); assert.equal(ui.node.id, f.nodes.A.id); assert.equal(JSON.stringify(ui).includes("的笔记"), false);
  assert.equal((await t.kn_current_node.execute({ source: "history" }, exec(f, "chat", events))).node.id, f.nodes.C.id);
  s.update({ sessionId: "chat", root: f.root, viewId: "v", sequence: 2, active: false, nodeId: null, source: "graph" });
  assert.equal((await current()).source, "entry");
  events.push({ type: "turn/end" }); assert.equal((await current()).source, "history");
  assert.equal((await t.kn_current_node.execute({}, exec(f, "other"))).node, null);
  assert.equal((await t.kn_current_node.execute({ source: "ui" }, exec(f, "chat", events))).node, null);
});

test("entry hints expire before second-request assembly and never return after reopening", async () => {
  const f = await makeV3Fixture({ nodes: ["A"] }); const s = new LearningState(); const events = [];
  s.enter("chat", f.root, f.nodes.A.id); assert.equal(s.entry("chat", f.root, exec(f, "chat", events).agent.session), undefined);
  events.push({ type: "turn/start" }); assert.equal(s.entry("chat", f.root, exec(f, "chat", events).agent.session), f.nodes.A.id);
  events.push({ type: "user/message", data: { source: { kind: "operator" } } });
  assert.equal(s.entry("chat", f.root, exec(f, "chat", events).agent.session), f.nodes.A.id);
  events.push({ type: "turn/start" }); assert.equal(s.entry("chat", f.root, exec(f, "chat", events).agent.session), undefined);
  assert.equal(s.entry("chat", f.root, exec(f, "chat", [{ type: "turn/start" }]).agent.session), undefined);
});

test("focus HTTP rejects foreign roots; node-origin records add only plugin memory hints", async () => {
  const f = await makeV3Fixture({ nodes: ["A"] }); const other = await makeV3Fixture({ nodes: ["B"] });
  const s = new LearningState(); const ctx = { sessions: { get: id => ({ header: { cwd: id === "foreign" ? other.workspace : f.workspace } }) } };
  const api = body => __internal.handleApiRequest(ctx, {}, request(body), s);
  const body = { kind: "view-focus", sessionId: "chat", root: f.root, viewId: "view", sequence: 1, nodeId: f.nodes.A.id, focusKind: "editor", active: true };
  assert.equal((await api(body)).body.ok, true); assert.equal(s.focus("chat", f.root).nodeId, f.nodes.A.id);
  assert.equal((await api({ ...body, sessionId: "foreign" })).body.error.code, "focus_scope_mismatch");
  assert.equal((await api({ ...body, sequence: -1 })).status, 400);
  const before = await readFile(join(f.root, f.nodes.A.relativePath), "utf8");
  assert.equal((await api({ kind: "record-node-conversation", root: f.root, nodeId: f.nodes.A.id, conversationId: "new", entryHint: true })).body.ok, true);
  const events = [{ type: "turn/start" }]; assert.equal(s.entry("new", f.root, exec(f, "new", events).agent.session), f.nodes.A.id);
  assert.equal(await readFile(join(f.root, f.nodes.A.relativePath), "utf8"), before);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(f.root, "node-conversations.json"), "utf8"))).sort(), ["nodes", "version"]);
});

test("同一对话先后从两个节点打开：入口线索与历史都归最新认领的节点", async () => {
  /* 用户实测 2026-10-25：DSH 复用空白会话 ⇒ 节点 1、节点 2 的「打开新对话」拿到同一个 sessionId ✗
   * 这里直接 import **源码** handleApiRequest（不是 index.js 里的构建产物 ✓）：宿主半的改动要由 Lead
   * 统一构建，构建前 __internal 里还是旧记录逻辑 ⇒ 走源码模块才是在断言这次改的行为 ✓。 */
  const f = await makeV3Fixture({ nodes: ["A", "B"] }); const s = new LearningState();
  const ctx = { sessions: { get: () => ({ header: { cwd: f.workspace } }) } };
  const api = body => handleApiRequest(ctx, {}, request({ ...body, root: f.root }), s);
  const events = [{ type: "turn/start" }];
  assert.equal((await api({ kind: "record-node-conversation", nodeId: f.nodes.A.id, conversationId: "shared", entryHint: true })).body.ok, true);
  assert.equal(s.entry("shared", f.root, exec(f, "shared", events).agent.session), f.nodes.A.id, "第一次认领先给 A ✓");
  assert.equal((await api({ kind: "record-node-conversation", nodeId: f.nodes.B.id, conversationId: "shared", entryHint: true })).body.ok, true);
  assert.equal(s.entry("shared", f.root, exec(f, "shared", events).agent.session), f.nodes.B.id, "节点 2 认领后入口线索换成 B ✓（旧行为仍指向 A ✗）");
  assert.deepEqual((await api({ kind: "node-conversations", nodeId: f.nodes.A.id })).body.conversations, [], "A 的历史列表不再有这条 ✓");
  assert.deepEqual((await api({ kind: "node-conversations", nodeId: f.nodes.B.id })).body.conversations.map(entry => entry.sessionId), ["shared"], "B 的历史列表有这条 ✓");
});

test("visible notes can publish focus before their persisted session is attached", async () => {
  const f = await makeV3Fixture({ nodes: ["有包络的波包"] });
  const state = new LearningState(); const readIds = [];
  const ctx = { get: name => name === "sessionPersistence" ? { stat: async id => {
    readIds.push(id); return id === "chat" ? { header: { cwd: f.workspace } } : undefined;
  } } : undefined };
  const body = { kind: "view-focus", sessionId: "chat", root: f.root, viewId: "view", sequence: 1,
    nodeId: f.nodes["有包络的波包"].id, focusKind: "editor", active: true };
  assert.equal((await __internal.handleApiRequest(ctx, {}, request(body), state)).body.ok, true);
  const current = await tools({}, state).kn_current_node.execute({ source: "ui" }, exec(f));
  assert.equal(current.node.title, "有包络的波包"); assert.equal(current.source, "ui");
  assert.deepEqual(readIds, ["chat"]);
  /*
   * 会话的工作区**解析不出来**时（三条来源都没有 ✓）⇒ 以**面板报的库**为准 ✓
   * （用户实测 2026-10-11：插件刚建/刚切过去的节点对话会话就属于这种 ✓，
   *  旧契约在这里拒收 ⇒ 界面里开着笔记却说"没有当前节点" ✗）。
   * 仍然只影响**这个会话自己**的聚焦 ✓：下面用它自己的 sessionId 查得到 ✓，别的会话查不到 ✓。
   */
  const unknown = await __internal.handleApiRequest(ctx, {}, request({ ...body, sessionId: "unknown" }), state);
  assert.equal(unknown.body.ok, true);
  assert.equal(unknown.body.scope, "claimed", "会话范围未知 ⇒ 按面板报的库记 ✓");
  assert.equal(state.focus("unknown", f.root).nodeId, f.nodes["有包络的波包"].id);
  assert.equal(state.focus("another-session", f.root), undefined, "别的会话仍然查不到 ✓");
  /* 会话库**能解析**、而面板报的是**另一个库**时依旧拒收 ✗（"面板串库"这种真故障不能放过 ✓） */
  const other = await makeV3Fixture({ nodes: ["另一个库"] });
  assert.equal(
    (await __internal.handleApiRequest(ctx, {}, request({ ...body, root: other.root }), state)).body.error.code,
    "focus_scope_mismatch",
  );
  assert.match(__internal.PROTOCOL_SECTION, /Never substitute a library root/);
});

test("prompts expose only first-request origin ID; changed revisions fail explicitly", async () => {
  const f = await makeV3Fixture({ nodes: ["A"] }); const s = new LearningState(); s.enter("chat", f.root, f.nodes.A.id);
  const events = [{ type: "turn/start" }]; let context;
  __internal.registerPrompts({ on: (_name, listener) => listener({ agent: { ...exec(f, "chat", events).agent, ctx: { systemPrompt: { context: entry => { context = entry; } } } } }) }, {}, () => true, s);
  assert.ok(context.text().includes(f.nodes.A.id)); assert.equal(context.text().includes("的笔记"), false);
  events.push({ type: "turn/end" }); assert.equal(context.text(), __internal.PROTOCOL_SECTION);
  const t = tools({}); const first = await t.kn_list_graph.execute({ mode: "overview" }, exec(f));
  assert.equal((await t.kn_list_graph.execute({ mode: "overview", revision: "0".repeat(64) }, exec(f))).error.code, "structure_changed");
});

test("understanding changes and distant bodies remain available without changing other notes", async () => {
  const f = await makeV3Fixture({ nodes: ["A", "B", "C", "D"], edges: [["A", "B"], ["B", "C"]] }); const t = tools({});
  assert.equal((await t.kn_read_node.execute({ id: f.nodes.D.id }, exec(f))).node.understandingMarked, false);
  await writeFile(join(f.root, "understanding.json"), JSON.stringify({ version: 1, nodes: { [f.nodes.D.id]: true } }));
  const distant = await t.kn_read_node.execute({ id: f.nodes.D.id }, exec(f));
  assert.equal(distant.node.understood, true); assert.equal(distant.node.understandingMarked, true); assert.ok(distant.note.text.includes("D 的笔记"));
  assert.ok((await readFile(join(f.root, f.nodes.A.relativePath), "utf8")).includes("A 的笔记"));
});

test("supporting reads do not replace the previous learning target", async () => {
  const f = await makeV3Fixture({ nodes: ["A", "B"] }); const t = tools({});
  const a = await t.kn_read_node.execute({ id: f.nodes.A.id }, exec(f));
  const b = await t.kn_read_node.execute({ id: f.nodes.B.id, role: "background" }, exec(f));
  const events = [a, b].flatMap((result, index) => [
    { type: "tool/call", data: { callId: String(index), name: "kn_read_node" } },
    { type: "tool/result", data: { message: { source: { callId: String(index) }, content: [{ type: "text", text: JSON.stringify(result) }] } } },
  ]);
  assert.equal(__internal.learningFocusOf(exec(f, "chat", events).agent.session), f.nodes.A.id);
  const history = await t.kn_current_node.execute({ source: "history" }, exec(f, "chat", events));
  assert.equal(history.node.id, f.nodes.A.id);
  assert.equal((await t.kn_read_node.execute({ id: f.nodes.B.id, role: "invalid" }, exec(f))).error.code, "invalid_input");
});

test("structure paging survives unchanged cache refresh, but rejects actual content changes", async () => {
  const f = await makeV3Fixture({ nodes: ["A", "B"] }); const t = tools({ structureMaxNodes: 1 });
  const first = await t.kn_list_graph.execute({ mode: "overview" }, exec(f));
  const second = await t.kn_list_graph.execute({ mode: "overview", offset: first.nextOffset, revision: first.revision, refresh: true }, exec(f));
  assert.equal(second.ok, true); assert.equal(second.revision, first.revision); assert.notEqual(second.nodes[0].id, first.nodes[0].id);
  await writeFile(join(f.root, "understanding.json"), JSON.stringify({ version: 1, nodes: { [f.nodes.A.id]: true } }));
  assert.equal((await t.kn_list_graph.execute({ mode: "overview", revision: first.revision }, exec(f))).error.code, "structure_changed");
});
