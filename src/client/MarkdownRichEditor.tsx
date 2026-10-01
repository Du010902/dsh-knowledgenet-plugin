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
 * 5. 失败要**可见** ✗（P2-6）：`onStatus` 上报 ready/failed，父面板显示错误并可切源码 ✓。
 */
import { useEffect, useImperativeHandle, useRef, type ReactNode, type RefObject } from "react";
import { Crepe, CrepeFeature } from "@milkdown/crepe";
import { replaceAll } from "@milkdown/kit/utils";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

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

/**
 * 渲染富文本编辑区。
 * @param props.markdown - 初始正文（**只在挂载时**使用 ✓，之后由用户编辑或 syncToken 驱动 ✓）。
 * @param props.onChange - **用户**改动后的 Markdown（初始化/外部同步不会触发 ✓）。
 * @param props.readOnly - 是否只读（保存期间 ✓）。
 * @param props.syncToken - 递增 ⇒ 整体替换为 `markdown` ✓（外部替换草稿时用 ✓）。
 * @param props.handleRef - 拿到 flush / replaceMarkdown / focus / isReady ✓。
 * @param props.onStatus - 就绪 / 失败 / 组合状态上报 ✓。
 * @param props.report - 诊断上报（可选 ✓）。
 * @returns 编辑区容器。
 */
export function MarkdownRichEditor(props: {
  markdown: string;
  onChange: (markdown: string) => void;
  readOnly: boolean;
  syncToken?: number | undefined;
  handleRef?: RefObject<MarkdownRichEditorHandle | null> | undefined;
  onStatus?: ((status: MarkdownRichEditorStatus) => void) | undefined;
  report?: ((step: string, detail?: unknown) => void) | undefined;
}): ReactNode {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const crepeRef = useRef<Crepe | null>(null);
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
  const readOnlyRef = useRef(props.readOnly);
  readOnlyRef.current = props.readOnly;

  const emitStatus = (): void => {
    onStatusRef.current?.({
      ready: readyRef.current,
      failed: failedRef.current,
      composing: composingRef.current,
    });
  };

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
        emitStatus();
        reportRef.current?.("markdown-editor-ready", { bytes: pending.length });
      },
      (error: unknown) => {
        syncingRef.current = false;
        if (cancelled || disposedRef.current) return;
        failedRef.current = true;
        emitStatus();
        reportRef.current?.("markdown-editor-failed", String(error));
      },
    );

    return () => {
      cancelled = true;
      disposedRef.current = true;
      readyRef.current = false;
      crepeRef.current = null;
      root.removeEventListener("compositionstart", onCompositionStart, true);
      root.removeEventListener("compositionend", onCompositionEnd, true);
      void crepe.destroy();
    };
    /* 只在挂载时建一次 ✓（后续内容变化由 sync effect 处理 ✓） */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 只读开关：保存期间**整块**不可编辑 ✓（不是只禁用工具栏 ✗） */
  useEffect(() => {
    crepeRef.current?.setReadonly(props.readOnly);
  }, [props.readOnly]);

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
  }, [props.syncToken]);

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
    },
    focus: () => {
      hostRef.current?.querySelector<HTMLElement>(".ProseMirror, [contenteditable='true']")?.focus();
    },
    isReady: () => readyRef.current && !failedRef.current,
  }), []);

  return <div className="kn-editor-rich" ref={hostRef} data-testid="kn-markdown-rich" />;
}
