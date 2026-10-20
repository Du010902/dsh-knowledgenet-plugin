/**
 * **Mermaid 图块**的纯逻辑（`design/mermaid-note-blocks.md` ✓）。
 *
 * 笔记里的 Mermaid 就是一段普通围栏代码块 ✓：
 *
 * ```mermaid
 * graph TD; A[卫星无线电信号] --> B[天线]
 * ```
 *
 * 它**必须继续以围栏代码块的形式存进 .md** ✗ —— 渲染出来的 SVG **绝不落地** ✗
 * （和公式块同一个原则：文件里只留源码 ✓，渲染是编辑器的事 ✓）。
 * 于是这里只放"不碰 DOM、不 import mermaid"的纯函数 ✓ ⇒ 可以直接离线单测 ✓：
 * 1. 认出 mermaid 围栏（语言大小写 / 别名 ✓）；
 * 2. 把源码塞进预览 HTML 的 `data-*` 属性（编码 / 解码 ✓，绝不拼进文本节点 ✗）；
 * 3. 把主题 token 映射成 mermaid 的 `themeVariables` ✓（浅色 / 深色跟着宿主走 ✓）；
 * 4. 预览 / 错误面板的 HTML 片段 ✓。
 *
 * 真正调用 `mermaid.render()` 的地方只有 `mermaid-renderer.ts` ✓。
 */
import { escapeHtml } from "./code-block-clipboard.ts";

/** mermaid 围栏的语言名 ✓（Markdown 里写 ```mermaid ✓） */
export const MERMAID_LANGUAGE = "mermaid";

/** 预览面板根节点的 class ✓（CSS 与点击委托都靠它认 ✓） */
export const MERMAID_PREVIEW_CLASS = "kn-mermaid";

/**
 * 预览面板上那两颗按钮的动作属性 ✓。
 * 为什么用 `data-*` + **事件委托** ✗：Crepe 的预览面板每渲染一次都会
 * `innerHTML = sanitize(...)` 整块换掉 ✓ ⇒ 直接挂 `addEventListener` 的按钮
 * 会在下一次重渲染时连同监听一起消失 ✗；挂在编辑器根上按属性认才稳定 ✓。
 */
export const MERMAID_ACTION_ATTR = "data-kn-mermaid-action";

/** 预览根节点上那份**编码后**的源码 ✓（复制 / 下载都从这里取 ✓） */
export const MERMAID_SOURCE_ATTR = "data-kn-mermaid-source";

/**
 * 预览根节点上记的**渲染时主题底色** ✓（下载 PNG 时铺的底色 ✓）。
 *
 * 为什么要记下来 ✗：用户可能渲染后切了主题 ✓，`download()` 若现读新主题就会把
 * 「旧主题的图 + 新主题的底色」拼在一起 ✗（深色图配浅色底 ⇒ 浅色字看不见 ✗）。
 */
export const MERMAID_BACKGROUND_ATTR = "data-kn-mermaid-bg";

/** 预览 HTML 里源码属性的长度上限 ✓（防止异常大的围栏把属性撑爆 ✗；超了就不给复制 / 下载 ✗） */
export const MERMAID_SOURCE_LIMIT = 256 * 1024;

/** 预览面板上的两个动作 ✓ */
export type MermaidAction = "copy" | "download";

/** 预览面板要用的文案（由调用方从插件词典取 ✓，绝不硬编码中文 ✗） */
export interface MermaidLabels {
  /** 「复制为代码」✓ */
  copy: string;
  /** 「下载图像」✓ */
  download: string;
  /** 「Mermaid 图渲染失败」✓ */
  failed: string;
  /** 运行时脚本加载失败（宿主路由不可用）✓ —— 提示要具体到"重启 DSH / 重装插件" ✗ */
  runtimeUnavailable: string;
}

/** 当前编辑器主题里与图配色有关的 token ✓（由调用方从 computed style 现读 ✓） */
export interface MermaidThemeInput {
  /** 正文前景 ✓ */
  text?: string;
  /** 次要文字 ✓ */
  mutedText?: string;
  /** 页面底色 ✓ */
  background?: string;
  /** 面板 / 卡片底色 ✓ */
  surface?: string;
  /** 边框 ✓ */
  border?: string;
  /** 品牌强调色 ✓ */
  brand?: string;
  /** 正文字体（中文回退要跟正文一致 ✓） */
  fontFamily?: string;
  /** 正文字号 ✓ */
  fontSize?: string;
}

/** 交给 mermaid 初始化的一组值 ✓ */
export interface MermaidTheme {
  /** `theme: "base"` 时覆盖的变量 ✓ */
  themeVariables: Record<string, string>;
  /** 字体（同时写进 themeVariables ✓；有些图直接读顶层配置 ✓） */
  fontFamily: string;
  /** 下载 PNG 时铺的底色 ✓（透明底在浅色文档里会把深色主题的浅色文字吞掉 ✗） */
  background: string;
}

/** 浅色默认值（宿主 token 读不到时的兜底 ✓，与 README 里的主题色一致 ✓） */
const FALLBACK: Required<MermaidThemeInput> = {
  text: "#1f2328",
  mutedText: "#656d76",
  background: "#ffffff",
  surface: "#f6f8fa",
  border: "#d0d7de",
  brand: "#3b82f6",
  fontFamily: "system-ui, -apple-system, \"Segoe UI\", \"Microsoft YaHei\", sans-serif",
  fontSize: "14px",
};

/**
 * 解析一个 CSS 颜色 ✓（`#rgb` / `#rrggbb` / `rgb()` / `rgba()` / `hsl()`）。
 *
 * 为什么范围要这么窄 ✗：这是"喂给 mermaid 之前"的最后一道关 ✓ ——
 * mermaid 的配色解析器（khroma）只认这几种 legacy 语法 ✓
 * （keyword / hex / rgb(a) / hsl(a)）✗，别的写法会让**整张图渲染失败** ✗。
 * @param value - CSS 颜色字符串 ✓。
 * @returns 分量 + alpha（0–1）；解析不了 ⇒ `null` ✓。
 */
function parseColor(value: string): { r: number; g: number; b: number; a: number } | null {
  const text = value.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
  if (short !== null) {
    return {
      r: Number.parseInt(short[1] + short[1], 16),
      g: Number.parseInt(short[2] + short[2], 16),
      b: Number.parseInt(short[3] + short[3], 16),
      a: 1,
    };
  }
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/.exec(text);
  if (long !== null) {
    return {
      r: Number.parseInt(long[1], 16),
      g: Number.parseInt(long[2], 16),
      b: Number.parseInt(long[3], 16),
      a: long[4] === undefined ? 1 : Number.parseInt(long[4], 16) / 255,
    };
  }
  const rgb = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})(?:\s*[,/]\s*([\d.]+))?\s*\)$/.exec(text);
  if (rgb !== null) {
    const channel = (raw: string): number => Math.max(0, Math.min(255, Number.parseInt(raw, 10)));
    const alpha = rgb[4] === undefined ? 1 : Math.max(0, Math.min(1, Number.parseFloat(rgb[4])));
    return { r: channel(rgb[1]), g: channel(rgb[2]), b: channel(rgb[3]), a: Number.isFinite(alpha) ? alpha : 1 };
  }
  const hsl = /^hsla?\(\s*([\d.]+)(?:deg)?\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%(?:\s*[,/]\s*([\d.]+))?\s*\)$/.exec(text);
  if (hsl !== null) {
    const hue = ((Number.parseFloat(hsl[1]) % 360) + 360) % 360;
    const saturation = Math.max(0, Math.min(100, Number.parseFloat(hsl[2]))) / 100;
    const lightness = Math.max(0, Math.min(100, Number.parseFloat(hsl[3]))) / 100;
    const alpha = hsl[4] === undefined ? 1 : Math.max(0, Math.min(1, Number.parseFloat(hsl[4])));
    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const segment = hue / 60;
    const x = chroma * (1 - Math.abs((segment % 2) - 1));
    const offset = lightness - chroma / 2;
    const [r, g, b] = segment < 1 ? [chroma, x, 0]
      : segment < 2 ? [x, chroma, 0]
        : segment < 3 ? [0, chroma, x]
          : segment < 4 ? [0, x, chroma]
            : segment < 5 ? [x, 0, chroma]
              : [chroma, 0, x];
    return {
      r: Math.round((r + offset) * 255),
      g: Math.round((g + offset) * 255),
      b: Math.round((b + offset) * 255),
      a: Number.isFinite(alpha) ? alpha : 1,
    };
  }
  return null;
}

/** 把分量拼回 mermaid 认得的 CSS 颜色 ✓（alpha < 1 时用 `rgba()` ✓） */
function colorString(parts: { r: number; g: number; b: number; a: number }): string {
  const clamp = (value: number, max: number): number => Math.max(0, Math.min(max, Math.round(value)));
  if (parts.a >= 0.999) return `rgb(${clamp(parts.r, 255)}, ${clamp(parts.g, 255)}, ${clamp(parts.b, 255)})`;
  return `rgba(${clamp(parts.r, 255)}, ${clamp(parts.g, 255)}, ${clamp(parts.b, 255)}, ${Math.round(parts.a * 1000) / 1000})`;
}

/**
 * 把传入的颜色**规范化成 mermaid 一定认得的 `rgb()` / `rgba()`** ✓。
 *
 * 为什么不能原样透传 ✗：
 * - 宿主 token 可能是 `color-mix(...)` / `oklch(...)` 之类现代颜色语法 ✓ ——
 *   浏览器能显示，但 mermaid 的配色解析器（khroma）只认 keyword / hex / rgb(a) / hsl(a) ✓
 *   ⇒ 原样透传会让**整张图渲染失败** ✗（实测 `Unsupported color format` ✗）；
 * - 探针元素对 `color-mix` 解析出来的是 `color(srgb …)` ✓（仍然不是 legacy 语法 ✗）。
 * ⇒ 这里统一解析成 legacy 语法 ✓；**解析不了就用兜底色** ✓
 * （宁可配色朴素一点，也不能让图出不来 ✗）；alpha 保留 ✓（边框 token 常带透明度 ✓）。
 * @param value - 原始颜色字符串 ✓。
 * @param fallback - 兜底色 ✓。
 * @returns `rgb(...)` / `rgba(...)` 形式的颜色 ✓。
 */
function canonicalColor(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim() ?? "";
  const fallbackColor = parseColor(fallback) ?? { r: 31, g: 35, b: 40, a: 1 };
  if (trimmed === "") return colorString(fallbackColor);
  const parsed = parseColor(trimmed);
  if (parsed === null) return colorString(fallbackColor);
  return colorString(parsed);
}

/**
 * 两色线性混合 ✓（`weightA` = A 的占比 ✓）。
 *
 * 为什么要在 JS 里混 ✗：mermaid 的主题变量解析器（khroma）**不认 `color-mix()`** ✓
 * （实测直接抛 `Unsupported color format` ✗）⇒ 主题变量里只能放 mermaid 认识的 CSS 颜色 ✓。
 * @param a - A 色（CSS 颜色 ✓）。
 * @param b - B 色 ✓。
 * @param weightA - A 的占比（0–1 ✓）。
 * @returns 混合后的 `rgb(...)` ✓；**任一个解析不了就退回 A** ✓（`a` 已由调用方规范化 ✓）。
 */
function mixColor(a: string, b: string, weightA: number): string {
  const first = parseColor(a);
  const second = parseColor(b);
  if (first === null || second === null) return a;
  const ratio = Math.max(0, Math.min(1, weightA));
  const mix = (left: number, right: number): number => left * ratio + right * (1 - ratio);
  return colorString({
    r: mix(first.r, second.r),
    g: mix(first.g, second.g),
    b: mix(first.b, second.b),
    a: mix(first.a, second.a),
  });
}
/**
 * 这段围栏是不是 Mermaid ✓。
 *
 * 大小写不敏感 ✓（Markdown 里 ` ```Mermaid` 也常见 ✓），
 * 也接受 `mmd` 这个常见别名 ✓；空串 / 别的语言一律 `false` ✓。
 *
 * @param language - 代码块的语言标识（可能为空 ✓）。
 * @returns 是 mermaid ⇒ `true` ✓。
 */
export function isMermaidLanguage(language: unknown): boolean {
  if (typeof language !== "string") return false;
  const normalized = language.trim().toLowerCase();
  return normalized === MERMAID_LANGUAGE || normalized === "mmd";
}

/**
 * 把源码编码成能安全放进 HTML 属性的形式 ✓。
 *
 * 为什么不是直接 `escapeHtml` ✗：源码里的换行 / 引号 / `&` 都会让属性值变脆 ✓，
 * 而 `encodeURIComponent` 的输出**全是 ASCII** ✓ ⇒ 放进双引号属性里没有任何转义问题 ✓；
 * 再由 DOMPurify 清洗一遍也不会改动它 ✓。
 *
 * @param source - Mermaid 源码 ✓。
 * @returns 编码后的属性值 ✓。
 */
export function encodeMermaidSource(source: string): string {
  if (source.length > MERMAID_SOURCE_LIMIT) return "";
  try {
    return encodeURIComponent(source);
  } catch {
    return "";
  }
}

/**
 * 解码 `data-kn-mermaid-source` ✓（坏数据一律当空串 ✓，不抛异常 ✗）。
 * @param value - 属性值 ✓。
 * @returns 原始源码 ✓。
 */
export function decodeMermaidSource(value: unknown): string {
  if (typeof value !== "string" || value === "") return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

/**
 * 主题 token ⇒ mermaid 的 `themeVariables` ✓（**纯函数** ✓，方便单测 ✓）。
 *
 * 用 `theme: "base"` + 显式变量 ✗（不用 `default` / `dark` 那两套固定配色 ✓）：
 * 插件的编辑器颜色走宿主的 `--dsw-alias-*` token ✓，浅色 / 深色由宿主决定 ✓
 * ⇒ 图也必须跟着 token 走 ✓，不能自己另起一套配色 ✗。
 *
 * @param input - 从 computed style 读到的颜色 ✓。
 * @returns 初始化参数里要用的那组值 ✓。
 */
export function mermaidTheme(input: MermaidThemeInput = {}): MermaidTheme {
  /* **全部规范化成 rgb()** ✓：mermaid 只认 legacy 颜色语法，现代颜色语法会让整张图渲染失败 ✗ */
  const text = canonicalColor(input.text, FALLBACK.text);
  const mutedText = canonicalColor(input.mutedText, FALLBACK.mutedText);
  const background = canonicalColor(input.background, FALLBACK.background);
  const surface = canonicalColor(input.surface, FALLBACK.surface);
  const border = canonicalColor(input.border, FALLBACK.border);
  const brand = canonicalColor(input.brand, FALLBACK.brand);
  const fontFamily = input.fontFamily?.trim() || FALLBACK.fontFamily;
  const fontSize = input.fontSize?.trim() || FALLBACK.fontSize;
  return {
    fontFamily,
    background,
    themeVariables: {
      background,
      fontFamily,
      fontSize,
      /* 主色：节点底色用面板色 ✓，描边用边框色 ✓，文字用正文色 ✓ */
      primaryColor: surface,
      primaryTextColor: text,
      primaryBorderColor: border,
      /* 次色 / 强调色：**从品牌色派生** ✓（不引入第二套色板 ✗；用 JS 混色，mermaid 不认 color-mix ✗） */
      secondaryColor: mixColor(brand, surface, 0.14),
      secondaryTextColor: text,
      secondaryBorderColor: brand,
      tertiaryColor: background,
      tertiaryTextColor: text,
      tertiaryBorderColor: border,
      /* 连线 / 文本 / 注释 ✓ */
      lineColor: mutedText,
      textColor: text,
      nodeTextColor: text,
      mainBkg: surface,
      nodeBorder: border,
      clusterBkg: background,
      clusterBorder: border,
      titleColor: text,
      edgeLabelBackground: background,
      /* 时序图 / 状态图 / 类图共用的底色与描边 ✓ */
      actorBkg: surface,
      actorBorder: border,
      actorTextColor: text,
      signalColor: text,
      signalTextColor: text,
      labelBoxBkgColor: surface,
      labelBoxBorderColor: border,
      labelTextColor: text,
      loopTextColor: text,
      noteBkgColor: surface,
      noteTextColor: text,
      noteBorderColor: border,
      /* 饼图 / 甘特图等会读的几项 ✓ */
      pie1: brand,
      pie2: mixColor(brand, background, 0.65),
      pie3: mutedText,
      pie4: border,
      pieTitleTextSize: "14px",
      pieSectionTextSize: "12px",
    },
  };
}

/**
 * 生成预览面板的 HTML ✓（交给 Crepe 的预览面板 `innerHTML` ✓，会被 DOMPurify 清洗 ✓）。
 *
 * 结构（`design/mermaid-note-blocks.md` ✓）：
 *
 * ```html
 * <div class="kn-mermaid" data-kn-mermaid-source="…编码后的源码…">
 *   <div class="kn-mermaid-actions">
 *     <button data-kn-mermaid-action="copy">复制为代码</button>
 *     <button data-kn-mermaid-action="download">下载图像</button>
 *   </div>
 *   <div class="kn-mermaid-canvas"><svg …></svg></div>
 * </div>
 * ```
 *
 * @param input.svg - mermaid 渲染出的 SVG 字符串 ✓。
 * @param input.source - 原始源码 ✓（复制 / 下载用 ✓）。
 * @param input.labels - 本地化文案 ✓。
 * @param input.background - 渲染时的主题底色 ✓（下载 PNG 铺底 ✓）。
 * @returns 预览 HTML ✓。
 */
export function mermaidPreviewHtml(input: {
  svg: string;
  source: string;
  labels: MermaidLabels;
  background: string;
}): string {
  const source = encodeMermaidSource(input.source);
  const sourceAttr = source === "" ? "" : ` ${MERMAID_SOURCE_ATTR}="${source}"`;
  const backgroundAttr = ` ${MERMAID_BACKGROUND_ATTR}="${encodeURIComponent(input.background)}"`;
  return `<div class="${MERMAID_PREVIEW_CLASS}"${sourceAttr}${backgroundAttr}>`
    + `<div class="${MERMAID_PREVIEW_CLASS}-actions">`
    + `<button type="button" class="${MERMAID_PREVIEW_CLASS}-action" ${MERMAID_ACTION_ATTR}="copy">${escapeHtml(input.labels.copy)}</button>`
    + `<button type="button" class="${MERMAID_PREVIEW_CLASS}-action" ${MERMAID_ACTION_ATTR}="download">${escapeHtml(input.labels.download)}</button>`
    + "</div>"
    + `<div class="${MERMAID_PREVIEW_CLASS}-canvas">${input.svg}</div>`
    + "</div>";
}

/**
 * 生成渲染失败的提示 HTML ✓（源码保持原样、仍然可编辑 ✓；不替换成空白 ✗）。
 * @param input.message - mermaid 抛出的原因 ✓（**必须转义** ✗）。
 * @param input.labels - 本地化文案 ✓。
 * @returns 错误面板 HTML ✓。
 */
export function mermaidErrorHtml(input: { message: string; labels: MermaidLabels }): string {
  return `<div class="${MERMAID_PREVIEW_CLASS} ${MERMAID_PREVIEW_CLASS}-error">`
    + `<div class="${MERMAID_PREVIEW_CLASS}-error-title">${escapeHtml(input.labels.failed)}</div>`
    + `<pre class="${MERMAID_PREVIEW_CLASS}-error-detail">${escapeHtml(input.message)}</pre>`
    + "</div>";
}

/**
 * 渲染前对 mermaid 源码做**最小安全处理** ✓。
 *
 * 威胁模型：笔记正文可能来自粘贴 / 导入（不完全可信 ✓）。mermaid 有两条改配置的路：
 * 1. `%%{init: …}%%` 指令 ✓ —— 实测 `securityLevel` / `theme` 这类 secure key 改不动 ✓，
 *    但 `themeCSS` 能往 SVG `<style>` 里写任意 CSS（含 `url(https://…)` 外部请求 ✗）、
 *    `htmlLabels` 能让图重新带 `<foreignObject>`（PNG 会退回 SVG ✓，但没必要 ✗）；
 * 2. **YAML frontmatter 的 `config:`** ✗ —— 它由 mermaid 的 `processFrontmatter` 直接并进配置 ✓，
 *    而它自己的清洗只挡 secure key ✓ ⇒ `themeCSS` / `htmlLabels` 从 frontmatter 走**完全绕过** ✗
 *    （实测能真的发出外部请求 ✗）。笔记里的图几乎不用 frontmatter ✓ ⇒ **整段去掉**最稳 ✓。
 * ⇒ init 指令里把这两个键的值替换成无害值 ✓（其余 init 配置保留 ✓，用户想改曲线 / 布局照旧 ✓）。
 *
 * 注意：这不是 XSS 防线 ✓（那由 DOMPurify 负责 ✓）；这里只收窄"外部资源 / HTML 标签"面 ✓。
 * @param source - mermaid 源码 ✓。
 * @returns 处理后的源码 ✓（没命中就原样返回 ✓）。
 */
export function sanitizeMermaidSource(source: string): string {
  let result = source;
  /* 1) YAML frontmatter 整段去掉（`--- … ---` 只在源码最前面才算 frontmatter ✓） */
  const frontmatter = /^\s*---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/.exec(result);
  if (frontmatter !== null) result = result.slice(frontmatter[0].length);
  if (!result.includes("%%{")) return result;
  /* 2) init 指令里只换**值** ✓：键可以带引号（`'themeCSS': …`）✓，换完 init 语法仍然成立 ✓ */
  return result
    .replace(/(['"]?themeCSS['"]?\s*:\s*)(['"])(?:\\.|(?!\2)[^\\])*\2/gi, "$1' '")
    .replace(/(['"]?htmlLabels['"]?\s*:\s*)(?:true|false|"true"|"false"|'true'|'false')/gi, "$1false");
}

/**
 * 下载文件名（不含扩展名 ✓）。
 *
 * 不从图里猜标题 ✓（猜错只会产生奇怪的文件名 ✓）；固定名字 + 时间戳 ✓，
 * 连续下载两张不会互相覆盖 ✓。
 *
 * @param now - 时间戳（单测可传固定值 ✓）。
 * @returns 例如 `mermaid-diagram-20261019-211500` ✓。
 */
export function mermaidDownloadName(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `mermaid-diagram-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * 从任意异常里取一条**短**原因 ✓（弹给用户看的一行字 ✓，不把整段堆栈塞进去 ✗）。
 * @param error - 捕获到的异常 ✓。
 * @returns 一行原因 ✓。
 */
export function mermaidErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine = raw.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (firstLine === "") return "unknown error";
  return firstLine.length > 240 ? `${firstLine.slice(0, 240)}…` : firstLine;
}

/** 有上限的 LRU 缓存接口 ✓（纯逻辑，便于单测 ✓） */
export interface BoundedCache {
  /** 取一条；命中会把该条挪到"最近使用" ✓ */
  get(key: string): string | undefined;
  /** 写一条；超上限时淘汰最久未用的 ✓ */
  set(key: string, value: string): void;
  /** 当前条目数 ✓ */
  readonly size: number;
  /** 当前总字符数 ✓ */
  readonly chars: number;
  /** 清空 ✓ */
  clear(): void;
}

/**
 * 建一个**有双重上限的 LRU 缓存** ✓（Mermaid 渲染结果用 ✓）。
 *
 * - `maxEntries` / `maxChars` 两个上限谁先到就淘汰谁 ✓；
 * - **单条超过 `maxItemChars` 不缓存** ✗（一张特别大的图不该把整个预算吃掉 ✓）；
 * - Map 的插入顺序当 LRU 队列 ✓（命中时删了再塞回末尾 ✓）。
 *
 * 为什么抽成纯函数 ✗：淘汰 / 记账 / 超大图跳过这些行为值得单测 ✓，
 * 而真正用它的渲染器碰 DOM、只能在浏览器里测 ✓。
 * @param maxEntries - 条目数上限 ✓。
 * @param maxChars - 总字符数上限 ✓。
 * @param maxItemChars - 单条字符数上限 ✓。
 * @returns 缓存对象 ✓。
 */
export function createBoundedCache(maxEntries: number, maxChars: number, maxItemChars: number): BoundedCache {
  const entries = new Map<string, string>();
  let totalChars = 0;
  return {
    get(key) {
      const hit = entries.get(key);
      if (hit === undefined) return undefined;
      entries.delete(key);
      entries.set(key, hit);
      return hit;
    },
    set(key, value) {
      if (value.length > maxItemChars) return;
      const previous = entries.get(key);
      if (previous !== undefined) {
        totalChars -= previous.length;
        entries.delete(key);
      }
      entries.set(key, value);
      totalChars += value.length;
      while (entries.size > maxEntries || totalChars > maxChars) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        totalChars -= entries.get(oldest)?.length ?? 0;
        entries.delete(oldest);
      }
    },
    get size() {
      return entries.size;
    },
    get chars() {
      return totalChars;
    },
    clear() {
      entries.clear();
      totalChars = 0;
    },
  };
}
