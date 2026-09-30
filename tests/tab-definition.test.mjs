/**
 * 右侧栏 tab type 定义的形状测试（纯函数，无需 DOM）。
 *
 * 这些断言来自一次真实失败：`guide` 写成对象而不是数组，注册时抛错，
 * 表现只是「开始页没有卡片、右侧栏也没有标签页」——没有任何可见线索。
 * 所以形状必须被钉住。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  GRAPH_GUIDE_ENTRY_ID,
  GRAPH_GUIDE_ORDER,
  GRAPH_TAB_ID,
  GRAPH_TAB_KIND,
  graphTabDefinition,
  guideEntryInject,
} from "../src/client/tab-definition.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tabSource = await readFile(path.join(HERE, "..", "src", "client", "tab.ts"), "utf8");
const titleSource = await readFile(path.join(HERE, "..", "src", "client", "GraphTabTitle.tsx"), "utf8");

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
    /*
     * **芯片用短名、卡片用全名**（照抄宿主「文件 / 工作区文件」那套，用户 2026-10 要求）：
     * 芯片是窄条，写"知识库图谱"会把别的标签挤掉 ✗。
     */
    assert.equal(definition.title(), "图谱", "标签芯片用短名");
    assert.equal(definition.guide[0].title(), "知识库图谱", "「开始」页卡片仍然用全名");
    assert.match(definition.guide[0].description(), /聚焦|空间/);
    const english = graphTabDefinition(true);
    assert.equal(english.title(), "Graph");
    assert.equal(english.guide[0].title(), "Knowledge graph");
    assert.match(english.guide[0].description(), /space/i);
  });

  it("图标同时给「标签页」和「开始页卡片」（两处必须一致）", () => {
    /*
     * 用户要求 2026-10：标签页与「开始」页入口卡片用**同一个**图谱图标 ✓。
     * 宿主的卡片逻辑是 `entry.icon ?? CubeGlyph`（`GuideBody.tsx:54`）——
     * 只给 definition.icon 不给 guide[].icon 的话，卡片会回落到灰色占位立方体 ✗。
     */
    const Icon = () => null;
    const withIcon = graphTabDefinition(false, Icon);
    assert.equal(withIcon.icon, Icon, "标签页芯片要用它");
    assert.equal(withIcon.guide[0].icon, Icon, "「开始」页卡片也要用它");
    /* 不给图标时两个字段都不出现（宿主走各自兜底），不要凭空塞一个 undefined ✓ */
    assert.equal("icon" in graphTabDefinition(false), false);
    assert.equal("icon" in graphTabDefinition(false).guide[0], false);
  });
});

describe("标签芯片的图标：必须自己注册标题组件", () => {
  /*
   * 用户反馈 2026-10（截图："这里没变啊"）：**只改 `definition.icon` 不会改变标签芯片的外观** ✗。
   * 宿主渲染芯片时优先用标签类型自己注册的 `sidebar.right.pane.tab.title` 组件
   * （`SidebarRight.tsx:246` 的 `titlesFor`），没有就回落到"打开标签时记下的那串纯文字"
   * —— layout 记录里只有 `title` 字段，**没有图标**（`persistence.ts:20`）。
   * 所以芯片里的图标只能靠注册标题组件拿到，写法照抄 shipped 的 `FilesTitle.tsx` ✓。
   */
  it("tab.ts 在 sidebar.right.pane.tab.title 座位注册了 GraphTabTitle（key 与本体一致）", () => {
    assert.ok(tabSource.includes('slots.inject("sidebar.right.pane.tab.title"'), "要注册标题座位");
    assert.match(
      tabSource,
      /slots\.inject\("sidebar\.right\.pane\.tab\.title"[\s\S]{0,220}key: definition\.id/,
      "key 必须与标签本体用同一个（宿主按 type 的 id 找座位）",
    );
    assert.ok(tabSource.includes("GraphTabTitle"), "注册的是我们的标题组件");
  });

  it("标题组件：图谱图标 + **固定短名**（不读被快照进记录的旧标题）", () => {
    assert.ok(titleSource.includes("GraphPanelIcon"), "芯片里要画那枚图谱图标");
    assert.match(titleSource, /<GraphPanelIcon size=\{16\}/, "与文件/浏览器芯片同尺寸（16）");
    assert.ok(titleSource.includes('tabShort'), "短名要走词典键 tabShort（中英跟随）");
    assert.ok(titleSource.includes('const LITERAL: Record<string, string> = { tabShort: "图谱" }'), "拿不到 t 时的字面兜底");
    /*
     * **不许读 `tab.title`**：宿主把"打开那一刻的文字"快照进 layout 记录并持久化
     * （`persistence.ts:20` 只存 title），已经开着的标签在记录里还是旧的长名字 ⇒
     * 读记录的话改成短名要关掉重开才生效 ✗（这正是上一轮"没变"的同款陷阱）。
     */
    assert.equal(titleSource.includes("{tab.title}"), false, "芯片文字不能来自标签记录（那是快照）");
    assert.equal(titleSource.includes("useTabInfo"), false, "用固定短名 ⇒ 不需要读标签记录");
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
