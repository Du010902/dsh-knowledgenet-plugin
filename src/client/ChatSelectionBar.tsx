/**
 * 对话里划词 → 浮条（添加前置 / 多选）→ 选目标节点（推荐 + 搜索）→ 写入。
 *
 * 设计要点：
 * - **不碰宿主 DOM**：浮条是 portal 到 `body` 的自己的元素，靠 `window.getSelection()`
 *   的选区矩形定位；宿主 DOM 只被读选区，不被改写。
 * - **多选**：点「多选」后把片段攒进列表，浮条变成「已选 N 段 · 完成 · 取消」，
 *   继续在对话里划词即继续追加（同一句重复划只算一条）。
 * - **目标节点**：给 2–3 个推荐（当前聚焦 → 最近加过前置的 → 最近聚焦的），
 *   外加**搜索**（走宿主 `POST {kind:'search-nodes'}`，与模型看到的同一套检索）。
 * - 每一步都上报（`chat-selection/…`），出问题可从 `kn_status` 自证。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { GRAPH_API_ROUTE } from "../shared/routes.ts";
import { pickWorkspacePath } from "./workspace-path.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import {
  defaultTitle,
  draftPrereqs,
  keepKnownTargets,
  normalizeSnippet,
  readLastSessionId,
  recommendTargets,
  rememberId,
  MRU_KEY,
  type PrereqDraft,
  type StoredMemory,
} from "./chat-selection.ts";
import { notifyLibraryChanged, readCurrentContext, readLastWorkspacePath, readNodeTitle } from "./current-context.ts";

export interface ChatSelectionBarProps {
  copy: {
    addPrereq: string;
    addNode?: string;
    addStandalone?: string;
    createNodeDone?: string;
    createNodeFailed?: string;
    createLibraryFailed?: string;
    noWorkspace?: string;
    nothingSelected?: string;
    multiTitle?: string;
    multiPlaceholder?: string;
    multiCount?: (count: number) => string;
    multi: string;
    selected: (count: number) => string;
    done: string;
    cancel: string;
    pickTitle: string;
    pickHint: string;
    recommended: string;
    searchHint: string;
    searching: string;
    noResult: string;
    titleLabel: string;
    confirm: string;
    added: string;
    failed: string;
    reuse: string;
    createAnyway: string;
    candidatesTitle: string;
    candidatesMessage: string;
    /** 可选：正在读当前库的节点表（推荐加载中） */
    loadingNodes?: string;
    /** 可选：当前库没有可推荐的最近节点 */
    noRecommend?: string;
    /** 可选：「添加为谁的前置」小节标题 */
    targetSection?: string;
    /** 可选：搜索框上方的标签 */
    searchLabel?: string;
    /** 可选：搜索框里的占位符 */
    searchPlaceholder?: string;
    /** 可选：有输入时的结果区标题（没输入时用 `recommended`） */
    resultsLabel?: string;
    /** 可选：结果行右侧的动作提示（选中时显示 ✓） */
    selectMark?: string;
    /** 可选：底部状态行——还没选目标 */
    statusPick?: string;
    /** 可选：底部状态行——已选目标（设计稿：`添加为 X 的前置`） */
    statusSelected?: (title: string) => string;
  };
  /** 逐步上报 */
  report?: (step: string, detail?: Record<string, unknown> | null) => void;
  /** 标准 props：工作区快照选择器（判断当前工作区是不是知识库） */
  useWorkspaces?: (selector: (snapshot: unknown) => unknown) => unknown;
  /** 标准 props：当前会话 id */
  sessionId?: string;
}

/** 浮条的样式（light DOM，注入 head） */
const STYLE_ID = "knowledgenet-selection-style";

/** 搜索框的 id（`<label htmlFor>` 要指到它上面） */
const PICK_SEARCH_ID = "knowledgenet-pick-search";

function ensureStyle(): void {
  if (typeof document === "undefined") return;
  const rules = [
    /*
     * 多选弹窗（用户要求）：浮条是 root 作用域，拿不到面板的 `.kn-modal*` 样式 ⇒ 自带一份 ✓。
     * 遮罩 z-index 要高于浮条（10001）与菜单（10002）✓。
     */
    ".kn-sel-mask {",
    "  position: fixed; inset: 0; z-index: 10003; display: flex; align-items: center; justify-content: center;",
    "  background: rgba(0, 0, 0, 0.12); pointer-events: none; }",
    ".kn-sel-modal {",
    "  pointer-events: auto;",
    "  width: min(560px, calc(100vw - 48px)); display: flex; flex-direction: column; gap: 10px;",
    "  padding: 14px 16px; border-radius: 12px; box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);",
    "  background: var(--dsw-alias-bg-layer-2, #ffffff); color: var(--dsw-alias-label-primary, #192523); }",
    ".kn-sel-modal-title { font-size: 13px; font-weight: 600; }",
    ".kn-sel-textarea {",
    "  width: 100%; min-height: 148px; resize: vertical; box-sizing: border-box;",
    "  font: inherit; font-size: 13px; line-height: 1.6; padding: 10px 12px; border-radius: 8px;",
    "  border: 0.5px solid var(--dsw-alias-border-l3, #d6e0dd); background: var(--dsw-alias-bg-layer-2, #ffffff); color: inherit; }",
    ".kn-sel-modal-hint { font-size: 12px; opacity: 0.65; }",
    ".kn-sel-modal-actions { display: flex; gap: 8px; justify-content: flex-end; }",
    ".kn-sel-modal-actions button {",
    "  font: inherit; font-size: 13px; padding: 6px 12px; border-radius: 8px; cursor: pointer;",
    "  border: 0.5px solid var(--dsw-alias-border-l3, #d6e0dd); background: transparent; color: inherit; }",
    ".kn-sel-modal-actions button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06)); }",
    ".kn-sel-modal-actions button:disabled { opacity: 0.5; cursor: default; }",
    ".kn-sel-bar {",
    "  position: fixed; z-index: 10001; display: flex; align-items: center; gap: 4px;",
    "  padding: 4px 6px; border-radius: 999px;",
    "  border: 0.5px solid var(--dsw-alias-border-l3, #d6e0dd);",
    "  background: var(--dsw-alias-bg-layer-2, #ffffff);",
    "  color: var(--dsw-alias-label-primary, #192523);",
    "  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28); font-size: 12px; }",
    ".kn-sel-bar button {",
    "  border: 0; border-radius: 999px; background: transparent; color: inherit;",
    "  font: inherit; font-size: 12px; padding: 3px 9px; cursor: pointer; }",
    ".kn-sel-bar button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06)); }",
    ".kn-sel-bar .kn-sel-primary { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06)); font-weight: 600; }",
    ".kn-sel-count { padding: 0 4px; opacity: .75; }",
    ".kn-pick-targets { display: flex; flex-direction: column; gap: 4px; margin-top: 10px; max-height: 240px; overflow: auto; }",
    ".kn-pick-item { display: flex; align-items: center; gap: 8px; padding: 6px 10px;",
    "  border: 0.5px solid var(--dsw-alias-border-l3, #d6e0dd); border-radius: 9px;",
    "  background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }",
    ".kn-pick-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06)); }",
    ".kn-pick-item small { opacity: .6; }",
    ".kn-draft-row { display: flex; flex-direction: column; gap: 3px; margin-top: 6px; }",
    ".kn-draft-text { font-size: 11px; opacity: .6; word-break: break-all; }",
    /*
     * 「设为前置」弹窗（形态照设计稿 `knowledgenet-picker-design.html`）：
     * 头部 / 内容 / 底部三段，全出血分隔线；字段与结果行都走宿主 token，亮暗主题自动跟随 ✓。
     */
    ".kn-pick-dialog {",
    "  box-sizing: border-box; width: min(520px, calc(100vw - 48px)); max-height: calc(100vh - 96px); overflow: auto;",
    "  border: 1px solid var(--dsw-alias-border-l3, #d6e0dd); border-radius: 12px;",
    "  background: var(--dsw-alias-bg-layer-2, #ffffff); color: var(--dsw-alias-label-primary, #192523);",
    "  box-shadow: 0 22px 64px rgba(0, 0, 0, .35); font-size: 13px; line-height: 1.5; }",
    ".kn-pick-head { padding: 20px 22px 15px; }",
    ".kn-pick-title { font-size: 15px; font-weight: 500; }",
    ".kn-pick-subtitle { margin-top: 5px; font-size: 12px; color: var(--dsw-alias-label-secondary, #5c6b66); }",
    ".kn-pick-content { padding: 0 22px 15px; }",
    /* 被添加的知识点：每条一个 chip，就地可编辑 */
    ".kn-pick-chips { display: flex; flex-wrap: wrap; gap: 7px; }",
    ".kn-pick-chip { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; min-height: 30px; padding: 3px 11px;",
    "  border: 1px solid var(--dsw-alias-border-l3, #d6e0dd); border-radius: 7px; cursor: text; }",
    ".kn-pick-chip:focus-within { border-color: #819b91; }",
    ".kn-pick-chip input { width: 150px; min-width: 60px; padding: 0; border: 0; outline: 0; background: transparent; color: inherit; font: inherit; }",
    ".kn-pick-chip-mark { color: var(--dsw-alias-label-secondary, #5c6b66); font-size: 11px; }",
    /* 「添加为谁的前置」：与上面的 chip 区隔开 */
    ".kn-pick-target { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--dsw-alias-border-l3, #d6e0dd); }",
    ".kn-pick-label { display: block; margin: 0 0 8px; font-size: 12px; font-weight: 500; }",
    ".kn-pick-group { margin: 14px 0 8px; font-size: 12px; color: var(--dsw-alias-label-secondary, #5c6b66); }",
    /*
     * 搜索框：**图标与输入框是同一行的两个 flex 子项**，不是"绝对定位盖在输入框上"。
     *
     * 为什么改（实测 ✗）：原来图标 `position: absolute` + 输入框 `padding-left: 35px`，
     * 而输入框的 padding 还会被别处的 `.kn-modal-input` 规则插一脚 ⇒ 图标和占位文字挤在同一条线上。
     * 现在边框/底色/内边距都长在**外层** `.kn-search-wrap` 上：11px 内边距 + 16px 图标 + 8px 间距
     * = 文字正好从 35px 处开始 ✓（与设计稿的 `padding-left: 35px` 等价），图标不可能再飘 ✓。
     */
    ".kn-search-wrap { display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 11px; box-sizing: border-box;",
    "  border: 1px solid var(--dsw-alias-border-l3, #d6e0dd); border-radius: 7px; background: var(--dsw-alias-bg-layer-1, #ffffff); }",
    ".kn-search-wrap svg { flex: none; width: 16px; height: 16px; color: var(--dsw-alias-label-secondary, #5c6b66); }",
    ".kn-search-wrap input { flex: 1; min-width: 0; height: 100%; padding: 0; border: 0; outline: 0;",
    "  background: transparent; color: inherit; font: inherit; }",
    ".kn-search-wrap input::placeholder { color: var(--dsw-alias-label-secondary, #5c6b66); }",
    /* 输入框自己的类（守门测试要求用到的 kn-* 必须有定义；行为与上面那条一致 ✓） */
    ".kn-search-input { flex: 1; min-width: 0; height: 100%; padding: 0; border: 0; outline: 0;",
    "  background: transparent; color: inherit; font: inherit; }",
    ".kn-search-input::placeholder { color: var(--dsw-alias-label-secondary, #5c6b66); }",
    /* 结果行：整行可点，选中时描边 + ✓ */
    ".kn-pick-results { display: flex; flex-direction: column; gap: 2px; max-height: 236px; overflow: auto; }",
    ".kn-pick-row { display: flex; align-items: center; width: 100%; min-height: 34px; padding: 6px 10px;",
    "  border: 1px solid transparent; border-radius: 6px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }",
    ".kn-pick-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06)); }",
    ".kn-pick-row[aria-pressed='true'] { border-color: #819b91; background: rgba(129, 155, 145, .18); }",
    ".kn-pick-row-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".kn-pick-row-mark { margin-left: auto; padding-left: 10px; font-size: 11px; color: var(--dsw-alias-label-secondary, #5c6b66); }",
    ".kn-pick-row[aria-pressed='true'] .kn-pick-row-mark { color: inherit; }",
    ".kn-pick-empty { margin: 0; padding: 7px 10px; font-size: 12px; color: var(--dsw-alias-label-secondary, #5c6b66); }",
    /* 底部：状态行 + 取消/确认添加 */
    ".kn-pick-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 13px 22px;",
    "  border-top: 1px solid var(--dsw-alias-border-l3, #d6e0dd); }",
    ".kn-pick-status { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--dsw-alias-label-secondary, #5c6b66); }",
    ".kn-pick-actions { display: flex; gap: 8px; flex: none; }",
    ".kn-pick-btn { height: 34px; padding: 0 13px; border: 1px solid var(--dsw-alias-border-l3, #d6e0dd); border-radius: 7px;",
    "  background: transparent; color: inherit; font: inherit; cursor: pointer; }",
    ".kn-pick-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06)); }",
    ".kn-pick-btn.is-primary { border-color: transparent; background: var(--dsw-alias-button-primary-fill, #d5e5df);",
    "  color: var(--dsw-alias-label-primary-foreground, #17221e); }",
    ".kn-pick-btn.is-primary:hover:not(:disabled) { filter: brightness(1.06); }",
    ".kn-pick-btn.is-primary:disabled { opacity: .42; cursor: not-allowed; }",
    ".kn-pick-error { margin: 0 22px 14px; font-size: 12px; color: var(--dsw-alias-state-error-primary, #e5534b); }",
    ".kn-pick-section { margin-top: 12px; font-size: 11px; opacity: .6; }",
  ].join("\n");
  /*
   * 已经存在同 id 的 `<style>` 时**更新内容，不能直接 return** ✓。
   *
   * 为什么（用户实测 ✗）：插件重新安装/重新加载客户端半时页面并没有整体刷新，
   * 上一版留下的 `<style id="…">` 还在 head 里 ⇒ 直接 return 的话这一版**新增与修改的规则一条都进不去**，
   * 表现为"弹窗只有一半样式、放大镜被撑成巨型" ✗。样式表和代码一样，必须跟着这一版走 ✓。
   */
  const existing = document.getElementById(STYLE_ID);
  if (existing !== null) {
    if (existing.textContent !== rules) existing.textContent = rules;
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = rules;
  document.head.append(style);
}

function readMemory(): StoredMemory {
  try {
    const raw = localStorage.getItem(MRU_KEY);
    if (raw === null) return { recentFocus: [], recentPrereqTargets: [] };
    const parsed = JSON.parse(raw) as Partial<StoredMemory>;
    return {
      recentFocus: Array.isArray(parsed.recentFocus) ? parsed.recentFocus.filter((x): x is string => typeof x === "string") : [],
      recentPrereqTargets: Array.isArray(parsed.recentPrereqTargets)
        ? parsed.recentPrereqTargets.filter((x): x is string => typeof x === "string")
        : [],
    };
  } catch {
    return { recentFocus: [], recentPrereqTargets: [] };
  }
}

function writeMemory(memory: StoredMemory): void {
  try {
    localStorage.setItem(MRU_KEY, JSON.stringify(memory));
  } catch {
    // 存不下就算了
  }
}

/** 供面板侧调用：把"当前聚焦/聊到的节点"记进记忆 */
export function rememberFocusNode(id: string | null | undefined, name?: string): void {
  if (typeof id !== "string" || id.trim() === "") return;
  const memory = readMemory();
  writeMemory({
    recentFocus: rememberId(memory.recentFocus, id),
    recentPrereqTargets: memory.recentPrereqTargets,
  });
  if (typeof name === "string" && name !== "") {
    try {
      const key = "knowledgenet.nodeTitles";
      const raw = localStorage.getItem(key);
      const titles = raw === null ? {} : (JSON.parse(raw) as Record<string, string>);
      titles[id] = name;
      localStorage.setItem(key, JSON.stringify(titles));
    } catch {
      // 标题缓存失败不影响功能
    }
  }
}

/** 记忆里 id → 标题（用于推荐项显示） */
function titleOf(id: string): string {
  // 1) 最近一次发布的 id→标题（库级信息、跨会话保留）——推荐项要显示真名
  const latest = readNodeTitle(id);
  if (latest !== null) return latest;
  try {
    const published = readCurrentContext(domSessionOf());
    const exact = published?.titles?.[id];
    if (typeof exact === "string" && exact !== "") return exact;
  } catch {
    // 读发布失败就退到缓存
  }
  try {
    const raw = localStorage.getItem("knowledgenet.nodeTitles");
    if (raw === null) return id.slice(0, 8);
    const titles = JSON.parse(raw) as Record<string, string>;
    return titles[id] ?? id.slice(0, 8);
  } catch {
    return id.slice(0, 8);
  }
}

/** 当前聊天会话 id（供 titleOf 在渲染期读取发布用） */
function domSessionOf(): string | null {
  try {
    if (typeof document === "undefined") return null;
    const value = document.querySelector("[data-conversation-session]")?.getAttribute("data-conversation-session");
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  } catch {
    return null;
  }
}

interface PickState {
  /** 每行一条草稿（标题可以在这里改） */
  drafts: PrereqDraft[];
}

/**
 * 划词浮条 + 片段收集 + 目标选择。
 * @param props - 文案与上报回调。
 * @returns portal 出去的小条与弹窗（没有划词时什么都不渲染）。
 */
export function ChatSelectionBar(props: ChatSelectionBarProps): ReactNode {
  const [bar, setBar] = useState<{ x: number; y: number; text: string } | null>(null);
  const [picking, setPicking] = useState<PickState | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<{ id: string; title: string }>>([]);
  const [searching, setSearching] = useState(false);
  /**
   * 「相近候选」等用户决定时**挂起的队列**：第 `index` 条命中了候选，
   * 用户决定后从 `index + 1` 继续 —— 多行时后面的行既不会被丢掉，也不会拿着同一个标题乱发 ✓。
   */
  const [pendingCandidates, setPendingCandidates] = useState<{
    fromId: string;
    queue: PrereqDraft[];
    index: number;
    candidates: string[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * **当前库**的节点表（id → 标题）。`null` = 还不知道（正在读 / 读失败）。
   *
   * 它同时承担两件事：① 推荐项显示真名；② **充当"哪些节点真的存在"的唯一依据** ——
   * 记忆（MRU）与标题缓存都是跨库的，不能拿它们判断"存在" ✗（否则推荐里会列出别的库的节点 ✓）。
   */
  const [libraryTitles, setLibraryTitles] = useState<Record<string, string> | null>(null);
  /** 这份节点表属于哪个库根（换库即作废，避免把上一个库的表当成本库的） */
  const libraryKeyRef = useRef("");
  /**
   * 选中的目标节点（设计稿的交互：**先选、再点「确认添加」**）。
   * `null` = 还没选，此时确认按钮置灰 ✓（避免误点就把前置挂到别的节点上 ✗）。
   */
  const [selectedTarget, setSelectedTarget] = useState<{ id: string; title: string } | null>(null);
  const collecting = useRef(false);
  const latest = useRef(props);
  latest.current = props;

  /*
   * 门禁：只在知识库工作区出现浮条（与面板同一套判据：登记过 ∧ 该目录本身是知识库）。
   *
   * **Hook 只能在渲染期调用**：`useWorkspaces` 如果是 Hook，放进 mouseup 回调里会抛
   * `Invalid hook call`，被我下面的 catch 吞掉后会变成"一律拒绝、浮条永不出现"（实测踩过）。
   * 所以这里在渲染期把「当前会话 + 当前工作区路径」取好存进 ref，判定时只读 ref + 读登记表。
   */
  const pathRef = useRef<string>("");
  const sessionRef = useRef<string>("");
  const snapCountRef = useRef<number>(-1);
  /** 渲染期拿到的快照：只用来"按 id 查路径"，不用它判断"当前是哪个工作区"（它可能不刷新） */
  const snapRef = useRef<unknown>(undefined);
  const allowed = (() => {
    try {
      const identity = (snapshot: unknown): unknown => snapshot;
      const snapshot = props.useWorkspaces?.(identity);
      snapRef.current = snapshot;
      const sessionId = props.sessionId ?? readLastSessionId();
      const workspacePath = pickWorkspacePath(snapshot, sessionId ?? undefined) ?? "";
      pathRef.current = workspacePath;
      sessionRef.current = String(sessionId ?? "");
      /*
       * 会话或工作区变了 ⇒ 上一次的门禁结论、浮条、多选态全部作废 ✓。
       * 否则"在知识库会话里选过字，切到没有知识库的仓库"会继续显示浮条（实测反馈 ✓）。
       */
      const scope = `${sessionId ?? ""}|${workspacePath}`;
      if (lastScopeRef.current !== scope) {
        lastScopeRef.current = scope;
        gateAllowedRef.current = false;
        collecting.current = false;
        setBar(null);
      }
      const items = (snapshot as { items?: unknown[] } | undefined)?.items;
      snapCountRef.current = Array.isArray(items) ? items.length : -1;
      // 新模型：只要有工作区路径就继续（真正的判定在 gateNow：面板发布的上下文 / 问宿主）
      return workspacePath.trim() !== "";
    } catch {
      return false;
    }
  })();
  const allowedRef = useRef(allowed);
  allowedRef.current = allowed;
  /*
   * **最近一次门禁结论**：只有它为 true 时才允许渲染浮条 ✓。
   *
   * 为什么需要：浮条是 portal、"bar" 是组件状态 ⇒ 切换会话/工作区时旧的 bar 不会被清掉 ✗，
   * 于是"在知识库会话里选过字、再切到**没有知识库**的仓库"仍会看到浮条（实测反馈 ✓）。
   * 用一次真实的门禁判定当硬前提，比依赖"状态恰好被清掉"可靠 ✓。
   */
  const gateAllowedRef = useRef(false);
  /** 上一次判定的「会话|工作区」：变化即作废旧状态（见上面的清理逻辑） */
  const lastScopeRef = useRef("");
  /** 当前库根（有库时）；空串表示"还没有库" */
  const libraryRootRef = useRef("");
  /** 还没有库时，宿主建议的建库位置（`<工作区>/.dsh_knowledge`） */
  const createPathRef = useRef("");
  /** 弹窗里的一行反馈（建库/建点成功或失败 ✓ —— 必须可见，否则就是"点了没反应" ✗） */
  const [note, setNote] = useState<string | null>(null);
  /** 多选弹窗是否打开 */
  const [multiOpen, setMultiOpen] = useState(false);
  /** 多选弹窗里的文本：**每一块选中的文字占一行** ✓ */
  const [multiText, setMultiText] = useState("");
  /** 作用域刚变过：此刻不允许再弹浮条（等下一次真正的按下 ✓）—— 彻底消除"一闪" ✓ */
  const suppressBarRef = useRef(false);
  /** 已知的节点数量：-1 表示"还不知道"（不改按钮状态，避免误灰 ✓）；0 表示库是空的 ✓ */
  const knownNodeCountRef = useRef(-1);
  /** 浮条弹出时所在的「会话|工作区」：一变就收起（见下面的轮询）✓ */
  const barScopeRef = useRef("");
  /** 正在拖动弹窗：拖动产生的 mouseup 不能当成"划词" ✗ */
  const draggingRef = useRef(false);
  /** 弹窗位置（拖动标题后固定；null = 居中 ✓） */
  const [multiPos, setMultiPos] = useState<{ x: number; y: number } | null>(null);

  /*
   * 多选弹窗打开时，**Esc = 取消** ✓。
   * 遮罩特意设成 `pointer-events: none`（这样还能继续在对话里划词 ✓），代价是"点外面关闭"没了 ✓
   * ⇒ 必须给一个键盘出口 ✓。
   */
  useEffect(() => {
    if (!multiOpen) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      collecting.current = false;
      setMultiOpen(false);
      setMultiText("");
      report("multi-cancel", "esc");
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
  }, [multiOpen]);

  /**
   * 拖动多选弹窗（按住标题拖 ✓）。
   *
   * 为什么需要：弹窗再小也可能压住要选的正文 ✓；能拖开就能在任何位置划词 ✓。
   *
   * **注意**：拖动会在页面上**真的产生一个选区** ✗（浏览器把"拖鼠标"当成划词 ✓），
   * 于是拖动结束时全局 mouseup 会把鼠标划过处的页面文字追加成一行（用户实测 ✓）。
   * 所以拖动期间：① 每帧清掉选区 ✓；② 置 `draggingRef` 让 mouseup 处理器直接跳过 ✓。
   */
  const startDragMulti = (event: React.MouseEvent<HTMLDivElement>): void => {
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = multiPos ?? {
      // 首次拖动：以当前实际位置为起点，避免"跳一下"✗
      x: window.innerWidth / 2 - 280,
      y: Math.max(24, window.innerHeight / 2 - 140),
    };
    draggingRef.current = true;
    const onMove = (move: MouseEvent): void => {
      // 拖动不是划词：把浏览器顺手产生的选区清掉 ✓
      try { window.getSelection()?.removeAllRanges(); } catch { /* 忽略 */ }
      setMultiPos({
        x: Math.min(window.innerWidth - 120, Math.max(8, origin.x + (move.clientX - startX))),
        y: Math.min(window.innerHeight - 80, Math.max(8, origin.y + (move.clientY - startY))),
      });
    };
    const onUp = (): void => {
      draggingRef.current = false;
      try { window.getSelection()?.removeAllRanges(); } catch { /* 忽略 */ }
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  /** 从多选文本里取出有效行（去空行、去重 ✓） */
  const multiLines = (text: string): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line === "" || seen.has(line)) continue;
      seen.add(line);
      out.push(line);
    }
    return out;
  };

  /**
   * 把**一条草稿**真正写到某个目标节点下（一次请求）。
   *
   * 为什么返回结果而不是自己收尾：多行时一次要发 N 条请求，中途命中「相近候选」必须**停下来**
   * 问用户 —— 否则后面的行会继续拿同一个标题乱发 ✗（旧实现就是一路发完 ✓）。
   *
   * @param fromId - 目标节点 id（A → B 里的 A）。
   * @param draft - 原文 + 标题（**这条自己的标题**，不是界面上那个共用的标题 ✗）。
   * @param create - true = 明确新建（跳过"相近候选先确认"）。
   * @returns 三种结果：成功 / 命中相近候选 / 失败。
   */
  const postAdd = async (
    fromId: string,
    draft: PrereqDraft,
    create: boolean,
  ): Promise<{ kind: "ok"; created: boolean } | { kind: "candidates"; candidates: string[] } | { kind: "error"; message: string }> => {
    report("add", { create, titleChars: draft.title.length });
    /* 标题被清空时回落到默认标题 ✓（不然宿主会回一句"title 不能为空"，用户还得自己找回来 ✗） */
    const nodeTitle = draft.title.trim() === "" ? defaultTitle(draft.text) : draft.title.trim();
    try {
      const response = await fetch(GRAPH_API_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ kind: "add-prerequisite", fromId, title: nodeTitle, snippet: draft.text, create }),
      });
      const body = (await response.json()) as {
        ok?: boolean;
        added?: { created?: boolean; candidates?: Array<{ title?: string }> };
        error?: { code?: string; message?: string };
      };
      if (body.ok !== true) {
        const code = body.error?.code ?? "";
        /*
         * **归属节点在当前库里不存在**（跨库残留的推荐）⇒ 顺手把它从记忆里删掉 ✓，
         * 免得下次又推荐一次、又失败（自愈）。库里节点表的这份也一并剔除 ✓。
         */
        if (code === "node_not_found") {
          forgetTarget(fromId);
          setLibraryTitles((prev) => {
            if (prev === null || prev[fromId] === undefined) return prev;
            const next = { ...prev };
            delete next[fromId];
            return next;
          });
          report("add-stale-target", { fromId: fromId.slice(0, 8) });
        }
        report("add-failed", { code, message: body.error?.message ?? "" });
        return { kind: "error", message: body.error?.message ?? props.copy.failed };
      }
      const candidates = (body.added?.candidates ?? []).map((item) => item.title ?? "").filter((item) => item !== "");
      if (create !== true && candidates.length > 0) {
        report("add-candidates", { count: candidates.length });
        return { kind: "candidates", candidates };
      }
      report("add-done", { created: body.added?.created === true });
      return { kind: "ok", created: body.added?.created === true };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      report("add-failed", { message: message.slice(0, 120) });
      return { kind: "error", message };
    }
  };

  /** 落地成功后记住这个目标（"最近被加过前置的节点"→下次优先推荐 ✓） */
  const rememberTarget = (fromId: string): void => {
    const memory = readMemory();
    writeMemory({ recentFocus: memory.recentFocus, recentPrereqTargets: rememberId(memory.recentPrereqTargets, fromId) });
  };

  /** 队列全部落地后的收尾：通知面板刷新 + 关掉这一轮的所有界面 ✓ */
  const finishQueue = (): void => {
    setError(null);
    setPicking(null);
    setSelectedTarget(null);
    setMultiOpen(false);
    setMultiText("");
    collecting.current = false;
    setBar(null);
    setQuery("");
    setResults([]);
    /* 通知面板**刷新数据 + 重跑布局 + 重新取景** ✓（否则新节点落在视野外 ✗） */
    notifyLibraryChanged();
  };

  /**
   * 依次落地队列里的草稿（从 `start` 开始），**把每一行各自建成一个节点** ✓。
   *
   * 两条关键纪律：
   * - **逐条用自己的标题**（见 `draftPrereqs`）：旧实现把 N 行都塞进同一个标题 ✗
   *   ⇒ 只有第一行真的建了点，其余行精确命中同一个节点、又被关系去重吃掉，**静默丢失** ✗；
   * - 命中相近候选就**暂停**队列，把剩下的连 `index` 一起存进 `pendingCandidates` ✓
   *   （用户决定复用/新建后从 `index + 1` 继续 ✓）。
   *
   * @param fromId - 目标节点 id。
   * @param queue - 草稿队列。
   * @param start - 从第几条开始（恢复时用）。
   */
  const runQueue = async (fromId: string, queue: readonly PrereqDraft[], start: number): Promise<void> => {
    for (let index = start; index < queue.length; index += 1) {
      const outcome = await postAdd(fromId, queue[index], false);
      if (outcome.kind === "candidates") {
        setPendingCandidates({ fromId, queue: [...queue], index, candidates: outcome.candidates });
        return;
      }
      if (outcome.kind === "error") {
        setError(outcome.message);
        return;
      }
    }
    rememberTarget(fromId);
    report("prereq-create", `lines:${queue.length - start}`);
    finishQueue();
  };

  /**
   * 用户对「相近候选」的决定：复用某个候选（create=false）或坚持新建（create=true），
   * 然后把挂起的队列跑完 ✓。
   *
   * 为什么必须**显式传标题**：旧实现在对话框里 `setTitle(target)` 之后立刻调 `addTo`，
   * 而 `addTo` 读的是**这次渲染闭包里的旧标题** ✗ ⇒ 「复用」发出去的还是原来那个标题
   * ⇒ 又命中同一批候选 ⇒ 对话框再次弹出，**点几次都不动**（死循环 ✓）。
   *
   * @param nodeTitle - 这条草稿最终要用的标题。
   * @param create - true = 坚持新建。
   */
  const resolveCandidate = async (nodeTitle: string, create: boolean): Promise<void> => {
    const pending = pendingCandidates;
    if (pending === null) return;
    setPendingCandidates(null);
    const draft: PrereqDraft = { ...pending.queue[pending.index], title: nodeTitle };
    const outcome = await postAdd(pending.fromId, draft, create);
    if (outcome.kind === "error") {
      setError(outcome.message);
      return;
    }
    if (outcome.kind === "candidates") {
      setPendingCandidates({ ...pending, candidates: outcome.candidates });
      return;
    }
    await runQueue(pending.fromId, pending.queue, pending.index + 1);
  };

  /**
   * **添加为孤立节点**：不挂任何前置，直接把选中的文字建成一个节点 ✓。
   *
   * 用户要求（2026-09）：还要覆盖两种以前做不到的情况 ——
   * ① 只想单独加一个孤立节点；② 库里**一个节点都没有**（这时"添加前置"无从谈起 ✓）。
   * 所以这里先在需要时**顺手建库**（默认位置 `<工作区>/.dsh_knowledge` ✓），再建节点 ✓。
   *
   * @param text - 选中的文字（已归一化）。
   */
  const createStandalone = async (text: string): Promise<boolean> => {
    const title = text.trim();
    if (title === "") {
      setNote(props.copy.nothingSelected ?? "没有选中文字");
      return false;
    }
    try {
      let root = libraryRootRef.current;
      if (root === "") {
        /*
         * **写入目标必须先拿到**（这是"点了没创建"的根因 ✓）：
         * 之前多选分支被提到门禁之前 ⇒ `libraryRootRef`/`createPathRef` 还是空的 ✗，
         * 而失败提示只写在（那时已隐藏的）浮条上 ⇒ 表现为"静默没反应" ✗。
         * 现在这里**自己现算一次**（现读 DOM 工作区 → 问宿主 → 需要就先建库 ✓）。
         */
        const target = await resolveWriteTarget();
        root = target.root !== "" ? target.root : target.createPath;
        if (root === "") {
          setNote(props.copy.noWorkspace ?? "找不到当前工作区，无法创建");
          report("standalone-create", "no-workspace");
          return false;
        }
      }
      if (createPathRef.current !== "" && libraryRootRef.current === "") {
        // 还没有库：按宿主建议的位置建一个（用户要求：创建第一个节点时默认同时创建知识库 ✓）
        const created = await fetch(GRAPH_API_ROUTE, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ kind: "create-library", root: createPathRef.current }),
        });
        const outcome = (await created.json().catch(() => null)) as
          | { ok?: boolean; error?: { code?: string; message?: string } }
          | null;
        if (outcome?.ok !== true) {
          const code = outcome?.error?.code ?? "unknown";
          setNote(`${props.copy.createLibraryFailed ?? "创建知识库失败"}：[${code}] ${outcome?.error?.message ?? ""}`);
          report("standalone-create", `library-failed:${code}`);
          return false;
        }
        libraryRootRef.current = createPathRef.current;
        root = createPathRef.current;
      }
      const response = await fetch(GRAPH_API_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ kind: "create-node", root, title }),
      });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; node?: { title?: string }; error?: { code?: string; message?: string } }
        | null;
      if (body?.ok !== true) {
        const code = body?.error?.code ?? "unknown";
        setNote(`${props.copy.createNodeFailed ?? "创建节点失败"}：[${code}] ${body?.error?.message ?? ""}`);
        report("standalone-create", `node-failed:${code}`);
        return false;
      }
      setNote(`${props.copy.createNodeDone ?? "已创建"}：${body.node?.title ?? title}`);
      report("standalone-create", "ok");
      return true;
    } catch (cause) {
      setNote(`${props.copy.createNodeFailed ?? "创建节点失败"}：${cause instanceof Error ? cause.message : String(cause)}`);
      report("standalone-create", `threw:${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 120));
      return false;
    }
  };

  /**
   * 从 DOM 读"**当前**工作区的路径"。
   *
   * 为什么不用 props：浮条挂在 root 作用域，工作区切换时它可能不重渲染（实测：切到普通工作区后
   * `pathRef` 仍是上一个知识库的路径），于是判定会一直停留在旧值。
   *
   * 依据是宿主稳定的无障碍属性（`ui-workspace/src/client/rows/Rows.tsx`）：
   * - 会话行 `data-row-key="session:<id>"` + `aria-selected="true"` = 当前会话；
   * - 往上找最近的 `data-row-key="workspace:<id>"` = 当前工作区；
   * - 路径从快照里按 id 查（快照只用于查路径，不用于判断"当前是哪台"）。
   *
   * @returns 路径；取不到返回空串。
   */
  const domWorkspacePath = (): string => {
    try {
      if (typeof document === "undefined") return "";
      const row = document.querySelector('[data-row-key^="session:"][aria-selected="true"]');
      const group = row?.closest?.('[data-row-key^="workspace:"]');
      const key = group?.getAttribute?.("data-row-key") ?? "";
      if (!key.startsWith("workspace:")) return "";
      const id = key.slice("workspace:".length);
      const items = (snapRef.current as { items?: Array<Record<string, unknown>> } | undefined)?.items ?? [];
      const hit = items.find((item) => item["workspaceId"] === id || item["id"] === id);
      const path = hit?.["path"];
      return typeof path === "string" ? path : "";
    } catch {
      return "";
    }
  };

  /**
   * 从 DOM 读**当前聊天会话 id**：宿主在对话容器上给了稳定属性
   * （`ui-conversation/src/ConversationContent.tsx:193` → `data-conversation-session={sessionId}`）。
   * 这是"我正在打字的那个会话"的权威来源——不依赖 props 是否刷新、也不依赖侧栏是否折叠。
   *
   * @returns 会话 id；读不到返回 null。
   */
  const domSessionId = (): string | null => {
    try {
      if (typeof document === "undefined") return null;
      const value = document.querySelector("[data-conversation-session]")?.getAttribute("data-conversation-session");
      return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
    } catch {
      return null;
    }
  };

  /** 问宿主：按 sessionId / root 查询库信息（写入目标与归属判定共用 ✓） */
    const ask = async (query: string): Promise<{ ok: boolean; root: string; code: string; createPath: string }> => {
      const response = await fetch(`${GRAPH_API_ROUTE}?${query}`, {
        headers: { accept: "application/json" },
        credentials: "same-origin",
      });
      const body = (await response.json()) as {
        ok?: boolean;
        library?: { root?: string };
        error?: { code?: string; createPath?: string };
      };
      return {
        ok: body.ok === true && typeof body.library?.root === "string" && body.library.root !== "",
        root: typeof body.library?.root === "string" ? body.library.root : "",
        code: body.error?.code ?? (body.ok === true ? "library" : "unknown"),
        createPath: typeof body.error?.createPath === "string" ? body.error.createPath : "",
      };
    };
  /**
   * **现算"该往哪里写"**：现读 DOM 的工作区 → 问宿主 → 有库给库根、没库给"建议建库位置"。
   *
   * 抽出来的原因（真实 bug ✗）：多选分支被提到门禁之前后，创建节点时 `libraryRootRef`/`createPathRef`
   * 还是空的 ⇒ 点"创建"什么都没发生，而提示只写在已隐藏的浮条上 ⇒ **静默失败** ✓。
   * 现在创建动作会自己调一次这里 ✓，不再依赖"门禁刚好跑过" ✓。
   *
   * @returns 库根（有库时）与建议建库位置（没库时）；两个都空表示"这个会话没有工作区归属"。
   */
  const resolveWriteTarget = async (): Promise<{ root: string; createPath: string }> => {
    /*
     * **必须在这里取一次会话 id** ✗→✓：
     * 这段逻辑原来长在 `gateNow` 里，用的 `sessionId` 是它的局部变量 ✓；
     * 抽成独立函数后我漏了声明 ⇒ `ReferenceError: sessionId is not defined` ✗
     * —— 而它抛在 `try` 之前 ⇒ 被上层 catch 成"threw"，节点一个都没建 ✓（用户实测"点了没反应" ✓）。
     */
    const sessionId = domSessionId();
    /*
     * **工作区路径的三个来源，按可靠度取**（重构时我把第 2 个来源丢了 ⇒ 才会出现"找不到当前工作区" ✗）：
     *  1. DOM 现读（最准：当前选中会话所属的工作区分组 ✓）；
     *  2. **面板发布过的上下文**（`readCurrentContext` —— 面板是按会话发布的 ✓；
     *     诊断里 `source: context-library` 就说明这条路是通的 ✓）；
     *  3. 本会话渲染期写入的快照路径（要求"确实属于当前会话" ✓，避免旧值 ✗）。
     */
    const published = (() => {
      try {
        return readCurrentContext(sessionId);
      } catch {
        return null;
      }
    })();
    /*
     * **0 号来源：面板发布的库根** ✓（最可靠）。
     * 面板取数成功时就知道**确切的库根** ✓ —— 不依赖 DOM 工作区行、不依赖会话 id 是否对得上、
     * 也不用再问宿主 ✓。实测：某些会话里前三种路径都拿不到 ⇒ 出现过"找不到当前工作区" ✗。
     */
    if (typeof published?.libraryRoot === "string" && published.libraryRoot.trim() !== "") {
      libraryRootRef.current = published.libraryRoot;
      createPathRef.current = "";
      return { root: published.libraryRoot, createPath: "" };
    }
    const publishedPath = published?.workspacePath ?? "";
    const workspacePath = domWorkspacePath();
    const sessionKey = `${sessionId ?? ""}|`;
    const snapshotPath = lastScopeRef.current.startsWith(sessionKey) ? pathRef.current : "";
    const effectivePath = [workspacePath, publishedPath, snapshotPath].map((v) => v.trim()).find((v) => v !== "") ?? "";
    if (effectivePath === "") {
      libraryRootRef.current = "";
      createPathRef.current = "";
      return { root: "", createPath: "" };
    }
    try {
      let resolvedRoot = "";
      let createPath = "";
      if (sessionId !== null) {
        const bySession = await ask(`sessionId=${encodeURIComponent(sessionId)}`);
        if (bySession.ok) resolvedRoot = bySession.root;
        else createPath = bySession.createPath;
      }
      if (resolvedRoot === "") {
        const byWorkspace = await ask(`root=${encodeURIComponent(effectivePath)}`);
        if (byWorkspace.ok) resolvedRoot = byWorkspace.root;
        else if (createPath === "") createPath = byWorkspace.createPath;
      }
      libraryRootRef.current = resolvedRoot;
      createPathRef.current = createPath;
      return { root: resolvedRoot, createPath };
    } catch {
      libraryRootRef.current = "";
      createPathRef.current = "";
      return { root: "", createPath: "" };
    }
  };

  /**
   * **划词那一刻**的权威判定（异步）。
   *
   * 规则（用户要求）：**只有"有工作区归属"的会话**才参与 ✓ —— 判据是侧栏里当前会话行往上能找到
   * `workspace:` 分组行（`domWorkspacePath()` 找不到就返回空串 ✓）；未分组会话直接拒绝，
   * 而且**放在探测之前**：既不看库、也不打宿主 ✓。
   *
   * @returns 是否允许 + 判定依据（供上报）。
   */

  /*
   * 门禁判定上报：`shown` 一直不出现时，靠它区分「被门禁挡住」还是「选区没识别到」。
   * 只在结论变化时发，避免刷屏。
   */
  const gateSignature = `${allowed}|${props.sessionId ?? readLastSessionId() ?? ""}|${props.useWorkspaces !== undefined}`;
  const lastGate = useRef("");
  useEffect(() => {
    if (lastGate.current === gateSignature) return;
    lastGate.current = gateSignature;
    report("gate", {
      allowed,
      hasSession: (props.sessionId ?? readLastSessionId()) !== null,
      hasWorkspaces: props.useWorkspaces !== undefined,
    });
  }, [gateSignature, allowed]);

  const report = (step: string, detail: Record<string, unknown> | null = null): void => {
    try {
      latest.current.report?.(step, detail);
    } catch {
      // 上报失败不影响功能
    }
  };

  useEffect(() => {
    if (typeof document === "undefined") return;
    ensureStyle();

    const selectionInfo = (): { ok: true; text: string; x: number; y: number } | { ok: false; reason: string } => {
      try {
        const selection = window.getSelection();
        if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return { ok: false, reason: "no-selection" };
        const text = normalizeSnippet(selection.toString());
        /* 单字也算数：中文里「熵 / 场 / 秩」这种一个字的考点是正常输入 ✓（只有空选区才拒绝） */
        if (text.length === 0) return { ok: false, reason: "too-short" };
        const target = selection.anchorNode;
        const element = target === null ? null : (target.nodeType === 1 ? (target as Element) : target.parentElement);
        // 输入框里的选择不算（那是用户在编辑自己的话）
        if (element !== null && typeof element.closest === "function"
          && element.closest("input, textarea, [contenteditable='true']") !== null) {
          return { ok: false, reason: "in-editable" };
        }
        /*
         * **侧栏里的选中不算划词** ✓（用户反馈：切仓库时浮条"一闪而过" ✗）。
         *
         * 点会话/工作区行时，浏览器常顺手把行内文字选中 ✓ ⇒ 被当成一次划词 ⇒ 浮条弹出、
         * 又被作用域检查收掉 ⇒ 就是你看到的那一闪 ✓。判据用宿主稳定的无障碍属性 ✓。
         */
        if (element !== null && typeof element.closest === "function"
          && element.closest('[data-row-key^="session:"], [data-row-key^="workspace:"]') !== null) {
          return { ok: false, reason: "in-sidebar" };
        }
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return { ok: false, reason: "no-rect" };
        return { ok: true, text, x: rect.left + rect.width / 2, y: rect.top };
      } catch (error) {
        return { ok: false, reason: `throw:${error instanceof Error ? error.message : String(error)}`.slice(0, 60) };
      }
    };

    const onMouseUp = (): void => {
      /*
       * **先判"有没有选中文字"，再问宿主**。
       *
       * 顺序很重要：`gateNow()` 在缓存未命中时会**发请求给宿主**并写诊断上报 ✗。
       * 之前它排在 `info.ok` 判断之前 ⇒ 每次普通点击、每次拖拽结束（哪怕没选中任何字）
       * 都会打一次宿主查询 + 几条上报 ⇒ 拖动结束时额外负担（代码审查提出 ✓）。
       * 现在没有有效选区就直接返回，一个请求都不发 ✓。
       */
      // 拖动弹窗产生的那次 mouseup：不是划词，直接忽略 ✗（用户实测：每拖一次就多一行 ✓）
      if (draggingRef.current) return;
      const info = selectionInfo();
      if (info.ok === false) {
        /*
         * 没选中文字 ⇒ **收起浮条** ✓（但不动弹窗：用户可能正在弹窗里点按钮 ✓）。
         *
         * 实测反馈 ✗："添加节点"浮条总是不及时消失 —— 之前这里只 `return`，浮条会一直赖在屏幕上 ✓
         * （点空白、滚走、松手都留着 ✗）。现在无选区即收起 ✓，配合下面的 mousedown 立即消失 ✓。
         */
        setBar(null);
        return;
      }
      /*
       * **弹窗已开**：每选一块就往文本框里追加一行 ✓（用户要求：一行为一个节点 ✓）。
       * 不做门禁、不打宿主 —— 弹窗已经开着，目标在打开时就解析过 ✓。
       */
      if (collecting.current) {
        const text = info.text.trim();
        if (text === "") return;
        setMultiText((current) => {
          // 同一块文字只留一行 ✓（避免重复划同一段时堆积 ✓）
          const existing = current.split("\n").map((line) => line.trim());
          if (existing.includes(text)) return current;
          return current.trim() === "" ? text : `${current.replace(/\n+$/, "")}\n${text}`;
        });
        report("multi-append-line", { chars: text.length });
        return;
      }
      /*
       * **同步判定后就显示** ✓（用户反馈：消失/出现都不够干脆 ✓）。
       *
       * 之前这里是 `await gateNow()`（1~2 次宿主请求 ✓）⇒ 浮条要等往返回来才出现 ✗，
       * 甚至可能在用户已经切走之后才冒出来 ✓（于是表现为"闪一下/不干脆" ✗）。
       * 现在显示只看**同步可得**的两件事：
       *  1. 这个会话有没有工作区归属（DOM 现读 ✓ / 面板发布的路径或库根 ✓）—— 未分组会话不显示 ✓；
       *  2. 库里已知有几个节点（用于"空库时置灰前置按钮" ✓）。
       * 至于"写入目标在哪"，等用户真的点创建时再解析 ✓（`createStandalone` 自己会做 ✓），
       * 所以显示路径上**一次网络请求都不需要** ✓。
       */
      let hasWorkspace = domWorkspacePath().trim() !== "";
      let published = null as ReturnType<typeof readCurrentContext>;
      try {
        published = readCurrentContext(domSessionId());
        if (!hasWorkspace) {
          hasWorkspace = (published?.libraryRoot ?? "").trim() !== "" || (published?.workspacePath ?? "").trim() !== "";
        }
        knownNodeCountRef.current = published === null ? -1 : Object.keys(published.titles ?? {}).length;
      } catch {
        knownNodeCountRef.current = -1;
      }
      if (!hasWorkspace) {
        report("blocked-by-gate", { source: "no-workspace" });
        setBar(null);
        return;
      }
      /*
       * 上一次交互刚导致作用域变化（切了会话/仓库 ✓）⇒ 那次遗留的选区不该再弹浮条 ✓
       * —— 这是"一闪而过"的最后一道闸门（下一次真正的按下会解除它 ✓）。
       */
      if (suppressBarRef.current) {
        report("blocked-by-gate", { source: "just-switched-scope" });
        setBar(null);
        return;
      }
      gateAllowedRef.current = true;
      report("bar-shown-scope", {
        source: published?.libraryRoot ? "published-root" : "dom-or-published-path",
        pathTail: String(published?.libraryRoot ?? published?.workspacePath ?? domWorkspacePath()).split(/[\\/]/).filter((part) => part !== "").pop() ?? "",
        sessionTail: (domSessionId() ?? "").slice(-6),
        snapCount: snapCountRef.current,
      });
      /*
       * **划词后先出浮条**（用户要求：浮条只有一个「添加节点」✓），点它才打开文本框弹窗 ✓。
       * 弹窗打开后，之后每次划词继续往文本框追加一行（见上面的 collecting 分支 ✓）。
       */
      // 记下浮条属于哪个「会话|工作区」✓ —— 之后只要这个作用域变了就收起（切换会话/仓库 ✓）
      barScopeRef.current = `${domSessionId() ?? ""}|${domWorkspacePath()}`;
      setBar({ x: info.x, y: info.y, text: info.text });
        setNote(null);
        report("bar-shown", { chars: info.text.length });
    };

    document.addEventListener("mouseup", onMouseUp);

    /*
     * **点别处 ⇒ 浮条立即消失** ✓（用户反馈：浮条总是不及时消失 ✗）。
     *
     * 用 `mousedown` 而不是等 `mouseup`：点下去的瞬间就收掉，手感才对 ✓。
     * 但要排除"点在浮条自己身上" —— 否则按钮会在 click 到达前就被卸载 ✗（点不动了 ✓）。
     */
    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target as Element | null;
      const insideBar = target !== null && typeof target.closest === "function" && target.closest(".kn-sel-bar") !== null;
      // 用户开始新的交互 ⇒ 解除"切换后禁止弹出"（这是新的一次划词机会 ✓）
      suppressBarRef.current = false;
      if (!insideBar) setBar(null);
    };
    document.addEventListener("mousedown", onMouseDown);

    /*
     * **选区一没，浮条立刻收** ✓（比 200ms 轮询更跟手 ✓）。
     * 注意：拖拽选择的过程中 `selectionchange` 会连续触发，但那时选区**没有折叠**（不是空 ✓）
     * ⇒ 不会误收 ✓；只有点别处/选区被清掉（折叠 ✓）才收起 ✓。
     */
    const onSelectionChange = (): void => {
      try {
        const selection = window.getSelection();
        if (selection === null || selection.isCollapsed) {
          barScopeRef.current = "";
          setBar(null);
        }
      } catch {
        // 忽略
      }
    };
    document.addEventListener("selectionchange", onSelectionChange);

    /*
     * **浮条只在它自己的「会话|工作区」里有效** ✓。
     *
     * 实测反馈 ✗：在当前仓库划词弹出浮条后，**点另一个仓库里的会话**，浮条还赖着不走 ✓。
     * 与其枚举所有切换方式（点侧栏 / 键盘 / 程序化切换，还得考虑阴影 DOM ✗），
     * 不如**直接核对作用域**：每 400ms 比一次，作用域变了就收起 ✓ —— 覆盖所有切换方式 ✓。
     */
    const scopeTimer = window.setInterval(() => {
      if (barScopeRef.current === "") return;
      const scope = `${domSessionId() ?? ""}|${domWorkspacePath()}`;
      if (scope !== barScopeRef.current) {
        barScopeRef.current = "";
        // 切换后的这段"余波"里禁止再弹浮条 ✓（直到用户下一次真正按下 ✓）—— 彻底消掉那一闪
        suppressBarRef.current = true;
        setBar(null);
        /*
         * **连选区一起清掉** ✓（否则会"闪一下" ✗）。
         *
         * 实测反馈：切到别的仓库后浮条是"消失→出现→消失" ✓ —— 因为旧会话遗留的选区还在，
         * 紧接着的 mouseup 又把它当成一次新划词 ⇒ 浮条被重新弹出 ⇒ 再被这里收掉 ✓。
         * 清掉选区后，那次 mouseup 根本看不到选区 ⇒ 不会重新弹出 ✓。
         */
        try { window.getSelection()?.removeAllRanges(); } catch { /* 忽略 */ }
      }
    }, 200);
    report("mounted", { ua: typeof navigator === "undefined" ? "" : String(navigator.platform ?? "").slice(0, 12) });
    return () => {
      window.clearInterval(scopeTimer);
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, []);

  /**
   * 调宿主：读一次**当前库**的节点表（id → 标题）。
   *
   * 与旧实现的区别（真实 bug ✗）：旧代码叫 `hydrateTitles`，会先判断
   * 「这个 id 是不是只有前 8 位」，而**跨库的标题缓存**让它以为"标题已经有了" ⇒ 直接 `return`，
   * 于是一次请求都不发、`resolvedTitles` 一直是空的 ⇒ 下面的过滤被跳过
   * ⇒ 推荐里列出别的库的节点（用户实测：推荐项全是当前库里没有的 ✗）。
   *
   * 现在无条件按**当前库**取一次，并把结果当成"什么存在"的**唯一依据** ✓；
   * 取不到就置 `null`，此时一个推荐都不显示 ✓。
   */
  const loadLibraryNodes = async (): Promise<void> => {
    try {
      /*
       * 取数顺序（可靠度从高到低）：
       * 1. 面板按**当前会话**发布的库根（`readCurrentContext`）—— 最准 ✓；
       * 2. 最近一次发布的工作区路径（`?root=`，实测面板走这条路取数成功 ✓）；
       * 3. 当前聊天会话 id（有些会话里 `?sessionId=` 会答"找不到库" ✗，所以放最后）。
       */
      const sessionId = domSessionOf();
      const published = (() => {
        try {
          return readCurrentContext(sessionId);
        } catch {
          return null;
        }
      })();
      const root = (published?.libraryRoot ?? "").trim() || readLastWorkspacePath().trim();
      const url = root !== ""
        ? `${GRAPH_API_ROUTE}?root=${encodeURIComponent(root)}`
        : (sessionId === null ? GRAPH_API_ROUTE : `${GRAPH_API_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`);
      const response = await fetch(url, { headers: { accept: "application/json" }, credentials: "same-origin" });
      const body = (await response.json()) as {
        ok?: boolean;
        library?: { root?: string };
        nodes?: Array<{ id?: string; title?: string }>;
      };
      if (body.ok !== true) {
        setLibraryTitles(null);
        report("library-nodes", "not-ok");
        return;
      }
      const map: Record<string, string> = {};
      for (const node of body.nodes ?? []) {
        if (typeof node.id === "string" && typeof node.title === "string") map[node.id] = node.title;
      }
      libraryKeyRef.current = String(body.library?.root ?? root ?? "");
      setLibraryTitles(map);
      report("library-nodes", { count: Object.keys(map).length });
    } catch {
      /* 读不到就保持"不知道" ⇒ 不显示任何推荐（搜索仍然可用 ✓） */
      setLibraryTitles(null);
    }
  };

  /** 推荐项显示用：**当前库**的标题优先 → 发布/缓存 → id */
  const labelOf = (id: string): string => libraryTitles?.[id] ?? titleOf(id);

  /**
   * 把某个 id 从记忆里彻底删掉（跨库残留的推荐：宿主答 `node_not_found` 时自愈 ✓）。
   * @param id - 要忘掉的节点 id。
   */
  const forgetTarget = (id: string): void => {
    const memory = readMemory();
    writeMemory({
      recentFocus: memory.recentFocus.filter((item) => item !== id),
      recentPrereqTargets: memory.recentPrereqTargets.filter((item) => item !== id),
    });
  };

  /** 从选择弹窗的状态里取草稿（回调里 TS 收窄不了 `picking`，所以单独抽一个空安全的读取） */
  const draftsOf = (state: PickState | null): PrereqDraft[] => state?.drafts ?? [];

  /** 调宿主：搜索可选目标节点 */
  const doSearch = async (text: string): Promise<void> => {
    if (text.trim() === "") {
      setResults([]);
      return;
    }
    setSearching(true);
    try {
      const response = await fetch(GRAPH_API_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ kind: "search-nodes", query: text }),
      });
      const body = (await response.json()) as { ok?: boolean; nodes?: Array<{ id: string; title: string }> };
      setResults(body.ok === true ? (body.nodes ?? []) : []);
      report("search", { count: (body.nodes ?? []).length });
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  // 非知识库工作区：着色/渲染都不做（门禁在划词那一刻现算，这里只保证有文档环境）
  if (typeof document === "undefined") return null;
  const memory = readMemory();
  /*
   * 推荐**只在当前库里筛**，而且**没确认当前库有哪些节点之前一个都不显示**。
   *
   * 实测反馈 ✗：换库之后推荐里出现的是**别的库**的节点（`.git/info/exclude…`、`最短路径算法`、`载噪比` …），
   * 显示的还是别的库的标题 —— 因为记忆与标题缓存都是跨库的最后值；点下去宿主只会答"找不到节点"。
   * 所以这里把 `libraryTitles`（当前库的节点表）当**唯一依据**：
   * `null`（还在读 / 读失败）⇒ 空列表 ✓；有表 ⇒ 只留表里确实有的 ✓。
   */
  const candidates = recommendTargets(
    { recentFocus: memory.recentFocus, recentPrereqTargets: memory.recentPrereqTargets },
    5,
  );
  const recommended = keepKnownTargets(candidates, libraryTitles, 3);
  /*
   * 结果区**只有一份**（设计稿）：没输入时列推荐，有输入时列搜索结果；
   * 行上的「选择 / ✓」由 `selectedTarget` 决定（先选、再确认添加）。
   */
  const pickRows: Array<{ id: string; title: string }> = query.trim() === ""
    ? recommended.map((id) => ({ id, title: labelOf(id) }))
    : results;

  return (
    <>
      {/*
        * **浮条**（用户要求：只保留一个「添加节点」✓）。
        * 点它才打开下面的文本框弹窗 ✓ —— 弹窗里再决定"创建独立节点 / 创建前置节点"✓。
        */}
      {bar === null || gateAllowedRef.current !== true ? null : createPortal(
        <div className="kn-sel-bar" style={{ left: bar.x, top: Math.max(8, bar.y - 40), transform: "translateX(-50%)" }}>
          <button
            type="button"
            className="kn-sel-primary"
            /*
             * **按下时不许动选区** ✗→✓：浏览器默认会在 mousedown 时把选区收掉
             * ⇒ 取消默认行为后，点击那一刻 `getSelection()` 还读得到原文 ✓，
             * 浮条也不会因为 selectionchange 先把自己收掉（表现为"点了没反应" ✗）。
             */
            onMouseDown={(event) => { event.preventDefault(); }}
            onClick={() => {
              /*
               * 现读选区优先；**读不到就回落到浮条弹出时记下的原文** ✓
               * （旧实现只现读 ⇒ 选区一旦被清掉就 `return`，用户看到的就是"点了没反应" ✗）。
               */
              const live = normalizeSnippet(window.getSelection()?.toString() ?? "").trim();
              const text = live === "" ? bar.text : live;
              if (text === "") return;
              setMultiText(text);
              setNote(null);
              setError(null);
              collecting.current = true;
              setMultiOpen(true);
              setBar(null);
              report("open-dialog", { chars: text.length });
            }}
          >
            {props.copy.addNode ?? "添加节点"}
          </button>
        </div>,
        document.body,
      )}

      {/*
        * **文本框弹窗**：第一次划词（经浮条）打开 ✓，之后每选中一块文字自动追加**单独一行** ✓
        * （**一行为一个节点** ✓）；底部三个按钮：创建前置节点 / 创建独立节点 / 取消 ✓。
        */}
      {multiOpen ? createPortal(
        <div className="kn-sel-mask" role="presentation">
          <div
            className="kn-sel-modal"
            role="dialog"
            aria-modal="true"
            style={multiPos === null ? undefined : { position: "fixed", left: multiPos.x, top: multiPos.y, margin: 0 }}
          >
            <div
              className="kn-sel-modal-title"
              style={{ cursor: "move", userSelect: "none" }}
              onMouseDown={startDragMulti}
              title="按住拖动可以把它挪开，方便继续在对话里选文字"
            >
              {props.copy.multiTitle ?? "多选：每一块文字占一行"}
            </div>
            <textarea
              className="kn-sel-textarea"
              value={multiText}
              rows={8}
              spellCheck={false}
              onChange={(event) => { setMultiText(event.target.value); }}
              placeholder={props.copy.multiPlaceholder ?? "在对话里继续划词，会自动追加到下一行；也可以直接在这里编辑"}
            />
            {note !== null ? <div className="kn-sel-modal-hint" style={{ opacity: 1 }}>{note}</div> : null}
            <div className="kn-sel-modal-hint">
              {props.copy.multiCount ? props.copy.multiCount(multiLines(multiText).length) : `共 ${multiLines(multiText).length} 行`}
            </div>
            <div className="kn-sel-modal-actions">
              <button
                type="button"
                className="kn-sel-primary"
                /* 空库（已知节点数为 0）时置灰 ✓；未知(-1)时保持可点 ✓（避免误灰 ✓） */
                disabled={multiLines(multiText).length === 0 || knownNodeCountRef.current === 0}
                title={knownNodeCountRef.current === 0 ? "这个知识库还没有任何节点：请先用「添加为独立节点」建一个" : undefined}
                onClick={() => {
                  const lines = multiLines(multiText);
                  /* 一行为一个节点，**每行各自的标题**（多行时共用一个标题会把后面的行静默丢掉 ✗） */
                  const list = draftPrereqs(lines);
                  if (list.length === 0) return;
                  collecting.current = false;
                  setMultiOpen(false);
                  setError(null);
                  setPicking({ drafts: list });
                  setSelectedTarget(null);
                  /*
                   * **先把"当前库有哪些节点"读回来**（`null` 期间一个推荐都不显示 ✓）：
                   * 推荐项必须是本库真实存在的节点，否则点下去只会得到"找不到节点" ✗。
                   */
                  setLibraryTitles(null);
                  void loadLibraryNodes();
                  report("open-picker", { count: list.length, from: "multi-modal" });
                }}
              >
                添加为前置
              </button>
              <button
                type="button"
                disabled={multiLines(multiText).length === 0}
                onClick={() => {
                  const lines = multiLines(multiText);
                  /*
                   * **先建、后关** ✗→✓：之前先关弹窗再创建 ⇒ 失败提示落在已关闭的界面上 ✗
                   * ⇒ 用户看到的就是"点了没反应"（真实反馈 ✓）。
                   * 现在提示留在弹窗里；只有**至少成功一个**才清空文本、继续下一批 ✓。
                   */
                  void (async () => {
                    let ok = 0;
                    for (const line of lines) {
                      if (await createStandalone(line)) ok += 1;
                    }
                    if (ok > 0) {
                      /*
                       * 建完就收工（用户要求 ✓）：
                       * ① 通知面板**刷新数据 + 重跑布局 + 重新取景** ✓（新节点必须在视野里 ✓）；
                       * ② **关掉弹窗** ✓（不再让用户手动点取消）。
                       */
                      notifyLibraryChanged();
                      collecting.current = false;
                      setMultiOpen(false);
                      setMultiText("");
                    } else {
                      // 全失败：保留弹窗与文本，让用户看到原因后直接重试 ✓
                      setNote(`创建失败：0/${lines.length} 个成功`);
                    }
                    report("standalone-create", `multi:${ok}/${lines.length}`);
                  })();
                }}
              >
                添加为独立节点
              </button>
              <button
                type="button"
                onClick={() => {
                  collecting.current = false;
                  setMultiOpen(false);
                  setMultiText("");
                  report("multi-cancel", null);
                }}
              >
                取消
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}


      {picking !== null ? createPortal(
        <div className="kn-modal-backdrop" role="presentation" onClick={() => { setPicking(null); }}>
          {/*
            * 「设为前置」弹窗 —— 形态按设计稿（`knowledgenet-picker-design.html`）：
            * 头部标题/副标题 → 被添加的知识点（每条一个可编辑 chip）→ 「添加为谁的前置」搜索区
            * → 底部状态行 + 取消/确认添加。样式自带一份（portal 在 light DOM，Shadow 样式管不到 ✓）。
            */}
          <div className="kn-pick-dialog" role="dialog" aria-modal="true" aria-labelledby="kn-pick-title" onClick={(event) => { event.stopPropagation(); }}>
            <div className="kn-pick-head">
              <div className="kn-pick-title" id="kn-pick-title">{props.copy.pickTitle}</div>
              <div className="kn-pick-subtitle">{props.copy.pickHint}</div>
            </div>

            <div className="kn-pick-content">
              {/*
                * **被添加的知识点**：一条草稿一个 chip，标题可以就地改 ✎
                * （旧实现只有一个输入框 ⇒ 多行时全部行共用一个标题、后面的行被静默丢掉 ✗）。
                */}
              <div className="kn-pick-chips">
                {picking.drafts.map((draft, index) => (
                  <label className="kn-pick-chip" key={`${index}:${draft.text.slice(0, 24)}`}>
                    <input
                      value={draft.title}
                      aria-label={draft.text.slice(0, 40)}
                      title={draft.text.slice(0, 120)}
                      onChange={(event) => {
                        const value = event.target.value;
                        setPicking((prev) => prev === null ? null : {
                          drafts: prev.drafts.map((item, i) => (i === index ? { ...item, title: value } : item)),
                        });
                      }}
                    />
                    <span className="kn-pick-chip-mark" aria-hidden="true">✎</span>
                  </label>
                ))}
              </div>

              <div className="kn-pick-target">
                <div className="kn-pick-section">{props.copy.targetSection ?? "添加为谁的前置"}</div>

                <label className="kn-pick-label" htmlFor={PICK_SEARCH_ID}>
                  {props.copy.searchLabel ?? props.copy.searchHint}
                </label>
                <div
                  className="kn-search-wrap"
                  /* 行内也写一份：边框/底色/内边距长在外层，图标与输入框是同一行的 flex 兄弟 ✓ */
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    height: 36,
                    boxSizing: "border-box",
                    padding: "0 11px",
                    border: "1px solid var(--dsw-alias-border-l3, #d6e0dd)",
                    borderRadius: 7,
                    background: "var(--dsw-alias-bg-layer-1, #ffffff)",
                  }}
                >
                  {/*
                    * 放大镜（设计稿：图标在输入框内部左侧）。
                    * **尺寸写死成属性 + 行内样式**：宿主页面里有大量 `… svg { width: … }` 规则，
                    * 只靠类选择器一旦被压过去，svg 会按 viewBox 撑满整行（实测变成巨型放大镜 ✗）。
                    */}
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    width={16}
                    height={16}
                    aria-hidden="true"
                    style={{ flex: "none", width: 16, height: 16, color: "var(--dsw-alias-label-secondary, #8a8a8a)" }}
                  >
                    <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.7" />
                    <path d="m16 16 4.5 4.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                  </svg>
                  <input
                    id={PICK_SEARCH_ID}
                    className="kn-search-input"
                    type="search"
                    value={query}
                    placeholder={props.copy.searchPlaceholder ?? "输入名称搜索"}
                    /* 输入框自己不画框（框在外层），也不依赖任何外部样式表 ✓ */
                    style={{
                      flex: 1,
                      minWidth: 0,
                      height: "100%",
                      padding: 0,
                      border: 0,
                      outline: 0,
                      background: "transparent",
                      color: "inherit",
                      font: "inherit",
                    }}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      void doSearch(event.target.value);
                    }}
                  />
                </div>

                {/* 有输入 → 「搜索结果」；没输入 → 「推荐」（与设计稿一致） */}
                <div className="kn-pick-group">
                  {query.trim() === "" ? props.copy.recommended : (props.copy.resultsLabel ?? "搜索结果")}
                </div>

                {/*
                  * 还没拿到当前库的节点表（`libraryTitles === null`）时**一个推荐都不列** ——
                  * 免得把别的库残留的 id 当成"本库的推荐" ✗（用户实测过 ✓）。
                  */}
                {query.trim() === "" && libraryTitles === null ? (
                  <p className="kn-pick-empty">{props.copy.loadingNodes ?? "正在读取当前知识库…"}</p>
                ) : null}

                {searching ? <p className="kn-pick-empty">{props.copy.searching}</p> : null}

                {pickRows.length === 0 && !searching && !(query.trim() === "" && libraryTitles === null) ? (
                  <p className="kn-pick-empty">
                    {query.trim() === ""
                      ? (props.copy.noRecommend ?? "这个库里还没有可推荐的最近节点，直接搜索吧")
                      : (props.copy.noResult ?? "没有匹配的知识点")}
                  </p>
                ) : null}

                {pickRows.length === 0 ? null : (
                  <div className="kn-pick-results" aria-label={query.trim() === "" ? props.copy.recommended : (props.copy.resultsLabel ?? "搜索结果")}>
                    {pickRows.map((row) => {
                      const active = selectedTarget?.id === row.id;
                      return (
                        <button
                          key={row.id}
                          type="button"
                          className="kn-pick-row"
                          aria-pressed={active}
                          onClick={() => { setSelectedTarget({ id: row.id, title: row.title }); }}
                        >
                          <span className="kn-pick-row-name">{row.title}</span>
                          <span className="kn-pick-row-mark">{active ? "✓" : (props.copy.selectMark ?? "选择")}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="kn-pick-foot">
              {/* 状态行（设计稿：左侧一句话说明"添加为谁的前置"） */}
              <div className="kn-pick-status">
                {selectedTarget === null
                  ? (props.copy.statusPick ?? "请选择要添加到的知识点")
                  : (props.copy.statusSelected?.(selectedTarget.title) ?? `添加为「${selectedTarget.title}」的前置`)}
              </div>
              <div className="kn-pick-actions">
                <button type="button" className="kn-pick-btn" onClick={() => { setPicking(null); }}>{props.copy.cancel}</button>
                <button
                  type="button"
                  className="kn-pick-btn is-primary"
                  disabled={selectedTarget === null}
                  onClick={() => {
                    const target = selectedTarget;
                    if (target === null) return;
                    /* 点「确认添加」才真的写：选中的目标 + 这一批草稿 ✓（设计稿的交互） */
                    void runQueue(target.id, draftsOf(picking), 0);
                  }}
                >
                  {props.copy.confirm}
                </button>
              </div>
            </div>

            {error === null ? null : <div className="kn-pick-error">{error}</div>}
          </div>
        </div>,
        document.body,
      ) : null}

      {pendingCandidates === null ? null : (
        <ConfirmDialog
          title={props.copy.candidatesTitle}
          message={`${props.copy.candidatesMessage}：${pendingCandidates.candidates.join("、")}`}
          confirmLabel={`${props.copy.reuse}「${pendingCandidates.candidates[0]}」`}
          cancelLabel={props.copy.createAnyway}
          /* 决定后由 `resolveCandidate` 用**显式标题**重发，并从下一条继续 ✓（不再读闭包里的旧标题 ✗） */
          onConfirm={() => { void resolveCandidate(pendingCandidates.candidates[0] ?? "", false); }}
          onCancel={() => { void resolveCandidate(pendingCandidates.queue[pendingCandidates.index]?.title ?? "", true); }}
        />
      )}
    </>
  );
}
