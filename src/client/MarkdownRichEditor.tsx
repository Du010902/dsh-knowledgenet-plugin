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
import { TextSelection } from "@milkdown/kit/prose/state";
import { replaceAll } from "@milkdown/kit/utils";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

import { makeTranslator } from "./card-model.ts";
import { tableMinWidth } from "./table-menu.ts";
import {
  KN_CODE_BLOCK_MIME,
  codeBlockHtml,
  encodeCodeBlockPayload,
  codeBlockFromClipboardHtml,
  insideCodeBlock,
  parseCodeBlockPayload,
} from "./code-block-clipboard.ts";
import { TableEntry, TableMenu } from "./TableMenu.tsx";
import {
  caretTargetForClick,
  caretTargetForSelection,
  caretTargetForTextblockSelection,
  firstCaretInTable,
  isCellTextblockSelection,
  isPlainClick,
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
  onPasteText?: ((text: string) => void) | undefined;
  report?: ((step: string, detail?: unknown) => void) | undefined;
  t?: unknown;
}): ReactNode {
  const t = useMemo(() => makeTranslator(props.t, TABLE_LITERAL), [props.t]);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const crepeRef = useRef<Crepe | null>(null);
  /** ProseMirror 视图（表格命令与"光标在不在表格里"都要用它 ✓） */
  const viewRef = useRef<ProseMirrorView | null>(null);
  /**
   * 表格入口当前该在哪（`null` = 不显示 ✓）。
   * 只由**编辑器 selection** 决定 ✓（不靠鼠标悬停推断 ✗）。
   */
  const contextPointRef = useRef<{ top: number; right: number } | null>(null);
  const [menu, setMenu] = useState<TableMenuAnchor | null>(null);
  /** 完整动作菜单是否展开（**点开才出现** ✓；复查要求"一个轻量入口，按需展开" ✓） */
  const [menuOpen, setMenuOpen] = useState(false);
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
   * 报一次"编辑器把 `ingested` 渲染成了 `canonical`" ✓（只有**喂进去**的时候才报 ✗，
   * 用户敲字走 `onChange` ✓）。父面板拿它维护"编辑器侧的干净快照" ✓ ——
   * 否则宿主去掉末尾空白、编辑器补回末尾换行，一来一回就被当成"又有未保存修改" ✗。
   */
  const reportBaseline = (ingested: string): void => {
    const crepe = crepeRef.current;
    if (crepe === null) return;
    onBaselineRef.current?.(ingested, crepe.getMarkdown());
  };

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
          case "row-before": commands.call(addRowBeforeCommand.key); break;
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

    const crepe = new Crepe({
      root,
      defaultValue: initialRef.current,
      /* 只启用在文档里明确列出的能力 ✓；AI / 图片上传不启用 ✗ */
      features: {
        [CrepeFeature.AI]: false,
        [CrepeFeature.ImageBlock]: false,
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
        [CrepeFeature.CodeMirror]: {
          searchPlaceholder: "搜索语言…",
          noResultText: "没有匹配的语言",
          copyText: "复制",
          /* 「PREVIEW」大写标签 → 轻量的「结果」✓（不常驻大写标签 ✓） */
          previewLabel: "结果",
          previewToggleButton: (previewOnlyMode: boolean) => (previewOnlyMode ? "编辑源码" : "只看结果"),
          /*
           * ⚠️ Crepe 的 code-mirror 特性用的是 **`previewToggleText`** ✗（不是基类的
           * `previewToggleButton` ✓）—— 只配后者的话按钮上仍是英文 "Hide" ✓（截图实测 ✓）。
           * 两个都配上 ✓，谁生效都对 ✓。
           */
          previewToggleText: (previewOnlyMode: boolean) => (previewOnlyMode ? "编辑源码" : "只看结果"),
          previewLoading: "渲染中…",
          previewOnlyByDefault: true,
          /* 代码/公式源码**成套**的编辑主题 ✓（见 KN_CODE_THEME ✓） */
          theme: KN_CODE_THEME,
          extensions: [syntaxHighlighting(KN_CODE_HIGHLIGHT)],
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
      },
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
        .then(() => { lastCopiedBlock = { ...payload }; reportRef.current?.("code-block-copy", { language: payload.language, chars: payload.code.length }); })
        .catch((error: unknown) => { reportRef.current?.("code-block-copy-failed", String(error)); });
    };
    root.addEventListener("click", onCopyClick, true);

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
      if (insideCodeBlock(currentBlockName(view))) return;
      /*
       * ① 本插件载荷（自定义格式 ✓）⇒ 最可靠 ✓；
       * ② 没有载荷（浏览器拒了多格式、或粘贴来自别的应用 ✓）⇒ 看 `text/html`：
       *    整段就是 `<pre><code class="language-…">` 时照样能还原 ✓（复查方案里写的就是这条降级 ✓）。
       */
      const plain = clip.getData("text/plain");
      // 系统可能保留 HTML 却移除语言信息；刚复制的原文匹配优先于 HTML 降级。
      const remembered = lastCopiedBlock !== null
        && (plain === lastCopiedBlock.code || (lastCopiedBlock.language.toLowerCase() === "latex"
          && plain === "$$\n" + lastCopiedBlock.code + "\n$$")) ? lastCopiedBlock : null;
      const payload = parseCodeBlockPayload(clip.getData(KN_CODE_BLOCK_MIME))
        ?? remembered
        ?? codeBlockFromClipboardHtml(clip.getData("text/html"));
      if (payload === null) {
        /* 没命中载荷 ⇒ **不拦** ✓，只把纯文本记下来（万一被 Markdown 拆散，提示条上还能一键补救 ✓） */
        const plain = clip.getData("text/plain");
        if (plain !== "") props.onPasteText?.(plain);
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      insertCodeBlockNode(view, payload);
      reportRef.current?.("code-block-paste", { language: payload.language, chars: payload.code.length, viaHtml: clip.getData(KN_CODE_BLOCK_MIME) === "" });
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
      const pos = view.posAtDOM(cell, 0);
      view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))));
      const body = root.closest<HTMLElement>(".kn-editor-body");
      if (!body) return;
      const rect = body.getBoundingClientRect();
      contextPointRef.current = { top: Math.max(0, Math.min(mouse.clientY - rect.top, rect.height - 180)) + body.scrollTop, right: Math.max(8, rect.right - Math.min(mouse.clientX + 220, rect.right - 8)) };
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
         * **接在自己的 `handleClick` 上** ✓（`design/table-click-jitter-and-caret-analysis.md`
         * 的建议 1 ✓）：普通单击在 ProseMirror 默认的 `selectClickedLeaf` **之前**就被处理成文字选区 ✓
         * ⇒ 没有"先节点选择、再纠正"的第二次变化（抖动的嫌疑来源 ✓）。
         *
         * `setProps` 只覆盖这一项 ✓（其它 props、含 Crepe 的 `handleDOMEvents` / `nodeViews` 原样保留 ✗）；
         * 上游本来也有 `handleClick` 的话先让它跑，它处理了就不抢 ✓（当前 Crepe 没有这一项，属防御 ✓）。
         */
        const previousClick = view.props.handleClick;
        view.setProps({
          handleClick: (targetView, targetPos, clickEvent) => {
            if (previousClick !== undefined && previousClick.call(view.props, targetView, targetPos, clickEvent) === true) {
              return true;
            }
            return placeTableCaret(targetView, clickEvent);
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
        emitStatus();
        scheduleMenu();
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
      root.removeEventListener("click", onCopyClick, true);
      root.removeEventListener("paste", onPastePayload, true);
      root.removeEventListener("contextmenu", onTableContext, true);
      root.removeEventListener("pointerup", onTextSelection);
      root.removeEventListener("keyup", onTextSelection);
      document.removeEventListener("selectionchange", onSelectionChanged);
      shadowRoot?.removeEventListener("selectionchange", onSelectionChanged);
      window.removeEventListener("resize", onSelectionChanged);
      resizeObserver?.disconnect();
      container?.removeEventListener("scroll", onSelectionChanged, true);
      void crepe.destroy();
    };
    /* 只在挂载时建一次 ✓（后续内容变化由 sync effect 处理 ✓） */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 只读开关：保存期间**整块**不可编辑 ✓（不是只禁用工具栏 ✗）⇒ 菜单收起、入口保留但禁用 ✓ */
  useEffect(() => {
    crepeRef.current?.setReadonly(props.readOnly);
    if (props.readOnly) setMenuOpen(false);
    /* 只读 / 非只读都要重算一次：入口的状态（禁用 / 可用）跟着变 ✓ */
    scheduleMenu();
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
      return crepe.getMarkdown();
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
      crepe.editor.action(replaceAll(markdown));
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
   * 渲染：Milkdown 挂载点 + 表格**入口**（光标进表格才有 ✓）+ 点开后出现的**菜单** ✓。
   * 两者都是**正文滚动容器的绝对定位子元素** ✓（`.kn-editor-body` 是 `position: relative` ✓）
   * ⇒ 与 ProseMirror 的 DOM 完全分离 ✗（不往 node view 里塞外来节点 ✓），
   * 也不占正文高度 ✓（复查要求"一个轻量入口，按需展开行列操作" ✓）。
   */
  return (
    <>
      <div className="kn-editor-rich" ref={hostRef} data-testid="kn-markdown-rich" />
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
    </>
  );
}
