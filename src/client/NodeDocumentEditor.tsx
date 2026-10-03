/**
 * **节点笔记编辑器**（`design/node-note-editor.html` 的界面语言 + `node-note-editor-plan.md` 的行为
 * + `design/node-document-editor-review.md` 的草稿保护修正）。
 *
 * 复查逼出来的六条，全部落在 `editorReducer` 与这里的接线里 ✓：
 * 1. **载入不覆盖脏草稿**：`load` 只依赖稳定的"库身份 + nodeId" ✓，
 *    父面板无关重渲染**不会**重新读取（否则输入第一个字就被磁盘正文冲掉 ✗ —— 复查头号问题）；
 * 2. 「查看最新正文」只**展开比较区** ✓；替换草稿另有明确按钮 + 二次确认 ✓；
 * 3. 冲突时提供「已合并，基于最新版本保存」✓（换基线、保留草稿、再提交 ✓）；
 * 4. **保存失败 ≠ 载入失败**：草稿始终在输入框里、可改可复制、重试执行**保存** ✓；
 * 5. 没有指纹的文档**不可编辑** ✓（宿主也会拒写 ✓）；
 * 6. 草稿按"库 + nodeId"缓存在组件外 ✓：面板卸载/切目标后能恢复，且不串库 ✓。
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";

import {
  readNodeDocument,
  saveNodeDocument,
  type DocumentTarget,
  type FetchLike,
  type NodeDocument,
} from "./node-document-client.ts";
import { makeTranslator } from "./card-model.ts";
import {
  MarkdownRichEditor,
  type MarkdownRichEditorHandle,
  type MarkdownRichEditorStatus,
} from "./MarkdownRichEditor.tsx";
import {
  EDITOR_LITERAL,
  canSave,
  commitSavedDraft,
  createLatestGuard,
  createSaveGate,
  diffLines,
  draftKey,
  editorReducer,
  scanUnsupportedSyntax,
  failureKey,
  forgetDraft,
  initialEditorState,
  isDirty,
  recallDraft,
  rememberDraft,
  saveCommit,
  type DiffLine,
} from "./node-document-state.ts";

/**
 * 节点笔记编辑器。
 * @param props.nodeId - 正在编辑的节点（稳定 id ✓）。
 * @param props.libraryKey - **库身份**（草稿缓存键用；稳定即可 ✓）。
 * @param props.target - 库目标（root 或 sessionId ✓）。
 * @param props.draftKey - 草稿缓存键（缺省 libraryKey + nodeId ✓）。
 * @param props.onClose - 关闭编辑区（调用方负责"未保存"三选一 ✓）。
 * @param props.onSaved - 保存成功回调（返回的文档可能带**新身份** ✓）。
 * @param props.onDirtyChange - 未保存状态变化（父面板只用来决定要不要拦 ✓）。
 * @param props.saveNonce - 「保存并继续」的触发计数：+1 ⇒ 保存一次 ✓。
 * @param props.report - 诊断上报（内部用 ref ⇒ **不参与** load 依赖 ✓）。
 * @param props.fetcher - fetch 注入点（测试用 ✓）。
 * @param props.t - 宿主 locale 函数（可选 ✓）。
 * @returns 编辑器界面。
 */
export function NodeDocumentEditor(props: {
  nodeId: string;
  libraryKey?: string | undefined;
  target?: DocumentTarget | undefined;
  draftKey?: string | undefined;
  onClose: () => void;
  onSaved?: (document: NodeDocument) => void;
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
  /** 现在能不能保存（父面板据此提前禁用离开弹窗里的「保存并继续」✓） */
  onSaveableChange?: ((saveable: boolean) => void) | undefined;
  /**
   * 保存生命周期：`(saving, outcome)` ✓。
   * - 开始保存 ⇒ `(true, null)`：父面板据此显示"保存中"、禁用弹窗里的危险按钮 ✓；
   * - 结束 ⇒ `(false, "saved" | "conflict" | "error" | <code>)`：
   *   没存下去时父面板要**收起"保存并继续"弹窗并清掉待办** ✓（复查 P2-2 ✓）。
   */
  onSaveOutcome?: ((saving: boolean, outcome: string | null) => void) | undefined;
  saveNonce?: number | undefined;
  report?: (step: string, detail?: unknown) => void;
  fetcher?: FetchLike;
  t?: unknown;
}): ReactNode {
  const t = useMemo(() => makeTranslator(props.t, EDITOR_LITERAL), [props.t]);
  const [state, dispatch] = useReducer(editorReducer, props.nodeId, initialEditorState);
  const [tab, setTab] = useState<"rich" | "source">("rich");
  const [confirmAdopt, setConfirmAdopt] = useState(false);
  /** 复制草稿的反馈（null = 还没复制过 ✓） */
  const [copyState, setCopyState] = useState<"done" | "failed" | null>(null);
  /**
   * **当下这份状态**（每次渲染都刷新 ✓）。
   *
   * 为什么需要 ✗：保存是异步的，回调里能看到的 `state` 是**发起保存那一刻**的闭包值 ✗ ——
   * 而"提交之后还有没有新修改"必须按**当下**这份判断 ✓（`saveCommit` 要用它 ✓）。
   */
  const stateRef = useRef(state);
  stateRef.current = state;

  /*
   * **稳定的依赖**（复查 P1-1）：回调用 ref 保管、目标对象用"键"参与依赖 ✓，
   * 于是父面板每次渲染产生的新函数/新对象都不会触发重读 ✓。
   */
  const reportRef = useRef(props.report);
  reportRef.current = props.report;
  const onSavedRef = useRef(props.onSaved);
  onSavedRef.current = props.onSaved;
  const onDirtyChangeRef = useRef(props.onDirtyChange);
  onDirtyChangeRef.current = props.onDirtyChange;
  const targetRef = useRef(props.target);
  targetRef.current = props.target;
  const targetKey = props.target === undefined
    ? ""
    : `${props.target.root ?? ""}|${props.target.sessionId ?? ""}`;
  const cacheKey = props.draftKey ?? `${props.libraryKey ?? ""}::${props.nodeId}`;
  const cacheKeyRef = useRef(cacheKey);
  cacheKeyRef.current = cacheKey;

  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  /** 在飞的保存请求（卸载时要中断 ✓） */
  const saveAbortRef = useRef<AbortController | null>(null);
  /** 保存互斥门（同步 ✓，所有保存入口共用；不使用 abort 代替 ✗） */
  const saveGateRef = useRef(createSaveGate());
  /** 保存请求的**独立**编号（与读请求分开 ⇒ 旧保存响应不许回写 ✓） */
  const saveSeqRef = useRef(0);
  /** 冲突「最新正文」读取的守卫（晚到的旧读取不许覆盖新的 ✓） */
  const conflictGuardRef = useRef(createLatestGuard());
  /** 保存生命周期回调给父面板：`(saving, outcome)` ✓（"保存并继续"失败要收起弹窗 ✓） */
  const saveOutcomeRef = useRef(props.onSaveOutcome);
  saveOutcomeRef.current = props.onSaveOutcome;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  /** 富文本编辑器的命令式句柄（flush / replace / focus ✓） */
  const richRef = useRef<MarkdownRichEditorHandle | null>(null);
  /** 最近一次粘贴进来的纯文本 ✓（粘贴被 Markdown 拆散时，提示条上给"作为代码块插入"✓） */
  const [lastPaste, setLastPaste] = useState("");
  /** 编辑器最近一次交给我们的草稿：用来分辨"这次变化是不是用户敲的" ✓ */
  const lastEditorDraftRef = useRef<string | null>(null);
  /** 递增 ⇒ 富编辑器整体替换文档（只在"外部替换草稿"时用 ✓，绝不每次草稿变化都调 ✗） */
  const [richSyncToken, setRichSyncToken] = useState(0);
  /** 富编辑器状态：就绪 / 失败 / 输入法组合中 ✓（失败要可见、组合中要推迟保存 ✓） */
  const [richStatus, setRichStatus] = useState<MarkdownRichEditorStatus>({ ready: false, failed: false, composing: false });
  /**
   * 组合中被推迟的**统一待办**：只记**类型**，不存闭包 ✗ ——
   * 组合结束补跑时**必须重走同一条"取快照 → 再执行"的流程** ✓
   * （第三次复查 P2-1：直接跑原始闭包会跳过快照，等于拿旧正文离开 ✗）。
   */
  const pendingActionRef = useRef<{ kind: "save" } | { kind: "source" } | { kind: "close" } | null>(null);
  /**
   * 这份**当前草稿**里富编辑器可能无法原样保留的语法 ⇒ 自动改用纯文本兜底 ✓。
   * 必须跟着 draft 走 ✗：只看载入基线的话，用户在纯文本里新加 HTML/脚注/指令后
   * 提示与"回正文要显式点一次"都不会更新 ✗（第二次复查 P2-3 ✓）。
   */
  const unsupported = useMemo(() => scanUnsupportedSyntax(state.draft).reasons, [state.draft]);
  /*
   * 比较区的逐行差异：**只在真的展开比较时**才算 ✓（纯函数 + useMemo：不在每次输入时重算整篇 ✗）。
   * 超过上限（超大文档）会退化成"整篇标为不同"，不给编辑器制造卡顿 ✓（见 `diffLines` ✓）。
   */
  const conflictDiff = useMemo(() => {
    if (!state.conflicted || !state.comparing || state.latest === null) return null;
    return diffLines(state.draft, state.latest.text);
  }, [state.conflicted, state.comparing, state.latest, state.draft]);
  /** 已经为哪个节点做过"载入即判纯文本"的判定 ✓（每节点只判定一次 ✓） */
  const autoSourceRef = useRef<string | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);

  const fetcher = useMemo<FetchLike>(
    () => props.fetcher ?? ((input, init) => fetch(input, init)),
    [props.fetcher],
  );

  /** 读一次（序号 + 取消；成功与失败分支都检查请求身份 ✓） */
  const load = useCallback(async (): Promise<void> => {
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    dispatch({ type: "load-start" });
    /*
     * **分阶段计时（客户端半）** ✓
     * （`design/plugin-note-editor-loading-optimization.md` 实施顺序第 1 条 ✓）：
     * "点节点编辑要等多久"以前只能猜 ✓ —— 这里记**请求往返 + 挂载**这一段的毫秒数 ✓，
     * 宿主那一半记在 `status.docReads` 里（走了索引直读还是全库兜底 ✓），两边一对就知道瓶颈在哪 ✓。
     * 只记数字与身份，**不记正文** ✗。
     */
    const started = Date.now();
    /*
     * **请求号** ✓（`design/plugin-note-editor-loading-recheck.md` 问题三 ✓）：
     * 两端都带上它，就能把客户端 `note-open-*` 与宿主 `status.noteApi` 按**同一次请求**对起来 ✓ ——
     * 只看宿主内部耗时会得出"接口很快"的错误结论 ✗（前置步骤没算进去 ✓）。
     */
    const requestId = `note-${started}-${seq}`;
    reportRef.current?.("note-open-start", { nodeId: props.nodeId, requestId });
    try {
      const outcome = await readNodeDocument(
        props.nodeId,
        fetcher,
        {
          target: targetRef.current,
          signal: controller.signal,
          isCurrent: () => seq === seqRef.current,
        },
        requestId,
      );
      if (outcome === undefined || seq !== seqRef.current) return;
      if (outcome.ok === true) {
        dispatch({ type: "load-ok", document: outcome.document });
        reportRef.current?.("node-document-read", { nodeId: props.nodeId, revision: outcome.document.revision });
        reportRef.current?.("note-open-loaded", {
          nodeId: props.nodeId,
          requestId,
          ms: Date.now() - started,
          bytes: outcome.document.text.length,
        });
        return;
      }
      dispatch({ type: "load-failed", key: failureKey(outcome.code) });
      reportRef.current?.("node-document-read-failed", { nodeId: props.nodeId, code: outcome.code });
      reportRef.current?.("note-open-failed", {
        nodeId: props.nodeId,
        requestId,
        code: outcome.code,
        ms: Date.now() - started,
      });
    } catch (error) {
      if (seq !== seqRef.current) return;
      dispatch({ type: "load-failed", key: "loadFailed" });
      reportRef.current?.("node-document-read-error", String(error));
      reportRef.current?.("note-open-failed", {
        nodeId: props.nodeId,
        requestId,
        code: "loadFailed",
        ms: Date.now() - started,
      });
    }
  }, [fetcher, props.nodeId]);

  /*
   * 挂载 / 真正换节点或换库时才读一次 ✓。
   *
   * **刻意不把 `props.target`、`props.report` 放进依赖** ✗：它们是父面板每次渲染的新对象/新函数，
   * 放进去就等于"父组件随便重渲染一下 → 重新读盘 → 冲掉刚输入的字" ✗（复查 P1-1 ✓）。
   */
  useEffect(() => {
    /*
     * **空草稿同样是有效草稿** ✗（用户把正文删光了、还没保存）：只要"有记录"就恢复 ✓，
     * 不能因为文字为空就当成没有草稿（复查 P1-1 ✓）。
     */
    const cached = recallDraft(cacheKeyRef.current);
    if (cached !== undefined) {
      dispatch({
        type: "restore-draft",
        draft: cached.draft,
        base: cached.base,
        hash: cached.hash,
        snapshot: cached.snapshot,
      });
      /* 留痕：重开时到底恢复了什么（**不含正文** ✓，只看脏不脏 / 有没有指纹 ✓） */
      reportRef.current?.("node-document-draft-recall", {
        nodeId: props.nodeId,
        dirty: cached.draft !== cached.snapshot,
        hasHash: cached.hash !== "",
      });
    }
    void load();
    return () => {
      /* 留痕：编辑器何时因关闭/切换被卸载（与"缓存提交""通知离开"对照 ✓，不含正文 ✓） */
      reportRef.current?.("node-document-unmount", {
        nodeId: props.nodeId,
        dirty: isDirty(stateRef.current),
      });
      /* 卸载：让在飞的请求全部失效（成功与失败分支都过不去 ✓），草稿则留在缓存里 ✓ */
      seqRef.current += 1;
      abortRef.current?.abort();
      saveAbortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, targetKey]);

  /*
   * 缓存只记**真正未保存**的内容 ✗（复查 P2-2）：
   * 刚读进来 / 已保存成功的正文不入缓存 ⇒ 重开不会无端要求合并 ✓；
   * 一旦变干净就把记录删掉 ✓。
   * 记录里**两种基线都要存** ✓（磁盘基线管冲突、编辑器快照管"改没改" ✓）。
   */
  useEffect(() => {
    if (isDirty(state)) {
      rememberDraft(cacheKeyRef.current, {
        draft: state.draft,
        base: state.base,
        hash: state.hash,
        snapshot: state.snapshot,
      });
    } else {
      forgetDraft(cacheKeyRef.current);
    }
  }, [state.draft, state.base, state.hash, state.snapshot, state.conflicted]);

  /* 有未保存修改就报给父面板（只影响"要不要拦"，不会触发重读 ✓） */
  const dirty = isDirty(state);
  /** 节点身份标题（空标题回落到 id ✓）：头部与悬停提示共用 ✓ */
  const title = state.title === "" ? props.nodeId : state.title;
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => { onDirtyChangeRef.current?.(false); }, []);

  /** 打开这篇笔记的开始时刻 ✓（切节点时重置 ✓；用来算"从打开到可输入"的毫秒数 ✓） */
  const openStartedRef = useRef(Date.now());
  useEffect(() => {
    openStartedRef.current = Date.now();
  }, [targetKey]);

  /*
   * **"到首次可输入"那一刻** ✓（`design/plugin-note-editor-loading-optimization.md` 实施顺序第 1 条 ✓）：
   * 与 `note-open-start` / `note-open-loaded` 配成三段 ✓ —— 读取（宿主索引直读 + 往返 ✓）、
   * 挂载与 Crepe 创建 ✓。只记毫秒与身份，**不记正文** ✗。
   */
  useEffect(() => {
    if (!richStatus.ready) return;
    reportRef.current?.("note-open-ready", { nodeId: props.nodeId, ms: Date.now() - openStartedRef.current });
  }, [richStatus.ready, props.nodeId]);
  /*
   * **冲突判定留痕**：只在状态**变化**时上报一次 ✓（不含正文 ✗；文档要求只记"指纹是否相等"这类事实 ✓）。
   * 排查"保存并关闭后重开怎么又冲突了"时，把 `node-document-cache-commit` / `node-document-leave-notify` /
   * `node-document-unmount` / `node-document-draft-recall` 与这两条按时间线对起来看 ✓。
   */
  const conflictRef = useRef(state.conflicted);
  useEffect(() => {
    if (state.conflicted === conflictRef.current) return;
    conflictRef.current = state.conflicted;
    reportRef.current?.(state.conflicted ? "node-document-conflict-detected" : "node-document-conflict-cleared", {
      nodeId: props.nodeId,
      dirty: isDirty(state),
      hasLatest: state.latest !== null,
    });
  }, [state.conflicted, state.draft, state.snapshot, state.latest, props.nodeId]);

  /*
   * 把"现在能不能保存"报给父面板 ✓：父面板据此**提前禁用**离开弹窗里的「保存并继续」✗
   * （复查 P2-2：没有指纹 / 载入失败时，那个按钮点了也不会成功，不如直接禁用 ✓，
   *  但仍然保留「继续编辑」与「放弃修改」，并在编辑器里显示错误与草稿 ✓）。
   */
  const saveable = state.phase === "ready" && state.hash !== "" && !state.conflicted && !state.saving;
  const onSaveableChangeRef = useRef(props.onSaveableChange);
  onSaveableChangeRef.current = props.onSaveableChange;
  useEffect(() => {
    onSaveableChangeRef.current?.(saveable);
  }, [saveable]);

  /*
   * **纯文本兜底**（用户不要「正文 / 源码」切换 ⇒ 模式不再由用户挑 ✓）。
   *
   * 复查 P1-4：富编辑器不能表示原始 HTML、自定义指令、脚注、引用式链接定义等，
   * 用户动一个普通段落后整篇会被重新序列化 ⇒ 那些内容可能被规范化甚至丢掉 ✗。
   * 所以命中这些语法时**自动**改用纯文本编辑（同一份草稿的另一种编辑方式 ✓，原文一字不动 ✓）。
   */
  useEffect(() => {
    if (state.phase !== "ready") return;
    /*
     * **只在这个节点载入时判定一次** ✗（第三次复查 P2-2）：
     * 之前依赖 `unsupported.length` ⇒ 用户编辑途中新出现一个潜在语法就会被**突然踢出正文** ✗。
     */
    if (autoSourceRef.current === props.nodeId) return;
    autoSourceRef.current = props.nodeId;
    if (unsupported.length > 0) setTab("source");
  }, [state.phase, props.nodeId, unsupported.length]);

  /*
   * 富编辑器**起不来**（初始化失败）⇒ 自动落到纯文本 ✓：
   * 没有「源码」按钮之后，这是那份草稿在面板里唯一还能改、能存的出口 ✗（不许让它变成只读 ✓）。
   */
  useEffect(() => {
    if (tab === "rich" && richStatus.failed) setTab("source");
  }, [tab, richStatus.failed]);

  /*
   * 停在纯文本是因为**语法**，而用户已经把那些语法删干净了 ⇒ 自动回正文 ✓
   * （否则他会被永远留在纯文本里，可这个模式从来不是他自己选的 ✗）。
   * 富编辑器失败时不回（回去也起不来 ✓）；已经在正文时什么都不做 ✓。
   */
  useEffect(() => {
    if (tab !== "source" || richStatus.failed || unsupported.length > 0) return;
    setTab("rich");
  }, [tab, richStatus.failed, unsupported.length]);

  /* 读取完成后把焦点给正文（设计稿要求 ✓） */
  useEffect(() => {
    if (state.phase !== "ready" || state.conflicted) return;
    textareaRef.current?.focus();
  }, [state.phase, state.conflicted, props.nodeId]);

  /**
   * 用**显式给定的正文与指纹**保存。
   *
   * 为什么把这个内部函数抽出来：冲突里的"已合并，基于最新版本保存"要用**新基线**提交，
   * 而 `state` 在这一拍还是旧的 ⇒ 不能只依赖 reducer 状态 ✗。
   */
  const saveWith = useCallback(async (text: string, hash: string): Promise<boolean> => {
    /**
     * **统一失败出口** ✗：所有"没存下去"的路径（提前拒绝、结构化失败、异常）都要
     * dispatch + 通知父面板 —— 少了通知，父面板就会留着三选一弹窗挡住错误，
     * 旧的离开待办也会一直挂着（复查 P2-2 ✓）。
     */
    const fail = (key: string): false => {
      dispatch({ type: "save-failed", key });
      saveOutcomeRef.current?.(false, key);
      return false;
    };
    if (hash === "") return fail("missingFingerprint");
    /*
     * **同步互斥**：所有保存入口（按钮、Ctrl+S、重试、合并保存、保存并继续）都过这道门 ✓。
     * 不能用 abort 代替它 ✗ —— abort 只取消客户端请求，宿主可能已经在写盘，
     * 重复点击会发出多次写入（复查 P2-6 ✓）。
     * 注意：被互斥门挡下**不算失败** ⇒ 不通知父面板，免得误清另一个请求的离开待办 ✓（复查 P2-2 ✓）。
     */
    if (!saveGateRef.current.tryEnter()) return false;
    const seq = seqRef.current;
    /* 独立编号：只允许**最新一次保存**的响应回写状态 ✓ */
    const saveSeq = saveSeqRef.current + 1;
    saveSeqRef.current = saveSeq;
    /* 保存一开始就让在飞的"最新正文"读取作废 ✓（复查 P2-3：否则旧读取回来会重新制造冲突 ✗） */
    conflictGuardRef.current.invalidate();
    saveOutcomeRef.current?.(true, null);
    dispatch({ type: "save-start" });
    const controller = new AbortController();
    saveAbortRef.current = controller;
    try {
      const outcome = await saveNodeDocument(
        { nodeId: props.nodeId, text, hash },
        fetcher,
        {
          target: targetRef.current,
          signal: controller.signal,
          isCurrent: () => seq === seqRef.current && saveSeq === saveSeqRef.current,
        },
      );
      if (outcome === undefined) return false;
      if (outcome.ok === true) {
        /*
         * **顺序就是这次要修的东西** ✓（`design/save-and-close-reopen-conflict-optimization.md`）：
         * ① 先算"保存确认"（草稿/基线/指纹/身份，与 reducer 同一套规则 ✓）；
         * ② 再**同步**落缓存 —— 父面板接下来会立刻卸载编辑器，靠 effect 就来不及了 ✗；
         * ③ 然后更新界面状态；
         * ④ 最后才通知父面板去关闭/切换 ✓。
         *
         * 少了 ② 就会出现：刚点"保存并关闭"，重开却看到星号 + "文件在外部发生了变化"✗
         * —— 那是**自己的保存**被残留的旧草稿缓存误判成外部修改 ✓。
         */
        const commit = saveCommit(stateRef.current.draft, outcome.document, text);
        /*
         * 键要取**组件实际在用的那个** ✓（别自己拼：调用方可以用 `draftKey` 自定义键 ✗）；
         * 自定义键不含节点身份 ⇒ 身份被采用后仍然用同一个键 ✓。
         */
        const previousKey = cacheKeyRef.current;
        const nextKey = props.draftKey === undefined
          ? draftKey(props.libraryKey ?? "", outcome.document.nodeId)
          : previousKey;
        const cached = commitSavedDraft(previousKey, nextKey, commit);
        dispatch({ type: "save-ok", document: outcome.document, submitted: text });
        reportRef.current?.("node-document-cache-commit", {
          nodeId: outcome.document.nodeId,
          kept: cached.kept,
          adopted: outcome.document.nodeId !== props.nodeId,
          hashSame: outcome.document.hash === hash,
        });
        reportRef.current?.("node-document-saved", {
          nodeId: outcome.document.nodeId,
          revision: outcome.document.revision,
        });
        /*
         * 提交之后**还有新修改** ⇒ 报一个不同的 outcome ✓：父面板收到非 "saved" 会清掉待办与弹窗
         * ⇒ **留在编辑区**，不把用户没保存的字藏起来 ✗（文档「保存确认成功但仍有新草稿」那一行 ✓）。
         */
        saveOutcomeRef.current?.(false, commit.dirty ? "saved-dirty" : "saved");
        reportRef.current?.(
          commit.dirty ? "node-document-saved-stay" : "node-document-leave-notify",
          { nodeId: outcome.document.nodeId },
        );
        onSavedRef.current?.(outcome.document);
        return true;
      }
      if (outcome.code === "conflict") {
        dispatch({ type: "save-conflict", latest: outcome.latest ?? null });
        reportRef.current?.("node-document-conflict", { nodeId: props.nodeId });
        /* 告诉父面板：这次没存下去 ⇒ 收起"保存并继续"的弹窗、清掉待办 ✓（复查 P2-2 ✓） */
        saveOutcomeRef.current?.(false, "conflict");
        return false;
      }
      reportRef.current?.("node-document-save-failed", { nodeId: props.nodeId, code: outcome.code });
      return fail(failureKey(outcome.code));
    } catch (error) {
      if (seq !== seqRef.current) return false;
      reportRef.current?.("node-document-save-error", String(error));
      return fail("saveFailed");
    } finally {
      /* 无论成功、冲突、失败、异常都要放行 ✓ —— 否则一次失败就把保存永久锁死 ✗ */
      saveGateRef.current.exit();
    }
  }, [fetcher, props.libraryKey, props.nodeId]);

  /**
   * **统一取出"当前正文快照"**（复查 P1-2/P1-3；第二次复查 P1-1 补上**按模式取值** ✓）。
   * 普通保存、重试、保存并继续、合并保存、退回纯文本、关闭 —— 全都必须先经过这里 ✓。
   *
   * **按当前模式读** ✗（这是我上一版最大的错 ✗）：
   * - **纯文本兜底**（`tab === "source"`）：富编辑器**根本没挂载** ⇒ 直接读受控 textarea 的最新草稿（就是 `state.draft`）✓；
   *   绝不能因为"富实例不在"就判定"取不到正文" ✗ —— 那会让纯文本兜底、以及
   *   "不支持语法自动转纯文本""初始化失败回退纯文本"两条路**全部无法保存** ✗✗；
   * - **正文模式**：必须有就绪实例；`flush()` 返回 null（未就绪 / 失败 / 组合中）**才**报错 ✓。
   *
   * @returns 取到的 Markdown；正文模式下实例不可用时返回 null ✗。
   */
  const snapshotDraft = useCallback((): string | null => {
    let live: string | null;
    if (tab === "source") {
      live = state.draft;
    } else {
      live = richRef.current?.flush() ?? null;
      if (live === null) return null;
    }
    if (live !== state.draft) {
      lastEditorDraftRef.current = live;
      dispatch({ type: "edit", text: live });
    }
    return live;
  }, [state.draft, tab]);

  const save = useCallback((): Promise<boolean> => {
    /*
     * 输入法正在组合 ⇒ **等它结束再存** ✗（P2-7）：直接取会拿到半成品、或打断输入 ✓。
     * 这条只对**正文模式**成立 ✗ —— 纯文本兜底的 textarea 由我们自己受控，随时可读 ✓。
     */
    if (tab === "rich" && richStatus.composing) {
      pendingActionRef.current = { kind: "save" };
      return Promise.resolve(false);
    }
    const live = snapshotDraft();
    if (live === null) {
      /* 正文模式实例不可用 ⇒ 如实报错（父面板会收起离开弹窗 ✓），绝不静默保存旧内容 ✗ */
      dispatch({ type: "save-failed", key: richStatus.failed ? "richFailed" : "richLoading" });
      saveOutcomeRef.current?.(false, richStatus.failed ? "richFailed" : "richLoading");
      return Promise.resolve(false);
    }
    return saveWith(live, state.hash);
  }, [saveWith, snapshotDraft, state.hash, tab, richStatus.composing, richStatus.failed]);

  /*
   * **统一待办**：保存、退回纯文本、关闭**共用一份** pending ✓ ——
   * 组合结束后在这里补跑，不再各维护互相冲突的标志 ✓（第二次复查 P1-2 要求 ✓）。
   */
  useEffect(() => {
    if (tab === "rich" && richStatus.composing) return;
    const pending = pendingActionRef.current;
    if (pending === null) return;
    pendingActionRef.current = null;
    if (pending.kind === "save") void save();
    else leaveRich(pending.kind); /* 重走"再取一次快照"的完整流程 ✓ */
    // leaveRich 在下面定义（函数声明顺序不影响 effect 运行 ✓）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [richStatus.composing, tab, save]);

  /* 「保存并继续」：saveNonce 变化 ⇒ 保存一次（首帧不触发 ✓） */
  const saveNonceRef = useRef(props.saveNonce ?? 0);
  useEffect(() => {
    const nonce = props.saveNonce ?? 0;
    if (nonce === saveNonceRef.current) return;
    saveNonceRef.current = nonce;
    void save();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.saveNonce]);

  /**
   * Ctrl / ⌘ + S：**只在本编辑器内**生效（含 Shadow DOM 里的真实焦点 ✓），
   * 不抢宿主其它编辑器的快捷键 ✗（复查指出的问题 ✓）。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      const root = rootRef.current;
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      const inside = root !== null && (path.includes(root) || root.contains(event.target as Node));
      if (!inside) return;
      if (!canSave(state)) return;
      event.preventDefault();
      void save();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => { window.removeEventListener("keydown", onKeyDown, true); };
  }, [save, state]);

  /** 冲突里"刷新最新正文"（没有 latest 时用 ✓）：只更新比较基线，**不碰草稿** ✗ */
  const refreshLatest = useCallback(async (): Promise<NodeDocument | null> => {
    /*
     * 复查 P2-3：这里必须 **try/catch + 独立请求编号** ✗ ——
     * 网络拒绝会在 `void` 启动的回调里变成未处理的 Promise 拒绝 ✗；
     * 多个延迟不同的读取还会互相覆盖（晚到的旧响应不许改状态 ✗）。
     */
    const token = conflictGuardRef.current.next();
    const seq = seqRef.current;
    dispatch({ type: "conflict-refresh-start" });
    try {
      const outcome = await readNodeDocument(props.nodeId, fetcher, {
        target: targetRef.current,
        isCurrent: () => seq === seqRef.current && conflictGuardRef.current.isCurrent(token),
      });
      if (outcome === undefined || seq !== seqRef.current || !conflictGuardRef.current.isCurrent(token)) {
        return null;
      }
      if (outcome.ok === true) {
        dispatch({ type: "conflict-refresh-ok", latest: outcome.document });
        return outcome.document;
      }
      dispatch({ type: "conflict-refresh-failed", key: failureKey(outcome.code) });
      return null;
    } catch (error) {
      if (seq !== seqRef.current || !conflictGuardRef.current.isCurrent(token)) return null;
      dispatch({ type: "conflict-refresh-failed", key: "mergeFailed" });
      reportRef.current?.("node-document-refresh-error", String(error));
      return null;
    }
  }, [fetcher, props.nodeId]);

  /**
   * 「已合并，基于最新版本保存」。
   *
   * **没有 latest 时只刷新、绝不写入** ✗（复查 P1-1）：那种情况下用户还没看过盘上那份，
   * 拿"刚读到的 hash"当基线提交就等于替他确认覆盖 ✗；
   * 等他看过并**再次点击**（那时 latest 已在）才真正换基线并保存 ✓。
   */
  const mergeAndSave = useCallback(async (): Promise<void> => {
    if (state.latest === null) {
      await refreshLatest();
      return;
    }
    /*
     * 复查 P1-3：合并保存**也必须**现取当前正文 ✗ —— 用户在富编辑器里改完最后一处
     * 立刻点合并，state.draft 可能还是旧的 ⇒ 提交旧内容、还会把旧内容规范化同步回编辑器 ✗。
     * 基线 hash 用 latest 的 ✓，正文快照一律走同一个入口 ✓。
     */
    const live = snapshotDraft();
    if (live === null) {
      dispatch({ type: "save-failed", key: richStatus.failed ? "richFailed" : "richLoading" });
      saveOutcomeRef.current?.(false, "richLoading");
      return;
    }
    dispatch({ type: "merge-and-save" });
    await saveWith(live, state.latest.hash);
  }, [refreshLatest, saveWith, snapshotDraft, state.latest, richStatus.failed]);

  /**
   * **离开富编辑器的统一入口**（复查 P1-2）：先取正文快照，再执行动作 ✓。
   * 用于退回纯文本、关闭编辑器 —— 不能只 `setTab` / 只调 `onClose` ✗（会丢最后一笔 ✓）。
   *
   * ⚠️ "有没有未保存内容"比的是 **`snapshot`（编辑器侧的干净快照）** ✗，不是 `base`（磁盘正文）✓：
   * 宿主保存时会去掉末尾空白/换行，而编辑器输出会补回末尾换行 ⇒ 拿磁盘正文比的话，
   * **刚保存成功**再点叉号就又会被判成"有未保存修改"、弹窗又冒出来 ✓（用户实测 ✓）。
   */
  const leaveRich = useCallback((kind: "source" | "close"): void => {
    /**
     * 真正执行"离开正文"。
     * @param dirty - **刚刚算出来的**未保存状态（不依赖 React state 的旧值 ✓）。
     */
    const act = (dirty: boolean): void => {
      if (kind === "source") setTab("source");
      else props.onClose(dirty);
    };
    /* 纯文本兜底：草稿本身就是权威，直接执行 ✓ */
    if (tab === "source") {
      if (kind === "close") act(state.draft !== state.snapshot);
      return;
    }
    const rich = richRef.current;
    /*
     * 正文模式但实例**没就绪 / 初始化失败** ⇒ 编辑器里不可能有用户改动 ✓
     * ⇒ 允许动作（"退回纯文本"正是那条恢复路径 ✓，不能一概禁止回退 ✗）。
     */
    if (rich === null || rich.isReady() !== true) {
      act(state.draft !== state.snapshot);
      return;
    }
    /*
     * **输入法正在组合**：既不能取半成品，更不能卸载编辑器 ✗ ⇒
     * 记进**统一待办**，等组合结束**重走本流程**（重新取快照 ✓，而不是直接执行 ✗）。
     */
    if (richStatus.composing) {
      pendingActionRef.current = { kind };
      return;
    }
    const live = snapshotDraft();
    if (live === null) return; /* ready 却取不到 ⇒ 不执行会卸载编辑器的动作 ✗ */
    act(live !== state.snapshot);
  }, [snapshotDraft, tab, richStatus.composing, state.draft, state.snapshot, props.onClose]);

  /** 放弃草稿并用最新正文（**二次确认之后**才走到这里；读不到就不动草稿、不写文件 ✓） */
  const adoptLatest = useCallback(async (): Promise<void> => {
    let latest = state.latest;
    if (latest === null) latest = await refreshLatest();
    if (latest === null) return;
    forgetDraft(cacheKeyRef.current);
    dispatch({ type: "adopt-latest" });
  }, [refreshLatest, state.latest]);

  /** 复制草稿：**给出成功/失败反馈** ✗（旧实现静默吞掉失败 ⇒ 用户以为复制了 ✓） */
  const copyDraft = useCallback((): void => {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (clipboard === undefined) {
      setCopyState("failed");
      return;
    }
    void clipboard.writeText(state.draft).then(
      () => setCopyState("done"),
      () => setCopyState("failed"),
    );
  }, [state.draft]);

  /*
   * **草稿不是编辑器敲出来的**（采用最新正文 / 保存后规范化 / 恢复缓存 ⇒ 都算"外部替换"）⇒
   * 让富编辑器整体同步一次 ✓；用户自己敲的变化绝不触发 ✗（否则丢光标与撤销栈 ✓）。
   */
  useEffect(() => {
    if (lastEditorDraftRef.current === null) {
      lastEditorDraftRef.current = state.draft;
      return;
    }
    if (state.draft === lastEditorDraftRef.current) return;
    lastEditorDraftRef.current = state.draft;
    setRichSyncToken((value) => value + 1);
  }, [state.draft]);

  return (
    <aside
      className="kn-editor"
      role="dialog"
      aria-label={t("notePanelTitle")}
      data-dirty={dirty ? "true" : "false"}
      data-phase={state.phase}
      ref={(node) => { rootRef.current = node; }}
    >
      {/*
       * **紧凑标题栏**（约 44px ✓，`design/editor-content-density-and-scrollbar-design.md`
       * + `design/editor-chrome-minimal-design.md`）：
       * 一行放完"节点标题 + 未保存标记 + 关闭" ✓ ——
       * 底部的单行状态栏（保存状态 + 保存按钮）、「⋯ 详情」入口、**以及「正文 / 源码」切换**
       * 全部撤掉 ✗：省下的高度与宽度都给正文 ✓；保存只走 Ctrl / ⌘ + S
       * （提示挂在标题栏的 title 上 ✓）；"有没有未保存的改动"由**节点名右上角的 `*`**表示 ✓。
       * 模式不再由用户挑 ✓：正常就是正文，只有"富编辑器保不住的语法 / 起不来"才自动落到纯文本 ✓
       * （见下面的 `unsupported` 与通知条 ✓）。
       * 注意：这里的标题是**节点身份**（导航上下文 ✓），正文里的 Markdown 标题照旧按层级显示 ✓。
       */}
      <div className="kn-editor-heading" title={`${t("editorHint")} · ${t("saveShortcut")}`}>
        <h2 className="kn-editor-title" title={title}>
          <span className="kn-editor-title-text">{title}</span>
          {/*
           * **未保存 = 标题右上角一个 `*`** ✓（底部那行提示撤掉之后，这是唯一的"未保存"标记 ✓）。
           * 保存中改在同一个位置显示"正在保存…" ✓：那是唯一会改变用户下一步动作的短时状态 ✓
           * （冲突与保存失败另有整条提示，不靠这里 ✓）。
           */}
          {state.saving ? (
            <span className="kn-editor-saving" title={t("statusSaving")}>{t("statusSaving")}</span>
          ) : dirty ? (
            <sup className="kn-editor-dirty" title={t("statusDirty")}>
              <span aria-hidden="true">*</span>
              <span className="sr-only">{t("statusDirty")}</span>
            </sup>
          ) : null}
        </h2>
        <button type="button" className="kn-editor-close" aria-label={t("closeEditor")} onClick={() => { leaveRich("close"); }}>
          ×
        </button>
      </div>

      {state.conflicted ? (
        /*
         * **真实冲突**的轻量呈现 ✓（`design/save-and-close-reopen-conflict-optimization.md`）：
         * 默认只有一句话 + 三个动作 ✗（不再自动摊开整篇源码、也不铺满黄色背景 ✓）；
         * 用户点「比较修改」才展开两个并排区块：「我的修改」/「文件最新版本」，
         * 背景是正常正文色，**只对差异行做局部标注** ✓。
         */
        <div className="kn-editor-conflict" role="alert">
          <div className="kn-editor-conflict-bar">
            <span className="kn-editor-conflict-text">{t("conflictNotice")}</span>
            <div className="kn-editor-conflict-actions">
              {/* ① 比较：没读到最新版本就顺手读一次 ✓；展开与否**由用户点**决定 ✗（不再自动展开 ✓） */}
              <button
                type="button"
                disabled={state.saving || state.refreshing}
                onClick={() => {
                  if (state.latest === null) void refreshLatest();
                  if (!state.comparing) dispatch({ type: "toggle-compare" });
                }}
              >
                {state.comparing ? t("hideCompare") : t("compareChanges")}
              </button>
              {/* ② 保存合并结果：**看过文件最新版本之后**才可用 ✓（不替用户承担合并 ✗） */}
              <button
                type="button"
                disabled={state.saving || state.refreshing || state.latest === null || !state.comparing}
                title={state.latest === null || !state.comparing ? t("mergeNeedsReview") : undefined}
                onClick={() => { void mergeAndSave(); }}
              >
                {t("mergeAndSave")}
              </button>
              {/* ③ 使用文件最新版本 = 放弃修改 ⇒ 仍要二次确认 ✓ */}
              <button
                type="button"
                className="is-danger"
                disabled={state.saving || state.refreshing}
                onClick={() => setConfirmAdopt(true)}
              >
                {t("adoptLatest")}
              </button>
            </div>
          </div>
          {state.refreshing ? <div className="kn-editor-dim">{t("refreshingLatest")}</div> : null}
          {state.latest === null || !state.comparing ? (
            <div className="kn-editor-dim">{t("mergeNeedsReview")}</div>
          ) : null}
          {conflictDiff === null ? null : (
            <div className="kn-editor-compare">
              {conflictDiff.identical ? <div className="kn-editor-dim">{t("compareIdentical")}</div> : null}
              <div className="kn-editor-compare-pane">
                <div className="kn-editor-compare-head">{t("myDraft")}</div>
                <div className="kn-editor-compare-body" aria-label={t("myDraft")}>
                  {conflictDiff.left.map((line: DiffLine, index: number) => (
                    <div
                      key={`left-${index}`}
                      className={line.changed ? "kn-editor-diff-line is-changed" : "kn-editor-diff-line"}
                    >
                      {line.text === "" ? " " : line.text}
                    </div>
                  ))}
                </div>
              </div>
              <div className="kn-editor-compare-pane">
                <div className="kn-editor-compare-head">{t("latestText")}</div>
                <div className="kn-editor-compare-body" aria-label={t("latestText")}>
                  {conflictDiff.right.map((line: DiffLine, index: number) => (
                    <div
                      key={`right-${index}`}
                      className={line.changed ? "kn-editor-diff-line is-changed" : "kn-editor-diff-line"}
                    >
                      {line.text === "" ? " " : line.text}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {/*
       * 复查 P1-4 / P2-6：两条**必须让用户看见**的提示 ——
       * ① 正文里有富编辑器无法原样保留的语法 ⇒ 按**实际所处模式**分别说明 ✓；
       * ② 富编辑器初始化失败 ⇒ 明说"已改用纯文本、内容不会丢" ✓（不许假装还能保存 ✗）。
       * 两条都不给"挑模式"的入口 ✗：正常只有正文；纯文本只是这两条路上不丢内容的兜底 ✓。
       *
       * ⚠️ **不许在还没切换时宣称已经切换** ✗
       * （`design/code-block-copy-paste-analysis.md`「提示与实际模式不一致」✓）：
       * 自动切模式只在**节点载入时**判一次 ✓（编辑途中不突然切换 ✓），
       * 所以编辑途中新出现的语法可能**仍在正文模式** ✓ —— 那时说"已自动改用纯文本编辑"就是假话 ✗。
       */}
      {unsupported.length > 0 ? (
        <div className="kn-editor-notice" role="alert">
          <div>{t(tab === "source" ? "unsupportedNotice" : "unsupportedNoticeRich")}</div>
          <div className="kn-editor-dim">{unsupported.join(" · ")}</div>
          <div className="kn-editor-dim">{t("unsupportedRisk")}</div>
          <div className="kn-editor-notice-actions">
            {tab === "rich" && lastPaste !== "" ? (
              /*
               * **粘贴被 Markdown 拆散**时的补救 ✓（复查「更小的第一步」✓）：
               * 把刚才粘进来的原文整体作为**一个代码块**插入 ✓（走事务 ⇒ 可撤销 ✓），
               * 比"退回纯文本"轻，也不用重新粘贴 ✓。
               */
              <button
                type="button"
                onClick={() => { richRef.current?.insertCodeBlock(lastPaste); setLastPaste(""); }}
              >{t("pasteAsCodeBlock")}</button>
            ) : null}
            {tab === "rich" ? (
              /* 已经在正文里 ⇒ 给一条"退回纯文本、不改写语法"的路 ✓（回来随时可以 ✓） */
              <button type="button" onClick={() => { leaveRich("source"); }}>{t("backToPlainText")}</button>
            ) : (
              /*
               * 想回正文必须**显式点一次**（这是有损转换 ✓）：风险说明就在上面一行 ✓。
               * 用户把语法删干净之后，这个条子本身会消失、并自动回正文 ✓（见上面第三条 effect ✓）。
               */
              <button type="button" onClick={() => { setTab("rich"); }}>{t("openRichAnyway")}</button>
            )}
          </div>
        </div>
      ) : null}

      {/* 富编辑器起不来：已经自动落到纯文本 ⇒ 这里只说明原因与"照常能存" ✓（没有可点的切换 ✗） */}
      {richStatus.failed ? (
        <div className="kn-editor-error" role="alert">
          <div>{t("richFailed")}</div>
        </div>
      ) : null}

      {/*
         * **"正在准备编辑器"只在编辑器真的挂载之后才显示** ✗
         * （`design/plugin-note-editor-loading-optimization.md` 加载体验修正 ✓）：
         * `richStatus` 初始就是未就绪 ✓，而**正文还在读**的时候富编辑器根本还没挂载 ✓ ——
         * 原来那种写法会同时显示"正在读取笔记"和"正在准备编辑器" ✗，
         * 让人以为两段在并行（其实是一前一后 ✓）。
         * 现在：读取阶段只有"正在读取笔记"✓；`phase === "ready"`（正文到手、组件已挂载 ✓）
         * 之后才轮到"正在准备编辑器"✓。
         */}
      {state.phase === "ready" && tab === "rich" && !richStatus.ready && !richStatus.failed ? (
        <div className="kn-editor-dim">{t("richLoading")}</div>
      ) : null}

      <div className="kn-editor-body">
        {/* 载入中：只有在**还没有任何内容**时才占满（有草稿就必须露出来 ✓ —— 复查 P1-3 ✓） */}
        {state.phase === "loading" && state.draft === "" && state.base === "" ? (
          <div className="kn-editor-dim">{t("loadingDocument")}</div>
        ) : (
          <>
            {state.phase === "loadError" ? (
              <div className="kn-editor-error" role="alert">
                <div>{t(state.loadErrorKey ?? "loadFailed")}</div>
                <div className="kn-editor-notice-actions">
                  <button type="button" onClick={() => { void load(); }}>{t("retryLoad")}</button>
                  {state.draft !== "" ? (
                    <>
                      <button type="button" onClick={copyDraft}>{copyState === "done" ? t("copied") : t("copyDraft")}</button>
                      {copyState === "failed" ? <span className="kn-editor-dim">{t("copyFailed")}</span> : null}
                    </>
                  ) : null}
                </div>
              </div>
            ) : null}

            {tab === "rich" ? (
              /*
               * **正文模式**：Typora 式即时编辑 ✓（表格、公式、代码块直接编辑，不用切预览 ✓）。
               * 实例由 `MarkdownRichEditor` 管；这里只喂初始正文与只读状态 ✓。
               * 草稿变化**不**回写编辑器 ✗（否则丢光标/撤销栈/中文输入 ✓）；
               * 只有"确认采用最新正文"那一次才用 syncToken 触发整体替换 ✓。
               */
              <MarkdownRichEditor
                markdown={state.draft}
                syncToken={richSyncToken}
                readOnly={state.saving || state.frozen || state.phase !== "ready"}
                handleRef={richRef}
                /*
                 * **粘贴进来的纯文本**留着 ✓（`design/code-block-copy-paste-analysis.md` ✓）：
                 * 万一它被 Markdown 拆成段落 + `Text` 块（截图那样 ✓），
                 * 下面那条提示里就给一个"作为代码块插入"的一键补救 ✓（可撤销 ✓）。
                 */
                onPasteText={(text) => { setLastPaste(text); }}
                t={props.t}
                /*
                 * **编辑器报来它自己的规范化结果** ✓：末尾换行这类差异是编辑器写的、不是用户改的 ✗
                 * ⇒ 由 reducer 在"草稿还是它吃掉的那份、而且当前干净"时采纳 ✓
                 * （Host 落盘会去掉末尾空白，两份基线各管一件事 ✓）。
                 */
                onBaseline={(ingested, canonical) => {
                  dispatch({ type: "editor-baseline", ingested, canonical });
                }}
                onChange={(markdown) => {
                  lastEditorDraftRef.current = markdown;
                  dispatch({ type: "edit", text: markdown });
                }}
                onStatus={setRichStatus}
                report={reportRef.current}
              />
            ) : (
              /*
               * **纯文本兜底**（只有两条自动路径会到这里 ✓，用户不挑模式 ✗）：
               * 同一份草稿的另一种编辑方式 ✓ —— 保留未知扩展、逐字不改写原文 ✓。
               */
              <textarea
                ref={textareaRef}
                className="kn-editor-text"
                aria-label={t("notePanelTitle")}
                spellCheck={false}
                /* 保存期间冻结输入：否则"保存并继续"时敲的字会随卸载丢掉 ✗（复查要求 ✓） */
                readOnly={state.saving || state.frozen}
                value={state.draft}
                onChange={(event) => dispatch({ type: "edit", text: event.target.value })}
              />
            )}

            {/* 保存失败：显示在输入框旁，**重试执行保存**（不是重新读取 ✗）✓ */}
            {state.saveErrorKey !== null ? (
              <div className="kn-editor-error" role="alert">
                <div>{t(state.saveErrorKey)}</div>
                <div className="kn-editor-notice-actions">
                  <button type="button" disabled={state.saving || state.refreshing} onClick={() => { void save(); }}>{t("retrySave")}</button>
                  <button type="button" onClick={copyDraft}>{t("copyDraft")}</button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>

      {confirmAdopt ? (
        <div className="kn-editor-confirm" role="dialog" aria-modal="true">
          <div className="kn-editor-confirm-title">{t("adoptLatestConfirmTitle")}</div>
          <div className="kn-editor-confirm-body">{t("adoptLatestConfirmMessage")}</div>
          <div className="kn-editor-notice-actions">
            <button type="button" disabled={state.saving || state.refreshing} onClick={() => setConfirmAdopt(false)}>{t("leaveStay")}</button>
            <button
              type="button"
              className="is-danger"
              onClick={() => {
                setConfirmAdopt(false);
                void adoptLatest();
              }}
            >
              {t("adoptLatest")}
            </button>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
