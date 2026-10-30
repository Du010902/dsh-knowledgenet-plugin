/**
 * 空间/聚焦视图里的**右键菜单**（节点：加前置；连线：删依赖）。
 *
 * 上游的两种视图已经通过 window 事件请求菜单（`nodeContextMenu.ts` 的约定）：
 * - `knowledgenet:node-context-menu` → `{ nodeId, x, y }`
 * - `knowledgenet:edge-context-menu` → `{ edgeId, x, y }`
 * 插件在这里监听并渲染**自己的**菜单（portal 到 body，`position: fixed`），
 * 动作走宿主路由的写入口——不在客户端直接改文件。
 *
 * 两个弹窗也是自己的（`window.prompt` 同样会被沙箱静默忽略，和 `confirm` 一个道理）：
 * - 输入标题（加前置）；
 * - 相近节点确认（复用已有 / 仍然新建），**不擅自建重复节点**。
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { makeTranslator } from "./card-model.ts";

import { GRAPH_API_ROUTE } from "../shared/routes.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { reportDiag } from "./diag.ts";
import { rankNodes, type SearchableNode } from "./node-search.ts";

/** 上游事件名（契约来自 vendor/upstream/components/nodeContextMenu.ts） */
export const NODE_MENU_EVENT = "knowledgenet:node-context-menu";
export const EDGE_MENU_EVENT = "knowledgenet:edge-context-menu";
/** 空白画布右键（由 GraphSpace / GraphUniverse 派发）：**建节点的唯一入口** */
export const CANVAS_MENU_EVENT = "knowledgenet:canvas-context-menu";

/**
 * 在指定屏幕坐标上请求打开"空白画布"菜单（面板按钮用它，就不必再写一份建节点弹窗）。
 * @param x - 视口 x。
 * @param y - 视口 y。
 */
export function requestCanvasMenu(x: number, y: number): void {
  try {
    /*
     * 上报留痕：面板右键"没有反应"时，`kn_status` 能据此区分两种原因——
     * 事件根本没到（没有这条记录 ✗）还是到了但菜单渲染失败（有记录 ✓）。
     * 实测踩到过：上游画布视图的右键处理吃掉了事件，我的处理器没被触发，日志里一片空白。
     */
    void reportDiag("graph-menu", "canvas-request", `${Math.round(x)},${Math.round(y)}`);
    window.dispatchEvent(new CustomEvent(CANVAS_MENU_EVENT, { detail: { x, y } }));
  } catch {
    // 没有 window（非浏览器环境）时什么都不做
  }
}

interface MenuNode {
  id: string;
  title?: string;
  /** 别名也参与候选匹配（"添加前置"输入框下面的已有节点列表用 ✓） */
  aliases?: readonly string[];
}

interface MenuEdge {
  id: string;
  fromId?: string;
  toId?: string;
  type?: string;
  description?: string;
}

/* 菜单三种来源：节点右键 / 连线右键 / **空白处右键（建节点入口）** ✓ */
type MenuState =
  | { kind: "node"; id: string; x: number; y: number }
  | { kind: "edge"; id: string; x: number; y: number }
  | { kind: "canvas"; id: string; x: number; y: number };

/** 菜单与输入框的样式（portal 在 light DOM，所以要注入到 document head） */
export function graphMenuCss(): string {
  return [
    /*
     * z-index 必须**高于** `.kn-modal-backdrop`（10001）。
     *
     * 踩过的坑：菜单是 10000、遮罩是 10001 ⇒ 透明遮罩盖在菜单上面 ⇒ 点「创建节点」被遮罩接走
     * （它只做 `setMenu(null)`）⇒ 表现成"点了没反应" ✗。凡是"菜单 + 透明遮罩"的组合，
     * 菜单必须在遮罩之上（遮罩只负责点外面关闭）。
     */
    ".kn-menu {",
    "  position: fixed; z-index: 10002; min-width: 168px; padding: 4px;",
    "  border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;",
    "  background: var(--dsw-alias-bg-layer-1);",
    "  color: var(--dsw-alias-label-primary);",
    "  box-shadow: 0 4px 8px rgb(0 0 0 / 4%), 0 16px 40px rgb(0 0 0 / 12%); font-size: 12.5px; }",
    ".kn-menu-title {",
    "  padding: 5px 10px 6px; font-size: 11px;",
    "  color: var(--dsw-alias-label-secondary);",
    "  border-bottom: 1px solid var(--dsw-alias-border-l2);",
    "  margin-bottom: 4px; max-width: 240px; overflow: hidden;",
    "  text-overflow: ellipsis; white-space: nowrap; }",
    ".kn-menu-item {",
    "  display: block; width: 100%; text-align: left; padding: 6px 10px;",
    "  border: 0; border-radius: 6px; background: transparent; color: inherit;",
    "  font: inherit; cursor: pointer; }",
    ".kn-menu-item:hover { background: var(--kn-hover, color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)); }",
    ".kn-menu-item:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; background: var(--kn-hover); }",
    ".kn-menu-item.is-danger { color: var(--dsw-alias-state-error-primary); }",
    ".kn-modal-input {",
    "  box-sizing: border-box; width: 100%; margin-top: 10px; padding: 6px 9px;",
    "  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;",
    "  background: transparent; color: var(--dsw-alias-label-primary); font: inherit; }",
    ".kn-modal-hint { margin-top: 8px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }",
    ".kn-modal-error { margin-top: 8px; font-size: 11.5px; color: var(--dsw-alias-state-error-primary); }",
    /*
     * 模态框本体与遮罩。
     *
     * 这几条曾经住在 `create-dialog-css.ts`（「添加知识库」用的），清理那个入口时被一起删掉 ✗，
     * 于是命名弹窗退化成浏览器默认样式、还跑到窗口左下角（用户实测截图）。
     * 教训：portal 到 body 的组件，样式必须和它**同一个模块**注入，别依赖别的组件的样式表。
     */
    ".kn-modal-backdrop { position: fixed; inset: 0; z-index: 10001; display: flex;",
    "  align-items: center; justify-content: center; padding: 16px;",
    "  background: rgba(0, 0, 0, 0.28); }",
    ".kn-modal { box-sizing: border-box; width: min(420px, 100%); padding: 16px;",
    "  border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px;",
    "  background: var(--dsw-alias-bg-layer-1);",
    "  color: var(--dsw-alias-label-primary);",
    "  box-shadow: 0 4px 8px rgb(0 0 0 / 4%), 0 16px 40px rgb(0 0 0 / 12%); font-size: 13px; }",
    ".kn-modal-title { font-size: 15px; line-height: 1.5; font-weight: 600; }",
    ".kn-modal-body { margin-top: 8px; font-size: 12px; line-height: 1.65; overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary); }",
    ".kn-modal-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 16px; }",
    ".kn-modal-btn { min-height: 32px; padding: 6px 14px; border-radius: 8px; cursor: pointer;",
    "  border: 1px solid var(--dsw-alias-border-l2); background: transparent;",
    "  color: inherit; font: inherit; }",
    ".kn-modal-btn:hover { background: var(--kn-hover, color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)); }",
    ".kn-modal-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }",
    ".kn-modal-btn:disabled { opacity: .5; cursor: default; }",
    ".kn-modal-primary { font-weight: 600;",
    "  border-color: transparent; color: #ffffff;",
    "  background: var(--dsw-alias-brand-primary); }",
  ].join("\n");
}

const STYLE_ID = "knowledgenet-menu-style";

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID) !== null) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = graphMenuCss();
  doc.head.append(style);
}

/**
 * 输入标题的图内弹窗（替代会被静默忽略的 `window.prompt`）。
 *
 * 用户 2026-10-29 要求：
 * ① 弹窗**只出现在图谱界面上方** ✓ —— 不再 portal 到 body 铺满整个窗口，而是渲染在
 *    `.graph` 里（`.kn-prompt-backdrop` 绝对定位到图谱区、贴顶居中）；
 * ② 输入「添加前置节点」名称时，**下面列出知识库里已有的节点**供选择 ✓
 *    （点一下就把名字填进输入框，再点「添加」；不会误建重复节点 ✓）。
 */
function PromptDialog(props: {
  title: string;
  hint: string;
  confirmLabel: string;
  cancelLabel: string;
  initial: string;
  busy?: boolean;
  /** 已有节点候选（只有"添加前置"传：输入时按匹配度列出来 ✓） */
  suggestions?: readonly MenuNode[];
  /** 候选列表的读屏名字 */
  suggestionLabel?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}): ReactNode {
  const [value, setValue] = useState(props.initial);
  const [error, setError] = useState<string | null>(null);
  /**
   * 输入框下方的已有节点候选：**复用面板搜索的打分**（标题 / 别名都算命中）✓，
   * 同一标题只列一次，最多 6 条（再多就成翻列表了 ✗）。
   */
  const matches = useMemo(() => {
    if (props.suggestions === undefined) return [];
    const query = value.trim();
    if (query === "") return [];
    const pool: SearchableNode[] = [];
    for (const node of props.suggestions) {
      if (typeof node.title !== "string" || node.title.trim() === "") continue;
      pool.push({ id: node.id, title: node.title, aliases: node.aliases });
    }
    const titles: string[] = [];
    const seen = new Set<string>();
    for (const hit of rankNodes(pool, query, 8)) {
      const title = hit.node.title;
      if (seen.has(title)) continue;
      seen.add(title);
      titles.push(title);
      if (titles.length >= 6) break;
    }
    return titles;
  }, [props.suggestions, value]);
  if (typeof document === "undefined") return null;
  const submit = (): void => {
    if (value.trim() === "") { setError(props.hint); return; }
    props.onConfirm(value.trim());
  };
  return (
    <div className="kn-prompt-backdrop" role="presentation" onClick={props.onCancel}>
      <div className="kn-prompt" role="dialog" aria-label={props.title} onClick={(event) => { event.stopPropagation(); }}>
        <div className="kn-prompt-title">{props.title}</div>
        <div className="kn-prompt-body">{props.hint}</div>
        <input
          className="kn-prompt-input"
          autoFocus
          value={value}
          placeholder={props.hint}
          onChange={(event) => { setValue(event.currentTarget.value); setError(null); }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              submit();
            } else if (event.key === "Escape") {
              props.onCancel();
            }
          }}
        />
        {matches.length === 0 ? null : (
          <div className="kn-prompt-suggest" role="listbox" aria-label={props.suggestionLabel ?? props.title}>
            {matches.map((title) => (
              <button
                key={title}
                type="button"
                role="option"
                aria-selected={false}
                className="kn-prompt-suggest-item"
                /* 按下时别抢走输入框焦点（否则连续点选会乱）✓ */
                onMouseDown={(event) => { event.preventDefault(); }}
                onClick={() => { setValue(title); setError(null); }}
              >
                {title}
              </button>
            ))}
          </div>
        )}
        <div className="kn-prompt-actions">
          <button type="button" className="kn-prompt-btn" onClick={props.onCancel}>{props.cancelLabel}</button>
          <button type="button" className="kn-prompt-btn kn-prompt-primary" onClick={submit}>
            {props.confirmLabel}
          </button>
        </div>
        {error === null ? null : <div className="kn-prompt-error">{error}</div>}
      </div>
    </div>
  );
}

export interface GraphContextMenuProps {
  nodes: readonly MenuNode[];
  edges: readonly MenuEdge[];
  /** 当前库的绑定：与 GET 用同一套（显式 root 优先，否则 sessionId） */
  root?: string | undefined;
  sessionId?: string | undefined;
  /** 写完之后的刷新 */
  onChanged: () => void;
  /** 「编辑笔记」入口（节点菜单 ✓）——面板据此打开正文编辑器 ✓ */
  onEditNote?: ((nodeId: string) => void) | undefined;
  /** 「进入节点群」入口（节点菜单 ✓）：点它**直接进入该节点所在的群**（2026-10-30 用户要求） */
  onViewGroups?: ((nodeId: string) => void) | undefined;
  /** 逐步上报（诊断） */
  report?: (step: string, detail?: Record<string, unknown> | null) => void;
  /** 宿主 / 插件的翻译函数 ✓ */
  t?: unknown;
  /** 文案 */
  copy: {
    nodeMenuTitle: string;
    /** 节点菜单里的「编辑笔记」（缺省回落中文 ✓） */
    editNote?: string;
    /** 节点菜单里的「进入节点群」（缺省回落中文 ✓） */
    viewGroups?: string;
    addPrerequisite: string;
    edgeMenuTitle: string;
    removeRelation: string;
  /** 空白处右键菜单：创建**独立节点**（不连任何关系，会归入地图的「独立节点」✓） */
  createIndependentNode?: string;
  /** 建独立节点弹窗的标题/提示/确认按钮 */
  createNodeTitle?: string;
  createNodeHint?: string;
  createNodeConfirm?: string;
  /** 空白菜单的标题（默认「这张图」；空白菜单只有一条动作，不再显示标题 ✓） */
  canvasMenuTitle?: string;
  /** 「添加前置」输入框下方已有节点列表的读屏名字 */
  suggestLabel?: string;
    removeNode: string;
    removeNodeConfirmTitle: string;
    removeNodeConfirmMessage: string;
    removeNodeDone: string;
  /** 删除确认的按钮与后果说明（只有一种删除方式：彻底删除，不再有"备份后删除"） */
  removeNodePurge?: string;
  removeNodeHint?: string;
    promptTitle: string;
    promptHint: string;
    confirmCreate: string;
    cancel: string;
    removeConfirmTitle: string;
    removeConfirmMessage: string;
    candidatesTitle: string;
    candidatesMessage: string;
    reuse: string;
    createAnyway: string;
    failed: string;
  };
}

/**
 * 渲染右键菜单与两个弹窗；右键事件由上游视图派发到 window。
 * @param props - 当前图数据、库绑定、回调与文案。
 * @returns 菜单/弹窗（没有右键时什么都不渲染）。
 */
/** 右键菜单的字面兜底 ✓（放在模块级：组件里的 `useMemo` 引用它不会踩"先用后声明"那条测试 ✓） */
const MENU_LITERAL: Record<string, string> = {
  canvasMenuTitle: "这张图",
  createIndependentNode: "创建独立节点",
  createNode: "创建节点",
  createNodeTitle: "创建独立节点",
  createNodeHint: "输入知识点名称（会作为文件名）；新节点不与任何节点相连，会归入地图的「独立节点」。",
  createNodeConfirm: "创建",
  suggestLabel: "知识库里已有的节点",
  viewGroups: "进入节点群",
  editNote: "编辑笔记",
  removeNodeHint: "删除会直接删掉那个 markdown 文件，不可恢复。",
  removeNodePurge: "删除",
  removeRelation: "删除这条依赖",
  nodeMenuTitle: "这个知识点",
  edgeMenuTitle: "这条依赖",
  createNodeDone: "已创建",
  menuFailed: "操作失败",
};

export function GraphContextMenu(props: GraphContextMenuProps): ReactNode {
  /* 缺 `copy` 的字段时用它补 ✓（英文界面下不许漏出中文 ✗） */
  const tr = useMemo(() => makeTranslator(props.t, MENU_LITERAL), [props.t]);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [prompt, setPrompt] = useState<{ fromId: string; x: number; y: number } | null>(null);
  const [pendingNew, setPendingNew] = useState<{ fromId: string; typed: string; candidates: string[] } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<{ fromId: string; edgeId: string; label: string } | null>(null);
  const [confirmRemoveNode, setConfirmRemoveNode] = useState<{ nodeId: string; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 空白处右键 → 「创建节点」的命名弹窗 */
  const [createNodeAt, setCreateNodeAt] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return;
    ensureStyle(document);
    const onNode = (event: Event): void => {
      const detail = (event as CustomEvent<{ nodeId?: unknown; x?: unknown; y?: unknown }>).detail;
      if (detail === null || typeof detail !== "object" || typeof detail.nodeId !== "string") return;
      setError(null);
      setMenu({ kind: "node", id: detail.nodeId, x: Number(detail.x) || 0, y: Number(detail.y) || 0 });
    };
    const onEdge = (event: Event): void => {
      const detail = (event as CustomEvent<{ edgeId?: unknown; x?: unknown; y?: unknown }>).detail;
      if (detail === null || typeof detail !== "object" || typeof detail.edgeId !== "string") return;
      setError(null);
      setMenu({ kind: "edge", id: detail.edgeId, x: Number(detail.x) || 0, y: Number(detail.y) || 0 });
    };
    /*
     * 空白画布右键：视图（GraphSpace / GraphUniverse）已经在派发 `knowledgenet:canvas-context-menu`，
     * 这里只需要接住它 → 给「创建节点」的入口。空库里的第一颗节点就是靠这条路建出来的。
     */
    const onCanvas = (event: Event): void => {
      const detail = (event as CustomEvent<{ x?: unknown; y?: unknown }>).detail;
      const x = detail !== null && typeof detail === "object" ? Number(detail.x) || 0 : 0;
      const y = detail !== null && typeof detail === "object" ? Number(detail.y) || 0 : 0;
      setError(null);
      setMenu({ kind: "canvas", id: "", x, y });
    };
    window.addEventListener(NODE_MENU_EVENT, onNode as EventListener);
    window.addEventListener(EDGE_MENU_EVENT, onEdge as EventListener);
    window.addEventListener(CANVAS_MENU_EVENT, onCanvas as EventListener);
    return () => {
      window.removeEventListener(NODE_MENU_EVENT, onNode as EventListener);
      window.removeEventListener(EDGE_MENU_EVENT, onEdge as EventListener);
      window.removeEventListener(CANVAS_MENU_EVENT, onCanvas as EventListener);
    };
  }, []);

  const report = (step: string, detail: Record<string, unknown> | null = null): void => {
    try {
      props.report?.(step, detail);
    } catch {
      // 上报失败不影响功能
    }
  };

  const titleOf = (id: string | undefined): string => {
    if (id === undefined) return "?";
    const node = props.nodes.find((item) => item.id === id);
    return node?.title ?? id.slice(0, 8);
  };

  /** 调宿主写入口；返回 { ok, added?, error? } */
  const post = async (body: Record<string, unknown>): Promise<{ ok: boolean; added?: { created?: boolean; candidates?: { title?: string }[] }; error?: { message?: string } }> => {
    const target: Record<string, unknown> = {};
    if (props.root !== undefined && props.root !== "") target.root = props.root;
    else if (props.sessionId !== undefined && props.sessionId !== "") target.sessionId = props.sessionId;
    const response = await fetch(GRAPH_API_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ ...target, ...body }),
    });
    const text = await response.text();
    try {
      return JSON.parse(text) as { ok: boolean; added?: { created?: boolean; candidates?: { title?: string }[] }; error?: { message?: string } };
    } catch {
      return { ok: false, error: { message: `HTTP ${response.status}：${text.slice(0, 100)}` } };
    }
  };

  const addPrerequisite = async (fromId: string, title: string, create: boolean): Promise<void> => {
    report("add-prerequisite", { create, title });
    const body = await post({ kind: "add-prerequisite", fromId, title, create });
    if (body.ok !== true) {
      setError(body.error?.message ?? props.copy.failed);
      report("add-prerequisite-failed", { message: body.error?.message ?? "" });
      return;
    }
    const candidates = (body.added?.candidates ?? []).map((item) => item.title ?? "").filter((item) => item !== "");
    if (create !== true && candidates.length > 0) {
      // 有相近节点：先问用户，不擅自建重复节点
      setPendingNew({ fromId, typed: title, candidates });
      report("add-prerequisite-candidates", { count: candidates.length });
      return;
    }
    report("add-prerequisite-done", { created: body.added?.created === true });
    props.onChanged();
  };

  const removeRelation = async (fromId: string, edgeId: string): Promise<void> => {
    report("remove-relation", {});
    const body = await post({ kind: "remove-prerequisite", fromId, edgeId });
    if (body.ok !== true) {
      setError(body.error?.message ?? props.copy.failed);
      report("remove-relation-failed", { message: body.error?.message ?? "" });
      return;
    }
    report("remove-relation-done", {});
    props.onChanged();
  };

  /**
   * 删除当前节点：调宿主移除**节点身份**（元数据进回收站，用户文件保留）。
   * @param nodeId - 要删除的节点 id。
   */
  /**
   * 删除一个节点：**直接删掉那个 markdown**（不可恢复 ✓）。
   *
   * 用户决定：节点就是一个文档，删除默认彻底删除 ✓ —— 所以不再有"备份后删除"这一档，
   * 也没有 `Backup/`（想留就自己复制那个 `.md` ✓）。
   *
   * @param nodeId - 节点 id。
   */
  const removeNode = async (nodeId: string): Promise<void> => {
    report("remove-node", {});
    const body = await post({ kind: "remove-node", nodeId });
    if (body.ok !== true) {
      setError(body.error?.message ?? props.copy.failed);
      report("remove-node-failed", { message: body.error?.message ?? "" });
      return;
    }
    report("remove-node-done", {});
    props.onChanged();
  };

  /**
   * 建一个**独立节点**（空白处右键 / 空库里的第一颗）。
   *
   * 走宿主的 `create-node` 路由：那边复用库自己的建节点写法（v3 = 写一个 markdown），
   * 所以建出来的节点扫描得到，不是"手搓的"。
   *
   * @param title - 知识点名称。
   */
  const createNode = async (title: string): Promise<void> => {
    const name = title.trim();
    if (name === "") return;
    report("create-node", {});
    const body = await post({ kind: "create-node", title: name });
    if (body.ok !== true) {
      setError(body.error?.message ?? props.copy.failed);
      report("create-node-failed", { message: body.error?.message ?? "" });
      return;
    }
    report("create-node-done", {});
    props.onChanged();
  };

  /*
   * 菜单的关闭逻辑（替代透明遮罩）：
   * - 在菜单**外面**按下鼠标 / 再点右键 / 按 Esc / 滚动 ⇒ 关闭；
   * - 菜单内部的点击不关闭（交给菜单项自己的 onClick）。
   *
   * 为什么不用"遮罩 + onClick"：遮罩只要拿到 `inset:0` 就会吃掉菜单上的点击 ✗（实测）。
   * 用全局监听：既没有覆盖层，也不会被任何上层元素挡住 ✓。
   */
  useEffect(() => {
    if (menu === null) return;
    const insideMenu = (target: EventTarget | null): boolean => {
      const node = target as { closest?: (selector: string) => unknown } | null;
      return typeof node?.closest === "function" && node.closest(".kn-menu") !== null;
    };
    const onDown = (event: Event): void => {
      if (insideMenu(event.target)) return;
      setMenu(null);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMenu(null);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("wheel", onDown, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("wheel", onDown, true);
    };
  }, [menu]);

  if (typeof document === "undefined") return null;

  return (
    <>
      {menu === null ? null : createPortal(
        <>
          {/*
           * **菜单不配透明遮罩**。
           *
           * 踩过的坑：为了让"点外面关闭"，菜单下面铺了一层透明的 `.kn-modal-backdrop`；
           * 一旦那层拿到 `position: fixed; inset: 0`（哪怕透明、哪怕 z-index 只差 1），
           * 它就会**吃掉菜单上的点击** ⇒ 表现成"菜单弹出来了，但点条目没反应"（用户实测 ✗）。
           * 现在关闭逻辑改由全局 `mousedown`（见 useMenuDismiss）负责，点外面照样关，
           * 但**没有任何元素压在菜单之上** ✓。
           */}
          <div className="kn-menu" style={{ left: menu.x, top: menu.y }} role="menu">
            {/*
             * 空白处菜单**不显示标题**（用户 2026-10-29："只需要有创建独立节点即可"）：
             * 那种场景只有一条动作，标题只会多占一行、还容易让人以为"这张图"是个可点的东西 ✗。
             */}
            {menu.kind === "canvas" ? null : (
              <div className="kn-menu-title">
                {menu.kind === "node" ? titleOf(menu.id) : edgeLabel(menu.id)}
              </div>
            )}
            {menu.kind === "canvas" ? (
              <button
                type="button"
                className="kn-menu-item"
                onClick={() => {
                  setMenu(null);
                  setCreateNodeAt({ x: menu.x, y: menu.y });
                  report("canvas-menu-create", {});
                }}
              >
                {props.copy.createIndependentNode ?? tr("createIndependentNode")}
              </button>
            ) : menu.kind === "node" ? (
              <>
                {/*
                 * 节点右键里**没有**「打开新对话」：从节点创建对话只从**笔记编辑界面**进
                 * （用户要求：右键空间视图中的节点不再打开对话 ✓）。
                 *
                 * 「编辑笔记」：与选中区那颗按钮同一条路 ✓（`design/node-note-editor-plan.md`
                 * 要求"选中节点信息区 + 右键菜单"两个入口 ✓）。
                 */}
                <button
                  type="button"
                  className="kn-menu-item"
                  onClick={() => {
                    const nodeId = menu.id;
                    setMenu(null);
                    props.onEditNote?.(nodeId);
                  }}
                >
                  {props.copy.editNote ?? tr("editNote")}
                </button>
                {/*
                 * 「进入节点群」：用户 2026-10-30 追加要求——入口放在**节点右键菜单**里；
                 * 点了**直接进入这个节点所在的节点群视图**（不再弹"所有群供选择"的弹窗 ✗）。
                 */}
                {props.onViewGroups === undefined ? null : (
                  <button
                    type="button"
                    className="kn-menu-item"
                    onClick={() => {
                      const nodeId = menu.id;
                      setMenu(null);
                      props.onViewGroups?.(nodeId);
                    }}
                  >
                    {props.copy.viewGroups ?? tr("viewGroups")}
                  </button>
                )}
                <button
                  type="button"
                  className="kn-menu-item"
                  onClick={() => {
                    const fromId = menu.id;
                    setMenu(null);
                    setPrompt({ fromId, x: menu.x, y: menu.y });
                  }}
                >
                  {props.copy.addPrerequisite}
                </button>
                {/*
                 * 节点菜单里**不**放「创建节点」：在节点上右键的意图几乎总是"给这个节点加前置"，
                 * 多一个"新建节点"只会让人以为要在它下面建子节点（实测反馈，不符合直觉）。
                 * 新建节点只在**空白处右键**出现。
                 */}
                {/*
                 * 删除当前节点：**直接删掉那个 markdown**（v3 没有"移除身份/保留文件夹"那一层），
                 * 用户的文件夹与笔记一个不动——所以确认框里要把这点说清楚，别让用户以为文件会没。
                 */}
                <button
                  type="button"
                  className="kn-menu-item is-danger"
                  onClick={() => {
                    const nodeId = menu.id;
                    setMenu(null);
                    setConfirmRemoveNode({ nodeId, label: titleOf(nodeId) });
                  }}
                >
                  {props.copy.removeNode}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="kn-menu-item is-danger"
                onClick={() => {
                  const edgeId = menu.id;
                  const edge = props.edges.find((item) => item.id === edgeId);
                  setMenu(null);
                  setConfirmRemove({ fromId: edge?.fromId ?? "", edgeId, label: `${titleOf(edge?.toId)} → ${titleOf(edge?.fromId)}` });
                }}
              >
                {props.copy.removeRelation}
              </button>
            )}
          </div>
        </>,
        document.body,
      )}

      {prompt === null ? null : (
        <PromptDialog
          title={props.copy.promptTitle}
          hint={props.copy.promptHint}
          confirmLabel={props.copy.confirmCreate}
          cancelLabel={props.copy.cancel}
          initial=""
          /* 输入时在下面列出**知识库里已有**的节点（排除当前这个节点自己 ✓） */
          suggestions={props.nodes.filter((node) => node.id !== prompt.fromId)}
          suggestionLabel={props.copy.suggestLabel ?? tr("suggestLabel")}
          onCancel={() => { setPrompt(null); }}
          onConfirm={(value) => {
            const fromId = prompt.fromId;
            setPrompt(null);
            void addPrerequisite(fromId, value, false);
          }}
        />
      )}

      {/*
        * 空白处右键 → 「创建独立节点」：只问名称。
        * 空库里的第一颗节点就走这条路（复用库自己的建节点写法，扫描得到、不是手搓的）。
        */}
      {createNodeAt === null ? null : (
        <PromptDialog
          title={props.copy.createNodeTitle ?? tr("createNodeTitle")}
          hint={props.copy.createNodeHint ?? tr("createNodeHint")}
          confirmLabel={props.copy.createNodeConfirm ?? tr("createNodeConfirm")}
          cancelLabel={props.copy.cancel}
          initial=""
          onCancel={() => { setCreateNodeAt(null); }}
          onConfirm={(value) => {
            setCreateNodeAt(null);
            void createNode(value);
          }}
        />
      )}

      {pendingNew === null ? null : (
        <ConfirmDialog
          title={props.copy.candidatesTitle}
          message={`${props.copy.candidatesMessage}：${pendingNew.candidates.join("、")}`}
          confirmLabel={`${props.copy.reuse}「${pendingNew.candidates[0]}」`}
          cancelLabel={props.copy.createAnyway}
          onConfirm={() => {
            const { fromId, candidates } = pendingNew;
            setPendingNew(null);
            void addPrerequisite(fromId, candidates[0] ?? "", false);
          }}
          onCancel={() => {
            const { fromId, typed } = pendingNew;
            setPendingNew(null);
            void addPrerequisite(fromId, typed, true);
          }}
        />
      )}

      {confirmRemove === null ? null : (
        <ConfirmDialog
          title={props.copy.removeConfirmTitle}
          message={`${props.copy.removeConfirmMessage}：${confirmRemove.label}`}
          confirmLabel={props.copy.removeRelation}
          cancelLabel={props.copy.cancel}
          onConfirm={() => {
            const { fromId, edgeId } = confirmRemove;
            setConfirmRemove(null);
            void removeRelation(fromId, edgeId);
          }}
          onCancel={() => { setConfirmRemove(null); }}
        />
      )}

      {error === null ? null : createPortal(
        <div className="kn-modal-backdrop" role="presentation" onClick={() => { setError(null); }}>
          <div className="kn-modal" role="dialog" aria-modal="true" onClick={(event) => { event.stopPropagation(); }}>
            <div className="kn-modal-title">{props.copy.failed}</div>
            <div className="kn-modal-body">{error}</div>
            <div className="kn-modal-actions">
              <button type="button" className="kn-modal-btn kn-modal-primary" onClick={() => { setError(null); }}>
                {props.copy.cancel}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/*
        * 删除节点：**只有一种**——直接删掉那个 `.md`（不可恢复）；
        * 「彻底删除」连同文件夹一起删掉（不可恢复）。用三按钮弹窗，别让用户猜默认行为。
        */}
      {confirmRemoveNode === null ? null : createPortal(
        <div className="kn-modal-backdrop" role="presentation" onClick={() => { setConfirmRemoveNode(null); }}>
          <div className="kn-modal" role="dialog" aria-modal="true" onClick={(event) => { event.stopPropagation(); }}>
            <div className="kn-modal-title">{props.copy.removeNodeConfirmTitle}</div>
            <div className="kn-modal-body">
              {`${props.copy.removeNodeConfirmMessage}：${confirmRemoveNode.label}`}
            </div>
            <div className="kn-modal-hint">
              {props.copy.removeNodeHint ?? tr("removeNodeHint")}
            </div>
            <div className="kn-modal-actions">
              <button type="button" className="kn-modal-btn" onClick={() => { setConfirmRemoveNode(null); }}>
                {props.copy.cancel}
              </button>
              <button
                type="button"
                className="kn-modal-btn is-danger"
                onClick={() => {
                  const { nodeId } = confirmRemoveNode;
                  setConfirmRemoveNode(null);
                  void removeNode(nodeId);
                }}
              >
                {props.copy.removeNodePurge ?? tr("removeNodePurge")}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );

  /** 连线菜单的标题：`B → A`（B 是前置） */
  function edgeLabel(edgeId: string): string {
    const edge = props.edges.find((item) => item.id === edgeId);
    if (edge === undefined) return edgeId.slice(0, 8);
    return `${titleOf(edge.toId)} → ${titleOf(edge.fromId)}`;
  }
}
