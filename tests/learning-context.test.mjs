import assert from "node:assert/strict";
import { after, test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { __internal, apply } from "../index.js";
import { resolveLearningConfig } from "../src/host/learning-config.ts";
import { makeV3Fixture, cleanupFixtures } from "./support/v3-fixture.mjs";
after(cleanupFixtures);
const tools = config => Object.fromEntries(__internal.createTools(config).map(tool => [tool.name, tool]));
const exec = cwd => ({ agent: { session: { header: { cwd }, snapshotEvents: () => [] } } });
test("local graph excludes unrelated nodes; overview has independent structure budgets and paging", async () => {
  const f = await makeV3Fixture({ nodes: ["A", "B", "C"], edges: [["A", "B"]] });
  const t = tools({ modelMaxNodes: 2, modelMaxEdges: 1, structureMaxNodes: 2, structureMaxEdges: 1 });
  assert.equal((await t.kn_list_graph.execute({}, exec(f.workspace))).error.code, "focus_required");
  const local = await t.kn_list_graph.execute({ focusId: f.nodes.A.id }, exec(f.workspace));
  assert.equal(local.ok, true); assert.deepEqual(local.nodes.map(n => n.title), ["A", "B"]);
  assert.equal(JSON.stringify(local).includes('"title":"C"'), false);
  const all = await t.kn_list_graph.execute({ mode: "overview" }, exec(f.workspace));
  assert.equal(all.nodes.length, 2); assert.equal(all.nextOffset, 2);
  const rest = await t.kn_list_graph.execute({ mode: "overview", offset: all.nextOffset }, exec(f.workspace));
  assert.equal(rest.nodes.length, 1); assert.equal(rest.nextOffset, null);
});
test("node read only returns target text, understanding and counts by default; explicit relationships are capped", async () => {
  const f = await makeV3Fixture({ nodes: ["A", "B", "C", "D"], edges: [["A", "B"], ["A", "C"]] });
  await writeFile(join(f.root, "understanding.json"), JSON.stringify({ version: 1, nodes: { [f.nodes.A.id]: true } }));
  const t = tools({ noteMaxChars: 3, maxNoteChars: 6, relationLimit: 1 });
  const r = await t.kn_read_node.execute({ id: f.nodes.A.id }, exec(f.workspace));
  assert.equal(r.ok, true); assert.equal(r.node.understood, true);
  assert.equal(r.note.text.length, 3); assert.equal(r.note.nextOffset, 3);
  assert.equal(r.relationCounts.prerequisites, 2); assert.deepEqual(r.prerequisites, []);
  assert.deepEqual(r.dependents, []); assert.deepEqual(r.relations, []);
  const next = await t.kn_read_node.execute({ id: f.nodes.A.id, offset: 3, noteMaxChars: 100 }, exec(f.workspace));
  assert.equal(r.note.text + next.note.text, "A 的笔记\n"); assert.equal(next.note.nextOffset, null);
  const rel = await t.kn_read_node.execute({ id: f.nodes.A.id, relations: "prerequisites" }, exec(f.workspace));
  assert.equal(rel.prerequisites.length, 1); assert.equal(rel.relationPage.nextOffset, 1);
  assert.equal((await t.kn_read_node.execute({ id: f.nodes.A.id, offset: -1 }, exec(f.workspace))).error.code, "invalid_input");
});
test("fresh library agents receive only the thin protocol; foreign agents receive empty plugin context", async () => {
  const f = await makeV3Fixture({ nodes: ["A"] });
  const callbacks = [];
  __internal.registerPrompts({ on: (_name, listener) => callbacks.push(listener) }, {});
  let entry;
  const events = [];
  callbacks[0]({ agent: { id: "scope", session: { header: { cwd: f.workspace }, snapshotEvents: () => events }, ctx: { systemPrompt: { context: value => { entry = value; } } } } });
  assert.equal(entry.text(), __internal.PROTOCOL_SECTION);
  assert.equal(entry.text().includes(__internal.LEARNING_SECTION), false);
  callbacks[0]({ agent: { session: { header: { cwd: join(f.workspace, "..", "plain") }, snapshotEvents: () => [] }, ctx: { systemPrompt: { context: value => { entry = value; } } } } });
  assert.equal(entry.text(), "");
});
test("unsupported isolation disables only plugin tools", async () => {
  const active = new Set(["ordinary_tool"]); const listeners = [];
  apply({ tools: { register: tool => { active.add(tool.name); return () => active.delete(tool.name); } }, on: (_name, listener) => listeners.push(listener), get: () => undefined }, {});
  assert.equal(active.has("kn_read_node"), true);
  listeners.forEach(listener => listener({ agent: { session: { header: { cwd: "/plain" } }, ctx: {} } }));
  assert.deepEqual([...active], ["ordinary_tool"]);
});
test("invalid plugin budgets fail at registration", () => {
  assert.throws(() => resolveLearningConfig({ searchLimit: 0 }));
  assert.throws(() => resolveLearningConfig({ noteMaxChars: 20000, maxNoteChars: 100 }));
});

test("known ID reads avoid metadata loading, while ambiguous titles require a choice",async()=>{
 const f=await makeV3Fixture({nodes:["Same","Other"]});await __internal.loadLibrary(f.root);const count=__internal.runtimeStatus().scans.length;
 const result=await tools({}).kn_read_node.execute({id:f.nodes.Same.id},exec(f.workspace));assert.equal(result.ok,true);assert.equal(__internal.runtimeStatus().scans.length,count);
 const {createNode}=await import("../src/host/v3/store.ts");await createNode(f.root,{title:"Same",note:"second"});const {loadLibrary}=__internal;await loadLibrary(f.root,{refresh:true});
 const ambiguous=await tools({}).kn_read_node.execute({title:"Same"},exec(f.workspace));assert.equal(ambiguous.error.code,"ambiguous_title");assert.equal(ambiguous.candidates.length,2);
});
