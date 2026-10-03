import { useState, type ReactNode } from "react";
import type { GraphSnapshot } from "../vendor/upstream/data/types.ts";
import type { DocumentTarget } from "./node-document-client.ts";
import { GRAPH_API_ROUTE } from "../shared/routes.ts";

/** 笔记关系查看与添加；边 fromId 指向其前置 toId。 */
export function NoteRelations(props: { nodeId: string; graph?: GraphSnapshot; target?: DocumentTarget; onChanged?: () => void; selection?: { text: string; top: number; left: number } | null }): ReactNode {
  const [mode, setMode] = useState<"pre" | "depend" | "add" | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const graph = props.graph;
  const pre = graph?.edges.filter(e => e.fromId === props.nodeId) ?? [];
  const depend = graph?.edges.filter(e => e.toId === props.nodeId) ?? [];
  const items = (mode === "depend" ? depend : pre).map(e => graph?.nodes.find(n => n.id === (mode === "depend" ? e.fromId : e.toId))).filter(n => n !== undefined);
  const candidates = graph?.nodes.filter(n => n.id !== props.nodeId && n.title.toLowerCase().includes(title.trim().toLowerCase()) && !pre.some(e => e.toId === n.id)).slice(0, 8) ?? [];
  const add = async (name: string, create: boolean): Promise<void> => {
    if (busy || name.trim() === "") return;
    setBusy(true); setError("");
    try {
      const response = await fetch(GRAPH_API_ROUTE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "add-prerequisite", ...props.target, fromId: props.nodeId, title: name.trim(), create, snippet: props.selection?.text }) });
      const result = await response.json();
      if (!response.ok || result.ok !== true) throw new Error(result.error?.message ?? "添加失败，请重试");
      props.onChanged?.(); setMode("pre"); setTitle("");
    } catch (e) { setError(e instanceof Error ? e.message : "添加失败，请重试"); }
    finally { setBusy(false); }
  };
  return <div className="kn-note-relations">
    <button type="button" onClick={() => { setMode(mode === "pre" ? null : "pre"); setError(""); }}>前置 {pre.length}</button>
    <button type="button" onClick={() => { setMode(mode === "depend" ? null : "depend"); setError(""); }}>被依赖 {depend.length}</button>
    <button type="button" onClick={() => { setMode("add"); setTitle(""); setError(""); }}>＋ 添加前置</button>
    {props.selection && !mode ? <button type="button" className="kn-note-selection" style={{ top: props.selection.top, left: props.selection.left }} onPointerDown={e => e.preventDefault()} onClick={() => { setTitle(props.selection?.text.slice(0, 120) ?? ""); setMode("add"); }}>＋ 添加前置节点</button> : null}
    {mode ? <div className="kn-note-relations-popover">
      <div className="kn-note-relations-head"><strong>{mode === "add" ? "添加前置" : mode === "pre" ? "前置知识" : "依赖此节点"}</strong><button type="button" onClick={() => setMode(null)} aria-label="关闭关系面板">×</button></div>
      {mode === "add" ? <>
        <input aria-label="前置节点名称" placeholder="搜索已有节点，或输入新节点名称" value={title} disabled={busy} onChange={e => setTitle(e.target.value)} />
        {candidates.map(n => <button type="button" key={n.id} disabled={busy} onClick={() => { void add(n.title, false); }}>{n.title}</button>)}
        <button type="button" disabled={busy || !title.trim()} onClick={() => { void add(title, true); }}>{busy ? "添加中…" : `新建「${title.trim() || "节点"}」并设为前置`}</button>
      </> : items.length ? items.map(n => <div className="kn-note-relation-item" key={n!.id}>{n!.title}</div>) : <div className="kn-editor-dim">暂无关系</div>}
      {error ? <div role="alert" className="kn-editor-error">{error}</div> : null}
    </div> : null}
  </div>;
}
