import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { GraphSnapshot } from "../vendor/upstream/data/types.ts";
import type { DocumentTarget } from "./node-document-client.ts";
import { GRAPH_API_ROUTE } from "../shared/routes.ts";
import { makeTranslator } from "./card-model.ts";
import { relationAddKeyIntent } from "./relation-add-keyboard.ts";

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
  /**
   * 列表里「已理解」标签的文案 ✓。
   *
   * **刻意与 `UnderstandingButton` 用同一个键 `understood`** ✓：中英词典里
   * 已经有这一条（`"已理解"` / `"Understood"` ✓），再起一个同义键只会多一份可能不同步的翻译 ✗。
   * 这里给出**本文件的回落值** ✓（与 `UnderstandingButton` 一致 ✓）：宿主与插件的翻译都缺席时也不会露出键名 ✓。
   */
  understood: "已理解",
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
  /**
   * **各节点的理解标记**（`Record<nodeId, boolean>` ✓，也就是宿主 `understanding.json` 的内容 ✓）。
   *
   * 用户实测要求：前置 / 被依赖列表里**已经理解**的节点后面加一个「已理解」标签 ✓，
   * **没有理解的节点什么都不加** ✗（不显示"未理解"✓ —— 没标记只是"没标过"，
   * 不等于"他不懂"，多一个灰标签反而变成噪声 ✓）。
   *
   * 缺席（宿主没给这份数据 / 只读场景）⇒ 一律当作没标记 ✓：列表退回原来的样子 ✓。
   */
  understanding?: Record<string, boolean> | undefined;
  /** 宿主 / 插件的翻译函数 ✓（缺席时用本文件的中文字面文案 ✓） */
  t?: unknown;
  selection?: { text: string; top: number; left: number } | null;
  /**
   * **选中文字 → 浮动工具栏的「＋ 添加前置节点」** ✓。
   *
   * 为什么不再用"贴着选区的浮钮" ✗（原 `.kn-note-selection`）：它和编辑器自己的
   * 格式化工具栏都浮在选区上方，**两块会互相遮挡** ✗（用户截图实测 ✓）。
   * 现在「添加前置节点」并进**同一个格式化工具栏** ✓（见 `MarkdownRichEditor` 的 `buildToolbar`），
   * 选区旁只剩一条工具栏 ✓；这里用 `nonce` 接收"要打开添加前置"的请求 ✓。
   */
  addRequest?: { text: string; nonce: number } | null;
}): ReactNode {
  /* `useMemo` 固化引用 ✓（否则每次渲染都是新函数，进依赖会引发自激效应 ✗ —— 有测试盯着 ✓） */
  const t = useMemo(() => makeTranslator(props.t, LITERAL), [props.t]);
  const [mode, setMode] = useState<"pre" | "depend" | "add" | null>(null);
  const [title, setTitle] = useState("");
  /** 本次"从选区添加"的原文 ✓（作为 snippet 上报给宿主工具 ✓ —— 与标题分开存 ✓） */
  const [snippet, setSnippet] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lastAddNonceRef = useRef(-1);
  /** 关系面板根节点 ✓（判断"点外面"用 ✓：面板在 shadow DOM 里 ⇒ 要用 composedPath 认领 ✓） */
  const rootRef = useRef<HTMLDivElement | null>(null);
  /*
   * **点旁边空白区域 ⇒ 弹窗自动消失** ✓（用户第十三轮要求 ✓）。
   * 面板在 shadow DOM 里 ⇒ 必须用 `composedPath()` + 根节点引用判"里面/外面" ✓
   * （事件冒到 document 时 target 会被重定向成 shadow host ✗）。
   * Esc 同样关闭 ✓（不改正文、不提交任何东西 ✓）。
   */
  useEffect(() => {
    if (mode === null) return undefined;
    const close = (): void => { setMode(null); setSnippet(""); };
    const onPointerDown = (event: PointerEvent): void => {
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      const root = rootRef.current;
      if (root !== null && path.includes(root)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      rootRef.current?.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')?.focus();
      close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [mode]);
  useEffect(() => {
    if (mode === "add") rootRef.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [mode]);
  /*
   * 工具栏点「＋ 添加前置节点」⇒ 打开添加面板，并把**选中原文**填进标题 ✓。
   * 用 `nonce` 而不是"内容变了就打开"✗：同一段文字反复触发也要能再次打开 ✓。
   */
  useEffect(() => {
    const request = props.addRequest;
    if (request === undefined || request === null) return;
    if (request.nonce === lastAddNonceRef.current) return;
    lastAddNonceRef.current = request.nonce;
    setTitle(request.text.slice(0, 120));
    setSnippet(request.text);
    setError("");
    setMode("add");
  }, [props.addRequest]);
  const graph = props.graph;
  const pre = graph?.edges.filter(e => e.fromId === props.nodeId) ?? [];
  const depend = graph?.edges.filter(e => e.toId === props.nodeId) ?? [];
  const items = (mode === "depend" ? depend : pre).map(e => graph?.nodes.find(n => n.id === (mode === "depend" ? e.fromId : e.toId))).filter(n => n !== undefined);
  const candidates = graph?.nodes.filter(n => n.id !== props.nodeId && n.title.toLowerCase().includes(title.trim().toLowerCase()) && !pre.some(e => e.toId === n.id)).slice(0, 8) ?? [];
  const add = async (name: string, create: boolean): Promise<void> => {
    if (busy || name.trim() === "") return;
    setBusy(true); setError("");
    try {
      const response = await fetch(GRAPH_API_ROUTE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "add-prerequisite", ...props.target, fromId: props.nodeId, title: name.trim(), create, snippet: snippet || props.selection?.text }) });
      const result = await response.json();
      if (!response.ok || result.ok !== true) throw new Error(result.error?.message ?? t("relFailed"));
      props.onChanged?.(); setMode("pre"); setTitle(""); setSnippet("");
    } catch (e) { setError(e instanceof Error ? e.message : t("relFailed")); }
    finally { setBusy(false); }
  };
  return <div className="kn-note-relations" ref={rootRef}>
    <button type="button" aria-expanded={mode === "pre" || mode === "add"} onClick={() => { setMode(mode === "pre" ? null : "pre"); setError(""); }}>{t("relPre", { count: pre.length })}</button>
    <button type="button" aria-expanded={mode === "depend"} onClick={() => { setMode(mode === "depend" ? null : "depend"); setError(""); }}>{t("relDepend", { count: depend.length })}</button>
    {/*
     * **「＋ 添加前置」从标题栏移进「前置」弹窗** ✓（用户第十三轮要求："使用频率不高" ✓）。
     * 弹窗里在列表下方给一个入口 ✓（见下面 `mode === "pre"` 那个按钮 ✓）；
     * 选中文字后工具栏那颗「添加前置节点」仍然直达添加态 ✓（`addRequest` ✓）。
     */}
    {/*
     * 旧的"贴着选区的浮钮"（`.kn-note-selection`）已删除 ✗ —— 它和格式化工具栏互相遮挡（用户截图 ✓）；
     * 功能并进浮动工具栏的「＋ 添加前置节点」✓（`addRequest` prop 接收请求 ✓）。
     * snippet 的取用顺序：本次"从选区添加"的原文 ✓ → 当前选区的原文（主按钮的既有行为 ✓）；
     * 关闭/成功后清空 ✓，不会把上一次请求的原文带到下一次 ✓。
     */}
    {mode ? <div className="kn-note-relations-popover">
      <div className="kn-note-relations-head"><strong>{mode === "add" ? t("relAddTitle") : mode === "pre" ? t("relPreTitle") : t("relDependTitle")}</strong><button type="button" onClick={() => { setMode(null); setSnippet(""); }} aria-label={t("relClose")}>×</button></div>
      {mode === "add" ? <>
        {/*
         * **回车 = 点「新建「x」并设为前置」** ✓（用户实测：输入名字后按 Enter 毫无反应 ✗）。
         * 判定抽到 `relation-add-keyboard.ts` ✓（纯函数 ⇒ 能被 Node 直接单测 ✓；
         * 重点钉住"输入法组合中不误触发"✓ 与"busy / 空标题和按钮 disabled 一致"✓）。
         * 这里只把意图落地：ignore 什么都不做 ✓；consume 只 preventDefault ✓；
         * create 才调与按钮语义相同的 `add(title.trim(), true)` ✓（`add()` 里还会再 trim 一次 ✓）。
         */}
        <input
          aria-label={t("relSearchLabel")}
          placeholder={t("relSearchPlaceholder")}
          value={title}
          disabled={busy}
          onChange={e => setTitle(e.target.value)}
          onKeyDown={event => {
            const intent = relationAddKeyIntent(event.key, {
              title,
              busy,
              isComposing: event.nativeEvent.isComposing === true,
              keyCode: event.nativeEvent.keyCode,
            });
            if (intent === "ignore") return;
            event.preventDefault();
            if (intent === "create") void add(title.trim(), true);
          }}
        />
        {candidates.map(n => <button type="button" key={n.id} disabled={busy} onClick={() => { void add(n.title, false); }}>{n.title}</button>)}
        <button type="button" disabled={busy || !title.trim()} onClick={() => { void add(title, true); }}>{busy ? t("relAdding") : t("relCreate", { title: title.trim() })}</button>
      </> : <>
        {items.length ? items.map(n => (
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
          >
            {/*
              * **已理解的节点后面加一个「已理解」标签** ✓（用户实测要求 ✓）。
              *
              * 判据只有一条：`understanding[n.id] === true` ✓ —— 没有标记、或显式标成"未理解"的节点
              * **一律什么都不加** ✗（用户明确要求"没理解的不做任何改变"✓；
              * 而且"没标过"不等于"他不懂"✓，多挂一个灰标签只是噪声 ✓）。
              *
              * 标签是**装饰性**的 ✓（`aria-hidden`）⇒ 按钮的无障碍名字仍然只有节点标题 ✓
              * （读屏听到"打开「克隆」"就够 ✓；理解状态另有编辑器头部那个真正的按钮承担 ✓）。
              */}
            {n!.title}{props.understanding?.[n!.id] === true ? <span className="kn-note-relation-understood" aria-hidden="true"><span className="kn-note-relation-understood-dot" />{t("understood")}</span> : null}
          </button>
        )) : <div className="kn-editor-dim">{t("relEmpty")}</div>}
        {/* **「＋ 添加前置」入口** ✓：只在「前置」弹窗里出现 ✓（标题栏不再放它 ✓） */}
        {mode === "pre" ? (
          <button
            type="button"
            className="kn-note-relations-add"
            onClick={() => { setMode("add"); setTitle(""); setSnippet(""); setError(""); }}
          >
            {t("relAdd")}
          </button>
        ) : null}
      </>}
      {error ? <div role="alert" className="kn-editor-error">{error}</div> : null}
    </div> : null}
  </div>;
}
