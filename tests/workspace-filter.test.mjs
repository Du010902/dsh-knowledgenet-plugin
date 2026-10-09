/**
 * 「跟着侧栏的归档筛选走」这条规则的测试。
 *
 * 两件事：
 * 1. `readArchivedFilter` 能从宿主落在 localStorage 的整值 JSON 里读出 `archivedFilter`
 *    （键名带版本号 ⇒ 按前缀找、取版本最高的；读不懂一律回落到宿主的默认值 ✓）；
 * 2. `recordState` 三种筛选模式下的表现与侧栏逐条对齐（隐藏已归档 / 全部 / 仅已归档 ✓）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { makeConversationActions } from "../src/client/node-conversations.ts";
import { readArchivedFilter } from "../src/client/workspace-filter.ts";

/** 假 localStorage：只实现我们读的那三个成员 ✓ */
function fakeStorage(entries) {
  const map = new Map(Object.entries(entries));
  return {
    get length() { return map.size; },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
  };
}

/** 造一组服务：会话列表给出 blank，工作区快照给出归档集合 + 工作区行 ✓ */
function services({ blank = false, archived = [], items = [{ workspaceId: "w1", path: "/workspace", sessionIds: [] }] } = {}) {
  return {
    sessions: {
      create: async () => "new",
      list: { getSnapshot: () => ({ phase: "ready", byId: { "chat-1": { blank } } }) },
    },
    uiWorkspace: { openSession: () => {} },
    workspaces: { list: { getSnapshot: () => ({ items, archivedSessionIds: archived }) } },
  };
}

const answers = { ok: true, json: async () => ({ ok: true, root: "/lib", cwd: "/workspace", conversations: [] }) };

describe("readArchivedFilter：读宿主的「筛选会话」", () => {
  it("按前缀找键、取版本最高的那个；三种取值都认", () => {
    const storage = fakeStorage({
      "dsh.workspace.view.v4": JSON.stringify({ archivedFilter: "only" }),
      "dsh.workspace.view.v5": JSON.stringify({ groupBy: "workspace", archivedFilter: "show" }),
      "unrelated.key": JSON.stringify({ archivedFilter: "only" }),
    });
    assert.equal(readArchivedFilter(storage), "show", "v5 比 v4 新 ✓；别的键不认 ✓");
    assert.equal(readArchivedFilter(fakeStorage({ "dsh.workspace.view.v5": JSON.stringify({ archivedFilter: "only" }) })), "only");
    assert.equal(readArchivedFilter(fakeStorage({ "dsh.workspace.view.v5": JSON.stringify({ archivedFilter: "default" }) })), "default");
  });

  it("没有存储 / 键缺 / JSON 坏 / 取值不认识 ⇒ 一律回落到宿主的默认值 default", () => {
    assert.equal(readArchivedFilter(null), "default");
    assert.equal(readArchivedFilter(fakeStorage({})), "default");
    assert.equal(readArchivedFilter(fakeStorage({ "dsh.workspace.view.v5": "not json" })), "default");
    assert.equal(readArchivedFilter(fakeStorage({ "dsh.workspace.view.v5": JSON.stringify({ archivedFilter: "everything" }) })), "default");
  });

  it("字段不在顶层也能找到（宿主换一层包也认 ✓）", () => {
    const storage = fakeStorage({ "dsh.workspace.view.v6": JSON.stringify({ state: { view: { archivedFilter: "show" } } }) });
    assert.equal(readArchivedFilter(storage), "show");
  });
});

describe("recordState：节点历史跟随工作区的归档筛选", () => {
  const actionsWith = (options) => makeConversationActions(() => services(options), async () => answers);

  it("默认（隐藏已归档）：已归档的不显示", () => {
    const filter = fakeStorage({ "dsh.workspace.view.v5": JSON.stringify({ archivedFilter: "default" }) });
    assert.equal(readArchivedFilter(filter), "default");
    /* 直接改全局：组件与动作读的是同一个 localStorage ✓ */
    globalThis.localStorage = filter;
    try {
      assert.equal(actionsWith({}).recordState("chat-1"), "show");
      assert.equal(actionsWith({ archived: ["chat-1"] }).recordState("chat-1"), "hide", "已归档 ⇒ 跟着筛选隐藏 ✓");
    } finally { delete globalThis.localStorage; }
  });

  it("全部对话：已归档的显示但要标出来（点不开的东西不许看着能点 ✗）", () => {
    globalThis.localStorage = fakeStorage({ "dsh.workspace.view.v5": JSON.stringify({ archivedFilter: "show" }) });
    try {
      assert.equal(actionsWith({}).recordState("chat-1"), "show");
      assert.equal(actionsWith({ archived: ["chat-1"] }).recordState("chat-1"), "archived");
    } finally { delete globalThis.localStorage; }
  });

  it("仅显示已归档：只留已归档的那些", () => {
    globalThis.localStorage = fakeStorage({ "dsh.workspace.view.v5": JSON.stringify({ archivedFilter: "only" }) });
    try {
      assert.equal(actionsWith({}).recordState("chat-1"), "hide");
      assert.equal(actionsWith({ archived: ["chat-1"] }).recordState("chat-1"), "archived");
    } finally { delete globalThis.localStorage; }
  });

  it("还没开始第一轮的空白会话一律不显示；拿不到服务时照常显示（不误伤 ✓）", () => {
    assert.equal(actionsWith({ blank: true }).recordState("chat-1"), "hide");
    assert.equal(makeConversationActions(() => undefined, async () => answers).recordState("chat-1"), "show");
  });
});
