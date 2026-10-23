/**
 * **Markdown 富文本编辑器**（Milkdown / Crepe）—— Typora 式即时编辑。
 *
 * 职责边界（`design/typora-style-markdown-editor-analysis.md`）：
 * - 只提供"初始化正文 / 用户改动后的 Markdown / 只读 / 聚焦 / 销毁"✓；
 * - **不**调用宿主保存 API、**不**持有文件指纹 ✓（那些仍归 NodeDocumentEditor 与 reducer ✓）；
 * - 保存内容永远是 **Markdown 文本** ✓ —— HTML / 内部 JSON 绝不落地 ✗。
 *
 * 复查（`design/rich-markdown-editor-review.md`）逼出来的几条，都在这里：
 * 1. **异步初始化期间的正文同步不能丢** ✗（P1-1）：实例没就绪时把最新正文记进
 *    `pendingRef`，`create()` 成功后**先补上**再确认 token ✓；
 * 2. **未就绪不许假装有正文** ✗（P1-1/P2-6）：`flush()` 在未就绪（或输入法正在组合）时返回 `null` ✓，
 *    父面板据此**禁止保存**并给出可见提示 ✓，绝不把挂载时的旧正文当"当前内容"写回去 ✗；
 * 3. **区分"用户事务"与"初始化/外部同步事务"** ✗（P2-5）：同步期间置 `syncingRef`，
 *    `markdownUpdated` 一律忽略 ✓（初始化解析出的规范化文本**不算**用户修改 ✓）；
 * 4. **卸载取消按实例** ✗（P1-1）：每次挂载用自己的 `cancelled` 标志 ✓，
 *    晚完成的实例立刻销毁 ✓，绝不附着到新节点上 ✓；
 * 5. 失败要**可见** ✗（P2-6）：`onStatus` 上报 ready/failed，父面板显示错误并自动改用纯文本 ✓。
 */
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Crepe, CrepeFeature } from "@milkdown/crepe";
import {
  INLINE_FORMAT_LITERAL,
  clearInlineFormat,
} from "./inline-format.ts";
import { imageBlockSchema } from "@milkdown/kit/component/image-block";
import { commandsCtx, editorViewCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import {
  addColAfterCommand,
  addColBeforeCommand,
  addRowAfterCommand,
  addRowBeforeCommand,
  moveColCommand,
  moveRowCommand,
  setAlignCommand,
} from "@milkdown/kit/preset/gfm";
import { deleteColumn, deleteRow, deleteTable } from "@milkdown/kit/prose/tables";
import type { EditorView as ProseMirrorView } from "@milkdown/kit/prose/view";
import { Fragment, type Node as ProseMirrorNode } from "@milkdown/kit/prose/model";
import { NodeSelection, TextSelection } from "@milkdown/kit/prose/state";
import { replaceAll } from "@milkdown/kit/utils";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages as CODE_MIRROR_LANGUAGES } from "@codemirror/language-data";
import { tags } from "@lezer/highlight";

import { makeTranslator } from "./card-model.ts";
import { tableMinWidth } from "./table-menu.ts";
import { MAX_IMAGE_BYTES, contentTypeForImage, imageDisplayUrl, isLibraryRelativeImageSrc, withExplicitImageTitles } from "../shared/note-images.ts";
import { GRAPH_API_ROUTE } from "../shared/routes.ts";
import { inFirstTableRow, tableRowTypes } from "./table-header-row.ts";
import {
  KN_CODE_BLOCK_MIME,
  codeBlockHtml,
  encodeCodeBlockPayload,
  codeBlockFromClipboardHtml,
  codeBlockFromPlainText,
  codeBlockFromRichHtml,
  formulaFromPlainText,
  insideCodeBlock,
  parseCodeBlockPayload,
} from "./code-block-clipboard.ts";
import { unwrapBlockquoteTransaction } from "./blockquote-escape.ts";
import { TableEntry, TableMenu } from "./TableMenu.tsx";
import { BlockInsertMenu } from "./BlockInsertMenu.tsx";
import {
  BLOCK_MENU_LITERAL,
  prepareAfterBlockInsertion,
  prepareContextInsertion,
  readBlockMenuGroups,
  type BlockMenuItemData,
  type BlockMenuGroupData,
} from "./block-insert.ts";
import {
  MERMAID_ACTION_ATTR,
  MERMAID_BACKGROUND_ATTR,
  MERMAID_SOURCE_ATTR,
  decodeMermaidSource,
} from "./mermaid-block.ts";
import { MERMAID_PREVIEW_SELECTOR, createMermaidRenderer, mermaidSvgOf } from "./mermaid-renderer.ts";
/*
 * **宿主共享的「原图预览」** ✓（聊天 / 文档里点图片用的就是它 ✓）。
 * **为什么直接用它** ✓：自绘一套的结果是右上角的按钮正好被 **Windows 原生标题栏**
 * （窗口控制按钮）压住 ✗ —— 真实截图实测 ✓。宿主这个组件的舞台是
 * `inset: var(--dsh-frame-chrome-top, 0px) 0 0` ✓（主动避开标题栏 ✓），
 * 而且 Esc / 点遮罩 / × / 焦点还原都是现成的 ✓；它走 `@deepseek-ai/dsh-client-ui-primitives`
 * 这块**基线模块** ✓（宿主模块表提供 ✓，`build.mjs` 的 `CLIENT_BASELINE` 已把它列为 external ✓）。
 */
import { ImageLightbox } from "@deepseek-ai/dsh-client-ui-primitives";
import {
  caretTargetForClick,
  caretTargetForSelection,
  caretTargetForTextblockSelection,
  firstCaretInTable,
  isCellTextblockSelection,
  isPlainClick,
  trailingParagraphTarget,
} from "./table-caret.ts";
import {
  TABLE_LITERAL,
  TABLE_MENU_ITEMS,
  movePayload,
  pathHitsNodes,
  readTableContext,
  readTableMoveState,
  pickBodyTable,
  resolveTableTarget,
  tableEntryHideReason,
  tableEntryPosition,
  tablePopoverPosition,
  type TableAlignment,
  type TableEntryHideReason,
  type TableMenuAction,
  type TableMoveState,
} from "./table-menu.ts";

/**
 * 代码块的语言列表 = CodeMirror 自带的全套语言 + **Mermaid** ✓
 * （`design/mermaid-note-blocks.md` ✓）。
 *
 * 为什么要加一项 ✗：Mermaid 围栏在 Markdown 里就是普通代码块 ✓，
 * 但 CodeMirror 的语言数据里**没有** mermaid ✗ ⇒ 不补这一项的话，
 * 用户从语言列表里根本选不到 mermaid ✓，也就没法在编辑器里新建一张图 ✗
 * （只能靠粘贴 / 已有笔记带进来的围栏 ✓）。
 *
 * `load` 返回 `undefined` 是**故意**的 ✓：mermaid 没有 CodeMirror 语法高亮 ✓，
 * 加载器拿不到语言支持时只当纯文本 ✓（源码照旧可编辑 ✓），图由预览面板渲染 ✓。
 */
const CODE_BLOCK_LANGUAGES: LanguageDescription[] = [
  ...CODE_MIRROR_LANGUAGES,
  LanguageDescription.of({
    name: "mermaid",
    alias: ["mermaid", "mmd"],
    extensions: ["mermaid", "mmd"],
    load: async () => undefined as never,
  }),
];

/**
 * **图片预览用到的三条文案** ✓：
 * - `imageViewerTitle` / `imageViewerClose` ⇒ 传给宿主 `ImageLightbox` 的 `labels` ✓
 *   （宿主组件自己不带语言 ✓，`dialog` / `close` 两条都是无障碍名称 ✓）；
 * - `imageViewerOpenHint` ⇒ 正文图上的悬停提示 ✓（`applyImageSources` 写进 `title` ✓）。
 *
 * 键在中英两份词典里都有 ✓（`tests/plugin-locale.test.mjs` 的字面兜底扫描口径 ✓）。
 */
const IMAGE_VIEWER_LITERAL: Record<string, string> = {
  imageViewerTitle: "查看大图",
  imageViewerClose: "关闭",
  imageViewerOpenHint: "点击查看大图",
};

/**
 * 收集一个表格块里的 **table 候选** ✓
 * （`design/table-entry-hidden-preview-table-analysis.md` ✓）。
 *
 * 块里除了正文表格，还有 `.drag-preview > table` 那张**隐藏预览表** ✗ ——
 * 它排在正文表格**前面** ✓，而 `querySelector("table")` 只看顺序、看不见 `display:none` ✗
 * ⇒ 拿到零矩形 ⇒ 入口被判成"没空间"、直接不显示 ✓（实测入口数 = 0 ✓）。
 * 这里把"隐藏 / 在不在 wrapper 里 / 有没有尺寸"都标出来 ✓，判定交给纯函数 ✓。
 */
function collectTableCandidates(block: HTMLElement): Array<{
  el: HTMLTableElement;
  hidden: boolean;
  inWrapper: boolean;
  width: number;
  height: number;
}> {
  const wrapper = block.querySelector<HTMLElement>(".table-wrapper");
  return Array.from(block.querySelectorAll<HTMLTableElement>("table")).map((el) => {
    const rect = el.getBoundingClientRect();
    return {
      el,
      hidden: el.closest(".drag-preview") !== null,
      inWrapper: wrapper !== null && wrapper.contains(el),
      width: rect.width,
      height: rect.height,
    };
  });
}

/** **活跃单元格**所在的正文表格 ✓（复查建议：有单元格时优先用它 ✓，最不依赖层级 ✓） */
function activeCellTable(view: ProseMirrorView): HTMLTableElement | null {
  try {
    const node = view.domAtPos(view.state.selection.from).node;
    const element = node.nodeType === 1 ? (node as HTMLElement) : node.parentElement;
    const table = element?.closest("table") ?? null;
    return table instanceof HTMLTableElement ? table : null;
  } catch {
    return null;
  }
}

/**
 * 从代码块节点视图的 DOM **反查它对应的 `code_block` 节点** ✓
 * （`design/code-block-copy-paste-analysis.md` ✓）。
 *
 * 为什么以**节点**为准 ✗：CodeMirror 的 DOM 里可能是折叠 / 高亮后的视图文本 ✓，
 * 而我们要写进剪贴板的是**原文** ✓ ⇒ 从 `view.posAtDOM` 找到节点、取 `textContent` ✓。
 */
/**
 * **复制成功后的对勾反馈** ✓
 * （用户要求："点击复制之后，他变成一个对勾，之后再变回来"✓）。
 *
 * Crepe 的复制按钮是 Vue 渲染的 ✓，我们只在**捕获阶段**接住它的点击（所以由我们写剪贴板 ✓）；
 * 反馈就直接改这个按钮本身 ✓：
 * - 记下原来的内容 ✓（图标 + 「复制」两个字 ✓），换成对勾 ✓，加一个类名 ✓；
 * - **1.2 秒后原样还回来** ✓；
 * - 连点不叠加 ✓（同一个计时器走完再说 ✓）；
 * - 按钮的渲染输出是静态的 ✓（`copyText` / `copyIcon` 都不变 ✓）⇒ 不会被 Vue 覆盖回去 ✓。
 */
const COPY_FEEDBACK_MS = 1200;
/*
 * **纯线条的对勾** ✓（用户实测："这个对勾好丑，就放一个纯线条的对勾就行"✗）。
 *
 * 上一版把 `fill="none"` 写成**属性** ✗ ⇒ 任何一条 CSS 的 `fill`（Crepe 的图标样式就有 ✓）
 * 都能盖掉它 ✓ ⇒ 路径被**填实**成一坨 ✓（截图里那个实心三角 ✓）。
 * 现在把这些都写成**内联样式** ✓（内联优先级高于任何 CSS 规则 ✓，除非人家写了 `!important` ✗），
 * 并且线宽收细到 1.6 ✓ ⇒ 就是一条干脆的对勾线 ✓。
 */
const COPIED_CHECK =
  '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" '
  + 'style="fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round">'
  + '<path d="M20 6 9 17l-5-5"/></svg>';

function flashCopied(button: HTMLElement): void {
  if (button.dataset.knCopied === "true") return;
  const original = button.innerHTML;
  button.dataset.knCopied = "true";
  button.classList.add("is-copied");
  button.innerHTML = COPIED_CHECK;
  window.setTimeout(() => {
    button.innerHTML = original;
    button.classList.remove("is-copied");
    delete button.dataset.knCopied;
  }, COPY_FEEDBACK_MS);
}
/**
 * **动作失败时的短暂文字反馈** ✓（Mermaid 预览里那两个按钮用 ✓）。
 *
 * 为什么需要 ✗：超长源码的「复制为代码」、两条路都失败的「下载图像」原先都是**静默无反应** ✗
 * ⇒ 用户只会以为按钮坏了 ✓。这里把按钮文字临时换成失败原因，1.5 s 后恢复 ✓。
 * @param button - 被点的按钮 ✓。
 * @param message - 本地化的失败文案 ✓。
 */
const ACTION_FAILURE_MS = 1500;
function flashActionFailure(button: HTMLElement, message: string): void {
  if (button.dataset.knFeedback === "true") return;
  const original = button.innerHTML;
  button.dataset.knFeedback = "true";
  button.textContent = message;
  window.setTimeout(() => {
    button.innerHTML = original;
    delete button.dataset.knFeedback;
  }, ACTION_FAILURE_MS);
}
/**
 * **把插入的图片真的写到磁盘上** ✓
 * （用户实测："我不知道图片插入到了当前PC中的什么位置"✗ —— 因为 Crepe 默认给的是 `blob:` URL ✗，
 * 只在内存里，刷新即失效 ✓，磁盘上什么都没写 ✓）。
 *
 * 走宿主路由 ✓（`kind:'image-save'` ✓）：宿主把它写进 `<库根>/<imageDir>/` ✓，
 * 默认就是用户要的 `.dsh_knowledge/image/` ✓（`imageDir` 可配置 ✓，见 `cordis.patch.yml` ✓）。
 *
 * @param file - 用户选/拖进来的文件 ✓。
 * @param target - 当前库目标（与笔记读写用同一个 ✓，别让图片跑到别的库去 ✗）。
 * @returns **库内相对路径** ✓（`image/xxx.png` ✓）—— 这一串会被写进 Markdown ✓
 *   （显示时再由 `applyImageSources` 换成同源 URL ✓ ⇒ 笔记挪到别的编辑器也读得懂 ✓）。
 */
async function uploadNoteImage(file: File, target: Record<string, unknown> | undefined): Promise<string> {
  if (file.size > MAX_IMAGE_BYTES) throw new Error("图片超过 12 MiB，请缩小后再插入");
  const mime = file.type || contentTypeForImage("", file.name);
  if (!mime.startsWith("image/")) throw new Error("请选择图片文件");
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { resolve(typeof reader.result === "string" ? reader.result : ""); };
    reader.onerror = () => { reject(new Error("read-failed")); };
    reader.readAsDataURL(file.type === "" ? file.slice(0, file.size, mime) : file);
  });
  const response = await fetch(GRAPH_API_ROUTE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "image-save", name: file.name, dataUrl, ...(target ?? {}) }),
  });
  const body = await response.json() as { ok?: unknown; path?: unknown; error?: { message?: unknown } };
  if (response.ok !== true || body.ok !== true || typeof body.path !== "string") {
    throw new Error(typeof body.error?.message === "string" ? body.error.message : "image-save-failed");
  }
  return body.path;
}

/**
 * **把库内相对路径的图片换成同源 URL 来显示** ✓
 * （Markdown 里存的仍是相对路径 ✓；这里只改 DOM 的 `src` 用于渲染 ✓）。
 *
 * @param root - 编辑器根 ✓。
 */
/**
 * **把库里的图片取回来、显示出来** ✓（用户实测两轮：磁盘上有图、笔记里看不到 ✗）。
 *
 * 关键认识（第三轮的真正原因 ✓）：**`<img src>` 带不了认证** ✗。
 * 宿主那条取图路由和别的接口一样要过 DSH 的连接鉴权 ✓ ——
 * 我们的 `fetch(...)` 能过（客户端半走的是同源/桥 ✓），而浏览器为 `<img>` 发的裸 GET
 * **拿不到那份凭据** ✓ ⇒ 401 ⇒ 图裂 ✓（我先前手工 curl 也是 401 ✓，同一个原因 ✓）。
 *
 * ⇒ 显示这条路改成：**用 `fetch` 把字节取回来**（它过得了鉴权 ✓），
 * 再 `URL.createObjectURL(blob)` 交给 `<img>` ✓。这样：
 * - `<img>` 只看 blob ✓，不需要任何凭据 ✓；
 * - Markdown 里仍然是**库内相对路径** ✓（可移植 ✓）；
 * - 同一条相对路径**只取一次** ✓（缓存在这张 map 里 ✓，卸载时统一 revoke ✓）。
 *
 * 另外：Crepe 的 image-block 会按节点属性重渲染 ✓ 把 `src` 写回相对路径 ✗
 * ⇒ 由 `MutationObserver` 盯着 `src` 变化再断言一次 ✓（见 `observeImages` ✓）。
 *
 * @param image - 目标 `<img>` ✓。
 * @param raw - 它的库内相对路径（`data-kn-raw-src` ✓）。
 * @param target - 当前库目标 ✓。
 * @param cache - 本编辑器实例的 blob 缓存 ✓（卸载时 revoke ✓）。
 * @param inflight - 正在取的 key ✓（防并发重复取 ✓）。
 * @param report - 诊断上报 ✓。
 */
/**
 * **图片还没取回来时先摆一个 1×1 透明占位** ✓。
 *
 * 为什么需要（用户实测 2026-10-11：DevTools 控制台里每开一次笔记就报两条
 * `dsh-app://app/image/<名字>.png` **404** ✗）：
 * Markdown 里存的是**库内相对路径** ✓，而 Crepe 建 DOM 时会原样写进 `src` ✗ ⇒
 * 浏览器拿文档基址去请求（`dsh-app://app/image/…`）⇒ **必然 404** ✗
 * —— 我们随后用 `fetch` + `blob:` 换掉它 ✓（那条路才过得了鉴权 ✓），
 * 所以**图是能显示的** ✓（上一轮截图里就是好的 ✓），但那次注定失败的请求已经发出去了 ✗，
 * 顺带还会闪一下"裂图"图标 ✗。
 *
 * 做法：节点一插进来就（在**同一个微任务**里）把 `src` 换成占位 ✓ ——
 * 图片真正开始加载是排在后面一个任务里的 ✓，换掉就等于这次请求从没发出 ✓
 * （配合下面 `childList` 观察器 ✓）。
 */
const IMAGE_PLACEHOLDER_SRC = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/**
 * 把"库内相对路径"的 `src` 掐掉、换成透明占位 ✓。
 *
 * 只动**还没显示出来**的图 ✗：已经是我们的 `blob:` ✓、或本来就是占位 ✓ 的都不碰
 * （否则 Crepe 每次重渲染都会把正在显示的图打回空白 ✗）。
 *
 * @param image - 目标 `<img>` ✓。
 * @param report - 诊断上报 ✓（换过一次就留一条痕 ✓）。
 */
function holdNoteImagePlaceholder(
  image: HTMLImageElement,
  report: ((step: string, detail?: unknown) => void) | undefined,
): void {
  const current = image.getAttribute("src") ?? "";
  if (current === IMAGE_PLACEHOLDER_SRC || current.startsWith("blob:") || current.startsWith("data:")) return;
  image.setAttribute("src", IMAGE_PLACEHOLDER_SRC);
  report?.("image-src-hold", { src: current.slice(0, 120) });
}

function ensureImageDisplay(
  image: HTMLImageElement,
  raw: string,
  target: Record<string, unknown> | undefined,
  cache: Map<string, string>,
  inflight: Set<string>,
  report: ((step: string, detail?: unknown) => void) | undefined,
): void {
  const key = `${raw}\u0000${String(target?.root ?? target?.sessionId ?? "")}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    if (image.getAttribute("src") !== cached) image.setAttribute("src", cached);
    return;
  }
  /* 有一张正在取 ⇒ 先把这次注定 404 的请求掐掉 ✓（别等它回来 ✗） */
  if (inflight.has(key)) {
    holdNoteImagePlaceholder(image, report);
    return;
  }
  inflight.add(key);
  holdNoteImagePlaceholder(image, report);
  const wanted = imageDisplayUrl(GRAPH_API_ROUTE, raw, target);
  void fetch(wanted)
    .then(async (response) => {
      if (response.ok !== true) throw new Error(`image-http-${response.status}`);
      const blob = await response.blob();
      if (!image.isConnected) return;
      const url = URL.createObjectURL(blob);
      cache.set(key, url);
      if (image.isConnected) image.setAttribute("src", url);
      report?.("image-src-ready", { path: raw, bytes: blob.size });
    })
    .catch((error: unknown) => {
      report?.("image-load-failed", { path: raw, error: String(error), url: wanted });
    })
    .finally(() => { inflight.delete(key); });
}

/**
 * 遍历编辑器里的图片，把库内相对路径的都换成 blob URL ✓。
 *
 * @param root - 编辑器根 ✓。
 * @param target - 当前库目标 ✓。
 */
const imageLoadListeners = new WeakSet<HTMLImageElement>();

/** Convert Crepe's saved height to a width so narrow containers preserve the image ratio. */
function fitNoteImage(image: HTMLImageElement): void {
  const fit = (): void => {
    /*
     * **别拿占位图量尺寸** ✗：占位是 1×1 ✓，用它算出来的宽度会把真图压成一条 ✗
     * （而且它会顺手把 Crepe 给的高度改成 `auto` ⇒ 真图加载完也没法再纠正 ✗）。
     */
    if ((image.getAttribute("src") ?? "") === IMAGE_PLACEHOLDER_SRC) return;
    const height = Number.parseFloat(image.style.height);
    if (image.naturalWidth <= 0 || image.naturalHeight <= 0 || !Number.isFinite(height) || height <= 0) return;
    const width = height * image.naturalWidth / image.naturalHeight;
    image.style.width = width + "px";
    image.style.height = "auto";
  };
  fit();
  if (!imageLoadListeners.has(image)) {
    imageLoadListeners.add(image);
    image.addEventListener("load", fit);
  }
}

function applyImageSources(
  root: HTMLElement,
  target: Record<string, unknown> | undefined,
  cache: Map<string, string>,
  inflight: Set<string>,
  report: ((step: string, detail?: unknown) => void) | undefined,
  /** 悬停提示 ✓（`点击查看大图` ✓；`undefined` = 不写 ✓）。见下面那段"很糊"的说明 ✓ */
  zoomHint: string | undefined,
): void {
  for (const image of root.querySelectorAll<HTMLImageElement>("img")) {
    fitNoteImage(image);
    /*
     * **悬停给一句提示** ✓（用户实测：插入的图片"会变得很糊"✗）：
     * 正文栏只有 ~770px ✓，3200px 的图被压到 24% ✓ ⇒ 想看清得**点一下**（宿主原图预览 ✓）。
     * 提示写在 `title` 上 ✓（不往 Crepe 的 node view 里塞外来按钮 ✗，理由见本文件表入口那条 ✓）；
     * `title` 不在图片观察器的过滤范围里 ✓（只盯 `src` / `style` ✓）⇒ 不会自激 ✓。
     */
    if (zoomHint !== undefined && image.title !== zoomHint) image.title = zoomHint;
    const raw = image.getAttribute("data-kn-raw-src") ?? image.getAttribute("src");
    if (raw === null || !isLibraryRelativeImageSrc(raw)) continue;
    image.setAttribute("data-kn-raw-src", raw);
    ensureImageDisplay(image, raw, target, cache, inflight, report);
  }
}
function codeBlockAt(view: ProseMirrorView, host: HTMLElement): { language: string; code: string } | null {
  try {
    const pos = view.posAtDOM(host, 0);
    const $pos = view.state.doc.resolve(pos);
    let node = view.state.doc.nodeAt(pos);
    if (node?.type.name !== "code_block") {
      node = null;
      for (let depth = $pos.depth; depth > 0; depth -= 1) {
        const ancestor = $pos.node(depth);
        if (ancestor.type.name === "code_block") {
          node = ancestor;
          break;
        }
      }
    }
    if (node === null || node.type.name !== "code_block") return null;
    const language = typeof node.attrs.language === "string" ? node.attrs.language : "";
    return { language, code: node.textContent };
  } catch {
    return null;
  }
}

/**
 * 写剪贴板：**纯文本 + HTML + 本插件载荷** ✓，逐级降级 ✓。
 *
 * 复查（`design/code-block-copy-paste-analysis.md` ✓）要求：
 * ① 纯文本那份必须是**裸代码** ✓（粘到终端 / IDE 的体验一点不能变 ✗）；
 * ② HTML 那份要**转义** ✓（不直接插入执行 ✓）；
 * ③ 自定义格式**不是唯一方案** ✗ ⇒ 浏览器拒绝时退回"纯文本 + HTML"，再退回纯文本 ✓；
 * ④ **不伪造** `vscode-editor-data` ✗（那是别人的格式 ✓）。
 */
let lastCopiedBlock: { language: string; code: string } | null = null;

/**
 * **代码块 / 公式块里"手动选中复制"的纯文本** ✓（用户第十三轮要求 ✓）。
 *
 * 语义要和右上角「复制」按钮分开：
 * - 点「复制」按钮 ⇒ 结构化载荷 ⇒ 粘贴回正文**还原成完整代码块 / 公式块** ✓（原有行为 ✓）；
 * - **手动选中一段代码/公式复制** ⇒ 只写纯文本 ✓ ⇒ 粘贴回来就是**纯文本**（不还原成块 ✗）。
 *
 * 这里记住最后一次"选中复制"的文本 ✓：粘贴时若剪贴板纯文本与它一致、又没有本插件载荷，
 * 就按纯文本插入 ✓（并清掉「复制按钮」的记忆，避免同一段文字被误还原成块 ✗）。
 */
let lastSelectionCopy: string | null = null;

/**
 * 把多行纯文本**原样**插到当前选区 ✓（行间用硬换行 ✓，不解析 Markdown、不建块 ✓）。
 *
 * @param view - 编辑器视图 ✓。
 * @param text - 剪贴板纯文本 ✓。
 * @returns 是否插入成功 ✓。
 */
function insertPlainTextAtSelection(view: ProseMirrorView, text: string): boolean {
  if (!view.editable) return false;
  const { state } = view;
  const selection = state.selection;
  if (!(selection instanceof TextSelection) || !selection.$from.parent.inlineContent) return false;
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\n+$/g, "");
  if (normalized === "") return false;
  const hardbreak = state.schema.nodes.hardbreak;
  const nodes: ProseMirrorNode[] = [];
  normalized.split("\n").forEach((line, index) => {
    if (index > 0) {
      if (hardbreak === undefined) nodes.push(state.schema.text(" "));
      else nodes.push(hardbreak.create());
    }
    if (line !== "") nodes.push(state.schema.text(line));
  });
  if (nodes.length === 0) return false;
  const fragment = Fragment.fromArray(nodes);
  const { from, to } = selection;
  const transaction = state.tr.replaceWith(from, to, fragment);
  transaction.setSelection(TextSelection.create(transaction.doc, from + fragment.size));
  view.dispatch(transaction.scrollIntoView());
  return true;
}

async function writeCodeBlockClipboard(payload: { language: string; code: string }): Promise<void> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  const Item = typeof ClipboardItem === "function" ? ClipboardItem : null;
  const plain = payload.language.toLowerCase() === "latex" ? "$$\n" + payload.code + "\n$$" : payload.code;
  if (clipboard?.write !== undefined && Item !== null) {
    try {
      await clipboard.write([new Item({
        "text/plain": new Blob([plain], { type: "text/plain" }),
        "text/html": new Blob([codeBlockHtml(payload)], { type: "text/html" }),
        [KN_CODE_BLOCK_MIME]: new Blob([encodeCodeBlockPayload(payload)], { type: KN_CODE_BLOCK_MIME }),
      })]);
      return;
    } catch {
      try {
        await clipboard.write([new Item({
          "text/plain": new Blob([plain], { type: "text/plain" }),
          "text/html": new Blob([codeBlockHtml(payload)], { type: "text/html" }),
        })]);
        return;
      } catch {
        /* 再不行就退回纯文本 ✓（与改造前一致 ✓） */
      }
    }
  }
  await clipboard?.writeText?.(plain);
}

/**
 * **给每张表格算一个"最小宽度"** ✓（用户实测 ✓）。
 *
 * 只靠 CSS 做不到 ✗：`width: 100%` 会让自动布局把列压到极窄（单元格上的 `min-width` 被忽略 ✗，
 * 13 列就变成"一个字一行"✗）；而 `min-width: max-content` 又会让表格**永不换行** ✗。
 * 所以按**列数**算下限 ✓：
 * - 列少 ⇒ 下限 < 可用宽度 ⇒ `width: 100%` 生效 ⇒ **铺满编辑区** ✓（上一次的要求 ✓）；
 * - 列多 ⇒ 下限 > 可用宽度 ⇒ 表格溢出 ⇒ `.table-wrapper` 出**下方横条** ✓（这一次的要求 ✓）。
 *
 * 幂等 ✓：值没变就不写（也就不会自激 ✓ —— 改 `style` 本身也会触发 DOM 变化 ✓）。
 *
 * @param root - 编辑器根节点 ✓（只看它里面的表格 ✓）。
 */
function applyTableMinWidths(root: HTMLElement): void {
  for (const table of root.querySelectorAll<HTMLTableElement>(".milkdown-table-block table, table")) {
    const columns = table.querySelector("tr")?.children.length ?? 0;
    const fontPx = Number.parseFloat(window.getComputedStyle(table).fontSize);
    const wanted = tableMinWidth(columns, fontPx);
    const next = wanted > 0 ? `${wanted}px` : "";
    if (table.style.minWidth !== next) table.style.minWidth = next;
  }
}

/** 当前选区**最内层的块节点名** ✓（用来判断"在不在代码块里"✓） */function currentBlockName(view: ProseMirrorView): string | undefined {
  try {
    const $from = view.state.selection.$from;
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      const node = $from.node(depth);
      if (node.isBlock) return node.type.name;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** 用**事务**插入一个完整代码块 ✓（可撤销 ✓；语言与原文一字不改 ✓） */
function insertCodeBlockNode(view: ProseMirrorView, payload: { language: string; code: string }): void {
  const type = view.state.schema.nodes.code_block;
  if (type === undefined) return;
  const text = payload.code === "" ? undefined : view.state.schema.text(payload.code);
  const node = type.create(payload.language === "" ? null : { language: payload.language }, text);
  /*
   * **在表格里粘贴代码块** ⇒ 插到**整张表之后** ✓。
   *
   * 为什么不能直接 `replaceSelectionWith` ✗：表格单元格里放不下块级节点 ⇒ ProseMirror 会把
   * **整张表拆成两半**（实测：表头 + 前半行、代码块、后半张表 ✗ —— 用户粘代码时最怕这种结构破坏 ✗）。
   * 与块插入菜单"表格这类拆不开的块 ⇒ 插到这一块之后"同一条口径 ✓（`design/editor-block-menu-redesign.md`）。
   */
  const tableBlock = selectionTableBlock(view);
  if (tableBlock !== null) {
    let tablePos = view.posAtDOM(tableBlock, 0);
    let tableNode = view.state.doc.nodeAt(tablePos);
    if (tableNode === null || tableNode.type.name !== "table") {
      tablePos -= 1;
      tableNode = view.state.doc.nodeAt(tablePos);
    }
    if (tableNode === null) {
      /* 正常路径拿不到表格节点（防御性回退）⇒ 插到文档末尾，也不能走 `replaceSelectionWith` 把表拆开 ✗ */
      const end = view.state.doc.content.size;
      const fallback = view.state.tr.insert(end, node);
      fallback.setSelection(TextSelection.near(fallback.doc.resolve(end + 1)));
      view.dispatch(fallback.scrollIntoView());
      return;
    }
    const after = tablePos + tableNode.nodeSize;
    const transaction = view.state.tr.insert(after, node);
    transaction.setSelection(TextSelection.near(transaction.doc.resolve(Math.min(after + 1, transaction.doc.content.size))));
    view.dispatch(transaction.scrollIntoView());
    return;
  }
  view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
}

/** 光标所在的那个表格块（DOM ✓）；不在表格里返回 `null` ✓ */function selectionTableBlock(view: ProseMirrorView): HTMLElement | null {
  const anchorNode = view.domAtPos(view.state.selection.from).node;
  const element = anchorNode.nodeType === 1 ? (anchorNode as HTMLElement) : anchorNode.parentElement;
  return element?.closest<HTMLElement>(".milkdown-table-block") ?? null;
}

/**
 * **活跃单元格**的矩形（视口坐标 ✓）；拿不到就返回 `null` ✓。
 *
 * 入口要跟着它走 ✓（`design/table-entry-scroll-visibility-review.md` 第 1 条 ✓）：
 * 光标在哪一格，入口就在哪一格旁边 —— 长表格往下滚时它跟着可见的单元格 ✓，
 * 而不是留在早已滚出视口的表格顶部被裁掉 ✗。
 */
function activeCellRect(view: ProseMirrorView): { top: number; bottom: number; right: number } | null {
  try {
    const node = view.domAtPos(view.state.selection.from).node;
    const element = node.nodeType === 1 ? (node as HTMLElement) : node.parentElement;
    const cell = element?.closest<HTMLElement>("td, th") ?? null;
    if (cell === null) return null;
    const rect = cell.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, right: rect.right };
  } catch {
    return null;
  }
}

/** 移动类动作用不了时的**原因**（文案 key ✓；复查要求边界时禁用并说清为什么 ✓） */function moveReason(move: TableMoveState | null, action: TableMenuAction): string {
  if (move === null) return "tableMoveUnavailable";
  if (move.blockedKey === "tableMoveSpan") return "tableMoveSpan";
  const isRow = action === "row-up" || action === "row-down";
  if (isRow && move.rowIndex === 0 && !move.rowUp && !move.rowDown) return "tableMoveHeader";
  return "tableMoveEdge";
}

/** 两次的"禁用原因"是否一样 ✓（一样就复用对象、不重渲染 ✓） */
function sameReasons(
  a: Partial<Record<TableMenuAction, string>>,
  b: Partial<Record<TableMenuAction, string>>,
): boolean {
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key as TableMenuAction] !== b[key as TableMenuAction]) return false;
  }
  return true;
}

/**
 * **代码/公式源码区的 CodeMirror 主题**（`design/code-and-math-block-redesign.md` ✓）。
 *
 * 为什么必须走主题扩展 ✗（而不是继续叠 CSS ✓）：截图里"浅色正文 + 深色活动行号块"的混搭，
 * 来自 CodeMirror 自带样式与 Crepe 主题各管一半 ✓；
 * 这个文档明确要求：editor / scroller / content / gutters / activeLine / selection / cursor
 * **成套**接入 ✓，只消除一个黑矩形会留下别的暗色元素 ✗。
 *
 * Crepe 的 `featureConfigs["code-mirror"].theme` 会把这段扩展**追加**进 CodeMirror ✓
 * ⇒ 后注册的主题规则生效 ✓，CSS 覆盖作为兜底 ✓。
 *
 * 颜色一律用宿主 token ✓（亮/暗自动跟随 ✓）；**默认关闭行号** ✓
 * （文档：短笔记更接近文档而不是 IDE ✓；"显示行号"这个开关目前没做 ✗）。
 */
/** Syntax colors use the host palette in both light and dark themes. */
const KN_CODE_HIGHLIGHT = HighlightStyle.define([
  { tag: [tags.meta, tags.variableName, tags.typeName, tags.propertyName, tags.operator, tags.punctuation], color: "var(--dsw-alias-label-primary)" },
  { tag: tags.comment, color: "var(--dsw-alias-label-secondary)", fontStyle: "italic" },
  { tag: [tags.keyword, tags.atom, tags.bool, tags.number], color: "color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, var(--dsw-alias-label-primary))" },
  { tag: [tags.string, tags.regexp, tags.escape], color: "color-mix(in srgb, var(--dsw-alias-brand-primary) 65%, var(--dsw-alias-label-primary))" },
]);
const KN_CODE_THEME = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    color: "var(--dsw-alias-label-primary)",
    fontSize: "13px",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Cascadia Mono", monospace',
    lineHeight: "1.6",
    overflow: "auto",
  },
  ".cm-content": { padding: "6px 0", caretColor: "var(--dsw-alias-label-primary)" },
  /* 默认关行号 ✓（也顺手去掉截图里那个深色行号方块 ✗） */
  ".cm-gutters": { display: "none", border: "none", backgroundColor: "transparent" },
  /* 活动行只给一点点反馈 ✓（不再整块变色 ✓） */
  ".cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent)",
  },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  ".cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in srgb, var(--dsw-alias-brand-primary) 26%, transparent)",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--dsw-alias-label-primary)" },
});


/** 编辑器对外接口（父组件通过 ref 调用 ✓） */
export interface MarkdownRichEditorHandle {
  /**
   * 现取当前 Markdown ✓。
   * @returns 未就绪、初始化失败、或输入法正在组合时返回 **null** ✗（调用方**不得**拿旧值代替 ✓）。
   */
  flush: () => string | null;
  /** 用给定 Markdown **整体替换**文档（只在确认替换时用 ✓） */
  replaceMarkdown: (markdown: string) => void;
  /** 聚焦正文 ✓ */
  focus: () => void;
  /**
   * 把一段文本**作为代码块插入** ✓（粘贴被拆散后的一键补救 ✓）。
   * @param code - 文本原文 ✓（缩进 / 空行一字不改 ✓）。
   * @param language - 语言标识（可选 ✓，留空就是「没有语言」✓）。
   */
  insertCodeBlock: (code: string, language?: string) => void;
  /** 实例是否已就绪 ✓ */
  isReady: () => boolean;
}

/** 编辑器状态上报（父面板据此显示加载/失败提示 ✓） */
export interface MarkdownRichEditorStatus {
  ready: boolean;
  failed: boolean;
  /** 正在输入法组合中（保存要等它结束 ✓） */
  composing: boolean;
}

/** 表格入口与弹出菜单在正文容器里的锚点（**内容坐标** ✓；`null` = 不显示 ✓） */
interface TableMenuAnchor {
  /** 入口按钮 ✓（`compact` = 实在没地方、只能压在单元格上 ⇒ 收成小图标 ✓） */
  entry: { top: number; right: number; inside: boolean; compact: boolean };
  /** 点开后弹出的菜单 ✓ */
  popover: { top: number; right: number };
  alignment: TableAlignment;
  /** 移动类动作用不了的原因（文案 key ✓；能用的不在这里 ✓） */
  disabledActions: Partial<Record<TableMenuAction, string>>;
  /** 只读 / 保存中 ⇒ 入口禁用并说明状态 ✓ */
  busy: boolean;
}

/**
 * **右键块插入菜单的打开状态** ✓（`design/editor-block-menu-redesign.md` ✓）。
 *
 * 三样东西缺一不可：
 * - `x` / `y`：宿主 Menu 的 portal 定位坐标（视口坐标 = 右键落点 / ＋ 手柄右侧 ✓）；
 * - `anchor`：文档里准备插入的位置 ✓（选中条目时才真正动文档 ✗ —— 直接 Esc 取消不能改正文 ✓）；
 * - `mode`：`context` = 右键（能拆段落就拆 ✓）、`after` = ＋ 手柄（总在这一块后面插 ✓）。
 * `groups` 是打开那一刻的 Crepe 条目快照 ✓（菜单渲染期间不会变 ✓）。
 */
interface BlockMenuBlockState {
  x: number;
  y: number;
  anchor: number;
  mode: "context" | "after";
  groups: BlockMenuGroupData[];
}

/** 菜单关闭时的空快照 ✓（常量复用 ⇒ 不因每次渲染新建数组触发菜单重算 ✓） */
const EMPTY_BLOCK_MENU_GROUPS: BlockMenuGroupData[] = [];

/**
 * **编辑器自己的浮动 UI / 菜单 / 手柄** ✓（点它们不算"点正文" ✓）。
 *
 * 用途：
 * - 右键菜单不接管这些位置 ✓（保留原生 / 它们自己的菜单 ✓）；
 * - "点正文下方空白 ⇒ 落到末尾空段落"不接管这些位置 ✓；
 * - `pointerdown` 时记下"这次按下是不是落在浮动 UI 上"✓ —— 用来处理
 *   "点了工具栏按钮 ⇒ 工具栏随即隐藏 ⇒ 同一坐标的 click 落到空白上"的时序 ✗
 *   （实测会把链接输入框一闪关掉 ✗，见 `design/inline-format-fix.md` §8.5 ✓）。
 */
const EDITOR_FLOATING_UI_SELECTOR = [
  ".milkdown-toolbar",
  ".milkdown-link-edit",
  ".milkdown-link-preview",
  ".milkdown-latex-inline-edit",
  ".language-picker",
  ".search-box",
  ".language-list",
  ".milkdown-block-handle",
  ".kn-table-menu",
  ".kn-block-menu",
  "[data-kn-block-menu]",
  ".milkdown-slash-menu",
].join(", ");

/**
 * 渲染富文本编辑区。
 * @param props.markdown - 初始正文（**只在挂载时**使用 ✓，之后由用户编辑或 syncToken 驱动 ✓）。
 * @param props.onChange - **用户**改动后的 Markdown（初始化/外部同步不会触发 ✓）。
 * @param props.readOnly - 是否只读（保存期间 ✓）。
 * @param props.syncToken - 递增 ⇒ 整体替换为 `markdown` ✓（外部替换草稿时用 ✓）。
 * @param props.handleRef - 拿到 flush / replaceMarkdown / focus / isReady ✓。
 * @param props.onStatus - 就绪 / 失败 / 组合状态上报 ✓。
 * @param props.onBaseline - 报"编辑器把某份正文渲染成了什么"（`ingested` → `canonical` ✓）：
 *   末尾换行这类是**编辑器的规范化**、不是用户修改 ✗ —— 父面板据此维护"编辑器侧的干净快照" ✓。
 * @param props.report - 诊断上报（可选 ✓）。
 * @param props.t - 宿主 locale 函数（表格菜单文案用 ✓）。
 * @returns 编辑区容器。
 */
export function MarkdownRichEditor(props: {
  markdown: string;
  onChange: (markdown: string) => void;
  readOnly: boolean;
  syncToken?: number | undefined;
  handleRef?: RefObject<MarkdownRichEditorHandle | null> | undefined;
  onStatus?: ((status: MarkdownRichEditorStatus) => void) | undefined;
  onBaseline?: ((ingested: string, canonical: string) => void) | undefined;
  /**
   * 粘贴进来的**纯文本**上报 ✓（`design/code-block-copy-paste-analysis.md` ✓）：
   * 没命中本插件载荷、也没被拦下的粘贴（就是普通 Markdown 粘贴 ✓）把原文交给父组件 ✓，
   * 万一被拆成段落 + `Text` 块（截图那样 ✓），提示条上还能一键"作为代码块插入"✓。
   */
  onSelectionText?: (selection: { text: string; top: number; left: number } | null) => void;
  /**
   * **「＋ 添加前置节点」从浮动工具栏触发** ✓（`design/inline-format-fix.md` §2.6 ✓）。
   *
   * 以前这是贴着选区的单独浮钮（`.kn-note-selection`）✗ —— 和格式化工具栏都浮在选区上方，
   * **两块互相遮挡**（用户截图 ✓）。现在并进同一个工具栏 ✓：这里只把**选中原文**交给父面板 ✓，
   * 由 `NoteRelations` 打开"添加前置"面板 ✓。
   */
  onAddPrerequisite?: ((selectionText: string) => void) | undefined;
  onPasteText?: ((text: string) => void) | undefined;
  report?: ((step: string, detail?: unknown) => void) | undefined;
  /** 当前库目标 ✓（图片落盘要和笔记读写用同一个库 ✗） */
  target?: unknown;
  t?: unknown;
}): ReactNode {
  /*
   * 字典 = 表格菜单的字面文案 ✓ + 图片预览的字面文案 ✓ + 块插入菜单的字面文案 ✓。
   * 为什么要并进来 ✓：`makeTranslator` 的第三层就是这份 dict ✓ ——
   * 宿主 `t` 与插件 `bind` 都取不到时，界面不能空着 ✓（复查口径 ✓）。
   */
  const t = useMemo(() => makeTranslator(props.t, { ...TABLE_LITERAL, ...IMAGE_VIEWER_LITERAL, ...BLOCK_MENU_LITERAL, ...INLINE_FORMAT_LITERAL }), [props.t]);
  /** 渲染器 / 事件处理里**现取**文案 ✓（locale 切换后不用重建编辑器 ✓） */
  const tRef = useRef(t);
  tRef.current = t;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const crepeRef = useRef<Crepe | null>(null);
  /** ProseMirror 视图（表格命令与"光标在不在表格里"都要用它 ✓） */
  const viewRef = useRef<ProseMirrorView | null>(null);
  /**
   * Crepe 的**块菜单构建器快照** ✓（右键菜单的条目 / 图标 / 命令都来自它 ✓）。
   *
   * 来源是 Crepe 官方配置项 `buildMenu` ✓（见下面 `new Crepe({ featureConfigs })` ✓）；
   * 上游斜杠 UI 本身被构建补丁关掉 ✗（`scripts/slash-menu-patch.mjs` ✓），
   * 但这个 builder 仍会在编辑器挂载时被调用一次 ✓ ⇒ 拿到即用 ✓。
   */
  const blockMenuBuilderRef = useRef<unknown>(null);
  /** 右键 / ＋ 手柄打开的块菜单（`null` = 没开 ✓） */
  const [blockMenu, setBlockMenu] = useState<BlockMenuBlockState | null>(null);
  /** 关闭块菜单是不是因为"点了编辑器外面"✓ —— 决定要不要把焦点抢回正文 ✗（用户可能去点别的面板 ✓） */
  const blockMenuOutsideRef = useRef(false);
  /**
   * **行内格式只在"选中文字 → 浮动工具栏"里出现** ✓（用户第四轮反馈：右键菜单再列一遍就是重复 ✗）。
   * 这里不再有提示、占位、锚点归一化那套"空光标行内格式"的接线 ✓（都随右键行内组一起删掉了 ✓）。
   */
  /** 「＋ 添加前置节点」回调现取 ✓（工具栏配置只在建编辑器时读一次 ✗ ⇒ 走 ref ✓） */
  const onAddPrerequisiteRef = useRef(props.onAddPrerequisite);
  onAddPrerequisiteRef.current = props.onAddPrerequisite;
  /** 规范化图注后要"重报基线" ✓ —— 经 ref 拿 ✓（`reportBaseline` 声明在后面 ✓，直接引用会踩"先用后声明"守卫 ✗） */
  const baselineRef = useRef<((markdown: string) => void) | null>(null);
  /** 库内图片 ⇒ blob URL 的缓存 ✓（同一张只取一次 ✓；卸载时统一 revoke ✓） */
  const imageCacheRef = useRef<Map<string, string>>(new Map());
  /** 正在取图的 key ✓（防并发重复取 ✓） */
  const imageInflightRef = useRef<Set<string>>(new Set());
  /**
   * **原图预览要显示的那张图** ✓（`null` = 没开 ✓）。
   *
   * 渲染交给宿主的 `ImageLightbox` ✓（见文件顶部 import 那段说明 ✓）——
   * 插件这边只负责"点什么 / 传哪张 / 什么时候关" ✓，不自己画遮罩、不自己管键盘 ✗。
   */
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  /** 关掉预览 ✓（**必须是稳定的函数引用** ✓：宿主组件把它当 effect 依赖 ✗，每次渲染换一个新函数会反复还原焦点 ✗） */
  const closeLightbox = useCallback((): void => { setLightbox(null); }, []);
  /**
   * 「点图片看原图」的入口 ✓ —— 经 ref 交给主 effect 里的事件委托 ✓。
   *
   * 为什么要 ref ✓：主 effect 只跑一次（依赖 `[]` ✓），直接闭包会抓住第一帧的函数 ✗；
   * 而这个函数要用 `tRef` 现取文案 ✓（locale 切了也得对 ✓）⇒ 每次都刷新这个 ref ✓。
   */
  const openImageViewerRef = useRef<(image: HTMLImageElement) => void>(() => {});
  /**
   * 表格入口当前该在哪（`null` = 不显示 ✓）。
   * 只由**编辑器 selection** 决定 ✓（不靠鼠标悬停推断 ✗）。
   */
  const contextPointRef = useRef<{ top: number; right: number } | null>(null);
  const [menu, setMenu] = useState<TableMenuAnchor | null>(null);
  /** 完整动作菜单是否展开（**点开才出现** ✓；复查要求"一个轻量入口，按需展开" ✓） */
  const [menuOpen, setMenuOpen] = useState(false);
  /*
   * **首帧先隐藏、就绪后再淡入** ✓（用户第二十二轮：打开笔记时"界面一闪而逝" ✗）。
   *
   * Crepe 的 `create()` 还没完成时，`defaultValue` 会先按**默认 schema** 画一遍：
   * 代码块/公式块还没换成正式 NodeView（代码露成纯文本、公式没渲染 ✗）——
   * 正好被用户看到，然后又被正式渲染覆盖 ✗。
   * 所以 `.kn-editor-rich` 初始带 `data-pending`（CSS 里 visibility:hidden ✓），
   * `create()` 成功后才摘掉属性、淡入 ✓；失败时保持隐藏（父面板会切回纯文本 ✓）。
   */
  const [firstPaintReady, setFirstPaintReady] = useState(false);
  /** rAF 合并：选区变化会连续触发，没必要每条都重算 ✓ */
  const menuFrameRef = useRef<number | null>(null);
  /**
   * **鼠标悬停的那张表格块** ✓（复查 P2a：悬停表格也要能看到入口 ✓）。
   * 只用来"显示入口 / 打开菜单时把光标放进去"✗ —— 悬停本身**不改选区** ✓。
   */
  const hoverBlockRef = useRef<HTMLElement | null>(null);
  /** "入口刚因为看不见而收起"是否已经上报过 ✓（避免每帧刷满诊断环形缓冲 ✗） */
  const entryHiddenReportedRef = useRef(false);
  /** 上次上报的"隐藏原因" ✓（只在**原因变化**时上报 ✓ —— 复查要求几种情况分开 ✓，但也不许刷屏 ✗） */
  const hideReasonRef = useRef<TableEntryHideReason | null>(null);
  /**
   * **打开菜单期间锁定的那张表格块** ✓（复查"避免跨表格误操作"✓）：
   * 菜单开着的时候鼠标飘到别的表格上也不换锚点 ✗；关掉菜单就解锁 ✓。
   */
  const menuBlockRef = useRef<HTMLElement | null>(null);

  /**
   * 收起入口并说明**为什么** ✓（原因只在变化时上报一次 ✓）。
   * @param reason - 见 `TableEntryHideReason` ✓。
   */
  const hideEntry = useCallback((reason: TableEntryHideReason): void => {
    setMenu(null);
    setMenuOpen(false);
    menuBlockRef.current = null;
    if (hideReasonRef.current === reason) return;
    hideReasonRef.current = reason;
    entryHiddenReportedRef.current = true;
    reportRef.current?.("table-entry-hidden", { reason });
  }, []);
  /**
   * **最近一次落点在表格单元格里的普通点击** ✓（屏幕坐标 + 时间 ✓）。
   *
   * 为什么需要它 ✗：上游节点视图 `TableNodeView.stopEvent` 会**吃掉** mousedown
   * （ProseMirror 因此根本不处理这次点击 ✗），它自己在 rAF 之后派发一个"整段结构选择"✗。
   * 我们在 `view.dispatch` 漏斗里改写它时需要点击坐标 ✓，也要靠时间戳把
   * **键盘**造出来的块选择排除掉（那是正常操作 ✓，不许被改写 ✗）。
   */
  const lastClickRef = useRef<{ x: number; y: number; at: number } | null>(null);
  /**
   * 入口按钮 / 菜单容器的**真实节点** ✓：判"点的是不是菜单内部"必须按引用 ✗ ——
   * Shadow DOM 里事件到 `document` 时 `event.target` 已被重定向成 shadow host ✓
   * （`design/table-menu-shadow-dom-review.md` 实测 ✓）。
   */
  const entryNodeRef = useRef<HTMLButtonElement | null>(null);
  const menuNodeRef = useRef<HTMLDivElement | null>(null);
  /** 时间窗：只认"点击之后这一小会儿"里冒出来的坏选区 ✓（键盘选的块不动 ✗） */
  const CLICK_WINDOW_MS = 600;
  const readyRef = useRef(false);
  const failedRef = useRef(false);
  const composingRef = useRef(false);
  /** 初始化还没完成时，最新一份需要同步进去的正文 ✓（P1-1） */
  const pendingRef = useRef<string | null>(null);
  /** 正在做初始化/外部同步 ⇒ 期间的 `markdownUpdated` 不是用户修改 ✗ */
  const syncingRef = useRef(false);
  /**
   * **我们刚注入的正文**：Milkdown 的通知可能是**异步**才到 ✗ ——
   * 那时 `syncingRef` 早就恢复 false 了，只靠它挡不住 ✗（复查"仍待验证"那条 ✓）。
   * 所以再比一次内容：通知里的 markdown 等于刚注入的这份 ⇒ 是回声，不算用户修改 ✓。
   */
  const echoRef = useRef<string | null>(null);
  /** 组件是否已卸载（跨实例共享 ✓，用于"晚完成也要销毁"✓） */
  const disposedRef = useRef(false);

  const initialRef = useRef(props.markdown);
  const markdownRef = useRef(props.markdown);
  markdownRef.current = props.markdown;
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;
  const reportRef = useRef(props.report);
  reportRef.current = props.report;
  const onStatusRef = useRef(props.onStatus);
  onStatusRef.current = props.onStatus;
  const onBaselineRef = useRef(props.onBaseline);
  onBaselineRef.current = props.onBaseline;
  const readOnlyRef = useRef(props.readOnly);
  readOnlyRef.current = props.readOnly;
  /**
   * **保存期间变只读前，编辑器是否有焦点** ✓。
   *
   * 用户实测：编辑后按 `Ctrl/⌘+S` 保存，光标竖线消失、想继续输入得用鼠标重新点一下 ✗ ——
   * 保存会把编辑器切到 `contenteditable=false`（只读）✓，浏览器因此把焦点移走 ✓；
   * 保存结束再切回来时**焦点不会自己回来** ✗。这里记下来、保存结束后还给正文 ✓
   * （前提是用户没在保存期间把焦点点到别处 ✓）。
   */
  const hadFocusBeforeReadOnlyRef = useRef(false);

  /**
   * **点图片 ⇒ 打开「原图预览」** ✓（用户实测：插入的图片"会变得很糊"✗）。
   *
   * 为什么正文里就是糊 ✓：正文栏最宽 860px（`.kn-editor-rich` ✓），面板里实际 ~770px ✓ ⇒
   * 3200×1920 的示意图在正文里只按 **24%** 渲染 ✓，图里的小字没有足够的像素 ✓。
   * 而磁盘上的字节和插入前**逐字节相同** ✓（不是保存时被压坏了 ✗）。
   * ⇒ 交给**宿主共享的 `ImageLightbox`** ✓：按窗口铺开（3200 的图在 1920 窗口里约 48% ✓，
   * 正文的两倍 ✓），并且它用 `--dsh-frame-chrome-top` 主动避开 Windows 标题栏 ✓
   * （自绘一个铺满视口的遮罩时，右上角按钮正好被窗口控制按钮压住 ✗ —— 用户真实截图 ✓）。
   *
   * @param image - 正文里那张已经解码好的 `<img>` ✓（直接复用它的 `currentSrc` ✓，
   *   也就是我们 `fetch` 回来、已经换成 `blob:` 的那张 ✓ —— 不重新下载、不重新编码 ✓）。
   */
  openImageViewerRef.current = (image: HTMLImageElement): void => {
    const naturalWidth = image.naturalWidth;
    const naturalHeight = image.naturalHeight;
    /* 还没解码好 / 还是那张 1×1 透明占位 ⇒ 打开也没意义 ✗（占位放大后就是一块白 ✓） */
    const src = image.currentSrc || image.getAttribute("src") || "";
    if (naturalWidth <= 0 || naturalHeight <= 0) return;
    if (src === "" || src === IMAGE_PLACEHOLDER_SRC) return;
    const raw = image.getAttribute("data-kn-raw-src") ?? "";
    const captionInput = image.closest<HTMLElement>(".milkdown-image-block")?.querySelector<HTMLInputElement>(".caption-input");
    const alt = (captionInput?.value ?? image.alt ?? "").trim();
    setLightbox({ src, alt });
    /* 正文里实际渲染宽度也报一条 ✓：下次再有人说"糊"，一眼能看出是 24% 还是真出错了 ✓ */
    reportRef.current?.("image-viewer-open", {
      path: raw,
      naturalWidth,
      naturalHeight,
      displayWidth: Math.round(image.getBoundingClientRect().width),
    });
  };

  /**
   * 报一次"编辑器把 `ingested` 渲染成了 `canonical`" ✓（只有**喂进去**的时候才报 ✗，
   * 用户敲字走 `onChange` ✓）。父面板拿它维护"编辑器侧的干净快照" ✓ ——
   * 否则宿主去掉末尾空白、编辑器补回末尾换行，一来一回就被当成"又有未保存修改" ✗。
   */
  const reportBaseline = (ingested: string): void => {
    const crepe = crepeRef.current;
    if (crepe === null) return;
    onBaselineRef.current?.(ingested, withExplicitImageTitles(crepe.getMarkdown()));
  };
  /* 规范化图注之后要"重报基线" ✓ —— 经 ref 给 `syncMenu` 用 ✓（它声明在前面 ✓） */
  baselineRef.current = (markdown: string): void => { reportBaseline(markdown); };

  const emitStatus = (): void => {
    onStatusRef.current?.({
      ready: readyRef.current,
      failed: failedRef.current,
      composing: composingRef.current,
    });
  };

  /**
   * 重算表格入口的位置与状态 ✓。
   *
   * 锚点优先级：**光标所在的表格** → **鼠标悬停的表格** ✓
   * （复查 `design/table-interaction-and-row-column-functions-review.md` P2a ✓：
   * 入口原来只在"selection 被判定在表格里"时才出现 ⇒ 悬停表格看不到入口，
   * 用户以为添加/删除行列没了 ✓）。**选区本身不因为悬停而改变** ✗ ——
   * 只有用户真的点开菜单时，才把光标放进那张表格（见 `openMenu` ✓）。
   *
   * 位置锚在**可见表格**上 ✗（不是整块容器 ✓）：`.table-wrapper` 承担横向滚动 ⇒
   * 表格可能有一部分在可视区外，先与它求交 ✓。
   *
   * 只读 / 保存中：入口**仍然显示**但禁用 ✓（复查要求"禁用并明确状态"✗，不是"凭空消失"✓）。
   */
  const syncMenu = useCallback((): void => {
    const view = viewRef.current;
    const host = hostRef.current;
    if (view === null || host === null || !readyRef.current || failedRef.current) {
      hideEntry("no-block");
      return;
    }
    /*
     * **表格宽度下限**先算好 ✓（用户实测：13 列被压成"一个字一行"✗ ⇒ 列多要出下方横条 ✓）。
     * 放在 `syncMenu` 里是因为它已经按帧跑在"内容/结构变了"之后 ✓（派发、滚动都触发 ✓），
     * 不必再加一个观察器 ✗；函数自己带值比较 ⇒ 不会自激 ✓。
     */
    applyTableMinWidths(host);
    applyImageSources(
      host,
      props.target as Record<string, unknown> | undefined,
      imageCacheRef.current,
      imageInflightRef.current,
      (step, detail) => { reportRef.current?.(step, detail); },
      tRef.current("imageViewerOpenHint"),
    );

    const context = readTableContext(view.state);
    /*
     * **锚在哪张表格** ✓（复查"多表格切换"那条 ✓）：
     * 菜单打开期间**锁定** ✓ → 否则**鼠标悬停的那张优先** ✓（用户指着谁就是谁 ✓）
     * → 都没有才退回**选区所在的表格** ✓。
     */
    const selectionBlock = context.inTable ? selectionTableBlock(view) : null;
    const block = resolveTableTarget({
      locked: menuBlockRef.current,
      hovered: hoverBlockRef.current,
      selection: selectionBlock,
    });
    const container = host.closest<HTMLElement>(".kn-editor-body");
    if (block === null || container === null) {
      hideEntry("no-block");
      return;
    }
    /*
     * **正文表格**：先按活跃单元格找 ✓（最稳 ✓，不依赖层级 ✓），
     * 找不到再从块内候选里**过滤** ✓（排除 `.drag-preview` 里的隐藏预览表 ✓，要求非零尺寸 ✓）。
     * 复查实测：原来 `querySelector("table")` 拿到的正是那张零尺寸的隐藏表 ✗ ⇒ 入口永远不显示 ✓。
     */
    const candidates = collectTableCandidates(block);
    const cellTable = selectionBlock === null ? null : activeCellTable(view);
    const body = cellTable ?? pickBodyTable(candidates)?.el ?? null;
    if (body === null) {
      hideEntry(candidates.length === 0 ? "no-body-table" : "zero-size");
      return;
    }
    const containerRect = container.getBoundingClientRect();
    /* **可见**表格范围 = 表格矩形 ∩ 横向滚动容器的可见矩形 ✓ */
    const tableRect = body.getBoundingClientRect();
    const wrapperRect = body.closest<HTMLElement>(".table-wrapper")?.getBoundingClientRect() ?? tableRect;
    const visible = {
      top: Math.max(tableRect.top, wrapperRect.top),
      bottom: Math.min(tableRect.bottom, wrapperRect.bottom),
      left: Math.max(tableRect.left, wrapperRect.left),
      right: Math.min(tableRect.right, wrapperRect.right),
    };
    /* 表格**上一块**的下沿：判断"上方有没有真空白" ✓（不许拿覆盖正文换空间 ✗） */
    const before = block.previousElementSibling;
    const previousBottom = before === null ? null : before.getBoundingClientRect().bottom;
    /*
     * **活跃单元格**的矩形 ✓（复查 `design/table-entry-scroll-visibility-review.md` 第 1 条 ✓）：
     * 入口原来固定锚在**表格顶部** ✗ ⇒ 长表格滚到靠下的行时，入口留在早已滚出视口的表格顶上，
     * 被正文的 `overflow-y:auto` 裁掉 ✓（复查实测入口 0…24、正文可见区 44…777，毫无交集 ✓）。
     * 交给活跃单元格 ⇒ 用户点哪儿、入口就贴在哪儿附近 ✓（没有单元格就用可见带 ✓）。
     */
    const cell = selectionBlock === null ? null : activeCellRect(view);
    /* 入口位置现在会**明确返回 `null`**（表格在正文视口里放不下按钮 ⇒ 收起入口 ✓，
       而不是把内容坐标夹到 >0 了事 ✗ —— 那正是复查看到的裁切外按钮 ✓） */
    const entry = tableEntryPosition(visible, containerRect, container.scrollTop, previousBottom, undefined, undefined, undefined, cell);
    if (entry === null) {
      /*
       * **把"为什么没显示"分开报** ✓（复查要求：别都报 `no-visible-band` ✗ ——
       * 查询到隐藏预览表那种错误会被这条笼统原因掩盖 ✓）。
       */
      const viewport = { top: containerRect.top, bottom: containerRect.bottom };
      hideEntry(tableEntryHideReason({ candidates, visible, viewport }) ?? "no-visible-band");
      return;
    }
    entryHiddenReportedRef.current = false;
    hideReasonRef.current = null;
    const popover = contextPointRef.current ?? tablePopoverPosition(entry, containerRect, container.scrollTop);
    /*
     * 对齐高亮与"行列移动能不能用"都**只看目标表格里的选区** ✓：
     * 悬停的是 B、光标还在 A 时，先不要拿 A 的状态去点亮 B 的菜单 ✗
     * （用户点开菜单时 `openMenu` 会把光标放进 B ✓，这一项随之重算 ✓）。
     */
    const selectionInTarget = selectionBlock !== null && selectionBlock === block;
    const alignment: TableAlignment = selectionInTarget ? context.alignment : "left";
    const move = selectionInTarget ? readTableMoveState(view.state) : null;
    const disabledActions: Partial<Record<TableMenuAction, string>> = {};
    for (const item of TABLE_MENU_ITEMS) {
      if (item.move !== true) continue;
      const allowed = move === null
        ? false
        : item.id === "row-up" ? move.rowUp
          : item.id === "row-down" ? move.rowDown
            : item.id === "col-left" ? move.colLeft
              : move.colRight;
      if (!allowed) disabledActions[item.id] = moveReason(move, item.id);
    }
    /*
     * **表头行上方不能再插行** ✓（用户两轮实测后的最终口径 ✓）：
     * Markdown / GFM 里**第一行就是表头** ✓ ⇒ "在它上面再插一行"这套结构根本表达不出来 ✗
     * （硬插普通行 ⇒ 文档不合法 ⇒ 事务的 `Fitter` 把表格**拆成两张** ✗ —— 用户第一张截图 ✓；
     * 中间试过的"新行当表头、旧表头降级"也被否决 ✗：第一行常常就是**段名** ✓，
     * 让它悄悄变成第二行同样很怪 ✓）。
     * ⇒ 与"表头行不参与移动"（`tableMoveHeader` ✓）同一套口径：**禁用 + 说明原因** ✓。
     */
    if (selectionInTarget) {
      const rowTypes = tableRowTypes(view.state.schema);
      if (rowTypes !== null && inFirstTableRow(view.state, rowTypes)) {
        disabledActions["row-before"] = "tableRowBeforeHeader";
      }
    }
    const busy = readOnlyRef.current;
    /* 位置与高亮都没变就**复用原对象** ⇒ React 不重渲染 ✓（选区一直在变 ✓） */
    setMenu((current: TableMenuAnchor | null) => {
      if (
        current !== null
        && current.entry.top === entry.top && current.entry.right === entry.right && current.entry.inside === entry.inside
        && current.entry.compact === entry.compact
        && current.popover.top === popover.top && current.popover.right === popover.right
        && current.alignment === alignment && current.busy === busy
        && sameReasons(current.disabledActions, disabledActions)
      ) {
        return current;
      }
      return { entry, popover, alignment, disabledActions, busy };
    });
  }, []);

  /**
   * 打开菜单 ✓：如果光标**不在**这张表格里（悬停就显示入口的情形 ✓），
   * 先把光标放进它的第一个单元格 ✓ —— 复查要求"操作目标来自最后有效单元格选区，
   * 不能通过改变选区来显示入口"✓：显示入口时**没有**动选区，只有用户点开才动 ✓。
   */
  const syncMenuRef = useRef<() => void>(() => {});
  const openMenu = useCallback((): void => {
    const view = viewRef.current;
    if (view === null) return;
    const inTable = readTableContext(view.state).inTable;
    const selectionBlock = inTable ? selectionTableBlock(view) : null;
    /*
     * **锁定操作对象** ✓（复查"打开菜单期间锁定操作对象，避免跨表格误操作"✓）：
     * 锚定"现在就用的那张"（悬停优先 → 选区 ✓，与 `syncMenu` 同一套规则 ✓）。
     */
    const locked = resolveTableTarget({ locked: null, hovered: hoverBlockRef.current, selection: selectionBlock });
    menuBlockRef.current = locked;
    /*
     * 光标**不在**这张表格里（悬停就显示入口的情形 ✓）⇒ 先把光标放进它的第一个单元格 ✓。
     * 复查要求"操作目标来自最后有效单元格选区，**不能通过改变选区来显示入口**"✓：
     * 显示入口时一个事务都不发 ✓，只有用户点开才动这一下 ✓。
     */
    if (locked !== null && selectionBlock !== locked) {
      try {
        const tablePos = view.posAtDOM(locked, 0);
        const caret = firstCaretInTable(view.state, tablePos);
        if (caret !== null) {
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, caret)));
          reportRef.current?.("table-entry-focus", { node: "table" });
        }
      } catch (error) {
        /* 取不到位置（理论上不会 ✓）⇒ 菜单照开，动作那边还会再挡一次 ✗ */
        reportRef.current?.("table-entry-focus-failed", String(error));
      }
    }
    setMenuOpen(true);
    /* 位置要等下一帧（光标可能刚被放进表格 ✓）⇒ 走同一套 rAF 合并 ✓ */
    if (menuFrameRef.current !== null) return;
    menuFrameRef.current = requestAnimationFrame(() => {
      menuFrameRef.current = null;
      syncMenuRef.current();
    });
  }, []);

  /** 合并到下一帧再算 ✓（点击、方向键、输入、输入法结束、容器尺寸/滚动都会走这里 ✓） */
  const scheduleMenu = useCallback((): void => {
    if (menuFrameRef.current !== null) return;
    menuFrameRef.current = requestAnimationFrame(() => {
      menuFrameRef.current = null;
      syncMenu();
    });
  }, [syncMenu]);

  /** 关掉菜单并把焦点还给正文 ✓（Esc / 点外面 / 执行完动作都走它 ✓） */
  const dismissMenu = useCallback((): void => {
    setMenuOpen(false);
    /* 关掉菜单 ⇒ **解锁**操作对象 ✓（下次按悬停/选区重新决定 ✓） */
    menuBlockRef.current = null;
    viewRef.current?.focus();
  }, []);

  /* `openMenu` 定义在前面 ⇒ 用 ref 指向最新的 `syncMenu` ✓（避免"先用后定义"✗） */
  useEffect(() => {
    syncMenuRef.current = syncMenu;
  }, [syncMenu]);

  /**
   * **点正文下方那块空白 ⇒ 落到"末尾的空段落"** ✓（用户实测：在最后一个块下面点一下毫无反应，
   * 于是 `/` 命令在那里根本用不了 ✗ —— 想插表格 / 公式只能先跑回上面回车 ✓）。
   *
   * 只认"落点在**最后一个块的下边缘之下**"这一种情况 ✗（正文里的点击一律交给 ProseMirror 原生 ✓）；
   * 末尾已经是空段落就用它、否则在末尾插一个 ✓（见 `trailingParagraphTarget` ✓）。
   */
  const placeTrailingCaret = useCallback((view: ProseMirrorView, event: MouseEvent): boolean => {
    if (!isPlainClick(event)) return false;
    /*
     * **点编辑器自己的浮动 UI 不算"点正文下方空白"** ✗。
     *
     * 为什么需要 ✗：工具栏（`.milkdown-toolbar`）是 `.milkdown` 的子节点、但**在 `.ProseMirror` 外面**
     * ✓；它在选区**下方**（空间不够时 Crepe 会翻到下面）时，点击坐标落点 > 最后一个块 bottom ✓
     * ⇒ 这条"空白兜底"会插一个空段落并移动选区 ✗ —— 实测会把链接输入框当场关掉
     * （Crepe 的 LinkEditTooltip 发现选区被改 ⇒ `_reset()` 隐藏 ✗），其它按钮也会顺手加空段 ✗。
     * 这里一律排除编辑器里的浮动 UI / 菜单 / 手柄 ✓（点它们就该只执行它们自己的动作 ✓）。
     */
    const clicked = event.target instanceof Element ? event.target : null;
    if (clicked !== null && clicked.closest(EDITOR_FLOATING_UI_SELECTOR) !== null) return false;
    /* 一次点击只处理一次 ✓（`handleClick` 主路径处理过之后，root 上的兜底监听不该再来一遍 ✓） */
    const marked = event as MouseEvent & { knTrailingHandled?: boolean };
    if (marked.knTrailingHandled === true) return true;
    const last = view.dom.lastElementChild as HTMLElement | null;
    const rect = last === null ? null : last.getBoundingClientRect();
    /* 没有块 / 拿不到矩形 ⇒ 视作"在空白里"（例如空文档 ✓） */
    if (rect !== null && event.clientY <= rect.bottom) return false;
    const target = trailingParagraphTarget(view.state);
    if (target === null) return false;
    marked.knTrailingHandled = true;
    const { state } = view;
    if (target.insert) {
      const paragraph = state.schema.nodes.paragraph?.createAndFill();
      if (paragraph === null || paragraph === undefined) return false;
      const transaction = state.tr.insert(target.pos, paragraph);
      transaction.setSelection(TextSelection.create(transaction.doc, target.pos + 1));
      view.dispatch(transaction);
    } else {
      view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, target.pos)));
    }
    if (!view.hasFocus()) view.focus();
    reportRef.current?.("editor-blank-click", { insert: target.insert });
    return true;
  }, []);

  /**
   * **点行内公式小浮窗的「完成」⇒ 收起浮窗** ✓。
   *
   * 为什么需要额外做一步 ✗：Crepe 的确认按钮只在 pointerdown 里更新数学值（`updateValue`），
   * 它自己**不隐藏**浮窗 ✗ —— 浮窗的显示条件是"选区是 math_inline 节点选择" ✓，
   * 而按钮的 pointerdown 被 `preventDefault` 了 ⇒ 选区不变 ⇒ 浮窗一直挂着 ✗（用户实测反馈 ✓）。
   * 这里在 Crepe 更新完值之后（0ms 定时器，晚于它同步的 pointerdown 处理器 ✓）把选区挪到公式**后面**
   * 的文字位置 ⇒ 选区不再是节点选择 ⇒ 浮窗自然收起 ✓，焦点也回到正文继续输入 ✓。
   */
  const dismissLatexInlineEditor = useCallback((): void => {
    const view = viewRef.current;
    if (view === null) return;
    const { state } = view;
    const selection = state.selection;
    if (!(selection instanceof NodeSelection) || selection.node.type.name !== "math_inline") return;
    view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, selection.to)));
    if (!view.hasFocus()) view.focus();
  }, []);

  /**
   * **关掉块菜单** ✓（Esc / 点外面 / 插入完成都会走这里 ✓）。
   *
   * 焦点策略：只有"还留在编辑器里"的关闭才把焦点还给正文 ✓ ——
   * 点了别的面板（例如右上角设置）时**不许**抢回来 ✗（`blockMenuOutsideRef` 在捕获阶段记下来源 ✓）。
   */
  const closeBlockMenu = useCallback((): void => {
    setBlockMenu(null);
    if (blockMenuOutsideRef.current) {
      blockMenuOutsideRef.current = false;
      return;
    }
    viewRef.current?.focus();
  }, []);

  /**
   * **选中块菜单的一项 ⇒ 准备空段落 ⇒ 执行 Crepe 的同源命令** ✓。
   *
   * 顺序不能反 ✗：`prepareAfterBlockInsertion` / `prepareContextInsertion` 会派发一次选区事务，
   * 命令（`setBlockTypeCommand` / `addBlockTypeCommand` …）作用在刚准备好的空段落上 ✓。
   */
  const runBlockMenuItem = useCallback((key: string): void => {
    const view = viewRef.current;
    const crepe = crepeRef.current;
    const current = blockMenu;
    setBlockMenu(null);
    if (view === null || crepe === null || current === null || readOnlyRef.current || !view.editable) return;
    let item: BlockMenuItemData | undefined;
    for (const group of current.groups) {
      item = group.items.find((entry) => entry.key === key);
      if (item !== undefined) break;
    }
    if (item === undefined) {
      reportRef.current?.("block-menu-missing-item", { key });
      return;
    }
    const prepared = current.mode === "after"
      ? prepareAfterBlockInsertion(view, current.anchor)
      : prepareContextInsertion(view, current.anchor);
    if (!prepared) {
      reportRef.current?.("block-menu-prepare-failed", { key, mode: current.mode });
      return;
    }
    try {
      crepe.editor.action((ctx: Ctx) => { item.onRun?.(ctx); });
      reportRef.current?.("block-menu-insert", { key, mode: current.mode });
    } catch (error) {
      reportRef.current?.("block-menu-insert-failed", { key, error: String(error) });
    }
    if (!view.hasFocus()) view.focus();
    scheduleMenu();
  }, [blockMenu, scheduleMenu]);

  /**
   * 块菜单开着时**记下这次 pointerdown 落在哪** ✓（捕获阶段，早于宿主 Menu 自己的"点外面关掉"✓）。
   * 宿主菜单 portal 在 body ⇒ 用 `composedPath()` 判"编辑器 / 菜单"最可靠 ✓
   * （与 `design/table-menu-shadow-dom-review.md` 同一个坑 ✓）。
   */
  useEffect(() => {
    if (blockMenu === null) return undefined;
    blockMenuOutsideRef.current = false;
    const onPointerDown = (event: PointerEvent): void => {
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      const host = hostRef.current;
      const insideEditor = host !== null && path.includes(host);
      const insideMenu = path.some((node) => node instanceof Element && node.getAttribute("role") === "menu");
      blockMenuOutsideRef.current = !insideEditor && !insideMenu;
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => { document.removeEventListener("pointerdown", onPointerDown, true); };
  }, [blockMenu]);

  /**
   * **普通单击 → 直接落下合法文字位置** ✓（`design/table-click-jitter-and-caret-analysis.md` ✓）。
   *
   * 接在 ProseMirror 的 **`handleClick`** 上：它在它默认的 `selectClickedLeaf` **之前**跑 ✓，
   * 返回 `true` 就表示"这次点击我处理了"⇒ ProseMirror 不会再建那个结构节点选择 ✓。
   *
   * 为什么不再用"mouseup + 微任务纠正" ✗：那等于**先**让原组件完成一次节点选择、
   * 插件**再**改成文字选区 ⇒ 两次选区/聚焦/滚动（复查点名的抖动嫌疑来源 ✓），
   * 竖线也会晚一拍出现 ✓。现在只有一次选区变化 ✓。
   */
  const placeTableCaret = useCallback((view: ProseMirrorView, event: MouseEvent): boolean => {
    if (!isPlainClick(event)) return false;
    const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
    const target = caretTargetForClick(view.state, coords ?? null);
    /*
     * **留痕**（复查明确要求：不能只以"注册了 handleClick"当完成证据 ✓）：
     * 记下"这次点击有没有走到这里、坐标解析成什么、有没有算出位置"✓（不含正文 ✗）。
     * 只在**表格相关**的点击上记 ✓（普通段落点击不刷屏 ✓）。
     */
    const inTable = readTableContext(view.state).inTable;
    if (coords !== null && (coords.inside !== -1 || inTable)) {
      reportRef.current?.("table-click-handle", {
        inside: coords.inside,
        target: target === null ? "none" : "caret",
      });
    }
    if (target === null) return false;
    /* 点一下本来就已经聚焦了 ⇒ 正常情况下这次 `focus()` 不会执行 ✓（只有键盘/外部触发才需要 ✓） */
    if (!view.hasFocus()) view.focus();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target)));
    reportRef.current?.("table-caret-fix", { node: view.state.selection.$from.parent.type.name });
    return true;
  }, []);

  /**
   * 执行一个表格动作 ✓。
   *
   * 为什么必须走 `editor.action`：命令要拿**编辑器自己的 ctx**（`commandsCtx` 的命令表、
   * `editorViewCtx` 的当前视图 ✓），另建一套等于对着另一个编辑器下命令 ✗。
   * - 插行/插列/对齐用 Milkdown 的表格命令 ✓（插行会带上本列的 alignment ✓）；
   * - 删行/删列用 prosemirror-tables 的 `deleteRow` / `deleteColumn` ✓ ——
   *   它按**当前选区**定位，不需要我们先"选中整行再删" ✓。
   */
  const runTableAction = useCallback((action: TableMenuAction): void => {
    const crepe = crepeRef.current;
    const view = viewRef.current;
    /*
     * **动手前再确认一次** ✓：菜单位置/显隐是"下一帧"才算出来的 ⇒ 这一拍选区可能已经跑掉了。
     * `deleteRow` / `addColumnBefore` 这类命令在表格外会抛 `RangeError` ✗
     * ⇒ 与其把异常丢进事件处理器（ErrorBoundary 只接渲染错误 ✗），不如查一次并安静收起 ✓。
     */
    if (
      crepe === null || view === null || !readyRef.current || failedRef.current
      || !readTableContext(view.state).inTable
    ) {
      setMenu(null);
      setMenuOpen(false);
      return;
    }
    try {
      /*
       * 移动类动作先算出参数（纯函数 ✓；复查要求"边界时禁用对应方向" ⇒ 这里再挡一次 ✗）。
       * `moveRowCommand` / `moveColCommand` 最终落到 `prosemirror-tables` 的整体搬移 ✓：
       * 单元格内容、列对齐、列宽跟着走，走事务 ⇒ 可撤销 ✓，不是删了再插、也不动 DOM ✗。
       */
      const moving = action === "row-up" || action === "row-down" || action === "col-left" || action === "col-right";
      const moveState = moving ? readTableMoveState(view.state) : null;
      const move = moving && moveState !== null ? movePayload(action, moveState) : null;
      if (moving && move === null) {
        /* 到了边界 / 选中的是多行多列 / 表里有合并单元格 ⇒ 不猜、不动 ✓ */
        reportRef.current?.("table-action-blocked", { action });
        setMenuOpen(false);
        scheduleMenu();
        return;
      }
      crepe.editor.action((ctx: Ctx) => {
        const commands = ctx.get(commandsCtx);
        switch (action) {
          case "row-before": {
            /*
             * **表头行上方插行 = 禁用** ✓（用户两轮实测之后的最终口径 ✓）。
             *
             * 为什么不能插：GFM 的内容模型是 `table_header_row table_row+` ✓ ⇒
             * 把普通行插到表头前面**不合法** ✓ ⇒ 事务的 `Fitter` 会把表格**拆成两张** ✗（第一张截图 ✓）。
             * 中间试过"新行当表头、旧表头降级"✓，用户实测后否决 ✗：
             * 第一行常常就是**段名** ✓ ⇒ 让它悄悄变成第二行同样很怪 ✓。
             *
             * 菜单里这一项在表头行上已经**禁用并说明原因** ✓（下面 `disabledActions` ✓）；
             * 这里再挡一次是**防御** ✓ —— 别让键盘 / 程序路径绕过菜单派发一份不合法的事务 ✗。
             */
            const rowTypes = tableRowTypes(view.state.schema);
            if (rowTypes !== null && inFirstTableRow(view.state, rowTypes)) {
              reportRef.current?.("table-action-blocked", { action, reason: "header-row" });
              break;
            }
            commands.call(addRowBeforeCommand.key);
            break;
          }
          case "row-after": commands.call(addRowAfterCommand.key); break;
          case "col-before": commands.call(addColBeforeCommand.key); break;
          case "col-after": commands.call(addColAfterCommand.key); break;
          case "align-left": commands.call(setAlignCommand.key, "left"); break;
          case "align-center": commands.call(setAlignCommand.key, "center"); break;
          case "align-right": commands.call(setAlignCommand.key, "right"); break;
          case "row-up":
          case "row-down": {
            if (move !== null) commands.call(moveRowCommand.key, { from: move.from, to: move.to });
            break;
          }
          case "col-left":
          case "col-right": {
            if (move !== null) commands.call(moveColCommand.key, { from: move.from, to: move.to });
            break;
          }
          case "table-delete": { deleteTable(view.state, view.dispatch); break; }
          case "row-delete": {
            const view = ctx.get(editorViewCtx) as ProseMirrorView;
            deleteRow(view.state, view.dispatch);
            break;
          }
          case "col-delete": {
            const view = ctx.get(editorViewCtx) as ProseMirrorView;
            deleteColumn(view.state, view.dispatch);
            break;
          }
        }
      });
    } catch (error) {
      /* 命令自己拒绝（例如选区在两次读取之间变了）⇒ 收起菜单、把原因留给诊断 ✓ */
      reportRef.current?.("table-action-failed", `${action}: ${String(error)}`);
      setMenu(null);
    }
    /*
     * 做完一件事就**收起菜单**、把焦点还给正文 ✓（复查要求"操作后回到正文" ✓）。
     * 不重新打开：用户要连着改结构，再点一次入口就行 ✓（常驻工具栏正是要避免的东西 ✗）。
     */
    setMenuOpen(false);
    view.focus();
    /* 动作改了文档与选区 ⇒ 下一帧重算位置与对齐高亮 ✓ */
    scheduleMenu();
  }, [scheduleMenu]);

  useEffect(() => {
    const root = hostRef.current;
    if (root === null) return undefined;
    /*
     * **按本次挂载的实例**取消 ✗（P1-1）：StrictMode 会跑两遍 effect，
     * 用共享的 disposedRef 会被第二遍重置 ⇒ 第一遍的实例"复活" ✗。
     */
    let cancelled = false;
    disposedRef.current = false;
    readyRef.current = false;
    failedRef.current = false;

    /*
     * **Mermaid 渲染器**（`design/mermaid-note-blocks.md` ✓）。
     *
     * 为什么每个编辑器实例建一个 ✗：它自己持有防抖计时器 / 代次 / 串行队列 ✓；
     * 切节点重开编辑器时旧的必须整体失效 ✓（`dispose()` 见下面的清理 ✓）。
     * 建在 `new Crepe` **之前** ✓：code-mirror 特性的 `renderPreview` 要在构造配置里就位 ✓。
     */
    const mermaid = createMermaidRenderer({
      root,
      labels: () => ({
        copy: tRef.current("mermaidCopyCode"),
        download: tRef.current("mermaidDownloadImage"),
        failed: tRef.current("mermaidRenderFailed"),
        runtimeUnavailable: tRef.current("mermaidRuntimeUnavailable"),
      }),
      /*
       * **文档里现有的代码块清单** ✓：异步渲染回来时要确认"那一块现在还是 mermaid 吗" ✓
       * —— 用户可能已经把语言改成 LaTeX / 普通代码了 ✗（LaTeX 由 latex 特性直接接管，
       * 不会通知我们的 `renderPreview` ✗）。从 ProseMirror 状态取才准 ✓（DOM 里的 CodeMirror
       * 会在失焦后被拆掉 ✗）。
       */
      blocks: () => {
        const view = viewRef.current;
        if (view === null) return [];
        const found: Array<{ language: string; text: string }> = [];
        view.state.doc.descendants((node: ProseMirrorNode) => {
          if (node.type.name !== "code_block") return true;
          found.push({ language: String(node.attrs.language ?? ""), text: node.textContent });
          return false;
        });
        return found;
      },
      report: (step, detail) => { reportRef.current?.(step, detail); },
    });

    const crepe = new Crepe({
      root,
      /* **进来时补显式空标题** ✓：`![](...)` ⇒ `![](... "")` ✓（见 `withExplicitImageTitles` ✓） */
      defaultValue: withExplicitImageTitles(initialRef.current),
      /*
       * 只启用在文档里明确列出的能力 ✓。
       *
       * **图片块现在启用了** ✓（用户实测要求："图片插到哪去了"✗）：
       * 不是让 Crepe 用它默认的 `blob:` URL ✗，而是配上我们自己的 `onUpload` ✓ ——
       * 真的写进 `<库根>/<imageDir>/` ✓（默认 `.dsh_knowledge/image/` ✓，可配置 ✓），
       * Markdown 里落的也是**库内相对路径** ✓（笔记挪到别的编辑器也读得懂 ✓）。
       * AI 仍然关闭 ✗。
       */
      features: {
        [CrepeFeature.AI]: false,
      },
      /*
       * **文案与行为配置**（`design/math-editor-ui-design.md` ✓）。
       *
       * 为什么需要：公式块在 Crepe 里**复用**了通用代码块的界面（latex 特性扩展的就是
       * codeBlockSchema ✓）⇒ 默认会露出 "Search language / Preview / Hide / Copy" ✗。
       * 这里用**官方配置项**换成中文与更贴切的措辞 ✓，而不是靠 CSS 假装替换文字 ✗
       * （文档明确要求：能用配置就用配置 ✓）。
       */
      featureConfigs: {
        /*
         * **空段落 / 空引用的输入提示** ✓（用户实测：引用块里只显示英文 "Please enter..." ✗）。
         * 用 Crepe 官方 `Placeholder` 配置项换成中文 ✓（`mode` 默认 block：任意空文本块都提示 ✓）。
         */
        [CrepeFeature.Placeholder]: {
          text: t("editorPlaceholder"),
        },
        /*
         * **链接输入框的文案** ✓：原来点「链接」后弹的是英文 "Paste link..." ✗ ——
         * 与工具栏中文名不一致 ✓（用户要求"补齐中文名称" ✓）；用 Crepe 官方配置项换掉 ✓。
         */
        [CrepeFeature.LinkTooltip]: {
          inputPlaceholder: t("inlineLinkPlaceholder"),
        },
        [CrepeFeature.Toolbar]: {
          boldLabel: t("inlineBold"), italicLabel: t("inlineItalic"),
          strikethroughLabel: t("inlineStrike"), codeLabel: t("inlineCode"),
          latexLabel: t("inlineMath"), linkLabel: t("inlineLink"),
          buildToolbar: (builder) => {
            builder.addGroup("kn-format", t("inlineFormat")).addItem("clear", {
              label: t("inlineClear"),
              icon: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="m16.2 3.3 4.5 4.5a2 2 0 0 1 0 2.8l-8 8H21v2H8.6l-5.3-5.3a2 2 0 0 1 0-2.8l10-9.2a2 2 0 0 1 2.9 0ZM10 9l-5.3 5 4.6 4.6h.7l4.6-4.6L10 9Z"/></svg>',
              active: () => false,
              onRun: (ctx) => { clearInlineFormat(ctx.get(editorViewCtx) as ProseMirrorView); },
            });
            /*
             * **「＋ 添加前置节点」并进同一个工具栏** ✓（`design/inline-format-fix.md` §2.6 ✓）：
             * 它以前是贴着选区的单独浮钮 ✗ ⇒ 和这条格式化工具栏互相遮挡（用户截图 ✓）。
             * 只有父面板给了回调才加这一项 ✓（独立挂编辑器的测试里不会多出一个死按钮 ✗）。
             */
            if (onAddPrerequisiteRef.current === undefined) return;
            builder.addGroup("kn-relation", t("relAddFromSelection")).addItem("add-prerequisite", {
              label: t("relAddFromSelection"),
              icon: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M13 3h2v6h6v2h-6v6h-2v-6H7v-2h6V3ZM5 19h14v2H5v-2Z"/></svg>',
              active: () => false,
              onRun: (ctx) => {
                const view = ctx.get(editorViewCtx) as ProseMirrorView;
                const { from, to } = view.state.selection;
                if (from === to) return;
                const text = view.state.doc.textBetween(from, to, " ").trim();
                if (text !== "") onAddPrerequisiteRef.current?.(text);
              },
            });
          },
        },
        [CrepeFeature.BlockEdit]: {
          /*
           * **块菜单条目来源** ✓（`design/editor-block-menu-redesign.md` ✓）。
           *
           * `buildMenu` 是 Crepe 的官方扩展点 ✓；这里只把 builder 快照留下来 ✓ ——
           * 右键菜单直接复用它的 label / icon /命令（`onRun`）✓，命令行为与旧斜杠菜单完全同源 ✓。
           * Crepe 自己的斜杠 UI 由构建补丁关掉 ✗（`scripts/slash-menu-patch.mjs` ✓）——
           * 用户反馈输入 `/` 会误判，所以触发入口只保留**右键**与 **＋ 手柄** ✓。
           */
          buildMenu: (builder) => {
            blockMenuBuilderRef.current = builder;
          },
        },
        [CrepeFeature.CodeMirror]: {
          searchPlaceholder: "搜索语言…",
          noResultText: "没有匹配的语言",
          copyText: "复制",
          /* 「PREVIEW」大写标签 → 轻量的「结果」✓（不常驻大写标签 ✓） */
          previewLabel: "结果",
          previewToggleButton: (previewOnlyMode: boolean) => (previewOnlyMode ? t("editorEditSource") : t("editorResultOnly")),
          /*
           * ⚠️ Crepe 的 code-mirror 特性用的是 **`previewToggleText`** ✗（不是基类的
           * `previewToggleButton` ✓）—— 只配后者的话按钮上仍是英文 "Hide" ✓（截图实测 ✓）。
           * 两个都配上 ✓，谁生效都对 ✓。
           */
          previewToggleText: (previewOnlyMode: boolean) => (previewOnlyMode ? t("editorEditSource") : t("editorResultOnly")),
          previewLoading: "渲染中…",
          previewOnlyByDefault: true,
          /* 代码/公式源码**成套**的编辑主题 ✓（见 KN_CODE_THEME ✓） */
          theme: KN_CODE_THEME,
          extensions: [syntaxHighlighting(KN_CODE_HIGHLIGHT)],
          /*
           * **语言列表补上 mermaid** ✓（CodeMirror 自带的数据里没有它 ✗）——
           * 否则用户只能靠粘贴 / 已有笔记得到 mermaid 围栏 ✓，没法从界面上新建 ✓。
           */
          languages: CODE_BLOCK_LANGUAGES,
          /*
           * **Mermaid 图块的预览** ✓：Crepe 的接口约定是
           * `null` = 没预览 ✓、`undefined` = 异步渲染中 ✓（渲染完再回填 ✓）。
           * 普通代码块 / 公式块照旧走它自己的路径 ✓（公式块由 latex 特性在外层再包一层 ✓）。
           */
          renderPreview: mermaid.renderPreview,
        },
        [CrepeFeature.Latex]: {
          /* 行内公式局部编辑的确认按钮 ✓（只提交到草稿，不等于保存文件 ✓） */
          inlineEditConfirm: "完成",
        },
        /*
         * **光标**（`design/table-click-jitter-and-caret-analysis.md` 建议 2 ✓）：
         * Crepe 的 Cursor 特性默认装 `prosemirror-virtual-cursor`，它会
         * `.ProseMirror.virtual-cursor-enabled { caret-color: transparent }` ⇒ **不是原生光标** ✗，
         * 竖线是绝对定位的虚拟元素，颜色还取自 `--crepe-color-outline`（暗色下对比太低 ✗）。
         * `virtual: false` 时 Crepe **根本不装那个插件**（`cursor` 特性里就那一句判断 ✓）
         * ⇒ 原生插入光标回来了 ✓，颜色跟随正文 ✓。
         *
         * 代价：虚拟光标顺带提供的**行内代码边界提示**（`skipWarning: ["inlineCode"]`）没有了 ✓；
         * 复查要求"优先用原生光标实现普通文本框效果"✓，所以接受这个取舍 ✓
         * （想回退就把这一行删掉，同时用下面的 `--prosemirror-virtual-cursor-color` 把颜色改成正文色 ✓）。
         */
        [CrepeFeature.Cursor]: {
          virtual: false,
        },
        /*
         * **图片：存到库里，而不是内存里** ✓。
         * `onUpload` 的返回值会被写成图片的 `src` ✓ ⇒ 这里回**库内相对路径** ✓
         * （显示时由 `applyImageSources` 换成同源 URL ✓）。
         */
        [CrepeFeature.ImageBlock]: {
          /*
           * ⚠️ Crepe 的**类型**与**运行期**在这两个键上不一致 ✗（老毛病 ✓，
           * 跟当年 `previewToggleText` / `previewToggleButton` 那次一样 ✓）：
           * 运行期读的是 `uploadButton` ✓，而 `Partial<ImageBlockConfig>` 里没声明它 ✗。
           * ⇒ 两个都写上（谁生效都对 ✓），并显式断言类型 ✓ —— 别为了过类型把运行期那句删掉 ✗。
           */
          uploadButton: t("imageUploadButton"),
          /* 那两个提示原来跟的是 Crepe 的英文默认值 ✗（截图里 "Write Image Caption" ✓） */
          uploadPlaceholderText: t("imageUploadPlaceholder"),
          captionPlaceholderText: t("imageCaptionPlaceholder"),
          confirmButton: t("imageConfirm"),
          onUpload: (file: File) => uploadNoteImage(file, props.target as Record<string, unknown> | undefined),
          /*
           * ⚠️ Crepe 的图片有**两套键名** ✗（`*` 与 `block*` ✓，实测产物里两套都有人读 ✓）：
           * 块级图片读的是 `block*` 那套 ✓ —— 只配一套的话，
           * 上传/文案会掉回它的默认值 ✓（用户截图里那句英文 "Write Image Caption" 就是这么来的 ✓）。
           * ⇒ 两套都写上 ✓，谁生效都对 ✓。
           */
          blockUploadButton: t("imageUploadButton"),
          blockUploadPlaceholderText: t("imageUploadPlaceholder"),
          blockCaptionPlaceholderText: t("imageCaptionPlaceholder"),
          blockConfirmButton: t("imageConfirm"),
          blockOnUpload: (file: File) => uploadNoteImage(file, props.target as Record<string, unknown> | undefined),
          /* 万一还有别的加载失败原因 ✓，留一条证据 ✓（`kn_status` 里看得到 ✓） */
          onImageLoadError: (src: string) => { reportRef.current?.("image-load-error", { src }); },
        } as never,
      },
    });
    // Markdown parsers return null for an empty title; the image schema requires a string.
    crepe.editor.config((ctx) => {
      ctx.update(imageBlockSchema.key, (previous) => (inner) => {
        const schema = previous(inner);
        return {
          ...schema,
          parseMarkdown: {
            ...schema.parseMarkdown,
            runner: (state, node, type) => schema.parseMarkdown.runner(state, { ...node, title: typeof node.title === "string" ? node.title : "" }, type),
          },
        };
      });
    });
    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown, previous) => {
        /*
         * **同步期间一律不算用户修改** ✗（P2-5）：初始化解析、`replaceAll` 外部替换
         * 都会走到这里；靠 `markdown === previous` 判断是不够的 ✗。
         */
        if (cancelled || syncingRef.current) return;
        if (markdown === previous) return;
        /* 异步回声：内容等于我们刚注入的那份 ⇒ 不是用户修改 ✓ */
        if (echoRef.current !== null && markdown === echoRef.current) {
          echoRef.current = null;
          return;
        }
        echoRef.current = null;
        pendingRef.current = null;
        onChangeRef.current(markdown);
      });
    });
    /* 输入法组合：组合期间取到的内容可能是不完整的 ⇒ flush 返回 null，保存要等组合结束 ✓（P2-7） */
    const onCompositionStart = (): void => {
      composingRef.current = true;
      emitStatus();
    };
    const onCompositionEnd = (): void => {
      composingRef.current = false;
      emitStatus();
      /* 组合结束即视为一次用户修改：此时再把当前 Markdown 交出去 ✓ */
      const crepeNow = crepeRef.current;
      if (crepeNow !== null && !syncingRef.current) onChangeRef.current(crepeNow.getMarkdown());
    };
    root.addEventListener("compositionstart", onCompositionStart, true);
    root.addEventListener("compositionend", onCompositionEnd, true);

    /*
     * **表格入口的触发条件**：选区变了就重算 ✓ ——
     * 点击、方向键、输入、输入法结束都会走到 `scheduleMenu` ✓（rAF 合并 ✓）。
     */
    const onSelectionChanged = (): void => { scheduleMenu(); };
    root.addEventListener("pointerup", onSelectionChanged, true);
    root.addEventListener("keyup", onSelectionChanged, true);
    root.addEventListener("focusin", onSelectionChanged, true);
    root.addEventListener("compositionend", onSelectionChanged, true);
    document.addEventListener("selectionchange", onSelectionChanged);
    window.addEventListener("resize", onSelectionChanged);
    /*
     * **Shadow DOM 里的选区事件**：面板整个跑在 ShadowRoot 内 ✓，
     * 选区变化不一定在 `document` 上冒出来（`document.getSelection()` 也看不到影子树里的选区 ✗）
     * ⇒ 影子根上再挂一个 ✓（`design/table-menu-shadow-dom-review.md` 要求顺带检查这类逻辑 ✓）。
     */
    const shadowRoot = typeof ShadowRoot !== "undefined" && root.getRootNode() instanceof ShadowRoot
      ? (root.getRootNode() as ShadowRoot)
      : null;
    shadowRoot?.addEventListener("selectionchange", onSelectionChanged);

    /*
     * **悬停表格 ⇒ 入口出现** ✓（复查 P2a：原来只有"selection 在表格里"才显示 ⇒ 用户找不到 ✓）。
     * 只记 hover 的表格块，**不改选区** ✗（选区只在用户点开菜单时才动 ✓，见 `openMenu`）。
     * 指针从表格移到入口那一瞬间会冒 `pointerleave` ✗ ⇒ 看 `relatedTarget`，是入口就不撤 ✓。
     */
    const onPointerOver = (event: Event): void => {
      const target = event.target as Element | null;
      if (target === null || typeof target.closest !== "function") return;
      const block = target.closest<HTMLElement>(".milkdown-table-block");
      if (block === hoverBlockRef.current) return;
      hoverBlockRef.current = block;
      scheduleMenu();
    };
    const onPointerLeaveRoot = (event: Event): void => {
      const next = (event as PointerEvent).relatedTarget as Element | null;
      if (next !== null && typeof next.closest === "function" && next.closest(".kn-table-entry, .kn-table-menu") !== null) {
        return; /* 正要去点入口 / 菜单 ⇒ 保持锚点 ✓ */
      }
      if (hoverBlockRef.current === null) return;
      hoverBlockRef.current = null;
      scheduleMenu();
    };
    root.addEventListener("pointerover", onPointerOver, true);
    root.addEventListener("pointerleave", onPointerLeaveRoot, true);

    /*
     * **记下"落点在单元格里的普通点击"** ✓（`design/table-functions-recheck-2.md` P1 ✓）。
     *
     * 上游 `TableNodeView.stopEvent` 在 mousedown / pointerdown 阶段就返回 `true` ✗
     * ⇒ ProseMirror 不处理这次点击、我们挂在 `handleClick` 上的主路径**也不会被调用** ✓；
     * 它自己在 rAF 之后派发一个"整段的结构选择"✗。改写它需要坐标 ⇒ 这里先记下来 ✓。
     * 用**捕获**阶段：不管谁中间 `stopPropagation` 都拿得到 ✓。
     */
    const onPointerDownRecord = (event: Event): void => {
      const mouse = event as MouseEvent;
      if (!isPlainClick(mouse)) return;
      const target = event.target as Element | null;
      if (target === null || typeof target.closest !== "function") return;
      /* 只记表格单元格里的点击（表格外的结构选择本来就是 ProseMirror 正常行为 ✓） */
      if (target.closest("td, th") === null) {
        lastClickRef.current = null;
        return;
      }
      lastClickRef.current = { x: mouse.clientX, y: mouse.clientY, at: Date.now() };
    };
    root.addEventListener("pointerdown", onPointerDownRecord, true);
    root.addEventListener("mousedown", onPointerDownRecord, true);

    /*
     * **兜底（复查 P1）**：`handleClick` 那条主路径在真实环境里可能没兜住（复查实测仍是整段选择 ✗）。
     * 点击结束后看一眼**最终选区**：如果还是"单元格里 textblock 的结构选择"，就按点击坐标改成文字位置 ✓。
     * 主路径成功时选区已经是 TextSelection ⇒ 这里什么都不做 ✗（不会产生第二次变化 ✓）。
     */
    const onMouseUpFallback = (event: MouseEvent): void => {
      if (!isPlainClick(event)) return;
      const { clientX, clientY } = event;
      queueMicrotask(() => {
        const view = viewRef.current;
        if (view === null) return;
        const coords = view.posAtCoords({ left: clientX, top: clientY });
        const target = caretTargetForSelection(view.state, coords ?? null);
        if (target === null) return;
        reportRef.current?.("table-click-fallback", { action: "caret", node: view.state.selection.constructor.name });
        if (!view.hasFocus()) view.focus();
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target)));
      });
    };
    root.addEventListener("mouseup", onMouseUpFallback, true);

    /*
     * **正文下方空白的兜底**（用户实测那条 ✗）：主路径挂在 ProseMirror 的 `handleClick` 上，
     * 它只对**落在可编辑元素里**的点击生效；万一那块空白不在 `.ProseMirror` 内（高度没撑满 / 浏览器差异 ✓），
     * 这里再兜一次 ✓。`placeTrailingCaret` 自带"一次点击只处理一次"的标记 ⇒ 不会重复落光标 ✓。
     */
    /**
     * **"这一次按下是不是从编辑器浮动 UI 开始的"** ✓。
     *
     * 为什么 click 时看 target 不够 ✗：点工具栏「链接」⇒ 命令把焦点给输入框 ⇒ Crepe 工具栏
     * 在 pointerup/click 之前就隐藏了 ✗ ⇒ 同一坐标的 click 落在工具栏原本盖住的空白上，
     * target 已经不是工具栏 ✓ ⇒ 会被误当成"点正文下方空白"、插空段落并关掉链接输入框 ✗
     * （实测 show 后 ~13ms 就关，用户看到一闪而过 ✓）。
     * 所以在**按下那一刻**（target 还准确）记下来，click 兜底看到标记就不再动作 ✓。
     */
    let pressedFloatingUi = false;
    const onRootPointerDownTrack = (event: PointerEvent): void => {
      const target = event.target instanceof Element ? event.target : null;
      pressedFloatingUi = target !== null && target.closest(EDITOR_FLOATING_UI_SELECTOR) !== null;
    };
    root.addEventListener("pointerdown", onRootPointerDownTrack, true);
    const onBlankAreaFallback = (event: MouseEvent): void => {
      if (pressedFloatingUi) {
        pressedFloatingUi = false;
        return;
      }
      const view = viewRef.current;
      if (view === null || !readyRef.current || failedRef.current) return;
      placeTrailingCaret(view, event);
    };
    root.addEventListener("click", onBlankAreaFallback);

    /*
     * **右键 ⇒ 块插入菜单** ✓（用户要求：把 `/` 触发改成右键弹窗 ✓，
     * `design/editor-block-menu-redesign.md` ✓）。
     *
     * 这些位置**不接管** ✓（保留用户熟悉的原有菜单）：
     * - 表格单元格：表格自己的行列操作菜单（`onTableContext` ✓，README 承诺过 ✓）；
     * - 代码块 / 图片块：浏览器原生菜单（复制源码、保存图片 ✓）；
     * - 编辑器里的浮动工具（工具栏 / 链接预览 / 语言选择 / 表格菜单 / 块手柄 ✓）；
     * - 已有**非空文字选区**：多半是想"复制" ✓；
     * - 只读 / 初始化中 / 失败 / 条目快照没拿到 ✓（宁可让原生菜单出现，也不弹空菜单 ✗）。
     */
    const onBlockMenuContext = (event: MouseEvent): void => {
      const view = viewRef.current;
      if (view === null || !readyRef.current || failedRef.current || readOnlyRef.current) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target === null) return;
      if (target.closest("td, th")) return;
      if (target.closest("pre, .milkdown-code-block, .milkdown-image-block") !== null) return;
      if (target.closest(EDITOR_FLOATING_UI_SELECTOR) !== null) return;
      // Keep native copy/cut for text selections; the floating toolbar provides formatting.
      if (!view.state.selection.empty) return;
      const groups = readBlockMenuGroups(blockMenuBuilderRef.current);
      if (groups.length === 0) { reportRef.current?.("block-menu-unavailable", { reason: "no-build-menu" }); return; }
      let anchor = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null;
      /*
       * **正文下方那块空白** ✓：与左键点击同一套「末尾空段落」兜底 ✓
       * （`trailingParagraphTarget` ✓）—— 那里 `posAtCoords` 给不到可靠位置 ✗。
       */
      const last = view.dom.lastElementChild as HTMLElement | null;
      const lastRect = last === null ? null : last.getBoundingClientRect();
      if (lastRect !== null && event.clientY > lastRect.bottom) {
        const trailing = trailingParagraphTarget(view.state);
        if (trailing !== null) anchor = trailing.pos;
      }
      if (anchor === null) return;
      event.preventDefault();
      event.stopPropagation();
      setBlockMenu({
        x: event.clientX, y: event.clientY, anchor, mode: "context", groups,
      });
      reportRef.current?.("block-menu-open", { via: "context", anchor });
    };
    root.addEventListener("contextmenu", onBlockMenuContext, true);

    /*
     * **`＋` 块手柄 ⇒ 同一个块菜单** ✓（`design/editor-block-menu-redesign.md` ✓）。
     *
     * 上游的加号按钮原本会"插空段落 → 打开自己的斜杠菜单" ✗；斜杠菜单已被构建补丁关掉 ✓
     * ⇒ 这里在**捕获阶段**拦下它 ✓（Vue 的处理器挂在按钮自己身上 ✓），改成
     * "在悬停的顶层块之后插入 + 我们的菜单" ✓。
     * 第二个 `.operation-item` 是拖拽手柄 ⇒ 不拦 ✓（拖动改顺序照旧 ✓）。
     */
    const addButtonOf = (target: EventTarget | null): HTMLElement | null => {
      if (!(target instanceof Element)) return null;
      const item = target.closest<HTMLElement>(".milkdown-block-handle .operation-item");
      if (item === null) return null;
      const first = item.parentElement?.querySelector<HTMLElement>(".operation-item") ?? null;
      return first === item ? item : null;
    };
    const onBlockHandlePointerDown = (event: PointerEvent): void => {
      if (readOnlyRef.current || addButtonOf(event.target) === null) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const onBlockHandlePointerUp = (event: PointerEvent): void => {
      const button = addButtonOf(event.target);
      if (button === null || readOnlyRef.current) return;
      const view = viewRef.current;
      if (view === null || !readyRef.current || failedRef.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const groups = readBlockMenuGroups(blockMenuBuilderRef.current);
      if (groups.length === 0) return;
      /*
       * 悬停块 = **垂直中心离手柄最近**的那个顶层块 ✓
       * （手柄是 floating-ui 贴在那块左边的 ✓，不依赖我们自己的命中算法 ✓）。
       */
      const handleRect = button.getBoundingClientRect();
      const centerY = handleRect.top + handleRect.height / 2;
      let closest: Element | null = null;
      let closestDistance = Number.POSITIVE_INFINITY;
      for (const child of Array.from(view.dom.children)) {
        if (!(child instanceof HTMLElement)) continue;
        const rect = child.getBoundingClientRect();
        if (rect.height <= 0) continue;
        const distance = Math.abs((rect.top + rect.bottom) / 2 - centerY);
        if (distance < closestDistance) { closest = child; closestDistance = distance; }
      }
      let anchor = view.state.selection.from;
      if (closest !== null) {
        try { anchor = view.posAtDOM(closest, 0); } catch { /* 落回当前选区 ✓ */ }
      }
      setBlockMenu({ x: Math.round(handleRect.right + 6), y: Math.round(handleRect.top), anchor, mode: "after", groups });
      reportRef.current?.("block-menu-open", { via: "handle", anchor });
    };
    root.addEventListener("pointerdown", onBlockHandlePointerDown, true);
    root.addEventListener("pointerup", onBlockHandlePointerUp, true);

    /*
     * **代码块"复制"改写成多格式剪贴板** ✓
     * （`design/code-block-copy-paste-analysis.md` ✓）。
     *
     * Crepe 的按钮只 `navigator.clipboard.writeText(裸代码)` ✗ ⇒ 剪贴板里没有"这是个 C++ 代码块"✓
     * ⇒ 粘回正文时被当 Markdown 解析、拆成段落 + 一个 `Text` 块 ✓（用户截图 ✓）。
     * 这里在**捕获阶段**接住这个按钮的点击 ✓：Vue 的处理器挂在按钮自己身上 ✓，
     * 捕获先跑到我们 ✓ ⇒ `stopPropagation()` 之后它不再执行 ✗，
     * 由我们写"纯文本 + HTML + 本插件载荷"三份 ✓（终端体验不变 ✓、正文粘贴保持完整块 ✓）。
     */
    const onCopyClick = (event: Event): void => {
      const view = viewRef.current;
      const target = event.target as Element | null;
      if (view === null || target === null || typeof target.closest !== "function") return;
      const button = target.closest<HTMLElement>(".copy-button");
      if (button === null) return;
      const host = button.closest<HTMLElement>(".milkdown-code-block");
      if (host === null) return;
      const payload = codeBlockAt(view, host);
      if (payload === null) return;
      event.stopPropagation();
      event.preventDefault();
      void writeCodeBlockClipboard(payload)
        .then(() => {
          lastCopiedBlock = { ...payload };
          /* 复制按钮 = 结构化复制 ⇒ 清掉"手动选中复制"的标记 ✓（免得同一段文字被当成纯文本 ✗） */
          lastSelectionCopy = null;
          /* **成功**才给对勾 ✓（写失败时不能显示"已复制" ✗） */
          flashCopied(button);
          reportRef.current?.("code-block-copy", { language: payload.language, chars: payload.code.length });
        })
        .catch((error: unknown) => { reportRef.current?.("code-block-copy-failed", String(error)); });
    };
    root.addEventListener("click", onCopyClick, true);

    /*
     * **代码块 / 公式块里"手动选中复制" ⇒ 只写纯文本** ✓（用户第十三轮要求 ✓）。
     *
     * 为什么需要 ✗：CodeMirror / 预览区默认复制会写 `text/plain + text/html` ✓，
     * 而粘贴路径还会用"刚复制的块"记忆和"纯文本像代码"启发式把内容**还原成块** ✗ ——
     * 用户想要的是：只有点右上角「复制」按钮再粘贴才还原成块 ✓；手动选中复制 = 纯文本 ✓。
     * 这里在捕获阶段改写剪贴板：只留 `text/plain` ✓，清掉复制按钮记忆 ✓、记录本次选中文本 ✓
     * （粘贴时据此走纯文本插入 ✓）。选区不在代码/公式块里时**不动** ✗（普通文字复制保持原样 ✓）。
     */
    const onCopySelection = (event: Event): void => {
      const clip = (event as ClipboardEvent).clipboardData;
      if (clip === null || clip === undefined) return;
      const root = hostRef.current?.getRootNode?.() as Document | ShadowRoot | null;
      const shadowSelection = root !== null && "getSelection" in root
        ? (root as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.() ?? null
        : null;
      const selection = shadowSelection ?? window.getSelection();
      if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return;
      const anchor = selection.anchorNode;
      const element = anchor === null
        ? null
        : anchor.nodeType === 1 ? (anchor as Element) : anchor.parentElement;
      if (element === null || element.closest(".milkdown-code-block") === null) return;
      const text = selection.toString();
      if (text === "") return;
      clip.setData("text/plain", text);
      event.preventDefault();
      lastCopiedBlock = null;
      lastSelectionCopy = text;
      reportRef.current?.("code-block-copy-selection", { chars: text.length });
    };
    root.addEventListener("copy", onCopySelection, true);

    /*
     * **行内公式小浮窗：点「完成」后收起** ✓（用户实测要求 ✓）。
     *
     * Crepe 的确认按钮只在 pointerdown 里更新公式值、**不隐藏浮窗** ✗（按钮 preventDefault 了焦点变化 ⇒
     * 选区仍是 math_inline 节点选择 ⇒ 浮窗的显示条件一直成立 ✗）。这里在 Crepe 处理完之后
     * （0ms 定时器 ✓）把选区挪到公式后面，浮窗自然收起 ✓；pointerdown 与键盘触发的 click 都监听 ✓
     * （同一次操作最多跑两次，`dismissLatexInlineEditor` 在选区已不是节点选择时直接返回 ✓）。
     */
    const onLatexInlineConfirm = (event: Event): void => {
      const target = event.target as Element | null;
      if (target === null || typeof target.closest !== "function") return;
      if (target.closest(".milkdown-latex-inline-edit .container button") === null) return;
      window.setTimeout(() => { dismissLatexInlineEditor(); }, 0);
    };
    root.addEventListener("pointerdown", onLatexInlineConfirm, true);
    root.addEventListener("click", onLatexInlineConfirm, true);

    /*
     * **Mermaid 预览里的两个动作** ✓（复制为代码 / 下载图像 ✓，`design/mermaid-note-blocks.md`）。
     *
     * 为什么用**事件委托** ✗：Crepe 每次重渲染预览都会把那段 HTML 整块 `innerHTML` 换掉 ✓
     * ⇒ 直接挂在按钮上的监听下一次就没了 ✗；挂在编辑器根上、按 `data-*` 属性认才稳定 ✓。
     * 两个动作都**不碰文档内容** ✓（复制不改剪贴板以外的状态 ✓；下载只读 SVG ✓）。
     */
    const onMermaidAction = (event: Event): void => {
      const target = event.target as Element | null;
      if (target === null || typeof target.closest !== "function") return;
      const button = target.closest<HTMLElement>(`[${MERMAID_ACTION_ATTR}]`);
      if (button === null || !root.contains(button)) return;
      const preview = button.closest<HTMLElement>(MERMAID_PREVIEW_SELECTOR);
      if (preview === null) return;
      event.preventDefault();
      event.stopPropagation();
      const action = button.getAttribute(MERMAID_ACTION_ATTR);
      const source = decodeMermaidSource(preview.getAttribute(MERMAID_SOURCE_ATTR));
      /* 渲染时的主题底色 ✓（主题切换后下载也不会「深色图 + 浅色底」✗） */
      const background = decodeMermaidSource(preview.getAttribute(MERMAID_BACKGROUND_ATTR));
      if (action === "copy") {
        if (source === "") {
          /* 源码超过属性上限时预览里没有 source 属性 ⇒ 明确提示，不要静默无反应 ✗ */
          flashActionFailure(button, tRef.current("mermaidCopyTooLarge"));
          reportRef.current?.("mermaid-copy-unavailable", { reason: "source_too_large" });
          return;
        }
        /* 与代码块复制走**同一条**多格式剪贴板路径 ✓（裸代码 + HTML + 本插件载荷 ✓） */
        void writeCodeBlockClipboard({ language: "mermaid", code: source })
          .then(() => {
            lastCopiedBlock = { language: "mermaid", code: source };
            flashCopied(button);
            reportRef.current?.("mermaid-copy", { chars: source.length });
          })
          .catch((error: unknown) => {
            flashActionFailure(button, tRef.current("mermaidActionFailed"));
            reportRef.current?.("mermaid-copy-failed", String(error));
          });
        return;
      }
      if (action === "download") {
        /* 并发双击只发一次下载 ✓（否则会同时转两张图 / 触发两次保存） */
        if (button.dataset.knBusy === "true") return;
        button.dataset.knBusy = "true";
        button.setAttribute("aria-busy", "true");
        const downloadStartedAt = Date.now();
        void mermaid.download(mermaidSvgOf(preview), source, background)
          .then((result) => {
            if (!result.ok) flashActionFailure(button, tRef.current("mermaidDownloadFailed"));
          })
          .catch((error: unknown) => {
            flashActionFailure(button, tRef.current("mermaidDownloadFailed"));
            reportRef.current?.("mermaid-download-failed", { message: String(error) });
          })
          .finally(() => {
            /*
             * **忙碌状态至少保持一小段时间** ✓：转 PNG 只要几十毫秒 ✓，
             * 真实双击的两次 click 间隔 ~100ms ✗ —— 一做完就解锁的话第二次照样会再下载一份 ✗。
             */
            const remaining = Math.max(0, 600 - (Date.now() - downloadStartedAt));
            window.setTimeout(() => {
              delete button.dataset.knBusy;
              button.removeAttribute("aria-busy");
            }, remaining);
          });
      }
    };
    root.addEventListener("click", onMermaidAction, true);

    /**
     * **点正文里的图片 ⇒ 打开「查看大图」** ✓（用户实测：插入的图片"会变得很糊"✗）。
     *
     * 判据只认两件事 ✓：
     * ① 点在**图片块**上 ✓（图片块右上角的图注按钮、图注输入框、底部拖拽手柄都不算 ✗）；
     * ② 在 `.milkdown-image-block` 里 ✓（代码块预览 / 别的图片不进这条 ✓）。
     *
     * ⚠️ **不能只认 `event.target` 是 `<img>`** ✗（实测踩到 ✓）：
     * 图片块被选中时，Crepe 会在 `.image-wrapper` 上盖一层 `::before` 遮罩 ✓
     * （`.milkdown-image-block.selected > .image-wrapper::before` ✓，而且**没有**
     * `pointer-events: none` ✗）⇒ 点到的其实是 `.image-wrapper` 那个 div ✓，
     * `target.closest("img")` 永远是 `null` ✗（只有一张图的笔记一打开就是选中态 ✓，
     * 于是"点了没反应"✓）。所以：**从块里再找那张图** ✓。
     *
     * 为什么**不** `preventDefault` / 不 `stopPropagation` ✗：
     * ProseMirror 照旧把这次点击处理成"选中图片节点"✓（要按 Del 删图、要看拖拽手柄都靠它 ✓）——
     * 查看器只是**盖在上面**的一层 ✓，关掉之后编辑器的状态和点之前一样 ✓。
     */
    const onImageClick = (event: Event): void => {
      const target = event.target as Element | null;
      if (target === null || typeof target.closest !== "function") return;
      /* 图注输入框 / 操作按钮 / 拖拽手柄不算 ✗（它们也在图片块里 ✓） */
      if (target.closest("input, button, .caption-input, .operation, .image-edit, .image-resize-handle") !== null) return;
      const block = target.closest<HTMLElement>(".milkdown-image-block");
      if (block === null || !root.contains(block)) return;
      const image = (target.closest<HTMLImageElement>("img") ?? block.querySelector<HTMLImageElement>("img"));
      if (image === null) return;
      openImageViewerRef.current(image);
    };
    root.addEventListener("click", onImageClick, true);

    /*
     * **点语言选择器里的搜索框，不许把弹窗关掉** ✓
     * （用户实测："只要我鼠标左键点击搜索框，这个弹窗就会消失"✗）。
     *
     * 根因是 **Shadow DOM 的事件重定向** ✗ —— Crepe 的选择器在 `window` 上挂了一个
     * "点到外面就关"的监听 ✓，判据是 `picker.contains(e.target)` ✓；
     * 而我们整个面板在 **shadow root** 里 ✓ ⇒ 事件到 `window` 时
     * `e.target` 已经被**重定向成 host 元素** ✗ ⇒ 永远判成"点在外面" ✓ ⇒ 一点就关 ✓。
     * （`composedPath()` 才拿得到真实目标 ✓，但那段逻辑在 Crepe 里 ✗，我们改不了它 ✓。）
     *
     * 修法：在**自己的根**上把这类点击的冒泡**截住** ✓ ——
     * 冒泡阶段里 shadow root 一定先于 `window` ✓，所以 window 上那个监听根本看不到这次点击 ✓，
     * 弹窗自然不关 ✓。**不 `preventDefault`** ✗：输入框照常获得焦点、照常打字 ✓。
     * 只拦"选择器框里"的点击 ✓，面板别处的点击一概不动 ✓
     * （宿主/插件自己的"点外面关掉"逻辑还要正常工作 ✓）。
     */
    const onClickInsideLanguagePicker = (event: Event): void => {
      const target = event.target as Element | null;
      if (target === null || typeof target.closest !== "function") return;
      if (target.closest(".language-picker, .search-box, .language-list") === null) return;
      event.stopPropagation();
    };
    root.addEventListener("click", onClickInsideLanguagePicker);

    /*
     * **粘贴本插件的代码块载荷** ⇒ 直接用事务插入完整 `code_block` ✓
     * （语言、缩进、空行、尖括号一字不改 ✓，不再被 Markdown 拆散 ✓）。
     *
     * 其它情况**一律放行** ✗：
     * ① 光标在代码块里 ⇒ 只插字符、不嵌套新块 ✓（验收要求 ✓）；
     * ② 外部复制的 Markdown / HTML ⇒ 继续走 milkdown 原有粘贴 ✓
     *    （也不能把所有多行文本都当代码 ✗，复查要求 ✓）。
     */
    const onPastePayload = (event: Event): void => {
      const view = viewRef.current;
      const clip = (event as ClipboardEvent).clipboardData;
      if (view === null || !readyRef.current || clip === null || clip === undefined) return;
      const html = clip.getData("text/html");
      const plain = clip.getData("text/plain");
      const knMime = clip.getData(KN_CODE_BLOCK_MIME);
      /*
       * **手动选中复制（代码/公式块）⇒ 按纯文本插入** ✓（用户第十三轮要求 ✓）：
       * 只认"上次手动选中复制的文本"且剪贴板里**没有**本插件载荷 ✓ ⇒
       * 不还原成代码块/公式块 ✗、不跑"纯文本像代码"启发式 ✗，直接按纯文本（行间硬换行）插入 ✓。
       * 粘进已有代码块里则保持原有"只插字符"行为 ✓。
       */
      const selectionCopy = lastSelectionCopy !== null && lastSelectionCopy === plain && knMime === ""
        ? lastSelectionCopy
        : null;
      /*
       * 标记**不在这里消费** ✓（复核查出的边界 ✗）：
       * 同一段"手动选中复制"的剪贴板连续粘贴多次，每次都应保持纯文本 ✓；
       * 早先"粘一次就清掉"会让第二次粘贴掉进"纯文本像代码"启发式、又被插成代码块 ✗。
       * 只在**下一次复制**（选中复制覆盖 / 点「复制」按钮清空）时更新 ✓ —— 剪贴板内容变了自然对不上 ✓。
       */
      if (insideCodeBlock(currentBlockName(view))) return;
      if (selectionCopy !== null) {
        event.preventDefault();
        event.stopImmediatePropagation();
        insertPlainTextAtSelection(view, selectionCopy);
        reportRef.current?.("code-block-paste", { via: "selection-plain", language: "", chars: selectionCopy.length, viaHtml: false });
        return;
      }
      /*
       * ① 本插件载荷（自定义格式 ✓）⇒ 最可靠 ✓；
       * ② 没有载荷（浏览器拒了多格式、或粘贴来自别的应用 ✓）⇒ 看 `text/html`：
       *    整段就是 `<pre><code class="language-…">` 时照样能还原 ✓（复查方案里写的就是这条降级 ✓）。
       * ③ **外部应用的纯文本代码** ✓：从浏览器 / 聊天窗口复制代码时剪贴板常常只有
       *    `text/plain`（或只有一层 div/span 包装 ✗）⇒ milkdown 会把它当 **Markdown** 解析 ✗
       *    （`#include<iostream>` 变原始 HTML、空行分段、缩进变代码块，最后整篇被踢进纯文本 ✓
       *    —— 用户截图里那一串 ✗）。所以先做一次**保守**的"这看起来是代码"识别 ✓，
       *    命中就用事务插入完整代码块 ✓（一字不改、也不产生 HTML 节点 ✓）。
       */
      // 系统可能保留 HTML 却移除语言信息；刚复制的原文匹配优先于 HTML 降级。
      const remembered = lastCopiedBlock !== null
        && (plain === lastCopiedBlock.code || (lastCopiedBlock.language.toLowerCase() === "latex"
          && plain === "$$\n" + lastCopiedBlock.code + "\n$$")) ? lastCopiedBlock : null;
      const strictHtml = codeBlockFromClipboardHtml(html);
      const formula = formulaFromPlainText(plain);
      const richHtml = strictHtml === null && !remembered && formula === null
        ? codeBlockFromRichHtml(html, plain)
        : null;
      const plainCode = strictHtml === null && !remembered && formula === null && richHtml === null
        ? codeBlockFromPlainText(plain)
        : null;
      const payload = parseCodeBlockPayload(knMime)
        ?? remembered
        ?? strictHtml
        ?? formula
        ?? richHtml
        ?? plainCode;
      if (payload === null) {
        /* 没命中载荷 ⇒ **不拦** ✓，只把纯文本记下来（万一被 Markdown 拆散，提示条上还能一键补救 ✓） */
        if (plain !== "") props.onPasteText?.(plain);
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      insertCodeBlockNode(view, payload);
      reportRef.current?.("code-block-paste", {
        language: payload.language,
        chars: payload.code.length,
        via: plainCode !== null ? "plain-code" : richHtml !== null ? "rich-html" : formula !== null ? "formula" : strictHtml !== null ? "html" : "payload",
        viaHtml: knMime === "",
      });
    };
    root.addEventListener("paste", onPastePayload, true);
    const onTableContext = (event: Event): void => {
      const mouse = event as MouseEvent;
      const element = event.target as Element | null;
      const cell = element?.closest("td, th");
      const view = viewRef.current;
      if (!cell || !view || readOnlyRef.current) return;
      event.preventDefault(); event.stopPropagation();
      menuBlockRef.current = cell.closest<HTMLElement>(".milkdown-table-block");
      const hit = view.posAtCoords({ left: mouse.clientX, top: mouse.clientY });
      const pos = hit?.pos ?? view.posAtDOM(cell, 0);
      view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))));
      const body = root.closest<HTMLElement>(".kn-editor-body");
      if (!body) return;
      const rect = body.getBoundingClientRect();
      contextPointRef.current = { top: Math.max(0, Math.min(mouse.clientY - rect.top, rect.height - 282)) + body.scrollTop, right: Math.max(8, rect.right - Math.min(mouse.clientX + 220, rect.right - 8)) };
      syncMenuRef.current(); setMenuOpen(true);
    };
    const readTextSelection = (): void => {
      const tree = root.getRootNode() as Document | (ShadowRoot & { getSelection?: () => Selection | null });
      const native = ("getSelection" in tree ? tree.getSelection?.() : null) ?? window.getSelection();
      if (native && !native.isCollapsed && native.rangeCount > 0) {
        const range = native.getRangeAt(0);
        const text = native.toString().trim();
        if (text && root.contains(range.commonAncestorContainer)) {
          const rect = range.getBoundingClientRect();
          props.onSelectionText?.({ text, top: Math.max(8, rect.top - 38), left: Math.max(8, Math.min(rect.left, window.innerWidth - 200)) });
          return;
        }
      }
      const view = viewRef.current;
      if (!view || view.state.selection.empty) { props.onSelectionText?.(null); return; }
      const { from, to } = view.state.selection;
      const text = view.state.doc.textBetween(from, to, " ").trim();
      const rect = view.coordsAtPos(from);
      props.onSelectionText?.(text ? { text, top: Math.max(8, rect.top - 38), left: Math.max(8, Math.min(rect.left, window.innerWidth - 200)) } : null);
    };
    const onTextSelection = (): void => { requestAnimationFrame(readTextSelection); };
    root.addEventListener("contextmenu", onTableContext, true);
    const clearTextSelection = (): void => { props.onSelectionText?.(null); };
    root.closest(".kn-editor-body")?.addEventListener("scroll", clearTextSelection, true);
    window.addEventListener("resize", clearTextSelection);
    root.addEventListener("pointerup", onTextSelection);
    root.addEventListener("keyup", onTextSelection);

    /*
     * 复查要求的两条"容器变化"通知 ✓：
     * ① 面板宽度变了不一定有 `window.resize` ⇒ 用 `ResizeObserver` 盯住正文容器 ✓；
     * ② `.table-wrapper` 横向滚动会改变"可见表格范围"⇒ 用**捕获**阶段接住后代滚动 ✓。
     */
    const container = root.closest<HTMLElement>(".kn-editor-body");
    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => { scheduleMenu(); }) : null;
    if (container !== null) {
      resizeObserver?.observe(container);
      container.addEventListener("scroll", onSelectionChanged, true);
    }

    /*
     * **代码块的语言列表里不再出现 LaTeX** ✓
     * （用户实测："将 code 块中的语言选择为 Latex，这个 code 块就变成了一个公式块"✗，
     * "代码块就是代码块，公式块就是公式块"✓）。
     *
     * 为什么它会变 ✗：在这套 schema 里**公式块和代码块是同一个节点** ✓ ——
     * 都是 `code_block` + `language: "LaTeX"` ✓（`$$` 的输入规则写的正是 `{ language: "LaTeX" }` ✓），
     * 而 Crepe 的 latex 特性只要看到这个语言就调 `renderLatex` ✓ ⇒ 列表里一选 LaTeX 就"变成公式"✓。
     *
     * ⇒ 把语言列表里**那一行**藏掉 ✓：用户再也点不到它 ✓，
     * 而**公式块照旧** ✓ —— 它们由 `$$` 输入规则创建 ✓，从不经过这个列表 ✓
     * （已存在的 `$$…$$` 笔记重新解析出来仍是 `language: "LaTeX"` ✓，照样渲染成公式 ✓）。
     *
     * 做法用一个**范围极小的观察器** ✓：只有当编辑器里真的出现了语言列表时才扫一遍 ✓，
     * 命中 `.language-list-item` 且文字是 LaTeX / latex / tex 的那一行 ⇒ 直接 `display: none` ✓
     * （列表行的样式里有 `display: flex` ✗，所以必须用内联样式盖掉 ✓）。
     */
    const LANGUAGE_LABELS_TO_HIDE = new Set(["latex", "la tex", "tex"]);
    const hideLatexLanguageItem = (): void => {
      if (root.querySelector(".language-picker") === null) return;
      for (const item of root.querySelectorAll<HTMLElement>(".language-list-item")) {
        if (item.style.display === "none") continue;
        const label = item.textContent?.trim().toLowerCase() ?? "";
        if (LANGUAGE_LABELS_TO_HIDE.has(label)) item.style.display = "none";
      }
    };
    const languageObserver = typeof MutationObserver === "function"
      ? new MutationObserver(() => { hideLatexLanguageItem(); })
      : null;
    languageObserver?.observe(root, { childList: true, subtree: true });
    /*
     * **盯着 `<img src>` 的变化** ✓：Crepe 的 image-block 重渲染时会把 `src` 写回相对路径 ✗
     * ⇒ 这里立刻再断言一次（改成 blob URL ✓）。
     *
     * **也盯着 `childList`** ✓（用户实测 2026-10-11：控制台报 `dsh-app://app/image/… 404` ✗）：
     * 图片节点是 Crepe 建 DOM 时**新插进来**的 ⇒ 只盯属性的话我们到得**太晚** ✗，
     * 那次注定失败的请求已经发出去了 ✓；盯住插入就能在同一个微任务里先摆占位 ✓
     * （见 `IMAGE_PLACEHOLDER_SRC` ✓），把 404 从源头掐掉 ✓。
     */
    const hasImage = (node: Node): boolean => node.nodeType === 1
      && ((node as Element).tagName === "IMG" || (node as Element).querySelector?.("img") !== null);
    const imageObserver = typeof MutationObserver === "function"
      ? new MutationObserver((records) => {
        const touched = records.some((record) => record.type === "attributes"
          ? (record.target as Element).tagName === "IMG"
          : record.type === "childList" && [...record.addedNodes].some(hasImage));
        if (!touched) return;
        applyImageSources(
          root,
          props.target as Record<string, unknown> | undefined,
          imageCacheRef.current,
          imageInflightRef.current,
          (step, detail) => { reportRef.current?.(step, detail); },
          tRef.current("imageViewerOpenHint"),
        );
      })
      : null;
    imageObserver?.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "style"] });

    /*
     * **首帧渲染稳定后才显示** ✓（配合 `.kn-editor-rich[data-pending]` ✓）。
     *
     * Crepe `create()` 刚完成时可能还是"默认 schema 的过渡渲染"（代码块/公式块还没换成
     * 正式 NodeView ✗）—— 实测 DOM 从 ~13KB 涨到 ~38KB 要再晚 100ms 左右 ✓；
     * 这里等**连续 200ms 无 DOM 变化**（最多 1.5s 兜底）再淡入，并同时把 ready 上报给父面板 ✓
     * ⇒ "正在准备编辑器"不会提前消失、用户看不到过渡界面 ✓。
     */
    let revealObserver: MutationObserver | null = null;
    let revealFrame: number | null = null;
    const revealEditorWhenSettled = (): void => {
      if (cancelled || disposedRef.current) return;
      if (typeof MutationObserver !== "function") {
        setFirstPaintReady(true);
        emitStatus();
        return;
      }
      const started = Date.now();
      let lastChange = started;
      revealObserver?.disconnect();
      revealObserver = new MutationObserver(() => { lastChange = Date.now(); });
      revealObserver.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
      const reveal = (): void => {
        revealObserver?.disconnect();
        revealObserver = null;
        if (revealFrame !== null) {
          cancelAnimationFrame(revealFrame);
          revealFrame = null;
        }
        if (cancelled || disposedRef.current) return;
        setFirstPaintReady(true);
        emitStatus();
      };
      const tick = (): void => {
        revealFrame = null;
        if (cancelled || disposedRef.current) {
          revealObserver?.disconnect();
          revealObserver = null;
          return;
        }
        const now = Date.now();
        if (now - lastChange >= 200 || now - started >= 1500) {
          reveal();
          return;
        }
        revealFrame = requestAnimationFrame(tick);
      };
      revealFrame = requestAnimationFrame(tick);
    };

    syncingRef.current = true;
    void crepe.create().then(
      () => {
        if (cancelled || disposedRef.current) {
          /* 晚完成的实例：立刻销毁，绝不附着到别的节点上 ✗ */
          void crepe.destroy();
          return;
        }
        crepeRef.current = crepe;
        readyRef.current = true;
        crepe.setReadonly(readOnlyRef.current);
        /* 拿住 ProseMirror 视图：表格菜单要按它的 selection 判断显隐与定位 ✓ */
        const view = crepe.editor.action((ctx: Ctx) => ctx.get(editorViewCtx) as ProseMirrorView);
        viewRef.current = view;
        /*
         * 块菜单条目的来源是配置项 `buildMenu` ✓（块菜单打开时从 `blockMenuBuilderRef` 读快照 ✓）——
         * 这里不用再取任何内部 API ✓（斜杠菜单本身已被构建补丁关掉 ✓）。
         */
        /*
         * **接在自己的 `handleClick` 上** ✓（`design/table-click-jitter-and-caret-analysis.md`
         * 的建议 1 ✓）：普通单击在 ProseMirror 默认的 `selectClickedLeaf` **之前**就被处理成文字选区 ✓
         * ⇒ 没有"先节点选择、再纠正"的第二次变化（抖动的嫌疑来源 ✓）。
         *
         * `setProps` 只覆盖这一项 ✓（其它 props、含 Crepe 的 `handleDOMEvents` / `nodeViews` 原样保留 ✗）；
         * 上游本来也有 `handleClick` 的话先让它跑，它处理了就不抢 ✓（当前 Crepe 没有这一项，属防御 ✓）。
         */
        const previousClick = view.props.handleClick;
        const previousKeyDown = view.props.handleKeyDown as unknown as
          | ((this: unknown, v: ProseMirrorView, event: KeyboardEvent) => boolean | void)
          | undefined;
        view.setProps({
          handleClick: (targetView, targetPos, clickEvent) => {
            if (previousClick !== undefined && previousClick.call(view.props, targetView, targetPos, clickEvent) === true) {
              return true;
            }
            /* 正文下方那块空白：落到末尾的空段落 ✓（右键在那里也能插块 ✓） */
            if (placeTrailingCaret(targetView, clickEvent)) return true;
            return placeTableCaret(targetView, clickEvent);
          },
          /*
           * **引用块边缘：Backspace / Delete 退出引用** ✓
           * （用户实测：引用里的文字删光后剩下一条竖条、怎么按都清不掉 ✗）。
           *
           * 上游 `blockquoteKeymap` 只有"包进引用"、没有"退出引用" ✗ ⇒ 我们补一条保守规则
           * （空引用整块删掉 / 单段落引用拆壳保留文字 ✓，多块等复杂结构不接管 ✓）。
           * 带修饰键的 Backspace 不拦 ✓（比如 Ctrl/⌘+Backspace 的删词要保留原生行为 ✓）。
           */
          handleKeyDown: (targetView, event) => {
            if (previousKeyDown !== undefined && previousKeyDown.call(view.props, targetView, event) === true) {
              return true;
            }
            if (!targetView.editable || event.isComposing || event.keyCode === 229) return false;
            if (event.key !== "Backspace" && event.key !== "Delete") return false;
            if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
            const transaction = unwrapBlockquoteTransaction(targetView.state, event.key === "Backspace" ? "back" : "forward");
            if (transaction === null) return false;
            event.preventDefault();
            targetView.dispatch(transaction.scrollIntoView());
            return true;
          },
        });
        /*
         * **主修复：包一层 `view.dispatch`（唯一漏斗 ✓）**
         * （`design/table-functions-recheck-2.md` P1 ✓ —— 上游 `TableNodeView.stopEvent` 吃掉了
         * mousedown，`handleClick` 那条路根本走不到 ✓；它自己那个"整段结构选择"是 rAF 之后才派发的 ✓，
         * 所以 mouseup + 微任务的兜底也追不上 ✗）。
         *
         * 任何事务只要想把选区变成"单元格里 textblock 的结构选择"，就在这里先把点击坐标
         * 折算成**最近的合法文字位置**再派发 ✓ —— 谁派发的、什么时候派发的都躲不开 ✗。
         * 我们**另发一个干净事务** ⇒ 顺带丢掉上游那个 `scrollIntoView()` ✗（抖动的嫌疑之一 ✓）。
         *
         * 只认"点击之后一小会儿内"冒出来的那种坏选区 ✓：键盘 `Backspace` 之类造出块选择
         * 是**正常**操作 ✗（那种不归我们管 ✓）。
         */
        const baseDispatch = view.dispatch.bind(view);
        view.dispatch = (transaction: Parameters<ProseMirrorView["dispatch"]>[0]): void => {
          const click = lastClickRef.current;
          const fresh = click !== null && Date.now() - click.at <= CLICK_WINDOW_MS;
          if (fresh && isCellTextblockSelection(transaction.selection)) {
            const coords = view.posAtCoords({ left: click.x, top: click.y });
            const target = caretTargetForTextblockSelection(transaction.doc, transaction.selection, coords ?? null);
            if (target !== null) {
              reportRef.current?.("table-click-rewritten", { changed: transaction.docChanged });
              /* 只改选区的那个事务直接丢掉 ✓（否则它的 `scrollIntoView` 还会把正文拽一下 ✗） */
              if (!transaction.docChanged) {
                baseDispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target)));
                return;
              }
              baseDispatch(transaction.setSelection(TextSelection.create(transaction.doc, target)));
              return;
            }
          }
          baseDispatch(transaction);
        };
        reportRef.current?.("table-caret-wired", { handleClick: true, dispatchFunnel: true });
        /*
         * **补上初始化期间攒下的同步** ✗（P1-1）：这期间 reducer 可能已经换了正文
         * （恢复草稿、重试读取、确认采用最新版 ✓）⇒ 这里用**最新**那份整体替换 ✓。
         *
         * ⚠️ **别把刚喂进去的那份再解析一遍** ✗
         * （`design/plugin-note-editor-loading-optimization.md` 优先优化二 ✓）：
         * 创建时 `defaultValue` 就是 `initialRef.current` ⇒ 编辑器**已经解析过它** ✓；
         * 而 `getMarkdown()` 回来的必然是**编辑器自己的写法**（末尾换行、列表标记 ✓）
         * ⇒ 拿它跟输入逐字比一定不同 ✗，于是白跑一次 `replaceAll`（整篇重解析 + 一条事务 ✓）。
         * 只有"初始化期间真的又同步过别的正文"（`pendingRef` 有值 ✓）或"要的正文不是创建时那份"时才替换 ✓。
         */
        const pending = pendingRef.current ?? markdownRef.current;
        const resynced = pendingRef.current !== null || pending !== initialRef.current;
        if (resynced && pending !== crepe.getMarkdown()) {
          echoRef.current = pending;
          crepe.editor.action(replaceAll(pending));
          reportRef.current?.("markdown-editor-resync", { bytes: pending.length, phase: "init" });
        }
        pendingRef.current = null;
        syncingRef.current = false;
        syncTokenRef.current = props.syncToken ?? 0;
        /*
         * **报一次基线** ✓：编辑器把 `pending` 渲染成了什么（末尾换行之类 ✓）——
         * 父面板据此把"编辑器快照"对齐到编辑器自己的写法 ✗（不是用户修改 ✓）。
         */
        reportBaseline(pending);
        scheduleMenu();
        /*
         * **等首帧渲染稳定再显示** ✓（用户第二十二轮："打开笔记时界面一闪而逝" ✗）。
         *
         * `create()` 刚完成时 Crepe 的 DOM 还可能是**默认 schema 的过渡渲染**：
         * 代码块/公式块的正式 NodeView 要再晚一两帧才挂上（实测 13KB → 38KB ✓）——
         * 这段窗口必须继续隐藏，否则用户看到的还是"过渡界面" ✗。
         * 这里等到**连续 200ms 没有 DOM 变化**（最多 1.5s 兜底）再摘掉 `data-pending` 并淡入 ✓；
         * `emitStatus()` 也一起延迟到那时 ⇒ 父面板的"正在准备编辑器"不会提前消失 ✓。
         */
        revealEditorWhenSettled();
        reportRef.current?.("markdown-editor-ready", { bytes: pending.length });
      },
      (error: unknown) => {
        syncingRef.current = false;
        if (cancelled || disposedRef.current) return;
        failedRef.current = true;
        emitStatus();
        setMenu(null);
        reportRef.current?.("markdown-editor-failed", String(error));
      },
    );

    return () => {
      cancelled = true;
      disposedRef.current = true;
      readyRef.current = false;
      crepeRef.current = null;
      viewRef.current = null;
      if (menuFrameRef.current !== null) {
        cancelAnimationFrame(menuFrameRef.current);
        menuFrameRef.current = null;
      }
      setMenu(null);
      setMenuOpen(false);
      root.removeEventListener("compositionstart", onCompositionStart, true);
      root.removeEventListener("compositionend", onCompositionEnd, true);
      root.removeEventListener("pointerup", onSelectionChanged, true);
      root.removeEventListener("keyup", onSelectionChanged, true);
      root.removeEventListener("focusin", onSelectionChanged, true);
      root.removeEventListener("compositionend", onSelectionChanged, true);
      root.removeEventListener("pointerover", onPointerOver, true);
      root.removeEventListener("pointerleave", onPointerLeaveRoot, true);
      root.removeEventListener("pointerdown", onPointerDownRecord, true);
      root.removeEventListener("mousedown", onPointerDownRecord, true);
      root.removeEventListener("mouseup", onMouseUpFallback, true);
      root.removeEventListener("click", onBlankAreaFallback);
      root.removeEventListener("pointerdown", onRootPointerDownTrack, true);
      root.removeEventListener("contextmenu", onBlockMenuContext, true);
      root.removeEventListener("pointerdown", onBlockHandlePointerDown, true);
      root.removeEventListener("pointerup", onBlockHandlePointerUp, true);
      root.removeEventListener("click", onCopyClick, true);
      root.removeEventListener("copy", onCopySelection, true);
      root.removeEventListener("pointerdown", onLatexInlineConfirm, true);
      root.removeEventListener("click", onLatexInlineConfirm, true);
      root.removeEventListener("click", onMermaidAction, true);
      root.removeEventListener("click", onImageClick, true);
      /*
       * 原图预览**不用在这里手动关** ✓：它是 React 组件（宿主 `ImageLightbox` ✓），
       * 跟着本组件卸载一起卸载 ✓，宿主自己的 effect 会还原焦点 ✓ ——
       * 上一版自绘的遮罩挂在 `document.body` 上 ✗，才需要显式 `close()` ✗。
       */
      /* 丢掉还在飞的 Mermaid 渲染 ✓（别对已销毁的组件回填预览 ✗） */
      mermaid.dispose();
      root.removeEventListener("click", onClickInsideLanguagePicker);
      root.removeEventListener("paste", onPastePayload, true);
      root.removeEventListener("contextmenu", onTableContext, true);
      root.closest(".kn-editor-body")?.removeEventListener("scroll", clearTextSelection, true);
      window.removeEventListener("resize", clearTextSelection);
      root.removeEventListener("pointerup", onTextSelection);
      root.removeEventListener("keyup", onTextSelection);
      document.removeEventListener("selectionchange", onSelectionChanged);
      shadowRoot?.removeEventListener("selectionchange", onSelectionChanged);
      window.removeEventListener("resize", onSelectionChanged);
      resizeObserver?.disconnect();
      languageObserver?.disconnect();
      imageObserver?.disconnect();
      revealObserver?.disconnect();
      revealObserver = null;
      if (revealFrame !== null) {
        cancelAnimationFrame(revealFrame);
        revealFrame = null;
      }
      for (const url of imageCacheRef.current.values()) URL.revokeObjectURL(url);
      imageCacheRef.current.clear();
      imageInflightRef.current.clear();
      container?.removeEventListener("scroll", onSelectionChanged, true);
      void crepe.destroy();
    };
    /* 只在挂载时建一次 ✓（后续内容变化由 sync effect 处理 ✓） */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 只读开关：保存期间**整块**不可编辑 ✓（不是只禁用工具栏 ✗）⇒ 菜单收起、入口保留但禁用 ✓ */
  useEffect(() => {
    const view = viewRef.current;
    if (props.readOnly) {
      /* 先记焦点再切只读 ✓（切完浏览器就把焦点移走了 ✗） */
      hadFocusBeforeReadOnlyRef.current = view !== null && view.hasFocus();
      crepeRef.current?.setReadonly(true);
      setMenuOpen(false);
      scheduleMenu();
      return;
    }
    const restore = hadFocusBeforeReadOnlyRef.current;
    hadFocusBeforeReadOnlyRef.current = false;
    crepeRef.current?.setReadonly(false);
    scheduleMenu();
    if (!restore || view === null) return;
    /*
     * **保存结束把焦点还给正文** ✓（用户要求：保存后竖线/光标位置还在，不用重新点 ✓）。
     * 等一拍再还：刚切回 contenteditable 的同一帧里 focus 可能被浏览器重新收走 ✗。
     * 只在"焦点落空"时还 ✓ —— 保存期间用户主动点了别的控件就不抢焦点 ✗。
     */
    window.setTimeout(() => {
      const current = viewRef.current;
      if (current === null) return;
      const root = current.dom.getRootNode() as Document | (ShadowRoot & { activeElement?: Element | null });
      const active = ("activeElement" in root ? root.activeElement : null) ?? document.activeElement;
      const lost = active === null || active === document.body || active === document.documentElement
        || active === (root as ShadowRoot).host || active === current.dom;
      if (lost && !current.hasFocus()) current.focus();
    }, 0);
    /* 只读 / 非只读都要重算一次：入口的状态（禁用 / 可用）跟着变 ✓ */
  }, [props.readOnly, scheduleMenu]);

  /*
   * 菜单展开期间：**点菜单/入口以外任何地方就关掉** ✓（关掉不等于改选区 ✗）。
   * 用捕获阶段的 `pointerdown` ✓：比 blur 更可靠（点正文空白也不会触发 blur ✓）。
   *
   * ⚠️ 必须用 **`event.composedPath()` + 节点引用** ✗（`design/table-menu-shadow-dom-review.md` ✓）：
   * 面板跑在 Shadow DOM 里，事件冒到 `document` 时 `event.target` 被**重定向成 shadow host** ✗
   * ⇒ 用 `target.closest(".kn-table-entry, .kn-table-menu")` 永远匹配不到内部节点 ✓，
   * 点菜单里的项也会被当成"点外面"、在 `click` 执行动作**之前**把菜单收掉 ✗。
   * `composedPath()` 给的是**真实**路径 ✓，而且按我们自己那两个节点的**引用**判 ✗，
   * 不会把同页面别的编辑器/别的实例的菜单误认成自己的 ✓。
   */
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onPointerDown = (event: Event): void => {
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      if (pathHitsNodes(path, [entryNodeRef.current, menuNodeRef.current])) return;
      setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [menuOpen]);

  /*
   * **外部替换**（token 变化）⇒ 整体替换 ✓；未就绪就先记账，等 `create()` 成功后补上 ✓（P1-1）。
   */
  const syncTokenRef = useRef(props.syncToken ?? 0);
  useEffect(() => {
    const token = props.syncToken ?? 0;
    if (token === syncTokenRef.current) return;
    const crepe = crepeRef.current;
    const next = markdownRef.current;
    if (crepe === null || !readyRef.current) {
      /* 还没就绪：**只记下来**，token 也先不确认 ✓（否则这次的正文就丢了 ✗） */
      pendingRef.current = next;
      return;
    }
    syncTokenRef.current = token;
    if (next === crepe.getMarkdown()) return;
    syncingRef.current = true;
    crepe.editor.action(replaceAll(next));
    syncingRef.current = false;
    pendingRef.current = null;
    /* 整篇换掉了 ⇒ **重报一次基线** ✓（编辑器渲染出来的写法可能与喂进去的不同 ✓）+ 菜单重算 ✓ */
    reportBaseline(next);
    scheduleMenu();
  }, [props.syncToken, scheduleMenu]);

  useImperativeHandle(props.handleRef, () => ({
    flush: (): string | null => {
      const crepe = crepeRef.current;
      /* 未就绪 / 失败 / 组合中 ⇒ **null** ✗：调用方不许拿旧正文代替 ✓（P1-1/P2-6/P2-7） */
      if (crepe === null || !readyRef.current || failedRef.current) return null;
      if (composingRef.current) return null;
      return withExplicitImageTitles(crepe.getMarkdown());
    },
    replaceMarkdown: (markdown: string) => {
      const crepe = crepeRef.current;
      if (crepe === null || !readyRef.current) {
        pendingRef.current = markdown;
        return;
      }
      if (markdown === crepe.getMarkdown()) return;
      syncingRef.current = true;
      echoRef.current = markdown;
      crepe.editor.action(replaceAll(withExplicitImageTitles(markdown)));
      syncingRef.current = false;
      pendingRef.current = null;
      /* 外部整篇替换 ⇒ **重报基线** ✓（编辑器渲染出来的写法可能与喂进去的不同 ✓） */
      reportBaseline(markdown);
      scheduleMenu();
    },
    focus: () => {
      hostRef.current?.querySelector<HTMLElement>(".ProseMirror, [contenteditable='true']")?.focus();
    },
    /*
     * **把某段文本作为代码块插入** ✓（`design/code-block-copy-paste-analysis.md`
     * 「更小的第一步」✓）：粘贴被 Markdown 拆散之后，提示条上给一个一键补救 ✓。
     * 走的是同一条事务路径 ✓（可撤销 ✓），语言留空由用户自己选 ✓。
     */
    insertCodeBlock: (code: string, language = "") => {
      const view = viewRef.current;
      if (view === null || !readyRef.current || failedRef.current) return;
      if (code === "") return;
      insertCodeBlockNode(view, { language, code });
      scheduleMenu();
    },
    isReady: () => readyRef.current && !failedRef.current,
  }), [scheduleMenu]);

  /*
   * 渲染：Milkdown 挂载点 + 表格**入口**（光标进表格才有 ✓）+ 点开后出现的**菜单** ✓
   * + 点图片才出现的**原图预览** ✓。
   * 前两者都是**正文滚动容器的绝对定位子元素** ✓（`.kn-editor-body` 是 `position: relative` ✓）
   * ⇒ 与 ProseMirror 的 DOM 完全分离 ✗（不往 node view 里塞外来节点 ✓），
   * 也不占正文高度 ✓（复查要求"一个轻量入口，按需展开行列操作" ✓）。
   *
   * 原图预览用**宿主的 `ImageLightbox`** ✓：它自己 portal 到 `document.body` ✓、
   * 自己处理 Esc / 点遮罩 / × / 焦点还原 / Windows 标题栏 ✓ —— 插件这边只在打开时给
   * `src` + `alt` + 两条文案 ✓（见文件顶部 import 那段说明 ✓）。
   */
  return (
    <>
      <div className="kn-editor-rich" ref={hostRef} data-testid="kn-markdown-rich" data-pending={firstPaintReady ? undefined : "true"} />
      {menu === null || !menuOpen ? null : (
        <TableMenu
          top={menu.popover.top}
          right={menu.popover.right}
          alignment={menu.alignment}
          t={t}
          onAction={runTableAction}
          onDismiss={dismissMenu}
          disabledReasons={menu.disabledActions}
          nodeRef={menuNodeRef}
        />
      )}
      {/*
       * **右键 / ＋ 手柄的块插入菜单** ✓：宿主的 `Menu` 自己 portal 到 body、
       * 自己处理 Esc / 点外面 / 键盘行走 / 视口边缘 ✓ —— 这里只给坐标与条目 ✓。
       * 行内格式**不在这个菜单里** ✓（用户第四轮反馈重复：选中文字后的浮动工具栏已经有一整套 ✓）。
       */}
      <BlockInsertMenu
        open={blockMenu !== null}
        x={blockMenu?.x ?? 0}
        y={blockMenu?.y ?? 0}
        groups={blockMenu?.groups ?? EMPTY_BLOCK_MENU_GROUPS}
        t={t}
        onSelect={runBlockMenuItem}
        onClose={closeBlockMenu}
      />
      {lightbox === null ? null : (
        <ImageLightbox
          src={lightbox.src}
          alt={lightbox.alt}
          labels={{ dialog: t("imageViewerTitle"), close: t("imageViewerClose") }}
          onClose={closeLightbox}
        />
      )}
    </>
  );
}
