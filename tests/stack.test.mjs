import assert from "node:assert/strict";
import { test } from "node:test";
import { __internal } from "../index.js";
let sequence = 0;
export const success = (name, value, args = {}) => {
  const callId = String(++sequence);
  return [{ type: "tool/call", data: { name, callId, arguments: JSON.stringify(args) } },
    { type: "tool/result", data: { message: { source: { kind: "tool", callId }, content: [{ type: "text", text: JSON.stringify(value) }] } } }];
};
const enter = id => success("kn_enter_node", { ok: true, current: { id } }, { title: "resolved by title" });
test("successful resolved results replay navigation; reads do not push", () => {
  const events = [...enter("A"), ...success("kn_read_node", { ok: true, node: { id: "A" } }), ...enter("B"), ...success("kn_back", { ok: true, current: { id: "A" } })];
  assert.deepEqual(__internal.foldStack(events), ["A"]);
  assert.equal(__internal.learningFocusOf({ snapshotEvents: () => events }), "A");
});
test("unfinished, failed and malformed results do not move the learning stack", () => {
  const events = [...enter("A"), { type: "tool/call", data: { name: "kn_enter_node", callId: "unfinished", arguments: '{"id":"B"}' } },
    ...success("kn_enter_node", { ok: false, error: {} }), ...success("kn_back", { ok: false })];
  assert.deepEqual(__internal.foldStack(events), ["A"]);
});
test("PTC successful navigation is replayable", () => {
  const event = { type: "tool/ptc-dispatch", data: { name: "kn_enter_node", subCallId: "ptc", content: [{ type: "text", text: '{"ok":true,"current":{"id":"C"}}' }] } };
  assert.deepEqual(__internal.foldStack([event]), ["C"]);
});
test("repeat enter switches target and helpers predict successful navigation", () => {
  const events = [...enter("A"), ...enter("B"), ...enter("A")];
  const session = { snapshotEvents: () => events };
  assert.deepEqual(__internal.stackOf(session), ["B", "A"]);
  assert.deepEqual(__internal.stackAfterEnter(session, "B"), ["A", "B"]);
  assert.deepEqual(__internal.stackAfterBack(session), { previous: "A", stack: ["B"] });
  assert.deepEqual(__internal.stackOf(undefined), []);
  assert.equal(__internal.currentIdOf({}), null);
});
test("a new ordinary request clears detailed context while explicit follow-up can retrieve identity", () => {
  const events = [{ type: "turn/start", data: { turn: 1 } }, ...enter("A")];
  const session = { snapshotEvents: () => events };
  assert.match(__internal.currentContextText({ session }, {}), /Target.*A/);
  events.push({ type: "user/message", data: { source: { kind: "human" }, content: [] } });
  assert.equal(__internal.currentContextText({ session }, {}), undefined);
  assert.equal(__internal.learningFocusOf(session), "A");
  events.push({ type: "turn/start", data: { turn: 2 } });
  assert.equal(__internal.currentContextText({ session }, {}), undefined);
});
