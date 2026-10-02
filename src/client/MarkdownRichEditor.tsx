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
  setAlignCommand,
} from "@milkdown/kit/preset/gfm";
import { deleteColumn, deleteRow } from "@milkdown/kit/prose/tables";
import type { EditorView as ProseMirrorView } from "@milkdown/kit/prose/view";
import { TextSelection } from "@milkdown/kit/prose/state";
import { replaceAll } from "@milkdown/kit/utils";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

import { makeTranslator } from "./card-model.ts";
import { TableEntry, TableMenu } from "./TableMenu.tsx";
import { caretTargetForClick, isPlainClick } from "./table-caret.ts";
import {
  TABLE_LITERAL,
  readTableContext,
  tableEntryPosition,
  tablePopoverPosition,
  type TableAlignment,
  type TableMenuAction,
} from "./table-menu.ts";

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
  /** 入口按钮 ✓ */
  entry: { top: number; right: number; inside: boolean };
  /** 点开后弹出的菜单 ✓ */
  popover: { top: number; right: number };
  alignment: TableAlignment;
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
  const [menu, setMenu] = useState<TableMenuAnchor | null>(null);
  /** 完整动作菜单是否展开（**点开才出现** ✓；复查要求"一个轻量入口，按需展开" ✓） */
  const [menuOpen, setMenuOpen] = useState(false);
  /** rAF 合并：选区变化会连续触发，没必要每条都重算 ✓ */
  const menuFrameRef = useRef<number | null>(null);
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
   * 重算表格入口的位置：**只看编辑器 selection** ✓。
   * 不在表格里 / 未就绪 / 失败 / 只读 ⇒ 一律收起 ✓（保存期间也不该还在 ✓）。
   *
   * 位置锚在**可见表格**上 ✗（不是整块容器 ✓）：
   * `.table-wrapper` 承担横向滚动 ⇒ 表格可能有一部分在可视区外，先与它求交 ✓
   * （复查实测：原来按整块容器定位，短表格也被贴到容器右边 ✗）。
   * 纵向放哪由 `tableEntryPosition` 决定：右侧空白 → 上方空白 → 表格自己的右上角 ✓
   * （宁可靠在表格上，也不盖住前一段正文 ✗）。
   */
  const syncMenu = useCallback((): void => {
    const view = viewRef.current;
    const host = hostRef.current;
    if (view === null || host === null || !readyRef.current || failedRef.current || readOnlyRef.current) {
      setMenu(null);
      setMenuOpen(false);
      return;
    }
    const context = readTableContext(view.state);
    if (!context.inTable) {
      setMenu(null);
      setMenuOpen(false);
      return;
    }
    const container = host.closest<HTMLElement>(".kn-editor-body");
    const anchorNode = view.domAtPos(view.state.selection.from).node;
    const element = anchorNode.nodeType === 1 ? (anchorNode as HTMLElement) : anchorNode.parentElement;
    const block = element?.closest<HTMLElement>(".milkdown-table-block") ?? null;
    const table = block?.querySelector<HTMLElement>("table") ?? null;
    if (container === null || block === null || table === null) {
      setMenu(null);
      setMenuOpen(false);
      return;
    }
    /* **可见**表格范围 = 表格矩形 ∩ 横向滚动容器的可见矩形 ✓ */
    const tableRect = table.getBoundingClientRect();
    const wrapperRect = table.closest<HTMLElement>(".table-wrapper")?.getBoundingClientRect() ?? tableRect;
    const visible = {
      top: Math.max(tableRect.top, wrapperRect.top),
      bottom: Math.min(tableRect.bottom, wrapperRect.bottom),
      left: Math.max(tableRect.left, wrapperRect.left),
      right: Math.min(tableRect.right, wrapperRect.right),
    };
    const containerRect = container.getBoundingClientRect();
    /* 表格**上一块**的下沿：判断"上方有没有真空白" ✓（不许拿覆盖正文换空间 ✗） */
    const before = block.previousElementSibling;
    const previousBottom = before === null ? null : before.getBoundingClientRect().bottom;
    const entry = tableEntryPosition(visible, containerRect, container.scrollTop, previousBottom);
    const popover = tablePopoverPosition(entry, containerRect, container.scrollTop);
    /* 位置与高亮都没变就**复用原对象** ⇒ React 不重渲染 ✓（选区一直在变 ✓） */
    setMenu((current: TableMenuAnchor | null) => {
      if (
        current !== null
        && current.entry.top === entry.top && current.entry.right === entry.right && current.entry.inside === entry.inside
        && current.popover.top === popover.top && current.popover.right === popover.right
      ) {
        return current.alignment === context.alignment ? current : { ...current, alignment: context.alignment };
      }
      return { entry, popover, alignment: context.alignment };
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
    viewRef.current?.focus();
  }, []);

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
         * **补上初始化期间攒下的同步** ✗（P1-1）：这期间 reducer 可能已经换了正文
         * （恢复草稿、重试读取、确认采用最新版 ✓）⇒ 这里用**最新**那份整体替换 ✓。
         */
        const pending = pendingRef.current ?? markdownRef.current;
        if (pending !== crepe.getMarkdown()) {
          echoRef.current = pending;
          crepe.editor.action(replaceAll(pending));
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
      document.removeEventListener("selectionchange", onSelectionChanged);
      window.removeEventListener("resize", onSelectionChanged);
      resizeObserver?.disconnect();
      container?.removeEventListener("scroll", onSelectionChanged, true);
      void crepe.destroy();
    };
    /* 只在挂载时建一次 ✓（后续内容变化由 sync effect 处理 ✓） */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 只读开关：保存期间**整块**不可编辑 ✓（不是只禁用工具栏 ✗）⇒ 表格入口与菜单一起收起 ✓ */
  useEffect(() => {
    crepeRef.current?.setReadonly(props.readOnly);
    if (props.readOnly) {
      setMenu(null);
      setMenuOpen(false);
    } else {
      scheduleMenu();
    }
  }, [props.readOnly, scheduleMenu]);

  /*
   * 菜单展开期间：**点菜单/入口以外任何地方就关掉** ✓（关掉不等于改选区 ✗）。
   * 用捕获阶段的 `pointerdown` ✓：比 blur 更可靠（点正文空白也不会触发 blur ✓）。
   */
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onPointerDown = (event: Event): void => {
      const target = event.target as Element | null;
      if (target !== null && typeof target.closest === "function" && target.closest(".kn-table-entry, .kn-table-menu") !== null) {
        return;
      }
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
      {menu === null ? null : (
        <TableEntry
          top={menu.entry.top}
          right={menu.entry.right}
          inside={menu.entry.inside}
          open={menuOpen}
          t={t}
          onToggle={() => { setMenuOpen((value: boolean) => !value); }}
        />
      )}
      {menu === null || !menuOpen ? null : (
        <TableMenu
          top={menu.popover.top}
          right={menu.popover.right}
          alignment={menu.alignment}
          t={t}
          onAction={runTableAction}
          onDismiss={dismissMenu}
        />
      )}
    </>
  );
}
