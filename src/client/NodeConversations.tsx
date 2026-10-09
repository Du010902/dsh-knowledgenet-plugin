import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DocumentTarget } from "./node-document-client.ts";
import { nodeConversations, type ConversationRecord } from "./node-conversations.ts";
import { makeTranslator } from "./card-model.ts";

const LITERAL = { nodeChats: "对话 {count}", nodeChatNew: "打开新对话", nodeChatEmpty: "还没有从此节点打开过对话", nodeChatLoading: "加载中…", nodeChatCreating: "创建中…", nodeChatClose: "关闭对话列表", nodeChatFailed: "操作失败，请重试", nodeChatHint: "只在当前节点记录这些对话" };

/** Compact node-owned history picker; navigation is delegated to the editor's leave guard. */
export function NodeConversations(props: { nodeId: string; target?: DocumentTarget; t?: unknown; onOpen: (sessionId: string) => void }): ReactNode {
  const t = useMemo(() => makeTranslator(props.t, LITERAL), [props.t]);
  const [items, setItems] = useState<ConversationRecord[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const root = props.target?.root;
  const sessionId = props.target?.sessionId;
  const identity = JSON.stringify([root, sessionId, props.nodeId]);
  const current = useRef(identity); current.current = identity;
  const holder = useRef<HTMLDivElement>(null);
  const pending = useRef(false);
  useEffect(() => {
    let active = true;
    setItems([]); setLoading(true); setError(""); setOpen(false);
    void nodeConversations.list(props.nodeId, { root, sessionId }).then(data => { if (active) setItems(data.conversations); }).catch((e: Error) => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [props.nodeId, root, sessionId]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (holder.current && !e.composedPath().includes(holder.current)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); setOpen(false); } };
    document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape, true); };
  }, [open]);
  const create = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const id = await nodeConversations.create(props.nodeId, props.target);
      const data = await nodeConversations.list(props.nodeId, props.target).catch(() => null);
      if (current.current !== identity) return;
      setItems(data?.conversations ?? [...items.filter(item => item.sessionId !== id), { sessionId: id, createdAt: Date.now() }]); setOpen(false); props.onOpen(id);
    } catch (e) { if (current.current === identity) setError(e instanceof Error ? e.message : t("nodeChatFailed")); }
    finally { pending.current = false; if (current.current === identity) setBusy(false); }
  };
  return <div className="kn-note-relations kn-node-conversations" ref={holder}>
    <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{t("nodeChats", { count: items.length })}</button>
    {open ? <div className="kn-note-relations-popover">
      <div className="kn-note-relations-head"><strong>{t("nodeChats", { count: items.length })}</strong><button type="button" aria-label={t("nodeChatClose")} onClick={() => setOpen(false)}>×</button></div>
      <button type="button" disabled={busy || loading} onClick={() => { void create(); }}>{t(busy ? "nodeChatCreating" : "nodeChatNew")}</button>
      {loading ? <div className="kn-editor-dim">{t("nodeChatLoading")}</div> : items.length ? items.map(item => <button className="kn-note-relation-item" type="button" key={item.sessionId} disabled={busy} onClick={() => { try { props.onOpen(item.sessionId); setOpen(false); } catch (e) { setError(e instanceof Error ? e.message : t("nodeChatFailed")); } }}><span>{nodeConversations.title(item.sessionId)}</span><small>{new Date(item.createdAt).toLocaleString()}</small></button>) : <div className="kn-editor-dim">{t("nodeChatEmpty")}</div>}
      {error ? <div className="kn-editor-error" role="alert">{error}</div> : null}
      <div className="kn-editor-dim kn-node-chat-hint">{t("nodeChatHint")}</div>
    </div> : null}
  </div>;
}
