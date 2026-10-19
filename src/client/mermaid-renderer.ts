/**
 * **Mermaid 图块渲染器** ✓（整个插件里**唯一** import `mermaid` 的地方 ✓）。
 *
 * 为什么单独一个文件 ✗：`mermaid` 是一大坨浏览器依赖 ✓（它自己要 DOM、要 `document` ✓），
 * 本仓库的离线单测跑在 Node 里 ✓ ⇒ 纯逻辑放 `mermaid-block.ts` ✓，
 * 这里只做"拿 DOM + 调库 + 防抖 + 丢弃过期结果" ✓。
 *
 * 与 Crepe 的接口约定（`@milkdown/components` 的 code-block 预览面板 ✓）：
 * `renderPreview(language, content, applyPreview)` 返回
 * - `null` ⇒ 没有预览（源码照旧 ✓）；
 * - `undefined` ⇒ **异步** ⇒ 渲染完再调 `applyPreview(html)` ✓（面板先显示 `previewLoading` ✓）。
 *
 * 几条容易踩的坑，都在这里收口 ✓：
 * 1. **每敲一个字都会调 `renderPreview`** ✗（预览面板的 watch 盯的是 text/language ✓）
 *    ⇒ 编辑中的那一块只记"最后一份源码" ✓（失焦再渲染 ✓），
 *    并且**每个请求各自防抖** ✓（一个笔记有多张图时不能互相取消 ✗，实测踩过 ✗）；
 * 2. **正在输入的那一块不能被预览顶掉** ✗（真实浏览器实测 ✓，见 `design/mermaid-note-blocks.md`）：
 *    面板的 `previewOnlyByDefault: true` 会在"异步预览回填"时给源码区加 `.hidden` ✓，
 *    于是用户敲下第一个字符、图渲染出来的一瞬间源码被 `display:none`、焦点掉到 body、
 *    后面输入的字符全丢 ✗。⇒ 这里在**用户正编辑这一块**时返回 `null`（不出预览 ⇒ 源码不被隐藏 ✓），
 *    只把渲染结果先攒着 ✓，等焦点离开这块（`focusout`）再回填 ✓；
 * 3. mermaid 的 `render()` 是**异步**的、且共享全局配置 ✗（`initialize` 是全局的 ✓）
 *    ⇒ 这里自己串行化 ✓ + 每次渲染前按当前主题重新 `initialize` ✓；
 * 4. 编辑器卸载 / 切节点后仍可能有渲染在飞 ✓ ⇒ `dispose()` 后代次失配的结果一律丢弃 ✗
 *    （绝不对已销毁的组件调 `applyPreview` ✓）；
 * 5. **下载优先 PNG，失败退回 SVG** ✓：根级 `htmlLabels: false` 之后图里没有 `<foreignObject>` ✓
 *    （实测 ✓）⇒ canvas 不会被判跨源污染 ✓；但某些图类型仍可能带 HTML 标签 / 老浏览器不给画 ✗
 *    ⇒ 失败就退回 `.svg`（也补主题底色 ✓），不让"下载"变成一个死按钮 ✓。
 */
import type { Mermaid } from "mermaid";

import {
  MERMAID_PREVIEW_CLASS,
  isMermaidLanguage,
  mermaidDownloadName,
  mermaidErrorMessage,
  mermaidErrorHtml,
  mermaidPreviewHtml,
  mermaidTheme,
  sanitizeMermaidSource,
  type MermaidLabels,
} from "./mermaid-block.ts";

/** 渲染前等多久（毫秒 ✓）：连续敲字时只渲染最后一次 ✓ */
const RENDER_DEBOUNCE_MS = 180;

/**
 * `mermaid` 用**动态 import** 加载 ✓（构建期仍然内联进同一个 client.js ✓）。
 *
 * 为什么不用顶层静态 import ✗：mermaid 是 6.5 MB 未压缩的大库 ✓，实测**模块求值要 550ms 左右** ✓
 * —— 插件客户端半是每个页面启动都要加载的 ✓ ⇒ 静态 import 等于所有会话启动都白付这笔钱 ✗。
 * 动态 import 被 `codeSplitting: false` 内联进同一文件后只是**推迟求值** ✓
 * （用户第一次真的遇到 Mermaid 图时再付 ✓），文件解析成本照付但小得多 ✓。
 */
let mermaidModule: Promise<Mermaid> | null = null;

/**
 * 取（并缓存）mermaid 实例 ✓。
 * @returns mermaid 默认导出 ✓。
 */
function loadMermaid(): Promise<Mermaid> {
  if (mermaidModule === null) {
    mermaidModule = import("mermaid").then((module) => module.default).catch((error: unknown) => {
      /* 加载失败不要缓存 rejected promise ✗：本页后续再遇到图还能重试一次 ✓ */
      mermaidModule = null;
      throw error;
    });
  }
  return mermaidModule;
}

/** 创建渲染器需要的上下文 ✓ */
export interface MermaidRendererOptions {
  /** 编辑器根节点 ✓（读主题 token、监听焦点用 ✓） */
  root: HTMLElement;
  /**
   * 本地化文案的**现取函数** ✓：宿主切语言时面板会整体重渲染 ✓，
   * 但编辑器实例不一定重建 ✓ ⇒ 这里每次渲染都现取 ✓（不缓存一份旧语言的文案 ✗）。
   */
  labels: () => MermaidLabels;
  /**
   * 当前文档里的**代码块清单** ✓（语言 + 源码 ✓）。
   *
   * 为什么需要它 ✗：渲染是异步的 ✓，等结果回来时那一块可能已经被改成别的语言了 ✗
   * （典型：mermaid → LaTeX 时 latex 特性直接接管、**不经过**我们的 `renderPreview` ✗
   * ⇒ 我们收不到"语言改了"的通知 ✓）。
   * 回填前用这份清单确认"文档里确实还有一个 mermaid 块用的是这段源码" ✓，
   * 否则丢弃结果 —— 绝不要把 mermaid 图回填到公式块 / 普通代码块上 ✗。
   */
  blocks: () => Array<{ language: string; text: string }>;
  /** 诊断上报（可选 ✓） */
  report?: ((step: string, detail?: unknown) => void) | undefined;
}

/** 渲染器对外的口子 ✓ */
export interface MermaidRenderer {
  /**
   * Crepe 的预览回调 ✓。
   * @param language - 代码块语言 ✓。
   * @param content - 代码块源码 ✓。
   * @param applyPreview - 异步渲染完成后回填预览（`null` = 收起预览 ✓）。
   * @returns `null` = 不是 mermaid / 空块 / 正在输入（都先不给预览 ✓）；`undefined` = 异步渲染中 ✓。
   */
  renderPreview: (
    language: string,
    content: string,
    applyPreview: (value: string | null) => void,
  ) => null | undefined;
  /**
   * 「下载图像」✓：优先 PNG（铺**渲染时**的主题底色 ✓），失败退回 `.svg`。
   * @param svg - 预览面板里**当前这份** SVG ✓。
   * @param source - 源码（只用于文件名 / 诊断 ✓）。
   * @param background - 渲染时记下的主题底色 ✓（不传就现读当前主题 ✓）。
   * @returns 完成（失败也不抛 ✓，由调用方给用户提示 ✓）。
   */
  download: (svg: SVGSVGElement | null, source: string, background?: string) => Promise<void>;
  /** 卸载时调用 ✓：丢掉在飞的渲染结果 ✓ */
  dispose: () => void;
}

/** mermaid 自己给的实例 id 前缀 ✓（页面里唯一即可 ✓） */
let renderSequence = 0;

/**
 * 读一个颜色 token 并**解析成真实颜色** ✓。
 *
 * 为什么不能直接用 `getPropertyValue` 的字符串 ✗：自定义属性的 computed value 只做了
 * `var()` 展开 ✓ —— 宿主 token 完全可能是 `color-mix(...)` / `oklch(...)` 之类 ✗，
 * 而 mermaid 的配色解析器只认它认识的 CSS 颜色 ✓（实测遇到 `color-mix` 直接抛
 * `Unsupported color format` ✗）。
 * 办法：把 token 当成 `background-color` 赋给一个**零尺寸探针元素** ✓，浏览器会把它算成 `rgb()` ✓。
 * @param root - 编辑器根节点（token 从这里继承 ✓）。
 * @param name - token 名 ✓。
 * @returns 解析后的颜色；拿不到 / 解析失败 ⇒ `""` ✓（交给 `mermaidTheme` 的兜底 ✓）。
 */
function readColorToken(root: HTMLElement, name: string): string {
  const documentRef = root.ownerDocument;
  const style = typeof getComputedStyle === "function" ? getComputedStyle(root) : null;
  const raw = style?.getPropertyValue(name).trim() ?? "";
  if (raw === "" || documentRef === null) return raw;
  const probe = documentRef.createElement("span");
  probe.style.cssText = "position:absolute;left:-9999px;top:0;width:0;height:0;visibility:hidden;pointer-events:none";
  probe.style.backgroundColor = `var(${name})`;
  root.appendChild(probe);
  try {
    const resolved = getComputedStyle(probe).backgroundColor.trim();
    /* 解析失败时浏览器给的是透明色 ⇒ 这时退回原始字符串 ✓ */
    if (resolved === "" || resolved === "rgba(0, 0, 0, 0)" || resolved === "transparent") return raw;
    /*
     * **再用 1×1 canvas 采样一次** ✓：Chrome 对 `color-mix()` 之类现代颜色语法，
     * computed 值会保留成 `color(srgb …)` / `oklch(…)` ✗（mermaid 的 khroma 不认 ✗）。
     * canvas 2D 会把它真正换算成像素 ✓ ⇒ 读回 `rgba(r, g, b, a)` ✓。
     */
    const canvas = documentRef.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (context === null) return resolved;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = resolved;
    context.fillRect(0, 0, 1, 1);
    const pixel = context.getImageData(0, 0, 1, 1).data;
    const [r, g, b, a] = [pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0, pixel[3] ?? 0];
    if (a === 0) return resolved;
    return a >= 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 1000) / 1000})`;
  } finally {
    probe.remove();
  }
}

/**
 * 从编辑器根节点上现读主题 token ✓。
 *
 * 为什么现读 ✗：插件不缓存宿主的主题 ✓ —— 浅色 / 深色切换后，下一次渲染自然跟着换 ✓。
 * @param root - 编辑器根节点 ✓。
 * @returns 一组候选颜色 + 字体 ✓。
 */
function readTheme(root: HTMLElement) {
  const style = typeof getComputedStyle === "function" ? getComputedStyle(root) : null;
  return mermaidTheme({
    text: readColorToken(root, "--dsw-alias-label-primary"),
    mutedText: readColorToken(root, "--dsw-alias-label-secondary"),
    background: readColorToken(root, "--dsw-alias-bg-layer-1"),
    surface: readColorToken(root, "--dsw-alias-bg-layer-2"),
    border: readColorToken(root, "--dsw-alias-border-l2"),
    brand: readColorToken(root, "--dsw-alias-brand-primary"),
    fontFamily: style?.fontFamily ?? "",
    fontSize: "14px",
  });
}

/**
 * **穿透 Shadow DOM 取真正的焦点元素** ✓。
 *
 * 面板整个跑在 ShadowRoot 里 ✓ ⇒ `document.activeElement` 只会是 shadow host ✓；
 * 要判断"用户是不是正把光标放在某个代码块的 CodeMirror 里"，必须一层层下钻 ✓。
 * @param documentRef - 文档 ✓。
 * @returns 最内层焦点元素（没有 / 不在文档里 ⇒ `null` ✓）。
 */
function deepActiveElement(documentRef: Document): Element | null {
  let active: Element | null = documentRef.activeElement;
  while (active !== null && active.shadowRoot !== null && active.shadowRoot.activeElement !== null) {
    active = active.shadowRoot.activeElement;
  }
  return active;
}

/**
 * 取 CodeMirror 文档的文本 ✓（`.cm-content` 里每个 `.cm-line` 是一行 ✓）。
 * @param content - `.cm-content` 节点 ✓。
 * @returns 行与行用 `\n` 连起来的文本 ✓。
 */
function codeMirrorText(content: Element): string {
  const lines = content.querySelectorAll(".cm-line");
  if (lines.length === 0) return content.textContent ?? "";
  let text = "";
  lines.forEach((line, index) => {
    if (index > 0) text += "\n";
    text += line.textContent ?? "";
  });
  return text;
}

/** 比较源码前统一行尾空白 / CRLF ✓（CodeMirror 的 DOM 文本不带末尾换行 ✓） */
function normalizeSource(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\s+$/u, "");
}

/** 触发一次浏览器下载 ✓（anchor 挂到 body、点一下就摘掉 ✓） */
function triggerDownload(documentRef: Document, href: string, filename: string): void {
  const anchor = documentRef.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  documentRef.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/**
 * 把预览里的 SVG 复制一份、规范成"可以直接交给看图器 / canvas"的形态 ✓。
 *
 * 三件事：
 * 1. 补 `xmlns` ✓（页面里的 SVG 是在 HTML 命名空间上下文里，序列化后需要它 ✓）；
 * 2. 把 `width` / `height` 写成 viewBox 的尺寸 ✓ —— mermaid 默认写的是 `width="100%"` ✗，
 *    交给 `<img>` / canvas 时拿不到固有尺寸 ✓（实测会退化成 111×150 的错误尺寸 ✗）；
 * 3. 去掉 `style="max-width: …"` ✓（那是页面里"缩到阅读栏宽"用的 ✓，导出时不该带上 ✓）。
 *
 * @param svg - 预览里的 SVG ✓。
 * @param background - 要给图垫的底色（`null` = 不垫 ✓，PNG 那条路自己在 canvas 上填 ✓）。
 * @returns 克隆并规范好的 SVG（**不改页面上的原节点** ✓）。
 */
function normalizedSvgClone(svg: SVGSVGElement, background: string | null): SVGSVGElement {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const box = svg.viewBox?.baseVal;
  const rect = svg.getBoundingClientRect();
  const width = box !== undefined && box.width > 0 ? box.width : Math.max(1, rect.width);
  const height = box !== undefined && box.height > 0 ? box.height : Math.max(1, rect.height);
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  clone.removeAttribute("style");
  if (background !== null) {
    const documentRef = svg.ownerDocument;
    const backdrop = documentRef.createElementNS("http://www.w3.org/2000/svg", "rect");
    backdrop.setAttribute("x", "0");
    backdrop.setAttribute("y", "0");
    backdrop.setAttribute("width", String(width));
    backdrop.setAttribute("height", String(height));
    backdrop.setAttribute("fill", background);
    clone.insertBefore(backdrop, clone.firstChild);
  }
  return clone;
}

/** 序列化一份 SVG ✓ */
function serializeSvg(svg: SVGSVGElement): string {
  return new XMLSerializer().serializeToString(svg);
}

/**
 * 把 SVG 画成 PNG ✓（根级 `htmlLabels: false` 之后图里没有 `<foreignObject>` ✓ ⇒ 不会污染 canvas ✓）。
 * @param svg - 预览里的 SVG ✓。
 * @param background - 画布底色（透明图在黑底 / 白底看图器里都可能看不清 ✓，先铺主题底色 ✓）。
 * @returns PNG Blob ✓；画不出来就抛异常（调用方退回 SVG ✓）。
 */
async function svgToPngBlob(svg: SVGSVGElement, background: string): Promise<Blob> {
  const documentRef = svg.ownerDocument;
  const clone = normalizedSvgClone(svg, null);
  const width = Number(clone.getAttribute("width"));
  const height = Number(clone.getAttribute("height"));
  if (!(width > 0 && height > 0)) throw new Error("SVG 没有有效尺寸");
  const source = serializeSvg(clone);
  const url = URL.createObjectURL(new Blob([source], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("SVG 图像加载失败"));
      image.src = url;
    });
    /* 2× 缩放：贴到文档 / 聊天里不发虚 ✓；上限防止超大图把 canvas 分配爆掉 ✗ */
    const scale = Math.min(2, 4096 / Math.max(width, height));
    const canvas = documentRef.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("浏览器没有 2D canvas");
    context.fillStyle = background;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/png");
    });
    if (blob === null) throw new Error("PNG 编码失败");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 创建一个渲染器 ✓（每个编辑器实例一个 ✓）。
 *
 * 关键点：**每个请求各自防抖** ✗ —— 一个笔记里可能有好几张图 ✓，
 * 用一个共享计时器/代次的话后一块会把前一块的渲染请求取消掉 ✗（只有最后一张图能出来 ✗）。
 * 所以这里按"这次调用"独立排期；同一块连续打字则由 `live` 收口（只渲染最后一份 ✓）。
 *
 * @param options - 编辑器根节点 / 文案 / 诊断 ✓。
 * @returns 渲染器 ✓。
 */
export function createMermaidRenderer(options: MermaidRendererOptions): MermaidRenderer {
  let disposed = false;
  /** 串行队列 ✓：mermaid 的全局配置 + 内部 temp 节点都不欢迎并发 ✗ */
  let queue: Promise<unknown> = Promise.resolve();
  /** 还在等防抖的计时器 ✓（`dispose()` 时统一清掉 ✓） */
  const timers = new Set<ReturnType<typeof setTimeout>>();
  /**
   * 用户**正在编辑**的那一块的最新一次请求 ✓。
   * 编辑器每敲一个字就会调一次 `renderPreview` ✗ ⇒ 编辑中只记下最后一份 ✓，
   * 失焦时再渲染一次 ✓（既能出图，又不会在打字时把源码顶掉 ✗）。
   */
  let live: { content: string; applyPreview: (value: string | null) => void } | null = null;
  /**
   * 已经渲染好、暂时**不能回填**的结果 ✓（回填会让正在编辑的源码被预览藏起来 ✗）。
   *
   * 为什么是**列表**而不是单个 ✗：一个笔记里可能有好几张图同时在渲染 ✓，
   * 先完成的那张不能被后完成的清掉 ✗（否则永久停在「渲染中…」✗）。
   * 数量有上限 ✓（真按上限丢时也只是少显示一张，不会出错 ✓）。
   */
  let pendingDeliveries: Array<{
    content: string;
    html: string;
    applyPreview: (value: string | null) => void;
  }> = [];
  const PENDING_LIMIT = 16;

  const report = (step: string, detail?: unknown): void => {
    try {
      options.report?.(step, detail);
    } catch {
      // 诊断失败不影响渲染
    }
  };

  /**
   * **用户此刻是不是正在编辑这段源码** ✓。
   *
   * 判据：文档里的最内层焦点元素落在一个 `.cm-content` 里 ✓，
   * 且这块 CodeMirror 的文本与传进来的源码一致 ✓
   * （同一份编辑器里可能有多个代码块，文本一致才说明"就是这一块"✓）。
   * @param content - 待渲染的源码 ✓。
   * @returns 正在编辑 ⇒ `true` ✓。
   */
  const isEditingContent = (content: string): boolean => {
    const documentRef = options.root.ownerDocument;
    const active = deepActiveElement(documentRef);
    if (active === null || !options.root.contains(active)) return false;
    const codeMirror = active.closest(".cm-content");
    if (codeMirror === null) return false;
    return normalizeSource(codeMirrorText(codeMirror)) === normalizeSource(content);
  };

  /**
   * **焦点是不是在某个 mermaid 代码块里** ✓。
   *
   * 比 `isEditingContent` 更宽 ✗：用户可能已经把这行改了几个字 ✓，
   * 这时"旧内容"的渲染结果照样不能让 `.codemirror-host` 被加 `.hidden` ✗
   * （那会抢走焦点、吞掉后续字符 ✗ —— 真实浏览器复查出来的 P1 ✓）。
   * @returns 是 ⇒ `true` ✓。
   */
  const focusedMermaidBlock = (): boolean => {
    const documentRef = options.root.ownerDocument;
    const active = deepActiveElement(documentRef);
    if (active === null || !options.root.contains(active)) return false;
    const codeMirror = active.closest(".cm-content");
    if (codeMirror === null) return false;
    const block = codeMirror.closest(".milkdown-code-block");
    const label = block?.querySelector(".language-button")?.textContent?.trim() ?? "";
    return isMermaidLanguage(label);
  };

  /** 文档里还有没有"这段源码 + mermaid 语言"的代码块 ✓（异步回填前的最终校验 ✓） */
  const hasMermaidBlockFor = (content: string): boolean => {
    try {
      return options.blocks().some(
        (block) => isMermaidLanguage(block.language) && normalizeSource(block.text) === normalizeSource(content),
      );
    } catch {
      /* 拿不到文档结构时宁可照常回填 ✓（总比永远停在「渲染中…」好 ✓） */
      return true;
    }
  };

  /** 把结果交给 Crepe ✓：正在编辑 / 焦点在 mermaid 块里 ⇒ 先攒着 ✓，否则直接回填 ✓ */
  const deliver = (content: string, html: string, applyPreview: (value: string | null) => void): void => {
    if (disposed) return;
    if (isEditingContent(content) || focusedMermaidBlock()) {
      pendingDeliveries.push({ content, html, applyPreview });
      if (pendingDeliveries.length > PENDING_LIMIT) pendingDeliveries = pendingDeliveries.slice(-PENDING_LIMIT);
      return;
    }
    try {
      applyPreview(html);
    } catch (error) {
      report("mermaid-preview-apply-failed", { message: mermaidErrorMessage(error) });
    }
  };

  /** 安全地回填一条 ✓（目标块已经不在 / 已改成别的语言 ⇒ 丢弃 ✗） */
  const applyPending = (item: { content: string; html: string; applyPreview: (value: string | null) => void }): void => {
    if (!hasMermaidBlockFor(item.content)) return;
    try {
      item.applyPreview(item.html);
    } catch (error) {
      report("mermaid-preview-apply-failed", { message: mermaidErrorMessage(error) });
    }
  };

  /** 焦点离开后，把攒下的结果回填 ✓（焦点还在 mermaid 块里就先不动 ✓，下次 focusout 再试 ✓） */
  const flushPending = (): void => {
    if (disposed || pendingDeliveries.length === 0) return;
    if (focusedMermaidBlock()) return;
    const list = pendingDeliveries;
    pendingDeliveries = [];
    for (const item of list) applyPending(item);
  };

  /** 焦点离开后，把"正在编辑那一块"的最后一版源码渲染出来 ✓ */
  const renderLive = (): void => {
    const request = live;
    live = null;
    if (request === null) return;
    if (request.content.trim() === "") {
      /* 只有空白 ⇒ 没有图可画 ✓（别让 mermaid 抛 "No diagram type detected" 变成错误面板 ✗） */
      try {
        request.applyPreview(null);
      } catch (error) {
        report("mermaid-preview-apply-failed", { message: mermaidErrorMessage(error) });
      }
      return;
    }
    schedule(request.content, request.applyPreview);
  };

  const onFocusOut = (): void => {
    /* 焦点可能正在挪到另一个输入框 ✓ ⇒ 让浏览器先把焦点落定 ✓ */
    setTimeout(() => {
      if (disposed) return;
      flushPending();
      renderLive();
    }, 0);
  };
  options.root.addEventListener("focusout", onFocusOut, true);

  /**
   * 真正渲染一次 ✓（调用方保证串行 ✓）。
   * @param content - 源码 ✓。
   * @returns SVG 文本 + **本次渲染用的主题底色** ✓（预览里记下来给下载用 ✓）。
   */
  const renderSvg = async (content: string): Promise<{ svg: string; background: string }> => {
    const mermaid = await loadMermaid();
    const theme = readTheme(options.root);
    /*
     * `theme: "base"` + 显式 themeVariables ✓：默认的 `default` / `dark` 两套配色
     * 不会跟随宿主的 token ✓ ⇒ 浅色面板里出现深色图、深色面板里出现浅色图 ✗。
     */
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: "base",
      themeVariables: theme.themeVariables,
      fontFamily: theme.fontFamily,
      /*
       * **根级 `htmlLabels: false`** ✓（实测 ✓）：mermaid v11 里
       * `flowchart.htmlLabels` 已弃用、只看得到部分标签 ✓ ⇒ 只写它的话边标签仍是
       * `<foreignObject>` ✗（下载 PNG 会被 canvas 判成污染 ✗）。写在根级才彻底是 SVG `<text>` ✓。
       */
      htmlLabels: false,
      flowchart: { useMaxWidth: true },
      sequence: { useMaxWidth: true },
      gantt: { useMaxWidth: true },
      journey: { useMaxWidth: true },
      timeline: { useMaxWidth: true },
    } as never);
    renderSequence += 1;
    const id = `kn-mermaid-${renderSequence.toString(36)}`;
    /* `%%{init}%%` 里的 themeCSS / htmlLabels 收窄（外部资源 / foreignObject ✓，见 mermaid-block 注释 ✓） */
    const result = await mermaid.render(id, sanitizeMermaidSource(content));
    return { svg: result.svg, background: theme.background };
  };

  /**
   * 排一次渲染 ✓（**每个请求各有一个计时器** ✓：多张图不会互相取消 ✓）。
   * @param content - 源码 ✓（同时作为"这段内容现在是什么语言"的键 ✓）。
   * @param applyPreview - 回填函数 ✓。
   */
  function schedule(content: string, applyPreview: (value: string | null) => void): void {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (disposed) return;
      const startedAt = Date.now();
      queue = queue.then(async () => {
        if (disposed) return;
        /*
         * 这段源码对应的块已经不是 mermaid 了（改成 LaTeX / 普通代码 / 被删）⇒
         * 这次的图 / 错误**都不要** ✗（否则会把别人的预览顶掉，甚至把图填进公式块 ✗）。
         */
        if (!hasMermaidBlockFor(content)) return;
        let html: string;
        try {
          const rendered = await renderSvg(content);
          if (disposed) return;
          html = mermaidPreviewHtml({
            svg: rendered.svg,
            source: content,
            labels: options.labels(),
            background: rendered.background,
          });
          report("mermaid-render", { chars: content.length, ms: Date.now() - startedAt });
        } catch (error) {
          if (disposed) return;
          const message = mermaidErrorMessage(error);
          html = mermaidErrorHtml({ message, labels: options.labels() });
          report("mermaid-render-failed", { message, ms: Date.now() - startedAt });
        }
        deliver(content, html, applyPreview);
      }).catch((error: unknown) => {
        report("mermaid-render-queue-failed", { message: mermaidErrorMessage(error) });
      });
    }, RENDER_DEBOUNCE_MS);
    timers.add(timer);
  }

  const renderPreview: MermaidRenderer["renderPreview"] = (language, content, applyPreview) => {
    if (disposed) return null;
    const source = content === undefined || content === null ? "" : String(content);
    /*
     * ⚠️ 只有**同一块**的调用才能作废 `live` ✗：
     * 渲染器是编辑器级单例 ✓，别的普通代码块初始化时也会调 `renderPreview` ✓
     * ⇒ 若无条件 `live = null`，用户正在编辑的 mermaid 块一失焦图就再也不出现了 ✗
     * （真实浏览器复查过 ✗）。判据用源码文本：同一块的旧/新源码才会相同或互为更新 ✓；
     * 无关块的内容基本不可能刚好一样 ✓。
     */
    const sameLiveContent = live !== null && normalizeSource(live.content) === normalizeSource(source);
    if (!isMermaidLanguage(language)) {
      if (sameLiveContent) live = null;
      return null;
    }
    if (source.trim() === "") {
      if (sameLiveContent) live = null;
      return null;
    }
    /*
     * **正在输入这一块** ⇒ 这一轮先返回 `null` ✓（不给"渲染中…"占位 ✗）：
     * 占位也会让 `preview.value` 变成非空 ✓ ⇒ 面板给源码区加 `.hidden` ✓ ⇒ 焦点被抢 ✗。
     * 只记下最后一份源码 ✓，失焦时再渲染 ✓。
     */
    if (isEditingContent(source)) {
      live = { content: source, applyPreview };
      return null;
    }
    /* 不是正在编辑的块（打开笔记 / 外部替换 / 其它块）⇒ 正常异步：先显示「渲染中…」✓ */
    schedule(source, applyPreview);
    return undefined;
  };

  const download: MermaidRenderer["download"] = async (svg, source, background) => {
    if (svg === null) return;
    const startedAt = Date.now();
    const theme = readTheme(options.root);
    /* 底色取**渲染时**记下的那份 ✓（主题切换后下载也不会「深色图 + 浅色底」✗） */
    const backdrop = background?.trim() || theme.background;
    const documentRef = svg.ownerDocument;
    const baseName = mermaidDownloadName();
    try {
      const png = await svgToPngBlob(svg, backdrop);
      const href = URL.createObjectURL(png);
      try {
        triggerDownload(documentRef, href, `${baseName}.png`);
      } finally {
        /* 给浏览器留出取用时间再回收 ✓ */
        setTimeout(() => { URL.revokeObjectURL(href); }, 10_000);
      }
      report("mermaid-download", { format: "png", chars: source.length, ms: Date.now() - startedAt });
      return;
    } catch (error) {
      /* PNG 画不出来（少见图元 / 浏览器限制 ✓）⇒ 退回 SVG ✓：至少图是完整的 ✓ */
      report("mermaid-download-fallback", { message: mermaidErrorMessage(error) });
    }
    try {
      const serialized = serializeSvg(normalizedSvgClone(svg, backdrop));
      const href = URL.createObjectURL(new Blob([serialized], { type: "image/svg+xml;charset=utf-8" }));
      try {
        triggerDownload(documentRef, href, `${baseName}.svg`);
      } finally {
        setTimeout(() => { URL.revokeObjectURL(href); }, 10_000);
      }
      report("mermaid-download", { format: "svg", chars: source.length, ms: Date.now() - startedAt });
    } catch (error) {
      report("mermaid-download-failed", { message: mermaidErrorMessage(error), chars: source.length });
    }
  };

  const dispose = (): void => {
    disposed = true;
    live = null;
    pendingDeliveries = [];
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    options.root.removeEventListener("focusout", onFocusOut, true);
  };

  return { renderPreview, download, dispose };
}

/** 预览里的下载按钮选中哪个 SVG ✓（`null` = 面板已经被换掉了 ✓） */
export function mermaidSvgOf(preview: Element): SVGSVGElement | null {
  const svg = preview.querySelector("svg");
  return svg instanceof SVGSVGElement ? svg : null;
}

/** 供测试 / 诊断确认预览根节点 class 没写错 ✓ */
export const MERMAID_PREVIEW_SELECTOR = `.${MERMAID_PREVIEW_CLASS}`;
