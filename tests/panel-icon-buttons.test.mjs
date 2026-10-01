/**
 * 面板头部的两颗图标按钮：形态守门（用户要求 2026-09）。
 *
 * 这一版把「重新整理」与「刷新」都从**文字胶囊**换成了**图标按钮**：
 * - **刷新** = harness 产品图标集的原版圆环字形（`ui-primitives/src/icons/index.tsx`
 *   的 `IconRefreshOutlineArtwork`，浏览器/文件面板那颗就是它）；
 * - **重新整理** = 用户给的设计稿里那枚"层级树"字形（三个圆角方块 + 一条分叉干线）。
 *
 * 钉住的点（都是容易回退或画偏的地方）：
 * 1. 两颗按钮都用 `kn-icon-btn`、**不能有可见文字**，但读屏名字（`aria-label`）与 hover 说明要在；
 * 2. **几何必须逐字照抄来源**：刷新对 harness、重新整理对设计稿 —— 上一轮"自己算几何"就把刷新画歪过 ✗；
 * 3. 画法按面板约定（16 网格 + 线宽 1 + `currentColor`），否则和邻居图标粗细对不上；
 * 4. 形状覆盖必须写在 `panel.css` **末尾** —— `.kn-root-fill .kn-btn` 那几条响应式规则
 *    会写死 height / padding，它们是单类选择器、与本组同优先级 ⇒ 只有靠"后出现"才压得住 ✗。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PANEL = path.join(HERE, "..", "src", "client", "GraphPanel.tsx");
const ICON = path.join(HERE, "..", "src", "client", "PanelIcon.tsx");
const CSS = path.join(HERE, "..", "src", "client", "panel.css");

const panel = await readFile(PANEL, "utf8");
const icon = await readFile(ICON, "utf8");
const css = await readFile(CSS, "utf8");
const tab = await readFile(path.join(HERE, "..", "src", "client", "tab.ts"), "utf8");
const tabDefinition = await readFile(path.join(HERE, "..", "src", "client", "tab-definition.ts"), "utf8");

/** 取某个图标按钮的 JSX 片段（从 className 到对应的 </button>） */
function buttonOf(marker) {
  const at = panel.indexOf(marker);
  assert.ok(at > 0, `找不到按钮片段：${marker}`);
  return panel.slice(at, panel.indexOf("</button>", at));
}

describe("面板头部图标按钮：共同形态", () => {
  it("两颗按钮都是 kn-icon-btn（外观一致），且都不再有可见文字", () => {
    assert.equal(
      (panel.match(/className="kn-btn kn-icon-btn"/g) ?? []).length,
      2,
      "「重新整理」与「刷新」都应是图标按钮",
    );
    for (const [marker, label, iconTag] of [
      ['aria-label={t("relayout")}', "重新整理", "<RelayoutTreeIcon />"],
      ['aria-label={t("refresh")}', "刷新", "<RefreshRingIcon />"],
    ]) {
      const button = buttonOf(marker);
      assert.ok(button.includes(iconTag), `${label} 按钮里应渲染图标`);
      const body = button.slice(button.indexOf(">") + 1);
      assert.ok(body.includes(iconTag), `${label} 的按钮体里只应有图标`);
      assert.equal(
        /t\("(relayout|refresh)"\)(?!\s*\})/.test(body.replace(/aria-label=\{[^}]*\}/g, "")),
        false,
        `${label} 不能再把文字渲染进按钮（那又会变回文字胶囊）`,
      );
    }
  });

  it("可见文字没了，读屏名字与 hover 说明必须在", () => {
    assert.ok(panel.includes('aria-label={t("relayout")}'), "重新整理要有 aria-label");
    assert.ok(panel.includes('title={t("relayoutHint")}'), "重新整理要有 hover 说明");
    assert.ok(panel.includes('aria-label={t("refresh")}'), "刷新要有 aria-label");
    assert.ok(panel.includes('title={t("refreshHint")}'), "刷新要有 hover 说明");
    assert.ok(panel.includes('relayoutHint: "重排布局，并把旋转中心复位到整张图"'), "说明文案要能查到");
  });

  it("形状=照抄宿主 `.tool` 图标按钮：28×28 圆 + 6px 内边距 + 15px 字形", () => {
    /* 来源：ui-sidebar-files/src/client/FilesBody.module.css 的 .tool */
    assert.match(css, /\.kn-icon-btn \{[\s\S]{0,400}width: 28px/, "按钮宽 28px（与宿主那颗一致）");
    assert.match(css, /\.kn-icon-btn \{[\s\S]{0,400}height: 28px/, "按钮高 28px");
    assert.match(css, /\.kn-icon-btn \{[\s\S]{0,400}padding: 6px/, "6px 内边距（28 − 2×6 = 16 内容区，容纳 15px 字形）");
    assert.match(css, /\.kn-icon-btn \{[\s\S]{0,400}border-radius: var\(--dsw-radius-sm/, "圆角用宿主 token");
    assert.match(css, /\.kn-icon-btn \{[\s\S]{0,400}border: none/, "去掉胶囊边框");
    assert.match(css, /\.kn-icon-btn \{[\s\S]{0,400}background: transparent/, "去掉胶囊底色");
    assert.match(css, /\.kn-icon-btn svg \{[\s\S]{0,120}width: 15px;[\s\S]{0,60}height: 15px/, "字形 15px（与宿主一致）");
    assert.match(css, /\.kn-icon-btn:hover:not\(:disabled\) \{[\s\S]{0,200}kn-hover/, "hover 用由主题 token 派生的 --kn-hover ✓");
    assert.match(css, /\.kn-icon-btn:focus-visible/, "键盘焦点要看得见");
  });

  it("形状覆盖放在 panel.css 末尾（否则会被 `.kn-root-fill .kn-btn` 的响应式调参压回去）", () => {
    const override = css.indexOf(".kn-root-fill .kn-btn.kn-icon-btn {");
    assert.ok(override > 0, "必须有 .kn-root-fill .kn-btn.kn-icon-btn 这条覆盖");
    const singles = [...css.matchAll(/\.kn-root-fill \.kn-btn \{/g)].map((m) => m.index ?? -1);
    assert.ok(singles.length >= 4, `应该有多档响应式调参（实际 ${singles.length} 条）`);
    for (const at of singles) {
      assert.ok(at < override, "覆盖必须出现在所有 `.kn-root-fill .kn-btn` 单类规则之后（同优先级靠后取胜）");
    }
    assert.match(css.slice(override), /width: 28px;[\s\S]{0,200}height: 28px;[\s\S]{0,200}padding: 6px;/, "覆盖里要把宽高与内边距都钉死");
  });
});

/**
 * 取某个图标函数的源码片段。
 *
 * **必须按"到下一个 export 为止"切**：这个文件里图标是一个个往后追加的，
 * 早先写成"从它到文件末尾"⇒ 后面新增图标（搜索放大镜、提交箭头）会被算进这一段，
 * 于是这条守门测试因为"多出来两条 path"而误报 ✗（实测踩过）。
 */
function glyphOf(name) {
  const start = icon.indexOf(`export function ${name}`);
  assert.ok(start > 0, `找不到 ${name}`);
  const nextExport = icon.indexOf("export function", start + 1);
  if (nextExport < 0) return icon.slice(start);
  /*
   * 往前退到下一个函数**自己的 JSDoc 之前**：它的说明文字里会出现 `stroke="currentColor"`
   * 这类字样，算进来的话"几条 path 带 currentColor"就会被数多 ✗。
   */
  const docStart = icon.lastIndexOf("/**", nextExport);
  return icon.slice(start, docStart > start ? docStart : nextExport);
}

describe("图谱标签图标：照抄用户给的那枚（三个节点 + 三条连线）", () => {
  /*
   * 用户要求 2026-10：把标签页与「开始」页卡片前面的图标换成 `dsh-graph-tab.html` 里的
   * `<symbol id="graph">`，而且**两处一致** ✓。这里钉"照抄"这件事本身：
   * 几何（24 网格、三个 r=3 的节点、一条三段的连线）与画法（线宽 1.5、圆头圆角、currentColor）都不许改。
   */
  it("几何与画法逐字照抄（24 网格 / 线宽 1.5 / 三个节点 + 三段连线）", () => {
    const glyph = glyphOf("GraphPanelIcon");
    assert.match(glyph, /viewBox="0 0 24 24"/, "用原版的 24 网格");
    assert.match(glyph, /strokeWidth=\{1\.5\}/, "用原版的线宽 1.5（24 网格换算到 16px 渲染 ≈ 1.0，与邻居同粗细）");
    assert.match(glyph, /stroke="currentColor"/, "单色，跟随主题与选中态");
    assert.match(glyph, /strokeLinecap="round"/, "圆头");
    assert.match(glyph, /strokeLinejoin="round"/, "圆角");
    assert.equal(
      glyph.includes('<path d="M8.2 6.8 15.8 10.2M7.5 8.5l2 7M15.8 13.8l-4.4 3.4" />'),
      true,
      "连线必须与原版一致",
    );
    for (const circle of ['<circle cx="6" cy="6" r="3" />', '<circle cx="19" cy="12" r="3" />', '<circle cx="10" cy="19" r="3" />']) {
      assert.ok(glyph.includes(circle), `节点必须与原版一致：${circle}`);
    }
    assert.equal((glyph.match(/<circle /g) ?? []).length, 3, "正好三个节点");
  });

  it("两处都用它：标签页（tab.ts）与「开始」页卡片（guide 条目）", () => {
    assert.ok(tab.includes("graphTabDefinition(prefersEnglish(), GraphPanelIcon as unknown)"), "标签页传入这枚图标");
    /* guide 条目必须把图标也带上 —— 宿主是 `entry.icon ?? CubeGlyph`，漏了就变成灰色占位方块 ✗ */
    assert.match(
      tabDefinition,
      /guide: \[\{[\s\S]{0,400}\.\.\.\(icon === undefined \? \{\} : \{ icon \}\)/,
      "guide 条目也要带上同一个图标",
    );
  });
});

describe("刷新按钮：harness 原版圆环字形", () => {
  it("几何与画法都与原版一致（不许自己改）", () => {
    const glyph = glyphOf("RefreshRingIcon");
    assert.match(glyph, /viewBox="0 0 16 16"/, "与宿主同网格（16）");
    assert.match(glyph, /strokeWidth=\{1\}/, "与宿主同线宽（ICON_REGULAR_STROKE = 1）");
    /*
     * 两条 path 的 `d` 必须与 `ui-primitives/src/icons/index.tsx` 的 `IconRefreshOutlineArtwork`
     * **逐字一致**（这里取首尾两段足够把"换过几何"钉出来）。
     */
    assert.ok(
      glyph.includes('d="M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611'),
      "圆环那条 path 的几何必须是原版（开头对不上就说明自己重画了）",
    );
    assert.ok(glyph.includes("13.0001 3.6L14.5001 5.1\""), "圆环那条 path 的收尾也要与原版一致");
    assert.ok(glyph.includes('d="M14.4999 1.5V5.1H10.8999"'), "箭头那条 path 必须与原版一致");
    assert.equal((glyph.match(/stroke="currentColor"/g) ?? []).length, 2, "两条 path 都自带 currentColor");
    assert.equal(glyph.includes("strokeLinecap"), false, "原版没有 linecap（自己加 round 就画偏了）");
    assert.equal(glyph.includes("strokeLinejoin"), false, "原版没有 linejoin");
    assert.equal(glyph.includes("<circle"), false, "原版没有 circle 元素（圆环是 path 画的）");
  });
});

describe("重新整理按钮：设计稿的层级树字形", () => {
  it("三个圆角方块 + 一条分叉干线，几何逐字照抄设计稿", () => {
    const glyph = glyphOf("RelayoutTreeIcon");
    /* 设计稿原样：上节点 / 左下节点 / 右下节点 + 主干与分叉 */
    assert.ok(glyph.includes('<rect x="6" y="1.5" width="4" height="3" rx=".7" />'), "上节点方块");
    assert.ok(glyph.includes('<rect x="1" y="11.5" width="4" height="3" rx=".7" />'), "左下节点方块");
    assert.ok(glyph.includes('<rect x="11" y="11.5" width="4" height="3" rx=".7" />'), "右下节点方块");
    assert.ok(glyph.includes('<path d="M8 4.5v3M3 11.5v-4h10v4" />'), "主干 + 分叉必须与设计稿一致");
    assert.equal((glyph.match(/<rect /g) ?? []).length, 3, "正好三个节点方块");
  });

  it("画法跟随面板约定：16 网格 + 线宽 1 + currentColor + round 端点", () => {
    const glyph = glyphOf("RelayoutTreeIcon");
    assert.match(glyph, /viewBox="0 0 16 16"/, "与面板其它图标同网格");
    assert.match(glyph, /stroke="currentColor"/, "单色描边，跟随主题");
    assert.match(glyph, /strokeWidth=\{1\}/, "线宽与右边那颗刷新一致（设计稿页面的 1.5 是整页样式，不是这一枚的参数）");
    assert.match(glyph, /strokeLinecap="round"/, "设计稿用的是圆头线帽");
    assert.match(glyph, /strokeLinejoin="round"/, "圆角连接");
    assert.match(glyph, /fill="none"/, "只描边、不填充");
  });
});

describe("重新整理的行为：顺带把旋转中心初始化", () => {
  /*
   * 用户反馈 2026-09：聚焦过某个节点之后，点「重新整理」只是重排了布局，
   * **环绕观察的中心仍然钉在那个节点上** ✗ —— 用户要求点完它就把中心初始化。
   *
   * 上游 `engine.relayout()` 是刻意"相机保持不动"的（注释里写得很清楚），
   * 所以归位必须由我们这一层补：同一次点击里再发一条 `fitAll` 相机命令
   * （`navigation.fitAll` 取的是**全部节点**的包围盒中心，天然不认某个聚焦节点 ✓）。
   */
  it("点一下 = 重排布局 + 发 fitAll 把中心收回来", () => {
    const button = buttonOf('aria-label={t("relayout")}');
    assert.ok(button.includes("setRelayoutToken((value) => value + 1)"), "要重跑力导向布局");
    assert.ok(button.includes("fitWholeGraph()"), "同时要把旋转中心复位（fitAll）");

    const helperStart = panel.indexOf("const fitWholeGraph");
    assert.ok(helperStart > 0, "找不到 fitWholeGraph");
    const helper = panel.slice(helperStart, panel.indexOf("}, []);", helperStart));
    assert.ok(helper.includes('type: "fitAll"'), "复位靠 fitAll 相机命令（取全部节点的包围盒中心）");
    assert.ok(helper.includes("useCallback"), "抽成稳定回调：否则每次渲染换引用会把事件监听器反复重挂");
    assert.ok(
      panel.includes("engine.relayout()"),
      "注释里要写明上游 relayout 是「相机不动」，避免以后有人把这步归位删掉",
    );
  });
});
