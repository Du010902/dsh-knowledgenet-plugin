/**
 * 主题 token 守卫（用户截图暴露的问题 ✓）。
 *
 * 背景：面板此前用了一批**听起来合理、但 harness 并不存在**的颜色 token
 * （`--dsw-alias-bg-elevated`、`--dsw-alias-border-secondary`、`--dsw-alias-accent` ✗ …）
 * ⇒ 全部掉进硬编码的深色兜底 ⇒ **宿主是浅色时面板仍是黑的** ✗（截图 ✓）。
 *
 * 这条测试把 harness 的真实 token 列表钉在这里（来自 client/Theme inspect ✓）：
 * 以后任何插件文件里出现**未知的颜色 token**，一律失败 ✗；
 * 几何类（圆角 / 焦点环）不在此列 ✓（它们不是主题色，允许带兜底 ✓）。
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT = path.join(ROOT, "src/client");

/** harness 真实颜色 token（client/Theme → listTokens ✓） */
const REAL_TOKENS = new Set([
  "--dsw-alias-bg-base",
  "--dsw-alias-bg-layer-1",
  "--dsw-alias-bg-layer-2",
  "--dsw-alias-bg-overlay",
  "--dsw-alias-border-l1",
  "--dsw-alias-border-l2",
  "--dsw-alias-brand-primary",
  "--dsw-alias-label-primary",
  "--dsw-alias-label-secondary",
  "--dsw-alias-state-error-primary",
  "--dsw-alias-state-idle-primary",
  "--dsw-alias-state-success-primary",
  "--dsw-alias-state-warn-primary",
  "--dsw-specific-sidebar-fill",
]);

/** 插件自己定义的派生变量（在 panel.css / create-dialog-css.ts 里声明 ✓） */
const LOCAL_TOKENS = new Set(["--kn-hover", "--kn-warn-bg"]);

/** 几何类（不是主题色 ✓，允许带兜底 ✓） */
const GEOMETRY = /^--dsw-(radius|focus-ring|shadow|font|spacing|size)/;

function clientFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "vendor") continue;
        walk(full);
        continue;
      }
      if (/\.(ts|tsx|css)$/.test(entry.name)) out.push(full);
    }
  };
  walk(CLIENT);
  return out;
}

describe("主题 token", () => {
  it("颜色 token 只能引用 harness 真实存在的名字（写错就会掉进硬编码深色 ✗）", () => {
    const files = clientFiles();
    assert.ok(files.length > 10, "要扫到客户端的源码与样式 ✓");
    const offenders = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/var\((--dsw-[a-z0-9-]+)/g)) {
        const name = match[1];
        if (REAL_TOKENS.has(name) || GEOMETRY.test(name)) continue;
        offenders.push(`${path.relative(ROOT, file)} → ${name}`);
      }
    }
    assert.deepEqual(offenders, [], `这些 token harness 里不存在（会掉进兜底颜色 ✗）：\n${offenders.join("\n")}`);
  });

  it("颜色 token 不许再带硬编码兜底（兜底会掩盖「名字写错」，浅色主题下还会露深色 ✗）", () => {
    const offenders = [];
    for (const file of clientFiles()) {
      const text = readFileSync(file, "utf8");
      /* 只盯颜色类 token ✓；几何类允许兜底 ✓ */
      for (const match of text.matchAll(/var\((--dsw-alias-(?:bg|border|label|brand|state)[a-z0-9-]*),\s*([^)]*)\)/g)) {
        offenders.push(`${path.relative(ROOT, file)} → ${match[1]} 兜底 ${match[2].trim()}`);
      }
    }
    assert.deepEqual(offenders, [], `颜色 token 上不该有兜底 ✗：\n${offenders.join("\n")}`);
  });

  it("派生颜色由真实 token 算出，派生变量本身有定义 ✓", () => {
    const panel = readFileSync(path.join(CLIENT, "panel.css"), "utf8");
    const dialog = readFileSync(path.join(CLIENT, "create-dialog-css.ts"), "utf8");
    assert.ok(
      `${panel}\n${dialog}`.includes("--kn-hover:"),
      "派生变量必须有定义（否则所有 var(--kn-hover) 都失效 ✗）",
    );
    assert.ok(dialog.includes(":root {"), "轻 DOM（portal 弹窗）要能在 :root 拿到派生变量 ✓");
    for (const name of LOCAL_TOKENS) {
      const used = clientFiles().some((file) => readFileSync(file, "utf8").includes(`var(${name}`));
      if (used) {
        assert.ok(
          `${panel}\n${dialog}`.includes(`${name}:`),
          `${name} 被用到就必须有定义 ✓`,
        );
      }
    }
  });

  it("面板与编辑器的底色来自主题 token（浅色主题下不该还是深色 ✗）", () => {
    const panel = readFileSync(path.join(CLIENT, "panel.css"), "utf8");
    assert.ok(panel.includes("--surface: var(--dsw-alias-bg-layer-1)"), "面板底色走 token ✓");
    assert.ok(
      /\.kn-editor \{[^}]*background: var\(--dsw-alias-bg-layer-1\)/s.test(panel),
      "编辑器（弹窗主体）底色必须来自主题 token ✓ —— 之前用不存在的 token + 深色兜底 ⇒ 浅色主题下是黑的 ✗",
    );
    const overrides = readFileSync(path.join(CLIENT, "editor-overrides.css"), "utf8");
    assert.ok(
      overrides.includes("--crepe-color-background: var(--dsw-alias-bg-layer-1)"),
      "富编辑器（Crepe）变量同样接到主题 token ✓（且必须放在覆盖文件里才能压过 Crepe 自带定义 ✓）",
    );
  });

  it("**表格必须看得出来是表格**：不透明边框 + 表头浅底（Crepe 自带的只有 20% 不透明度 ✗）", () => {
    const overrides = readFileSync(path.join(CLIENT, "editor-overrides.css"), "utf8");
    assert.ok(
      /border: 1px solid var\(--dsw-alias-border-l2\)/.test(overrides),
      "单元格边框要用**不透明**的主题 token ✓（用户截图里表格完全看不出格子 ✗）",
    );
    assert.ok(
      /th \{[^}]*background: var\(--dsw-alias-bg-layer-2\)/s.test(overrides),
      "表头要有浅底 ✓",
    );
    assert.ok(overrides.includes(".selectedCell::after"), "选中区域要有可见高亮 ✓");
    assert.ok(overrides.includes(".column-resize-handle"), "列宽手柄要看得见 ✓");
    /* 权重必须高于 Crepe 的 `.milkdown .milkdown-table-block td` ✓ */
    assert.ok(
      overrides.includes(".kn-root .kn-editor-rich .milkdown th"),
      "选择器要抬高权重到 .kn-root .kn-editor-rich … ✗（否则被 Crepe 压住 ✓）",
    );
  });

  it("**正文宽度**：必须盖掉 Crepe 的宽页面内边距（60px 120px ✗），否则侧栏里正文只剩 ~162px", () => {
    const overrides = readFileSync(path.join(CLIENT, "editor-overrides.css"), "utf8");
    assert.ok(
      /\.kn-editor-rich \.milkdown \.ProseMirror \{[^}]*padding: 8px 6px 28px/s.test(overrides),
      "侧栏里正文内边距要收窄到「够放手柄」的程度 ✓（实测：不覆盖就只有 162px 正文宽 ✗）",
    );
    assert.ok(
      overrides.includes(".kn-root .kn-editor-rich .milkdown .ProseMirror"),
      "选择器要带插件作用域 ✓",
    );
    /*
     * 布局改版（用户实测）之后：编辑器**铺满**整个图谱区 ✓ ⇒
     * 面板的容器宽度**就是**编辑器宽度 ✓，所以"宽面板 ⇒ 居中阅读栏"这条 `@container`
     * 不再是"拿外围宽度当展开模式" ✗（那条限制的前提已经消失 ✓）。
     */
    assert.ok(
      /@container \(min-width: 720px\)[\s\S]{0,400}?max-width: 860px/s.test(overrides),
      "宽面板要给正文一条居中的阅读栏 ✓（现在容器宽度 == 编辑器宽度 ✓）",
    );
  });

  it("**表格布局**：本体保持 display:table，横向滚动交给外层容器 ✓", () => {
    const overrides = readFileSync(path.join(CLIENT, "editor-overrides.css"), "utf8");
    assert.ok(
      /\.kn-editor-rich \.milkdown table \{[^}]*display: table/s.test(overrides),
      "table 本体必须保持原生 display: table ✗（改成 block 会破坏列宽计算 ✓）",
    );
    assert.ok(
      /table-wrapper \{[^}]*overflow-x: auto/s.test(overrides),
      "横向滚动要落在 Crepe 的 .table-wrapper 上 ✓（实测它就是表格外层 ✓）",
    );
    assert.ok(!/\.kn-editor-rich \.milkdown table \{[^}]*overflow-x/s.test(overrides), "table 本体自己不该横滚 ✓");
    /*
     * **默认占满阅读栏宽度** ✓（用户第三次实测：列少时也要「占满编辑界面的宽度」✓）：
     * 原来是 `width: auto`（shrink-to-fit ✓）⇒ 三列表格缩在中间一小块 ✗（截图 ✓）；
     * 现在 `width: 100%` + `table-layout: auto` ✓ ⇒ 列按内容比例分掉整条阅读栏 ✓。
     * 溢出仍然安全 ✓：列内容（`min-width: 6em` ✓）撑不下时实际宽度超过容器 ✓，
     * 此时 auto 外边距按 0 处理 ⇒ 从左边开始、由 `.table-wrapper` 横滚 ✓。
     */
    assert.ok(
      /\.kn-editor-rich \.milkdown table \{[^}]*width: 100%/s.test(overrides),
      "表格默认要占满编辑区宽度 ✓（不许再 shrink-to-fit ✗）",
    );
    assert.ok(
      !/\.kn-editor-rich \.milkdown table \{[^}]*width: auto/s.test(overrides),
      "不许退回 `width: auto` ✗（那就是「列少时缩在中间」的成因 ✓）",
    );
    /*
     * **横向居中** ✓（用户第二次实测：表格原来贴着阅读栏左边缘 ✗，要求"优先居中显示"✓）：
     * 用 `margin-inline: auto` 而不是给外层加 flex 居中 ✓ ——
     * 撑不下时 auto 外边距按 0 处理 ✓ ⇒ 仍从左开始、由 `.table-wrapper` 横滚 ✓
     * （flex `justify-content: center` 会把溢出内容的左边那截滚不到 ✗）。
     */
    assert.ok(
      /\.kn-editor-rich \.milkdown table \{[^}]*margin-inline: auto/s.test(overrides),
      "短表格要在阅读栏里居中 ✓",
    );
    assert.ok(
      !/table-wrapper \{[^}]*justify-content/s.test(overrides),
      "别用 flex 居中表格 ✗（溢出时左边会滚不到 ✓）",
    );
    assert.ok(/padding: 8px 12px/.test(overrides), "单元格内边距按设计建议 8/12 ✓");
    assert.ok(/min-width: 6em/.test(overrides), "列最小宽度要按字体算（em ✓），不是固定小像素 ✗");
    assert.ok(/font-size: 15px/.test(overrides), "正文 15px ✓（窄侧栏不靠缩字号解决布局 ✗）");
  });

  it("**公式块 UI**：不露语言下拉、标签中文、普通代码块的语言菜单收敛 ✓", () => {
    const rich = readFileSync(path.join(CLIENT, "MarkdownRichEditor.tsx"), "utf8");
    const overrides = readFileSync(path.join(CLIENT, "editor-overrides.css"), "utf8");
    const state = readFileSync(path.join(CLIENT, "node-document-state.ts"), "utf8");
    /* 文案走**官方配置项** ✓（不靠 CSS 假装替换文字 ✗） */
    assert.ok(rich.includes("featureConfigs"), "要用 Crepe 的 featureConfigs ✓");
    assert.ok(rich.includes('previewLabel: "结果"'), "「PREVIEW」→「结果」✓");
    assert.ok(rich.includes("searchPlaceholder"), "语言搜索占位符要本地化 ✓");
    assert.ok(rich.includes('inlineEditConfirm: "完成"'), "行内公式确认按钮 ✓");
    /* 公式块按**实测到的稳定标识**识别 ✓ */
    assert.ok(
      overrides.includes('.cm-content[data-language="stex" i]'),
      "按 CodeMirror 的 stex 语言 id 识别公式块 ✓（实测标记 ✓）",
    );
    assert.ok(
      overrides.includes(":has(.preview .katex-display)"),
      "并且以「预览里有 KaTeX」为准 ✓（更可靠 ✓）",
    );
    assert.ok(
      /:is\(:has\(\.cm-content\[data-language="stex" i\]\), :has\(\.preview \.katex-display\)\)\s*\.language-picker/s.test(overrides),
      "只在公式块里隐藏语言选择器 ✗（真代码块要保留 ✓）",
    );
    assert.ok(overrides.includes("max-height: 7.5em"), "公式源码最多约 6 行 ✓");
    /*
     * **结果面板要回到正文字号** ✓（用户实测：公式挤成一小团 ✗）：
     * Crepe 的公式块扩自代码块 ⇒ 预览区继承 0.875em（≈13px ✗）⇒ 显示数学比正文小一圈 ✓。
     */
    assert.ok(
      /:has\(\.preview \.katex-display\)\)\s*\n?\s*\.preview \{[^}]*font-size: 15px/s.test(overrides),
      "公式结果面板要用正文字号 ✓（别继承代码块的 0.875em ✗）",
    );
    /*
     * **`\\` 换行必须给出行距** ✓（用户实测："两行公式重叠了" ✗）：
     * KaTeX 只给 `.katex .katex-html > .newline { display: block }` ✓ —— 高度 0 ✗，
     * 第二行就紧贴第一行的分母 ✓。我们显式补一条高度 ✓，而且**只在 display 公式里** ✓
     * （行内公式 `$…$` 没有 `.katex-display` 父级 ⇒ 不受影响 ✓）。
     */
    assert.ok(
      /\.katex-display \.katex-html > \.newline \{[^}]*height: 1em/s.test(overrides),
      "display 公式的换行要有行距 ✓（否则两行会贴在一起 ✗）",
    );
    assert.ok(
      !/\.newline \{[^}]*height: 0(?:px|em|;)/s.test(overrides),
      "不许把换行高度设成 0 ✗",
    );
    /* 普通代码块的语言菜单要收敛 ✓（截图里的 410px 列表 ✗） */
    assert.ok(/list-wrapper \{[^}]*max-height: 260px/s.test(overrides), "菜单高度上限 260px ✓");
    assert.ok(/list-wrapper \{[^}]*width: 220px/s.test(overrides), "菜单宽度 220px ✓");
    assert.ok(overrides.includes("background: var(--dsw-alias-bg-overlay)"), "菜单不透明 ✓（不穿透 ✓）");
    /* ```latex 围栏的语义保护 ✓（会被渲染成公式 ✗） */
    assert.ok(state.includes("LaTeX 围栏代码"), "```latex 要提示语义差异 ✓");
  });

  it("**代码/公式统一外观**：CodeMirror 主题成套接入、默认关行号、公式常规态只有结果 ✓", () => {
    const rich = readFileSync(path.join(CLIENT, "MarkdownRichEditor.tsx"), "utf8");
    const overrides = readFileSync(path.join(CLIENT, "editor-overrides.css"), "utf8");
    /* 主题走 CodeMirror 扩展 ✓（文档：不能只消除一个黑矩形 ✗） */
    assert.ok(rich.includes('from "@codemirror/view"'), "要接入 CodeMirror 主题扩展 ✓");
    for (const part of [".cm-scroller", ".cm-content", ".cm-gutters", ".cm-activeLine", ".cm-selectionBackground", ".cm-cursor"]) {
      assert.ok(rich.includes(part), `主题要覆盖 ${part} ✓（成套，不是只改一处 ✗）`);
    }
    assert.ok(/\.cm-gutters":\s*\{\s*display:\s*"none"/.test(rich), "默认关闭行号 ✓（深色行号块 ✗）");
    assert.ok(rich.includes("theme: KN_CODE_THEME"), "主题要真的交给 Crepe ✓");
    /* 按钮文案键：Crepe 用的是 previewToggleText ✓（只配 previewToggleButton 会留英文 "Hide" ✗） */
    assert.ok(rich.includes("previewToggleText"), "同时配置 previewToggleText ✓（实测英文 Hide 就是这个键 ✓）");
    /* 语言名常态可见 ✓（截图里左上角曾是空的 ✗） */
    assert.ok(/\.language-button \{[^}]*opacity: 0\.85/s.test(overrides), "语言名常态可见 ✓");
    /* 公式块：常规态不挂工具条 ✓、结果标签只在聚焦时出现 ✓ */
    assert.ok(
      /height: 20px;[\s\S]{0,200}?opacity: 0;/s.test(overrides),
      "公式工具条常规态隐藏 ✓（悬停/聚焦才出现 ✓）",
    );
    assert.ok(/preview-label \{\s*visibility: hidden;/s.test(overrides), "「结果」标签常规态不常驻 ✓");
    /* 结果区不纵向滚动 ✓（短分数不该有纵向滚动条 ✗） */
    assert.ok(
      /:has\(\.preview \.katex-display\)\)\s*\.preview \{[^}]*overflow-y: hidden/s.test(overrides),
      "结果区不纵向滚动 ✓（长公式只在结果外层横滚 ✓）",
    );
  });

  it("**密度**：顶部一行 + 底部一行；纵向滚动只由正文视口负责 ✓", () => {
    const editor = readFileSync(path.join(CLIENT, "NodeDocumentEditor.tsx"), "utf8");
    const panel = readFileSync(path.join(CLIENT, "panel.css"), "utf8");
    const overrides = readFileSync(path.join(CLIENT, "editor-overrides.css"), "utf8");
    /* 顶部：标题（含未保存标记）+ 模式切换 + 关闭，都在同一行 ✓；底栏与「⋯ 详情」已撤掉 ✗ */
    assert.ok(editor.includes('className="kn-editor-heading"'), "头部是紧凑标题栏 ✓");
    assert.ok(editor.includes('className="kn-editor-dirty"'), "未保存标记在标题右上角 ✓");
    for (const gone of ["kn-editor-more", "kn-editor-details", "kn-editor-foot", "kn-editor-save"]) {
      assert.ok(!editor.includes(gone), `${gone} 已撤掉 ⇒ 不许长回来 ✗`);
    }
    assert.ok(!editor.includes("kn-editor-tag"), "常驻「节点笔记」徽标要撤掉 ✗（占高度 ✓）");
    /* 纵向滚动：只有 .kn-editor-body ✓；富容器不再自己滚 ✓ */
    assert.ok(
      /\.kn-editor-body \{[^}]*overflow-y: auto/s.test(panel),
      "正文视口负责纵向滚动 ✓",
    );
    assert.ok(
      !/\.kn-editor-rich \{[^}]*overflow: auto/s.test(panel)
        && !/\.kn-editor-rich \{[^}]*min-height: 220px/s.test(panel),
      "富容器不该再有 min-height:220px + overflow:auto ✗（会叠出第二条滚动条 ✓）",
    );
    assert.ok(
      /\.kn-editor-rich \.milkdown \{[^}]*height: auto/s.test(panel),
      "Crepe 容器自然撑高（height:auto ✓），不是 height:100% ✗",
    );
    /* 细滚动条：只作用于插件内的滚动容器 ✓ */
    assert.ok(overrides.includes("scrollbar-width: thin"), "细滚动条 ✓");
    assert.ok(overrides.includes("::-webkit-scrollbar-thumb"), "滑块样式 ✓");
    assert.ok(overrides.includes("width: 8px"), "初始视觉宽度 8px ✓（文档建议 6–8px ✓）");
    assert.ok(overrides.includes("::-webkit-scrollbar-button"), "箭头不占位 ✓");
    assert.ok(
      !/::-webkit-scrollbar[^{]*\{[^}]*opacity: 0/s.test(overrides),
      "不许把**滚动条**永久隐藏 ✗（用户要能发现超宽内容 ✓；工具条的悬停淡出不算 ✓）",
    );
  });

  it("**覆盖样式必须最后拼接**：写在 panel.css 里会被后到的 Crepe CSS 压住 ✗", () => {
    const build = readFileSync(path.join(ROOT, "build.mjs"), "utf8");
    assert.ok(build.includes("editorOverridesCss"), "build.mjs 要读这份覆盖样式 ✓");
    const line = build.split("\n").find((row) => row.includes("const css = ") && row.includes("panelCss"));
    assert.ok(line !== undefined, "要能读到拼接那一行 ✓");
    /* 用 indexOf 比较先后，避免正则里塞 ${} 与 \n（写错一次就白排查 ✗） */
    const order = ["panelCss", "graphCss", "editorCss", "editorOverridesCss"].map((name) => line.indexOf(name));
    assert.ok(order.every((at) => at >= 0), `四个部分都要出现在拼接行里 ✓：${line.trim()}`);
    assert.deepEqual(order, [...order].sort((a, b) => a - b), `顺序必须是 panel → graph → 第三方 → 覆盖 ✓：${line.trim()}`);
  });

  it("注入的样式里不许有**未展开的 @import**（浏览器会当 URL 请求 ⇒ 整条样式链失效 ✗）", () => {
    const build = readFileSync(path.join(ROOT, "build.mjs"), "utf8");
    assert.ok(build.includes("const inlineImports"), "build.mjs 要递归展开 @import ✓");
    assert.ok(build.includes("未展开的 @import"), "展开后还要**校验没有残留** ✗");
    assert.ok(
      build.includes("样式 @import 解析不到"),
      "解析不到要**构建失败** ✗（静默跳过会让表格/公式没样式 ✗）",
    );
    /* 真实症状：Crepe 的 table.css 第一行就是 @import，展开前表格没有任何基础样式 ✓ */
    const tableCss = readFileSync(
      path.join(ROOT, "node_modules/@milkdown/crepe/lib/theme/common/table.css"),
      "utf8",
    );
    assert.ok(tableCss.includes("@import"), "这条守卫针对的正是这种文件 ✓");
  });
});
