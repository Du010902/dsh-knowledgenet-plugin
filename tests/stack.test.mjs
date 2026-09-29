/**
 * 学习栈折叠（纯函数）测试。
 *
 * 学习栈是「当前学到哪个知识点」的唯一真相来源，且必须是**可回放**的：
 * 同样的事件序列在任何时候、任何进程里都折叠出同样的栈。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { __internal } from "../index.js";

const call = (name, args) => ({ type: "tool/call", data: { name, arguments: JSON.stringify(args) } });
const other = { type: "tool/call", data: { name: "read", arguments: "{}" } };
const result = { type: "tool/result", data: {} };

describe("学习栈从事件流折叠", () => {
  it("空事件流 → 空栈", () => {
    assert.deepEqual(__internal.foldStack([]), []);
  });

  it("enter 压栈，back 弹栈，其它工具不影响", () => {
    const events = [
      other,
      call("kn_enter_node", { id: "A" }),
      result,
      call("kn_read_node", { id: "A" }),
      call("kn_enter_node", { id: "B" }),
      call("kn_back", {}),
    ];
    assert.deepEqual(__internal.foldStack(events), ["A"]);
  });

  it("重复 enter 同一个节点等价于「切到它」，不会出现两份", () => {
    const events = [
      call("kn_enter_node", { id: "A" }),
      call("kn_enter_node", { id: "B" }),
      call("kn_enter_node", { id: "A" }),
    ];
    assert.deepEqual(__internal.foldStack(events), ["B", "A"]);
  });

  it("空栈上 back 是无操作（不会变成负数或抛错）", () => {
    assert.deepEqual(__internal.foldStack([call("kn_back", {}), call("kn_back", {})]), []);
  });

  it("坏掉的 arguments 不会污染栈", () => {
    const events = [
      { type: "tool/call", data: { name: "kn_enter_node", arguments: "{not json" } },
      { type: "tool/call", data: { name: "kn_enter_node", arguments: JSON.stringify({ id: 42 }) } },
      call("kn_enter_node", { id: "C" }),
    ];
    assert.deepEqual(__internal.foldStack(events), ["C"]);
  });

  it("会话对象不可用时退化成空栈，而不是抛错", () => {
    assert.deepEqual(__internal.stackOf(undefined), []);
    assert.deepEqual(__internal.stackOf({}), []);
    assert.equal(__internal.currentIdOf({}), null);
  });

  it("enter/back 的「预演」栈与折叠后的栈一致（工具返回的栈就是下一次折叠的结果）", () => {
    const session = {
      snapshotEvents: () => [call("kn_enter_node", { id: "A" }), call("kn_enter_node", { id: "B" })],
    };
    assert.deepEqual(__internal.stackOf(session), ["A", "B"]);
    assert.deepEqual(__internal.stackAfterEnter(session, "C"), ["A", "B", "C"]);
    assert.deepEqual(__internal.stackAfterEnter(session, "A"), ["B", "A"]);
    assert.deepEqual(__internal.stackAfterBack(session), { previous: "B", stack: ["A"] });
  });
});
