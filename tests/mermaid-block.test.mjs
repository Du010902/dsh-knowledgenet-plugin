/**
 * **Mermaid 图块的纯逻辑**测试（`design/mermaid-note-blocks.md` ✓）。
 *
 * 这里只测 `src/client/mermaid-block.ts` ✓ —— 它不 import mermaid、不碰 DOM ✓
 * ⇒ 可以在 Node 里直接跑 ✓。真正调 `mermaid.render()` 的那条路要靠浏览器测试 ✓
 * （`tests/mermaid-note.browser.mjs` ✓）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MERMAID_ACTION_ATTR,
  MERMAID_BACKGROUND_ATTR,
  MERMAID_LANGUAGE,
  MERMAID_PREVIEW_CLASS,
  MERMAID_SOURCE_ATTR,
  MERMAID_SOURCE_LIMIT,
  createBoundedCache,
  decodeMermaidSource,
  encodeMermaidSource,
  isMermaidLanguage,
  mermaidDownloadName,
  mermaidErrorMessage,
  mermaidErrorHtml,
  mermaidPreviewHtml,
  mermaidTheme,
  sanitizeMermaidSource,
} from "../src/client/mermaid-block.ts";

const LABELS = { copy: "复制为代码", download: "下载图像", failed: "Mermaid 图渲染失败" };
const FLOW = "graph TD;\n  A[卫星无线电信号] --> B[天线]\n  B --> C[射频前端: 放大、滤波、下变频]\n  C --> D[ADC: 模拟信号转数字采样]";

describe("认出 Mermaid 围栏", () => {
  it("语言名大小写不敏感，也接受 mmd 别名", () => {
    for (const language of ["mermaid", "Mermaid", "MERMAID", " mmd ", "MMD"]) {
      assert.equal(isMermaidLanguage(language), true, `${language} 应当被认成 mermaid ✓`);
    }
    assert.equal(MERMAID_LANGUAGE, "mermaid");
  });

  it("别的语言 / 空值一律不是 Mermaid", () => {
    for (const language of ["", "python", "latex", "mermaidx", "javascript"]) {
      assert.equal(isMermaidLanguage(language), false, `${language} 不该被认成 mermaid ✗`);
    }
    assert.equal(isMermaidLanguage(null), false);
    assert.equal(isMermaidLanguage(undefined), false);
    assert.equal(isMermaidLanguage(42), false);
  });
});

describe("源码编解码（放进 data-* 属性再取回来）", () => {
  it("引号 / 换行 / & / 箭头 / 中文都能原样往返", () => {
    const source = 'graph LR; A["带 \\"引号\\" 的标签"] --> B{判断 & 分支}\r\nB -->|是| C';
    const encoded = encodeMermaidSource(source);
    assert.equal(encoded.includes("\n"), false, "编码后不能有换行（否则属性会断）");
    assert.equal(encoded.includes('"'), false, "编码后不能有引号（否则属性会断）");
    assert.equal(decodeMermaidSource(encoded), source.replace(/\r\n/g, "\r\n"));
  });

  it("坏数据一律当空串（不抛异常）", () => {
    assert.equal(decodeMermaidSource("%E4%BD"), "");
    assert.equal(decodeMermaidSource(""), "");
    assert.equal(decodeMermaidSource(undefined), "");
    assert.equal(decodeMermaidSource(null), "");
  });

  it("超大源码不编码（不给复制 / 下载留一个撑爆属性的隐患）", () => {
    assert.equal(MERMAID_SOURCE_LIMIT > 0, true);
    assert.equal(encodeMermaidSource("a".repeat(MERMAID_SOURCE_LIMIT + 1)), "");
    assert.notEqual(encodeMermaidSource("a".repeat(16)), "");
  });
});

describe("主题 token ⇒ mermaid themeVariables", () => {
  it("宿主 token 被规范化成 mermaid 认得的 rgb()（不是原样透传）", () => {
    const theme = mermaidTheme({
      text: "#111827",
      mutedText: "#6b7280",
      background: "#ffffff",
      surface: "#f9fafb",
      border: "#d1d5db",
      brand: "#2563eb",
      fontFamily: "system-ui, sans-serif",
    });
    assert.equal(theme.themeVariables.primaryTextColor, "rgb(17, 24, 39)");
    assert.equal(theme.themeVariables.primaryColor, "rgb(249, 250, 251)");
    assert.equal(theme.themeVariables.primaryBorderColor, "rgb(209, 213, 219)");
    assert.equal(theme.themeVariables.lineColor, "rgb(107, 114, 128)");
    assert.equal(theme.themeVariables.background, "rgb(255, 255, 255)");
    assert.equal(theme.themeVariables.fontFamily, "system-ui, sans-serif");
    assert.equal(theme.background, "rgb(255, 255, 255)", "下载底色跟着主题走 ✓");
    assert.equal(theme.fontFamily, "system-ui, sans-serif");
  });

  it("没给 token 时有确定性的浅色默认值（不是随机 / undefined）", () => {
    const theme = mermaidTheme();
    assert.match(theme.background, /^rgb\(\d+, \d+, \d+\)$/);
    assert.match(theme.themeVariables.primaryTextColor, /^rgb\(\d+, \d+, \d+\)$/);
    assert.ok(theme.fontFamily.length > 0);
    assert.equal(theme.themeVariables.fontSize, "14px");
    /* 两次调用结果一致 ✓（纯函数 ✓） */
    assert.deepEqual(theme, mermaidTheme());
  });

  it("现代颜色语法（color-mix / oklch / color(srgb …)）解析不了时退回兜底色，绝不原样透传", () => {
    const theme = mermaidTheme({
      text: "color-mix(in srgb, #111827 80%, white)",
      mutedText: "oklch(0.5 0.1 200)",
      background: "color(srgb 0.1 0.2 0.3)",
      surface: "rgb(249, 250, 251)",
      border: "#d1d5db",
      brand: "#2563eb",
    });
    /* 解析不了的字段用兜底色 ✓（图必须能渲染出来 ✗ 不能整张失败 ✗） */
    assert.equal(theme.themeVariables.primaryTextColor, mermaidTheme().themeVariables.primaryTextColor);
    assert.equal(theme.themeVariables.lineColor, mermaidTheme().themeVariables.lineColor);
    assert.equal(theme.themeVariables.background, mermaidTheme().themeVariables.background);
    /* 解析得了的照常 ✓ */
    assert.equal(theme.themeVariables.primaryColor, "rgb(249, 250, 251)");
  });

  it("品牌色只以**派生色**参与（不把节点底色直接染成品牌色）", () => {
    const theme = mermaidTheme({ brand: "#ff0000", surface: "#ffffff", text: "#000000", background: "#ffffff" });
    assert.equal(theme.themeVariables.primaryColor, "rgb(255, 255, 255)", "节点底色仍是面板色 ✓");
    assert.equal(theme.themeVariables.secondaryBorderColor, "rgb(255, 0, 0)");
  });

  it("所有主题变量都是 mermaid 认得的颜色 / 简单值（不许出现 color-mix 之类 ✗）", () => {
    const theme = mermaidTheme({ brand: "#3b82f6", surface: "#f6f8fa", background: "#ffffff", text: "#1f2328" });
    for (const [key, value] of Object.entries(theme.themeVariables)) {
      assert.equal(/color-mix|oklch|light-dark/i.test(value), false, `${key} 的值 mermaid 可能解析不了：${value}`);
    }
    /* 派生色是 JS 混出来的具体 rgb ✓（不是原样把品牌色塞进去 ✓） */
    assert.match(theme.themeVariables.secondaryColor, /^rgb\(\d+,\s*\d+,\s*\d+\)$/);
    assert.match(theme.themeVariables.pie2, /^rgb\(\d+,\s*\d+,\s*\d+\)$/);
    /* 混色解析不了时退回 A 色，不抛错 ✓ */
    /* 解析不了的颜色要回落到兜底色（而不是原样透传 ✗） */
    assert.match(
      mermaidTheme({ brand: "not-a-color", surface: "#fff" }).themeVariables.secondaryColor,
      /^rgb\(\d+, \d+, \d+\)$/,
    );
  });
});

describe("预览 HTML", () => {
  it("含预览根、两个动作按钮、源码属性与内联 SVG", () => {
    const html = mermaidPreviewHtml({ svg: "<svg><text>卫星</text></svg>", source: FLOW, labels: LABELS, background: "#ffffff" });
    assert.ok(html.includes(`class="${MERMAID_PREVIEW_CLASS}"`), "根节点 class 要对 ✓");
    assert.ok(html.includes(MERMAID_ACTION_ATTR), "动作用 data 属性标出来（事件委托靠它 ✓）");
    assert.ok(html.includes('data-kn-mermaid-action="copy"'));
    assert.ok(html.includes('data-kn-mermaid-action="download"'));
    assert.ok(html.includes("<svg><text>卫星</text></svg>"), "SVG 原样进预览 ✓");
    assert.ok(html.includes("复制为代码") && html.includes("下载图像"));
    /* 源码要能取回来 ✓ */
    const sourceAttr = new RegExp(`${MERMAID_SOURCE_ATTR}="([^"]*)"`).exec(html);
    assert.notEqual(sourceAttr, null, "源码属性必须在 ✓");
    assert.equal(decodeMermaidSource(sourceAttr?.[1]), FLOW);
    /* 渲染时的主题底色也要带上 ✓（下载 PNG 的底色不能等下载时再猜 ✗） */
    const backgroundAttr = new RegExp(`${MERMAID_BACKGROUND_ATTR}="([^"]*)"`).exec(html);
    assert.notEqual(backgroundAttr, null, "主题底色属性必须在 ✓");
    assert.equal(decodeMermaidSource(backgroundAttr?.[1]), "#ffffff");
  });

  it("源码没编码成功（超长 / 坏数据）时不写空属性", () => {
    const html = mermaidPreviewHtml({ svg: "<svg/>", source: "a".repeat(MERMAID_SOURCE_LIMIT + 1), labels: LABELS, background: "#ffffff" });
    assert.equal(html.includes(MERMAID_SOURCE_ATTR), false, "超长源码不写属性（宁可不给复制 ✓）");
  });

  it("文案要被转义（词典里的文字也按不可信处理）", () => {
    const html = mermaidPreviewHtml({
      svg: "<svg/>",
      source: "graph TD; A-->B",
      labels: { copy: "<b>复制</b>", download: "a&b", failed: "\"x\"" },
      background: "#ffffff",
    });
    assert.equal(html.includes("<b>复制</b>"), false, "标签必须被转义 ✓");
    assert.ok(html.includes("&lt;b&gt;复制&lt;/b&gt;"));
    assert.ok(html.includes("a&amp;b"));
  });
});

describe("渲染失败面板", () => {
  it("原因原样显示但必须转义", () => {
    const html = mermaidErrorHtml({ message: 'Parse error <script>alert(1)</script> "x"', labels: LABELS });
    assert.ok(html.includes(MERMAID_PREVIEW_CLASS));
    assert.equal(html.includes("<script>"), false, "错误文本里的标签不许原样进来 ✗");
    assert.ok(html.includes("&lt;script&gt;"));
    assert.ok(html.includes(LABELS.failed));
  });

  it("错误原因只取第一行、超长截断", () => {
    assert.equal(mermaidErrorMessage(new Error("第一行\n第二行")), "第一行");
    assert.equal(mermaidErrorMessage("纯字符串"), "纯字符串");
    assert.equal(mermaidErrorMessage({ weird: true }), "[object Object]");
    assert.equal(mermaidErrorMessage(new Error("   ")), "unknown error");
    const long = "x".repeat(1000);
    const message = mermaidErrorMessage(new Error(long));
    assert.ok(message.length <= 241, "超长原因要截断 ✓");
    assert.ok(message.endsWith("…"));
  });
});

describe("下载文件名", () => {
  it("固定时间戳格式、带日期时间", () => {
    assert.equal(mermaidDownloadName(new Date(2026, 9, 19, 21, 15, 0)), "mermaid-diagram-20261019-211500");
    assert.equal(mermaidDownloadName(new Date(2026, 0, 2, 3, 4, 5)), "mermaid-diagram-20260102-030405");
  });
});


describe("init 指令收窄（外部资源 / HTML 标签）", () => {
  it("themeCSS / htmlLabels 被替换成无害值，其它 init 配置保留", () => {
    const source = "%%{init: {'theme': 'dark', 'themeCSS': 'body{background:url(https://example.invalid/x)}', 'htmlLabels': true}}%%\ngraph TD; A-->B";
    const sanitized = sanitizeMermaidSource(source);
    assert.equal(sanitized.includes("example.invalid"), false, "themeCSS 里的外部 url 必须被清掉 ✗");
    assert.match(sanitized, /['"]?themeCSS['"]?\s*:\s*' '/, "保留键、换成无害值（避免 init 语法坏掉 ✓）");
    assert.match(sanitized, /['"]?htmlLabels['"]?\s*:\s*false/, "强制不是 HTML 标签 ✓");
    assert.ok(sanitized.includes("'theme': 'dark'"), "其它 init 配置保留 ✓");
    assert.ok(sanitized.includes("graph TD; A-->B"), "正文源码原样保留 ✓");
  });

  it("没有 init 指令时原样返回", () => {
    const source = "graph TD; A-->B";
    assert.equal(sanitizeMermaidSource(source), source);
  });

  it("YAML frontmatter 整段去掉（否则 config.themeCSS 能绕过清洗 ✗）", () => {
    const source = [
      "---",
      "config:",
      "  themeCSS: '.node rect{fill:url(https://evil.invalid/p.svg#p)}'",
      "  htmlLabels: true",
      "---",
      "graph TD; A[甲] --> B[乙]",
    ].join("\n");
    const sanitized = sanitizeMermaidSource(source);
    assert.equal(sanitized.includes("evil.invalid"), false, "frontmatter 里的外部 url 必须被清掉 ✗");
    assert.equal(sanitized.includes("---"), false, "frontmatter 整段去掉 ✓");
    assert.equal(sanitized.includes("htmlLabels"), false);
    assert.ok(sanitized.includes("graph TD; A[甲] --> B[乙]"), "图本身的源码保留 ✓");
  });

  it("引号形式的布尔 htmlLabels 也要收窄", () => {
    const source = '%%{init: {"htmlLabels": "true", "theme": "dark"}}%%\ngraph TD; A-->B';
    const sanitized = sanitizeMermaidSource(source);
    assert.match(sanitized, /"htmlLabels":\s*false/, "带引号的 true 一样要换掉 ✗");
    assert.ok(sanitized.includes('"theme": "dark"'), "别的 init 配置保留 ✓");
  });
});

describe("有上限的 LRU 缓存", () => {
  it("命中会挪到最近使用；条目数上限会淘汰最久未用", () => {
    const cache = createBoundedCache(3, 1000, 100);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    assert.equal(cache.size, 3);
    assert.equal(cache.get("a"), "1");
    cache.set("d", "4");
    assert.equal(cache.get("b"), undefined, "最久未用的要被淘汰 ✓");
    assert.equal(cache.get("a"), "1");
    assert.equal(cache.get("d"), "4");
    assert.equal(cache.size, 3);
  });

  it("总字符上限：写入条目时会连续淘汰", () => {
    const cache = createBoundedCache(10, 10, 100);
    cache.set("a", "12345");
    cache.set("b", "12345");
    assert.equal(cache.chars, 10);
    cache.set("c", "12345");
    assert.ok(cache.chars <= 10, `总字符超上限：${cache.chars}`);
    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.get("c"), "12345");
  });

  it("单条超过上限不缓存；同键覆盖不重复记账", () => {
    const cache = createBoundedCache(4, 100, 10);
    cache.set("big", "x".repeat(11));
    assert.equal(cache.get("big"), undefined);
    cache.set("k", "1234567890");
    cache.set("k", "12345");
    assert.equal(cache.size, 1);
    assert.equal(cache.chars, 5, "覆盖要减掉旧值长度 ✓");
    assert.equal(cache.get("k"), "12345");
    cache.clear();
    assert.equal(cache.size, 0);
    assert.equal(cache.chars, 0);
  });
});
