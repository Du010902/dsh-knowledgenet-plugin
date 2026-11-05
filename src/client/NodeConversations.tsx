import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DocumentTarget } from "./node-document-client.ts";
import { nodeConversations, PracticeLaunchError, type ConversationRecord, type ConversationState, type NodePractice } from "./node-conversations.ts";
import { makeTranslator } from "./card-model.ts";

const LITERAL = { nodeChats: "对话 {count}", nodeChatNew: "＋ 打开新对话", nodeChatEmpty: "还没有从此节点打开过对话", nodeChatLoading: "加载中…", nodeChatCreating: "创建中…", nodeChatClose: "关闭对话列表", nodeChatFailed: "操作失败，请重试", nodeChatHint: "只在当前节点记录这些对话", nodeChatArchived: "已归档", nodeChatArchivedHint: "已归档的对话不能在侧栏直接打开：先在左侧栏取消归档" };
const PRACTICE_ZH = {
  nodePracticeQuiz: "AI 提问",
  nodePracticeExplain: "自述理解",
  nodePracticeQuizPrompt: "我想针对知识点 {node} 做主动输出练习（AI 提问）。请按 ID 读取该节点作为参考，逐题提问并点评我的回答。默认三题，请先问第一题。",
  nodePracticeExplainPrompt: "我想针对知识点 {node} 做主动输出练习（自述理解）。请按 ID 读取该节点作为参考，分别评价我的理解是否准确、关键点是否讲全。如果下面没有自述，请先给我一个简短的引导。\n\n我的理解：\n",
  nodePracticeUnavailable: "当前 DSH 不支持预填对话草稿，请更新 DSH 后重试。",
  nodePracticeFailed: "无法打开练习，请重试。",
};

/** 侧栏筛选变化后的轮询间隔：筛选值只落在 localStorage 里（宿主没暴露服务），只能这么跟 ✓ */
const FILTER_POLL_MS = 500;

/** Compact node-owned history picker; navigation is delegated to the editor's leave guard. */
export function NodeConversations(props: { nodeId: string; title?: string; target?: DocumentTarget; t?: unknown; onOpen: (sessionId: string, onError?: (error: unknown) => void) => void }): ReactNode {
  const t = useMemo(() => makeTranslator(props.t, { ...LITERAL, ...PRACTICE_ZH }), [props.t]);
  const [items, setItems] = useState<ConversationRecord[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [listError, setListError] = useState("");
  /**
   * 「筛选已归档」的复核计数器。
   *
   * 那个筛选值由宿主 ui-workspace 存在**会话作用域的 slot store** 里、只落进 localStorage，
   * 插件拿不到订阅 ⇒ **只要这块界面还在（笔记编辑器开着）就隔一小会儿复读一次** ✓。
   *
   * ⚠️ 不要缩成"弹窗打开时才轮询" ✗：弹窗一被点外面就关了，用户正是在**去侧栏改筛选**的路上
   * 把它关掉，于是列表与「对话 N」的计数会一直是旧值（用户实测："只有重新打开笔记编辑界面才更新"✗）。
   */
  const [filterRevision, setFilterRevision] = useState(0);
  const root = props.target?.root;
  const sessionId = props.target?.sessionId;
  const identity = JSON.stringify([root, sessionId, props.nodeId]);
  const current = useRef(identity); current.current = identity;
  const holder = useRef<HTMLDivElement>(null);
  const pending = useRef<object | null>(null);
  useEffect(() => {
    current.current = identity;
    setBusy(false);
    let active = true;
    let generation = 0;
    setItems([]); setLoading(true); setError(""); setListError(""); setOpen(false);
    const reload = async () => {
      const request = ++generation;
      try { const data = await nodeConversations.list(props.nodeId, { root, sessionId }); if (active && request === generation) { setItems(data.conversations); setListError(""); } }
      catch (e) { if (active && request === generation) setListError(e instanceof Error ? e.message : t("nodeChatFailed")); }
      finally { if (active && request === generation) setLoading(false); }
    };
    const unsubscribe = nodeConversations.subscribe(recordsChanged => {
      if (recordsChanged) void reload();
      else if (active) setFilterRevision(value => value + 1);
    });
    const refresh = () => { void reload(); };
    window.addEventListener("focus", refresh);
    void reload();
    return () => { active = false; pending.current = null; if (current.current === identity) current.current = ""; unsubscribe(); window.removeEventListener("focus", refresh); };
  }, [props.nodeId, root, sessionId]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (holder.current && !e.composedPath().includes(holder.current)) setOpen(false); };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing || e.keyCode === 229) return;
      e.preventDefault(); e.stopImmediatePropagation();
      holder.current?.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')?.focus();
      setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape, true); };
  }, [open]);
  /** 一直盯着侧栏的「筛选会话」与归档集合（一次 localStorage 读 + 一次快照读，很便宜 ✓） */
  useEffect(() => {
    const timer = setInterval(() => setFilterRevision(value => value + 1), FILTER_POLL_MS);
    return () => clearInterval(timer);
  }, []);
  const create = async (mode?: NodePractice["mode"]) => {
    if (pending.current !== null) return;
    const attempt = {};
    pending.current = attempt; setBusy(true); setError("");
    const failed = (error: unknown) => {
      if (current.current !== identity) return;
      setOpen(true);
      setError(mode ? t(error instanceof PracticeLaunchError && error.reason === "unavailable" ? "nodePracticeUnavailable" : "nodePracticeFailed")
        : error instanceof Error ? error.message : t("nodeChatFailed"));
    };
    try {
      const practice = mode === undefined ? undefined : {
        mode,
        prompt: t(mode === "quiz" ? "nodePracticeQuizPrompt" : "nodePracticeExplainPrompt", {
          node: JSON.stringify({ title: props.title ?? props.nodeId, id: props.nodeId }),
        }),
      };
      const id = await nodeConversations.create(props.nodeId, props.target, practice);
      if (current.current !== identity || pending.current !== attempt) return;
      setOpen(false); props.onOpen(id, failed);
    } catch (e) { if (pending.current === attempt) failed(e); }
    finally { if (pending.current === attempt) { pending.current = null; setBusy(false); } }
  };
  /**
   * 哪些记录该出现、以什么形态出现 —— 全部交给 `recordState`（那里对齐侧栏的归档筛选 ✓）：
   *
   * - **已知是空白**的会话不算一次对话（打开新对话但一句没聊 ⇒ 侧栏里也看不见它 ✗）；
   * - **已归档**的会话按侧栏当前筛选处理：默认隐藏；「全部对话」下显示但**标出来并禁掉**
   *   （宿主不让直接打开归档会话，能点却没反应更糟 ✗）；「仅显示已归档」下只显示它们 ✓。
   *
   * **每轮渲染都现算**（不做记忆化）：筛选值不在依赖里就缓存的话，重新打开弹窗那一刻会先显示旧值 ✗
   * （用户实测："点开弹窗还是旧的"）。
   */
  void filterRevision; /* 复读触发的一次重算 ✓ */
  /* 筛选值**每轮只读一次**（每行各读一次纯属浪费：那是一次 localStorage 全键扫描 ✓） */
  const filter = nodeConversations.archivedFilter();
  const rows = items.flatMap(item => {
    const state: ConversationState = nodeConversations.recordState(item.sessionId, filter);
    return state === "hide" ? [] : [{ item, archived: state === "archived" }];
  });
  return <div className="kn-note-relations kn-node-conversations" ref={holder}>
    <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{t("nodeChats", { count: rows.length })}</button>
    {open ? <div className="kn-note-relations-popover">
      <div className="kn-note-relations-head"><strong>{t("nodeChats", { count: rows.length })}</strong><button type="button" aria-label={t("nodeChatClose")} onClick={() => setOpen(false)}>×</button></div>
      {loading ? <div className="kn-editor-dim">{t("nodeChatLoading")}</div> : rows.length ? rows.map(({ item, archived }) => <button className="kn-note-relation-item" type="button" key={item.sessionId} disabled={busy || archived} title={archived ? t("nodeChatArchivedHint") : undefined} onClick={() => { try { props.onOpen(item.sessionId); setOpen(false); } catch (e) { setError(e instanceof Error ? e.message : t("nodeChatFailed")); } }}><span>{nodeConversations.title(item.sessionId)}</span><small>{new Date(item.createdAt).toLocaleString()}{archived ? ` · ${t("nodeChatArchived")}` : ""}</small></button>) : <div className="kn-editor-dim">{t("nodeChatEmpty")}</div>}
      {error || listError ? <div className="kn-editor-error" role="alert">{error || listError}</div> : null}
      <div className="kn-node-chat-hint">{t("nodeChatHint")}</div>
      <button type="button" className="kn-note-relations-add" disabled={busy || loading} onClick={() => { void create(); }}>{t(busy ? "nodeChatCreating" : "nodeChatNew")}</button>
      <button type="button" className="kn-note-relations-add" disabled={busy || loading} onClick={() => { void create("quiz"); }}>{t("nodePracticeQuiz")}</button>
      <button type="button" className="kn-note-relations-add" disabled={busy || loading} onClick={() => { void create("explain"); }}>{t("nodePracticeExplain")}</button>
    </div> : null}
  </div>;
}
