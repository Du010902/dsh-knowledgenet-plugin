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
  EDITOR_LITERAL,
  canSave,
  createLatestGuard,
  createSaveGate,
  editorReducer,
  failureKey,
  forgetDraft,
  initialEditorState,
  isDirty,
  previewBlocks,
  recallDraft,
  rememberDraft,
  statusText,
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
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const [confirmAdopt, setConfirmAdopt] = useState(false);
  /** 复制草稿的反馈（null = 还没复制过 ✓） */
  const [copyState, setCopyState] = useState<"done" | "failed" | null>(null);

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
    try {
      const outcome = await readNodeDocument(props.nodeId, fetcher, {
        target: targetRef.current,
        signal: controller.signal,
        isCurrent: () => seq === seqRef.current,
      });
      if (outcome === undefined || seq !== seqRef.current) return;
      if (outcome.ok === true) {
        dispatch({ type: "load-ok", document: outcome.document });
        reportRef.current?.("node-document-read", { nodeId: props.nodeId, revision: outcome.document.revision });
        return;
      }
      dispatch({ type: "load-failed", key: failureKey(outcome.code) });
      reportRef.current?.("node-document-read-failed", { nodeId: props.nodeId, code: outcome.code });
    } catch (error) {
      if (seq !== seqRef.current) return;
      dispatch({ type: "load-failed", key: "loadFailed" });
      reportRef.current?.("node-document-read-error", String(error));
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
      dispatch({ type: "restore-draft", draft: cached.draft, base: cached.base, hash: cached.hash });
    }
    void load();
    return () => {
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
   */
  useEffect(() => {
    if (isDirty(state)) {
      rememberDraft(cacheKeyRef.current, { draft: state.draft, base: state.base, hash: state.hash });
    } else {
      forgetDraft(cacheKeyRef.current);
    }
  }, [state.draft, state.base, state.hash, state.conflicted]);

  /* 有未保存修改就报给父面板（只影响"要不要拦"，不会触发重读 ✓） */
  const dirty = isDirty(state);
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => { onDirtyChangeRef.current?.(false); }, []);

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
        /* `submitted` 用来把宿主**规范化后的正文**同步回草稿 ⇒ 不会一直显示"未保存" ✓ */
        dispatch({ type: "save-ok", document: outcome.document, submitted: text });
        /* 身份被"采用"（adopted-* → ULID）⇒ 草稿搬到新键、**旧键删掉** ✓（复查 P2-4 ✓） */
        if (outcome.document.nodeId !== props.nodeId) {
          forgetDraft(`${props.libraryKey ?? ""}::${props.nodeId}`);
          rememberDraft(`${props.libraryKey ?? ""}::${outcome.document.nodeId}`, {
            draft: outcome.document.text,
            base: outcome.document.text,
            hash: outcome.document.hash,
          });
        }
        reportRef.current?.("node-document-saved", {
          nodeId: outcome.document.nodeId,
          revision: outcome.document.revision,
        });
        saveOutcomeRef.current?.(false, "saved");
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

  const save = useCallback((): Promise<boolean> => saveWith(state.draft, state.hash), [saveWith, state.draft, state.hash]);

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
    dispatch({ type: "merge-and-save" });
    await saveWith(state.draft, state.latest.hash);
  }, [refreshLatest, saveWith, state.draft, state.latest]);

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

  const blocks = useMemo(() => previewBlocks(state.draft), [state.draft]);

  return (
    <aside
      className="kn-editor"
      aria-label={t("notePanelTitle")}
      data-dirty={dirty ? "true" : "false"}
      data-phase={state.phase}
      ref={(node) => { rootRef.current = node; }}
    >
      <div className="kn-editor-heading">
        <div className="kn-editor-row">
          <span className="kn-editor-tag">{t("notePanelTitle")}</span>
          <button type="button" className="kn-editor-close" aria-label={t("closeEditor")} onClick={props.onClose}>
            ×
          </button>
        </div>
        <h2 className="kn-editor-title">{state.title === "" ? props.nodeId : state.title}</h2>
        <div className="kn-editor-path">{state.path}</div>
      </div>

      <div className="kn-editor-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "edit"}
          className={tab === "edit" ? "is-active" : ""}
          onClick={() => setTab("edit")}
        >
          {t("tabEdit")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "preview"}
          className={tab === "preview" ? "is-active" : ""}
          onClick={() => setTab("preview")}
        >
          {t("tabPreview")}
        </button>
      </div>

      {state.conflicted ? (
        <div className="kn-editor-notice" role="alert">
          <div>{t("conflictNotice")}</div>
          {state.refreshing ? <div className="kn-editor-dim">{t("refreshingLatest")}</div> : null}
          <div className="kn-editor-notice-actions">
            {/* ① 只展开/收起比较 ✓（**绝不**替换草稿 ✗） */}
            <button type="button" disabled={state.saving || state.refreshing} onClick={() => dispatch({ type: "toggle-compare" })}>
              {state.comparing ? t("hideLatest") : t("compareLatest")}
            </button>
            {/* ② 合并后保存：换基线、保留草稿 ✓ */}
            <button type="button" disabled={state.saving || state.refreshing} onClick={() => { void mergeAndSave(); }}>{t("mergeAndSave")}</button>
            {state.latest === null ? <span className="kn-editor-dim">{t("mergeNeedsReview")}</span> : null}
            {/* ③ 放弃草稿：明确按钮 + 二次确认 ✓ */}
            <button type="button" className="is-danger" disabled={state.saving || state.refreshing} onClick={() => setConfirmAdopt(true)}>
              {t("adoptLatest")}
            </button>
            {state.latest === null ? (
              <button type="button" disabled={state.saving || state.refreshing} onClick={() => { void refreshLatest(); }}>{t("refreshBaseline")}</button>
            ) : null}
          </div>
          {state.comparing && state.latest !== null ? (
            <pre className="kn-editor-latest" aria-label={t("latestText")}>{state.latest.text}</pre>
          ) : null}
        </div>
      ) : null}

      <div className="kn-editor-hint">{t("editorHint")}</div>

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

            {tab === "edit" ? (
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
            ) : (
              <div className="kn-editor-preview">
                <div className="kn-editor-dim">{t("previewSimplified")}</div>
                {blocks.map((block, index) => (block.heading
                  ? <h3 key={index}>{block.text}</h3>
                  : <div key={index}>{block.text}</div>))}
              </div>
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

      <div className="kn-editor-foot">
        <div className="kn-editor-row">
          <span className={state.conflicted ? "kn-editor-status is-conflict" : "kn-editor-status"}>
            {statusText(state, t)}
          </span>
          <button
            type="button"
            className="kn-editor-save"
            disabled={!canSave(state)}
            onClick={() => { void save(); }}
          >
            {t("saveNote")}
          </button>
        </div>
        <div className="kn-editor-row kn-editor-sub">
          <span>{t("saveShortcut")}</span>
          {state.revision > 0 ? <span>rev {state.revision}</span> : null}
        </div>
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
