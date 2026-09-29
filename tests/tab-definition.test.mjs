/**
 * 右侧栏 tab type 定义的形状测试（纯函数，无需 DOM）。
 *
 * 这些断言来自一次真实失败：`guide` 写成对象而不是数组，注册时抛错，
 * 表现只是「开始页没有卡片、右侧栏也没有标签页」——没有任何可见线索。
 * 所以形状必须被钉住。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GRAPH_GUIDE_ENTRY_ID,
  GRAPH_GUIDE_ORDER,
  GRAPH_TAB_ID,
  GRAPH_TAB_KIND,
  graphTabDefinition,
  guideEntryInject,
} from "../src/client/tab-definition.ts";

describe("右侧栏 tab type 定义", () => {
  const definition = graphTabDefinition(false);

  it("id / kind / 优先级 / keepMounted", () => {
    assert.equal(definition.id, GRAPH_TAB_ID);
    assert.equal(definition.kind, GRAPH_TAB_KIND);
    assert.equal(definition.priority, "extension");
    /*
     * **必须 false**：隐藏时保持挂载会让「看不见的三维场景 + 取数」继续烧 CPU/GPU，
     * 桌面端拖动窗口明显卡顿（实测 + 代码审查确认）。代价是切回来重建场景（相机回默认）。
     */
    assert.equal(definition.keepMounted, false, "切走后必须卸载：否则 3D 渲染与取数会一直跑");
  });

  it("guide 必须是数组，且每条都有 id / order / title（注册时会校验）", () => {
    assert.ok(Array.isArray(definition.guide), "guide 必须是数组（写成对象会在注册时报 entries.map is not a function）");
    assert.ok(definition.guide.length >= 1);
    const entry = definition.guide[0];
    assert.equal(typeof entry.id, "string");
    assert.equal(entry.id, GRAPH_GUIDE_ENTRY_ID);
    assert.equal(entry.order, GRAPH_GUIDE_ORDER);
    assert.equal(typeof entry.title, "function");
    assert.equal(typeof entry.description, "function");
    // 条目 id 在提供者内必须唯一
    const ids = definition.guide.map((item) => item.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("title/description 是函数（语言在每次调用时重读）", () => {
    assert.equal(typeof definition.title, "function");
    assert.equal(definition.title(), "知识库图谱");
    assert.match(definition.guide[0].description(), /聚焦|空间/);
    const english = graphTabDefinition(true);
    assert.equal(english.title(), "Knowledge graph");
    assert.match(english.guide[0].description(), /space/i);
  });
});

describe("入口卡片的打开回调", () => {
  it("用 sidebarRight.openTabIn(sessionId, kind) 打开（不依赖 info hook）", () => {
    const calls = [];
    const navigation = { openTabIn: (sessionId, kind, options) => { calls.push([sessionId, kind, options]); } };
    const face = guideEntryInject("s-1", navigation);
    assert.equal(face.openGraph("knowledgenet"), true);
    assert.deepEqual(calls, [["s-1", "knowledgenet", { replaceTab: true }]]);
  });

  it("服务不在时答 false（让卡片退回 hook 那条路，而不是假装成功）", () => {
    assert.equal(guideEntryInject("s-1", undefined).openGraph("knowledgenet"), false);
    assert.equal(guideEntryInject("s-1", {}).openGraph("knowledgenet"), false);
  });

  it("服务抛错时也答 false，不把异常丢进指南页", () => {
    const navigation = { openTabIn: () => { throw new Error("surface gone"); } };
    assert.equal(guideEntryInject("s-1", navigation).openGraph("knowledgenet"), false);
  });
});
