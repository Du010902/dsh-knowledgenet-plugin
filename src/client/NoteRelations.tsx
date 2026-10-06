import { useMemo, useState, type ReactNode } from "react";
import type { GraphSnapshot } from "../vendor/upstream/data/types.ts";
import type { DocumentTarget } from "./node-document-client.ts";
import { GRAPH_API_ROUTE } from "../shared/routes.ts";
import { makeTranslator } from "./card-model.ts";

/**
 * 关系面板的中英文案 ✓（**原来全是硬编码中文** ✗ —— 用户实测："插件的语言没有跟随系统"✓）。
 * 一律走 `t` ✓；宿主与插件两套翻译都缺席时才回落到这里的中文 ✓。
 */
const LITERAL: Record<string, string> = {
  relPre: "前置 {count}",
  relDepend: "被依赖 {count}",
  relAdd: "＋ 添加前置",
  relAddFromSelection: "＋ 添加前置节点",
  relAddTitle: "添加前置",
  relPreTitle: "前置知识",
  relDependTitle: "依赖此节点",
  relEmpty: "暂无关系",
  relSearchPlaceholder: "搜索已有节点，或输入新节点名称",
  relSearchLabel: "前置节点名称",
  relCreate: "新建「{title}」并设为前置",
  relAdding: "添加中…",
  relFailed: "添加失败，请重试",
  relClose: "关闭关系面板",
  relOpen: "打开「{title}」",
};

/** 笔记关系查看与添加；边 fromId 指向其前置 toId。 */
export function NoteRelations(props: {
  nodeId: string;
  graph?: GraphSnapshot;
  target?: DocumentTarget;
  onChanged?: () => void;
  /**
   * **点列表里的节点 ⇒ 跳到那个节点的编辑界面** ✓（用户实测要求 ✓）。
   *
   * 这里只把 **node id** 交出去 ✓（标题可能重复 ✗、也可能被改名 ✓）：
   * 真正切编辑器的是父面板 ✓ —— 它会先过"未保存改动"的三选一 ✓
   * ⇒ 直接切不会悄悄丢掉正在编辑的草稿 ✓。
   */
  onOpenNode?: ((nodeId: string) => void) | undefined;
  /** 宿主 / 插件的翻译函数 ✓（缺席时用本文件的中文字面文案 ✓） */
  t?: unknown;
  selection?: { text: string; top: number; left: number } | null;
}): ReactNode {
  /* `useMemo` 固化引用 ✓（否则每次渲染都是新函数，进依赖会引发自激效应 ✗ —— 有测试盯着 ✓） */
  const t = useMemo(() => makeTranslator(props.t, LITERAL), [props.t]);
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
      if (!response.ok || result.ok !== true) throw new Error(result.error?.message ?? t("relFailed"));
      props.onChanged?.(); setMode("pre"); setTitle("");
    } catch (e) { setError(e instanceof Error ? e.message : t("relFailed")); }
    finally { setBusy(false); }
  };
  return <div className="kn-note-relations">
    <button type="button" onClick={() => { setMode(mode === "pre" ? null : "pre"); setError(""); }}>{t("relPre", { count: pre.length })}</button>
    <button type="button" onClick={() => { setMode(mode === "depend" ? null : "depend"); setError(""); }}>{t("relDepend", { count: depend.length })}</button>
    <button type="button" onClick={() => { setMode("add"); setTitle(""); setError(""); }}>{t("relAdd")}</button>
    {props.selection && !mode ? <button type="button" className="kn-note-selection" style={{ top: props.selection.top, left: props.selection.left }} onPointerDown={e => e.preventDefault()} onClick={() => { setTitle(props.selection?.text.slice(0, 120) ?? ""); setMode("add"); }}>{t("relAddFromSelection")}</button> : null}
    {mode ? <div className="kn-note-relations-popover">
      <div className="kn-note-relations-head"><strong>{mode === "add" ? t("relAddTitle") : mode === "pre" ? t("relPreTitle") : t("relDependTitle")}</strong><button type="button" onClick={() => setMode(null)} aria-label={t("relClose")}>×</button></div>
      {mode === "add" ? <>
        <input aria-label={t("relSearchLabel")} placeholder={t("relSearchPlaceholder")} value={title} disabled={busy} onChange={e => setTitle(e.target.value)} />
        {candidates.map(n => <button type="button" key={n.id} disabled={busy} onClick={() => { void add(n.title, false); }}>{n.title}</button>)}
        <button type="button" disabled={busy || !title.trim()} onClick={() => { void add(title, true); }}>{busy ? t("relAdding") : t("relCreate", { title: title.trim() })}</button>
      </> : items.length ? items.map(n => (
        /*
         * **列表项是按钮** ✓（原来是 `<div>` ✗ ⇒ 点不动 ✓，用户实测 ✓）：
         * 点击跳到该节点的编辑界面 ✓；键盘也能 Tab 到、回车打开 ✓。
         * 没有回调时（只读场景 ✓）退化成不可点的行 ✓（保留原来的样子 ✓）。
         */
        <button
          type="button"
          className="kn-note-relation-item"
          key={n!.id}
          disabled={props.onOpenNode === undefined}
          title={props.onOpenNode === undefined ? undefined : t("relOpen", { title: n!.title })}
          onClick={() => { props.onOpenNode?.(n!.id); }}
        >{n!.title}</button>
      )) : <div className="kn-editor-dim">{t("relEmpty")}</div>}
      {error ? <div role="alert" className="kn-editor-error">{error}</div> : null}
    </div> : null}
  </div>;
}
