/**
 * **Mermaid 图块接入**的静态守卫（`design/mermaid-note-blocks.md` ✓）。
 *
 * 这些断言不看"某个 CSS 选择器写了没有"这种表面东西 ✗，而是钉住几条**掉一次就出事**的接线：
 * 1. 编辑器确实把 `renderPreview` / 语言列表接上了 ✓（否则图永远不出现 / 用户选不到 mermaid ✗）；
 * 2. 输入保护在 ✓（正在编辑时不给预览占位 ⇒ 源码不会被隐藏、焦点不会被抢 ✗）；
 * 3. 动作按钮走事件委托 ✓（Crepe 每次重渲染都会换掉预览的 HTML ✗）；
 * 4. 构建产物里没有 `require("util")` 这类非基线请求 ✓（mermaid 的 lodash 副本会带进来 ✗）。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, "..");
const read = (relative) => readFile(path.join(PLUGIN, relative), "utf8");

const editorSource = await read("src/client/MarkdownRichEditor.tsx");
const rendererSource = await read("src/client/mermaid-renderer.ts");
const blockSource = await read("src/client/mermaid-block.ts");
const css = await read("src/client/editor-overrides.css");
const dictSource = await read("src/client/index.ts");
const tableDictSource = await read("src/client/table-menu.ts");
const buildSource = await read("build.mjs");
const clientSource = await read("client.js");
const manifest = JSON.parse(await read("package.json"));

describe("编辑器接线", () => {
  it("code-mirror 特性带上 renderPreview 与 mermaid 语言项", () => {
    assert.ok(editorSource.includes("renderPreview: mermaid.renderPreview"), "预览回调要接上 ✓");
    assert.ok(editorSource.includes("languages: CODE_BLOCK_LANGUAGES"), "语言列表要接上 ✓");
    assert.ok(editorSource.includes('name: "mermaid"'), "语言列表里要有 mermaid ✓");
    assert.ok(editorSource.includes('extensions: ["mermaid", "mmd"]'));
  });

  it("渲染器在 new Crepe 之前创建、在清理时 dispose", () => {
    const createAt = editorSource.indexOf("const mermaid = createMermaidRenderer({");
    const crepeAt = editorSource.indexOf("const crepe = new Crepe({");
    assert.ok(createAt > 0 && crepeAt > createAt, "渲染器要先于 Crepe 构造 ✓（配置里要用 ✓）");
    assert.ok(editorSource.includes("mermaid.dispose()"), "卸载时要丢掉在飞的渲染 ✓");
  });

  it("预览里的两个动作走编辑器根上的**事件委托**", () => {
    assert.ok(editorSource.includes('root.addEventListener("click", onMermaidAction, true)'));
    assert.ok(editorSource.includes('root.removeEventListener("click", onMermaidAction, true)'));
    assert.ok(editorSource.includes("[${MERMAID_ACTION_ATTR}]"), "按属性认按钮 ✓（重渲染不丢 ✓）");
    assert.ok(editorSource.includes("writeCodeBlockClipboard({ language: \"mermaid\", code: source })"),
      "复制走与代码块同一套多格式剪贴板 ✓");
    assert.ok(editorSource.includes("mermaid.download(mermaidSvgOf(preview), source, background)"), "下载要带上渲染时的主题底色 ✓");
  });
});

describe("输入保护（浏览器实测过的那条致命 UX）", () => {
  it("正在编辑这一块时返回 null，而不是先塞「渲染中…」占位", () => {
    assert.ok(rendererSource.includes("isEditingContent"), "要能判断「用户正编辑哪一块」✓");
    assert.ok(rendererSource.includes('active.closest(".cm-content")'), "焦点判据是 CodeMirror 的 .cm-content ✓");
    assert.ok(rendererSource.includes("live = { content: source, applyPreview }"), "编辑中只记最后一份源码 ✓");
    assert.ok(rendererSource.includes('addEventListener("focusout", onFocusOut, true)'), "焦点离开再渲染 ✓");
    assert.ok(rendererSource.includes("if (isEditingContent(source))"), "编辑中必须返回 null（占位也会隐藏源码 ✗）");
    assert.ok(rendererSource.includes("renderLive"), "失焦后要把最后一份源码渲染出来 ✓");
  });

  it("每个请求**各自防抖**（多张图不能互相取消 ✗，实测踩过）", () => {
    assert.match(rendererSource, /RENDER_DEBOUNCE_MS = \d+/);
    assert.ok(rendererSource.includes("timers.add(timer)"), "每个请求自己的计时器 ✓");
    assert.equal(rendererSource.includes("clearTimer()"), false, "不要再有共享计时器（会取消上一张图 ✗）");
    assert.ok(rendererSource.includes("clearTimeout(timer)"), "dispose 时要清掉所有计时器 ✓");
  });

  it("内容改成别的语言 / 被删掉后，旧的渲染结果不许回填", () => {
    assert.ok(editorSource.includes("blocks: () =>"), "编辑器要把「文档里的代码块清单」交给渲染器 ✓");
    assert.ok(editorSource.includes("view.state.doc.descendants"), "清单要从 ProseMirror 状态取（DOM 里的 CodeMirror 会拆掉 ✗）✓");
    assert.ok(rendererSource.includes("hasMermaidBlockFor"), "回填前要确认那一块还是 mermaid ✓");
    assert.ok(rendererSource.includes("if (!hasMermaidBlockFor(content)) return;"), "不是 mermaid 了 ⇒ 渲染结果直接丢 ✓");
    assert.ok(rendererSource.includes("if (!hasMermaidBlockFor(item.content)) return;"), "攒下的结果回填前也要再确认一次 ✓");
  });

  it("焦点在任何 mermaid 块的源码里时一律先攒着（旧结果回填会抢焦点 ✗）", () => {
    assert.ok(rendererSource.includes("focusedMermaidBlock"), "要按「焦点是不是在 mermaid 块里」判断 ✓");
    assert.ok(rendererSource.includes("if (isEditingContent(content) || focusedMermaidBlock())"));
    assert.ok(rendererSource.includes("pendingDeliveries"), "攒结果要用列表（多图同时渲染不能互相清掉 ✗）");
    assert.ok(rendererSource.includes("PENDING_LIMIT"), "列表要有上限 ✓");
    assert.equal(rendererSource.includes("latestLanguage"), false, "旧的 content→language 表已被文档清单校验取代 ✓");
  });
});

describe("预览 HTML 与样式", () => {
  it("构建期注入的 CSS 里有 Mermaid 图块的排版", () => {
    for (const needle of [".kn-mermaid", ".kn-mermaid-actions", ".kn-mermaid-canvas", ".kn-mermaid-error"]) {
      assert.ok(css.includes(needle), `editor-overrides.css 缺少 ${needle}`);
    }
    assert.ok(css.includes(":has(.kn-mermaid)"), "样式只定向到 Mermaid 预览 ✓（不碰公式块 ✗）");
  });

  it("预览根节点 / 动作属性用常量统一（源码与 CSS 不会各写一份）", () => {
    assert.ok(blockSource.includes('export const MERMAID_PREVIEW_CLASS = "kn-mermaid"'));
    assert.ok(blockSource.includes('export const MERMAID_ACTION_ATTR = "data-kn-mermaid-action"'));
    assert.ok(blockSource.includes('export const MERMAID_SOURCE_ATTR = "data-kn-mermaid-source"'));
  });

  it("中文 / 英文词典都有这些文案（英文界面不落回中文 ✗）", () => {
    const keys = [
      "mermaidCopyCode", "mermaidDownloadImage", "mermaidRenderFailed",
      "mermaidActionFailed", "mermaidDownloadFailed", "mermaidCopyTooLarge", "mermaidRuntimeUnavailable",
    ];
    for (const dict of [dictSource, tableDictSource]) {
      for (const key of keys) assert.ok(dict.includes(`${key}:`), `词典缺少 ${key}`);
    }
    assert.ok(dictSource.includes("mermaidCopyCode: \"Copy as code\""), "DICT_EN 里要有英文 ✓");
    assert.ok(dictSource.includes("mermaidRenderFailed: \"Mermaid diagram failed to render\""));
    assert.ok(dictSource.includes("mermaidDownloadFailed: \"Download failed\""));
    assert.ok(dictSource.includes("mermaidCopyTooLarge: \"Source too large to copy\""));
    assert.ok(dictSource.includes("mermaidRuntimeUnavailable: \"Mermaid runtime failed to load"));
  });
});

describe("构建与产物", () => {
  it("mermaid 是**构建期内联**的 devDependency（不是运行时依赖）", () => {
    assert.equal(manifest.dependencies?.["mermaid"], undefined, "运行时依赖必须为空 ✓");
    assert.match(manifest.devDependencies?.mermaid ?? "", /^11\./);
    assert.match(manifest.devDependencies?.["@codemirror/language-data"] ?? "", /^6\./);
  });

  it("构建期清掉了 lodash 的 `require(\"util\")` 探测（客户端只许请求基线模块）", () => {
    assert.ok(buildSource.includes("browserUtilProbePatchPlugin"), "补丁插件还在 ✓");
    assert.ok(buildSource.includes('require("util")'), "补丁要认识这个形状 ✓");
    assert.equal(clientSource.includes('require("util")'), false, "产物里不许残留 require(\"util\") ✗");
  });

  it("产物接线正确：client.js 只剩预览接线，mermaid 在独立运行时里", async () => {
    assert.ok(clientSource.length > 0);
    for (const needle of ["kn-mermaid", "mermaid-diagram-", "mermaid-render"]) {
      assert.ok(clientSource.includes(needle), `client.js 里应当有 ${needle}（预览接线 ✓）`);
    }
    assert.equal(clientSource.includes("init_mermaid_core"), false, "client.js 里不该再有 mermaid 本体 ✗");
    const runtime = await readFile(path.join(PLUGIN, "client.mermaid.js"), "utf8");
    assert.ok(runtime.includes("__KN_MERMAID__"), "独立运行时必须导出 __KN_MERMAID__ ✓");
    assert.ok(clientSource.includes("@local/dsh-knowledgenet"));
  });

  it("渲染器用的是 theme:\"base\" + 显式变量、根级关掉 htmlLabels", () => {
    assert.ok(rendererSource.includes('theme: "base"'));
    assert.ok(rendererSource.includes("themeVariables: theme.themeVariables"));
    assert.ok(rendererSource.includes("htmlLabels: false"), "根级 htmlLabels ✓（v11 里 flowchart.htmlLabels 已弃用 ✗）");
    assert.equal(rendererSource.includes("flowchart: { htmlLabels"), false, "不要再写 flowchart.htmlLabels ✗");
  });

  it("mermaid 运行时按需加载（同源 <script src>，不再内联进 client.js）", () => {
    assert.ok(rendererSource.includes("loadRuntimeScript"), "用脚本加载运行时 ✓");
    assert.ok(rendererSource.includes("MERMAID_RUNTIME_ROUTE"), "路由常量来自 shared/routes ✓");
    /* 注释里可能提到这句 ⇒ 先去掉注释再断言 ✓ */
    const rendererCode = rendererSource
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");
    assert.equal(/import\("mermaid"\)/.test(rendererCode), false, "不许再 import(\"mermaid\")（会内联进 client.js ✗）");
    assert.ok(rendererSource.includes("__KN_MERMAID_RUNTIME_REV__"), "URL 要带构建期内容 hash（immutable 缓存）✓");
    assert.ok(rendererSource.includes("mermaidLoading = null"), "加载失败不缓存（下次还能重试）✓");
  });

  it("下载优先 PNG，失败退回补了底色的 SVG，并返回成功/失败给 UI", () => {
    assert.ok(rendererSource.includes('"image/png"'), "先试 PNG ✓");
    assert.ok(rendererSource.includes('"image/svg+xml;charset=utf-8"'), "失败退回 SVG ✓");
    assert.ok(rendererSource.includes("normalizedSvgClone"), "导出前要规范化（width/height/xmlns/去 max-width）✓");
    assert.ok(rendererSource.includes("fillRect"), "PNG 要铺主题底色 ✓");
    assert.ok(rendererSource.includes("return { ok: false, format: null }"), "两条路都失败要如实返回 ✗（不能静默）");
    assert.ok(rendererSource.includes("return { ok: true, format:"), "成功也要把格式返回 ✓");
  });

  it("渲染结果缓存：键含主题、LRU 有上限、只缓存成功结果", () => {
    assert.ok(rendererSource.includes("renderCache"), "要有缓存 ✓");
    assert.ok(rendererSource.includes("createBoundedCache(24"), "用有上限的 LRU（条目/字符双上限）✓");
    assert.ok(rendererSource.includes("renderCacheKey(theme"), "键里要带主题签名（换主题不能复用旧图 ✗）");
    assert.ok(rendererSource.includes('report("mermaid-render-cache"'), "缓存命中要留诊断 ✓");
    assert.ok(rendererSource.includes("renderCache.set(key, result.svg)"), "只缓存成功渲染出的 SVG ✓");
    /* 命中时**不应该**再加载 mermaid（首次求值要 ~550ms）✓ */
    const cacheAt = rendererSource.indexOf("renderCache.get(key)");
    const loadAt = rendererSource.indexOf("const mermaid = await loadMermaid()");
    assert.ok(cacheAt > 0 && loadAt > cacheAt, "先查缓存、再 await loadMermaid() ✓");
  });

  it("UI 失败反馈与并发保护接线", () => {
    assert.ok(editorSource.includes("flashActionFailure"), "失败要换成文字提示（不能静默 ✗）");
    assert.ok(editorSource.includes('tRef.current("mermaidCopyTooLarge")'), "超长源码复制要提示 ✓");
    assert.ok(editorSource.includes('tRef.current("mermaidDownloadFailed")'), "下载失败要提示 ✓");
    assert.ok(editorSource.includes('button.dataset.knBusy === "true"'), "下载连点只发一次 ✓");
    assert.ok(editorSource.includes('button.setAttribute("aria-busy", "true")'), "忙碌状态要可感知 ✓");
  });

  it("隐藏的动作按钮不吃点击（透明 ≠ 可点）", () => {
    assert.ok(css.includes("pointer-events: none;"), "常态按钮不能参与命中测试 ✓");
    assert.match(css, /:hover \.kn-mermaid-actions[\s\S]{0,200}pointer-events: auto/, "悬停要恢复可点 ✓");
    assert.ok(css.includes("@media (hover: none)"), "触屏设备要常驻显示按钮（否则永远点不到 ✗）");
  });
});
