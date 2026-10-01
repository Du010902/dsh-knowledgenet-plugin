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
  keepKnownTargets,
  MAX_SNIPPETS,
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
    /* 注：`multiTitle` / `multiSubtitle` / `multiPlaceholder` 的声明见下面的 @deprecated 区块 */
    multiCount?: (count: number) => string;
    /** 可选：「被添加的知识点」标签 */
    multiLabel?: string;
    /** 可选：标签框下方那行说明（现在只说明"划词会自动追加"） */
    multiDetails?: string;
    /**
     * 以下三项**已不再渲染** ✓（用户要求：去掉标题、删掉副标题、不许手动输入新标签）。
     *
     * 先保留声明（宿主仍在传，删掉会牵动 `index.ts` 与文案文件）；
     * 真正清理时**三处一起删**：本接口、`src/client/index.ts` 的 copy、以及重建后的 `client.js`。
     */
    /** @deprecated 弹窗标题「收集知识点」（用户要求去掉） */
    multiTitle?: string;
    /** @deprecated 标题下的副标题（用户要求删除） */
    multiSubtitle?: string;
    /** @deprecated 手动输入新标签的占位符（输入框已移除） */
    multiPlaceholder?: string;
    /** @deprecated 标签组右侧的「点击标签可修改名称」（已删除） */
    multiHint?: string;
    /** @deprecated 旧第二层弹窗的标题（合并后不再渲染） */
    pickTitle?: string;
    /** @deprecated 旧第二层弹窗的副标题（合并后不再渲染） */
    pickHint?: string;
    /** @deprecated 旧弹窗的"前置名称"输入框标签（合并后不再渲染） */
    titleLabel?: string;
    /** 可选：弹窗里「添加为前置」那个选项的文字（与 `addStandalone` 二选一） */
    multiAsPrereq?: string;
    multi: string;
    selected: (count: number) => string;
    done: string;
    cancel: string;
    recommended: string;
    searchHint: string;
    searching: string;
    noResult: string;
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
     * 浮条与它的遮罩：浮条是 root 作用域，拿不到面板的 `.kn-modal*` 样式 ⇒ 自带一份 ✓。
     * 遮罩 z-index 要高于浮条（10001）与菜单（10002）✓。
     * （弹窗本体已改成设计稿的 `.kn-pick-dialog` 系列，旧的 `.kn-sel-modal*` / 文本框样式已删 ✓）
     */
    ".kn-sel-mask {",
    "  position: fixed; inset: 0; z-index: 10003; display: flex; align-items: center; justify-content: center;",
    "  background: rgba(0, 0, 0, 0.12); pointer-events: none; }",
    ".kn-sel-bar {",
    "  position: fixed; z-index: 10001; display: flex; align-items: center; gap: 4px;",
    "  padding: 4px 6px; border-radius: 999px;",
    "  border: 0.5px solid var(--dsw-alias-border-l2);",
    "  background: var(--dsw-alias-bg-layer-2);",
    "  color: var(--dsw-alias-label-primary);",
    "  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28); font-size: 12px; }",
    ".kn-sel-bar button {",
    "  border: 0; border-radius: 999px; background: transparent; color: inherit;",
    "  font: inherit; font-size: 12px; padding: 3px 9px; cursor: pointer; }",
    ".kn-sel-bar button:hover { background: var(--kn-hover, color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)); }",
    ".kn-sel-bar .kn-sel-primary { background: var(--kn-hover, color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)); font-weight: 600; }",
    /*
     * 「收集知识点」弹窗的标签组（形态照设计稿 `knowledgenet-multiselect-design.html`）：
     * 一个 chip = 一个待建的知识点，chip 内可改名、× 可删；末尾一个输入框负责新增 ✓。
     * 弹窗外壳复用上面那套 `.kn-pick-*`（同一个设计语言，两处弹窗共用 ✓）。
     */
    ".kn-ms-label-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 9px; }",
    ".kn-ms-label-row .kn-pick-label { margin: 0; }",
    ".kn-ms-composer { display: flex; flex-wrap: wrap; align-content: flex-start; gap: 7px; min-height: 90px; padding: 10px; box-sizing: border-box;",
    "  border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px; background: var(--dsw-alias-bg-layer-1); }",
    ".kn-ms-composer:focus-within { border-color: #819b91; }",
    ".kn-ms-chip { display: inline-flex; align-items: center; gap: 3px; max-width: 100%; min-height: 30px; padding: 0 5px 0 10px;",
    "  border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px; background: var(--dsw-alias-bg-layer-2); color: inherit; }",
    ".kn-ms-chip input { padding: 0; border: 0; outline: 0; background: transparent; color: inherit; font: inherit; }",
    ".kn-ms-remove { display: grid; place-items: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 5px;",
    "  background: transparent; color: var(--dsw-alias-label-secondary); font-size: 16px; line-height: 1; cursor: pointer; }",
    ".kn-ms-remove:hover { background: var(--kn-hover, color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)); color: inherit; }",
    /*
     * 注：`.kn-ms-new`（末尾那个"手动输入新标签"的输入框）已按用户要求删掉 ✓ ——
     * 知识点只能来自对话划词，标签本身仍可就地改名（`.kn-ms-chip input`）。
     */
    /* 一个标签都没有时的引导语（只是提示，不是"可以在这里输入"的输入位） */
    ".kn-ms-placeholder { align-self: center; color: var(--dsw-alias-label-secondary); font-size: 12px; }",
    ".kn-ms-details { margin: 8px 0 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }",
    /*
     * 「是否添加为前置」这一行：**两个互斥选项**（创建独立节点 / 添加为前置）✓。
     *
     * 用原生 radio：语义准确（不是"可同时勾选"的复选框）、键盘（方向键 / Space）与读屏天然可用 ✓；
     * 样式上把行做成可点区域，radio 本体保持浏览器默认外观（不自己画控件 = 不会在亮暗主题里跑偏 ✓）。
     */
    ".kn-ms-mode { display: flex; flex-wrap: wrap; align-items: center; gap: 18px; margin: 14px 0 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }",
    ".kn-ms-radio { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; color: inherit; font-size: 12px; }",
    ".kn-ms-radio input { margin: 0; accent-color: var(--dsw-alias-brand-primary); cursor: pointer; }",
    ".kn-ms-radio:hover { color: var(--dsw-alias-label-primary); }",
    ".kn-ms-note { margin-top: 8px; font-size: 12px; }",
    ".kn-ms-drag { font-size: 11px; letter-spacing: 4px; line-height: 1; color: var(--dsw-alias-label-secondary); opacity: .55; }",
    /*
     * 「设为前置」弹窗（形态照设计稿 `knowledgenet-picker-design.html`）：
     * 头部 / 内容 / 底部三段，全出血分隔线；字段与结果行都走宿主 token，亮暗主题自动跟随 ✓。
     */
    ".kn-pick-dialog {",
    "  box-sizing: border-box; width: min(520px, calc(100vw - 48px)); max-height: calc(100vh - 96px); overflow: auto;",
    /*
     * **必须显式 `pointer-events: auto`**：收集弹窗的遮罩是 `pointer-events: none`（这样还能继续在对话里划词 ✓），
     * 子元素不打开指针事件的话整个弹窗都点不动 ✗（旧 `.kn-sel-modal` 就带着这一条，重构时容易漏）。
     */
    "  pointer-events: auto;",
    "  border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px;",
    "  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);",
    "  box-shadow: 0 22px 64px rgba(0, 0, 0, .35); font-size: 13px; line-height: 1.5; }",
    /* 头部现在只承担"拖动把手"（标题已按用户要求去掉），所以内边距改小、只留拖拽区 ✓ */
    ".kn-pick-head { padding: 12px 22px 10px; }",
    /* 注：`.kn-pick-title` / `.kn-pick-subtitle` 已随标题删除一起移除（没有元素再用它们） */
    ".kn-pick-content { padding: 0 22px 15px; }",
    /*
     * 注：`.kn-pick-chip*`（第二层弹窗里那排"被添加的知识点"）已随**两层弹窗合并**一起删掉 ✓ ——
     * 现在标签只有一份（`.kn-ms-chip*`），不会再出现"两个弹窗各有一套标签"的重复形态 ✓。
     */
    /* 「添加为谁的前置」：与上面的标签区隔开（展开时才有） */
    ".kn-pick-target { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--dsw-alias-border-l2); }",
    ".kn-pick-label { display: block; margin: 0 0 8px; font-size: 12px; font-weight: 500; }",
    ".kn-pick-group { margin: 14px 0 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }",
    /*
     * 搜索框：**图标与输入框是同一行的两个 flex 子项**，不是"绝对定位盖在输入框上"。
     *
     * 为什么改（实测 ✗）：原来图标 `position: absolute` + 输入框 `padding-left: 35px`，
     * 而输入框的 padding 还会被别处的 `.kn-modal-input` 规则插一脚 ⇒ 图标和占位文字挤在同一条线上。
     * 现在边框/底色/内边距都长在**外层** `.kn-search-wrap` 上：11px 内边距 + 16px 图标 + 8px 间距
     * = 文字正好从 35px 处开始 ✓（与设计稿的 `padding-left: 35px` 等价），图标不可能再飘 ✓。
     */
    ".kn-search-wrap { display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 11px; box-sizing: border-box;",
    "  border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px; background: var(--dsw-alias-bg-layer-1); }",
    ".kn-search-wrap svg { flex: none; width: 16px; height: 16px; color: var(--dsw-alias-label-secondary); }",
    ".kn-search-wrap input { flex: 1; min-width: 0; height: 100%; padding: 0; border: 0; outline: 0;",
    "  background: transparent; color: inherit; font: inherit; }",
    ".kn-search-wrap input::placeholder { color: var(--dsw-alias-label-secondary); }",
    /* 输入框自己的类（守门测试要求用到的 kn-* 必须有定义；行为与上面那条一致 ✓） */
    ".kn-search-input { flex: 1; min-width: 0; height: 100%; padding: 0; border: 0; outline: 0;",
    "  background: transparent; color: inherit; font: inherit; }",
    ".kn-search-input::placeholder { color: var(--dsw-alias-label-secondary); }",
    /* 结果行：整行可点，选中时描边 + ✓ */
    ".kn-pick-results { display: flex; flex-direction: column; gap: 2px; max-height: 236px; overflow: auto; }",
    ".kn-pick-row { display: flex; align-items: center; width: 100%; min-height: 34px; padding: 6px 10px;",
    "  border: 1px solid transparent; border-radius: 6px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }",
    ".kn-pick-row:hover { background: var(--kn-hover, color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)); }",
    ".kn-pick-row[aria-pressed='true'] { border-color: #819b91; background: rgba(129, 155, 145, .18); }",
    ".kn-pick-row-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".kn-pick-row-mark { margin-left: auto; padding-left: 10px; font-size: 11px; color: var(--dsw-alias-label-secondary); }",
    ".kn-pick-row[aria-pressed='true'] .kn-pick-row-mark { color: inherit; }",
    ".kn-pick-empty { margin: 0; padding: 7px 10px; font-size: 12px; color: var(--dsw-alias-label-secondary); }",
    /* 底部：状态行 + 取消/确认添加 */
    ".kn-pick-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 13px 22px;",
    "  border-top: 1px solid var(--dsw-alias-border-l2); }",
    ".kn-pick-status { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--dsw-alias-label-secondary); }",
    ".kn-pick-actions { display: flex; gap: 8px; flex: none; }",
    ".kn-pick-btn { height: 34px; padding: 0 13px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px;",
    "  background: transparent; color: inherit; font: inherit; cursor: pointer; }",
    ".kn-pick-btn:hover { background: var(--kn-hover, color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)); }",
    ".kn-pick-btn.is-primary { border-color: transparent; background: var(--dsw-alias-brand-primary);",
    "  color: var(--dsw-alias-bg-base); }",
    ".kn-pick-btn.is-primary:hover:not(:disabled) { filter: brightness(1.06); }",
    ".kn-pick-btn.is-primary:disabled { opacity: .42; cursor: not-allowed; }",
    ".kn-pick-error { margin: 0 22px 14px; font-size: 12px; color: var(--dsw-alias-state-error-primary); }",
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

/**
 * 划词浮条 + 片段收集 + 目标选择。
 * @param props - 文案与上报回调。
 * @returns portal 出去的小条与弹窗（没有划词时什么都不渲染）。
 */
export function ChatSelectionBar(props: ChatSelectionBarProps): ReactNode {
  const [bar, setBar] = useState<{ x: number; y: number; text: string } | null>(null);
  /**
   * 弹窗当前是哪种动作（用户要求 2026-09：**两层弹窗合并成一层** ✓）。
   *
   * - `false`（默认）= 创建独立节点：底部主按钮就是「创建独立节点」；
   * - `true` = 添加为前置：同一个按钮变成「添加为前置」，并**在下面展开**目标选择区。
   *
   * 合并之前这里是两个弹窗（收集弹窗 → 选择弹窗），用户要来回切换、还会丢掉上下文；
   * 现在一个弹窗里切换，标签、搜索词、选中的目标都留在同一份 state 里 ✓。
   */
  const [asPrereq, setAsPrereq] = useState(false);
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
  /**
   * 多选弹窗里的**标签**：一个标签 = 一个待建的知识点 ✓
   * （设计稿：chip 组 + 末尾一个可输入的新标签，Enter/粘贴多行追加、退格删最后一个 ✓）。
   */
  const [chips, setChips] = useState<string[]>([]);
  /** 末尾输入框里正在敲的新标签 */
  /** 「创建独立节点」正在跑：避免连点建出重复节点 ✗ */
  const busyRef = useRef(false);
  /** 作用域刚变过：此刻不允许再弹浮条（等下一次真正的按下 ✓）—— 彻底消除"一闪" ✓ */
  const suppressBarRef = useRef(false);
  /** 已知的节点数量：-1 表示"还不知道"（不改按钮状态，避免误灰 ✓）；0 表示库是空的 ✓ */
  const knownNodeCountRef = useRef(-1);
  /** 浮条弹出时所在的「会话|工作区」：一变就收起（见下面的轮询）✓ */
  const barScopeRef = useRef("");
  /** 正在拖动弹窗：拖动产生的 mouseup 不能当成"划词" ✗ */
  const draggingRef = useRef(false);
  /**
   * 按下那一刻的现场（在**捕获阶段**记下）：松开时用它判断"这一按到底是不是划词"。
   * `inside` = 按在浮条自己身上（那种情况交给浮条自己的 click 处理，不在 mouseup 里重弹 ✓）。
   */
  const pressRef = useRef<{ x: number; y: number; text: string; inside: boolean; insideSelection: boolean } | null>(null);
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
      closeMulti();
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

  /**
   * 把一段（可能多行的）文本追加成标签：去空行、去重、有上限（`MAX_SNIPPETS`）✓。
   *
   * 为什么在**标签层**就去重和截断：`draftPrereqs` 也会做一次，但那是在"确定添加"之后 ——
   * 界面上看得见的标签和被创建的节点必须一一对应，不能"显示 12 个、只建 8 个" ✗。
   *
   * @param current - 现有标签。
   * @param raw - 新文本（可含换行 ⇒ 一次加多个）。
   * @returns 新数组（不修改入参）。
   */
  const appendChips = (current: readonly string[], raw: string): string[] => {
    const next = [...current];
    for (const line of raw.split(/\r?\n/)) {
      const text = line.trim();
      if (text === "" || next.includes(text)) continue;
      if (next.length >= MAX_SNIPPETS) break;
      next.push(text);
    }
    return next;
  };

  /** 关掉多选弹窗（顺带清空标签 ✓） */
  const closeMulti = (): void => {
    collecting.current = false;
    setMultiOpen(false);
    setChips([]);
    /*
     * 动作模式与目标选择一起复位 ✓：下次打开弹窗必须回到"创建独立节点"的干净状态，
     * 不能把上一次勾过的「添加为前置」和选中的目标带给下一个知识点 ✗。
     */
    setAsPrereq(false);
    setSelectedTarget(null);
    setError(null);
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
    setSelectedTarget(null);
    setAsPrereq(false);
    setMultiOpen(false);
    setChips([]);
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
      /*
       * 失败后弹窗必须回来 ✓（合并成一层后只有一个弹窗，"关掉再报错"就是"点了没反应" ✗）：
       * 恢复成"前置模式 + 目标已选"的现场，用户能直接看到错误、再点一次按钮重试 ✓。
       */
      setMultiOpen(true);
      setAsPrereq(true);
      collecting.current = true;
      setSelectedTarget({ id: pending.fromId, title: titleOf(pending.fromId) });
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
        /*
         * **在自己弹窗里选中文字不算划词** ✓（用户反馈 2026-09）。
         *
         * 现象：在「收集知识点」弹窗里按住鼠标划一段文字（哪怕只是想复制），
         * 松手就被当成一次划词 ⇒ 那段文字被追加成一个"待建知识点" ✗（用户明确说这不合理）。
         *
         * 期望的语义（用户原话）：**只有对话正文里的选中**才等于"要添加的知识点" ✓。
         * 所以这里按"选区祖先落在自己的弹窗/浮条里"排除 ——
         * 弹窗本体与浮条都是 portal 到 `document.body` 的 **light DOM**，
         * 选区锚点节点一定在它们内部 ⇒ `closest` 直接可用 ✓（不需要 `composedPath` 那套 Shadow 处理）。
         *
         * 注意：`.kn-pick-dialog` 是唯一弹窗的外壳（两层弹窗已合并），
         * 里面标签、说明、推荐行、按钮的文字都被这一条覆盖 ✓；输入框另有上面的 `in-editable` ✓。
         */
        if (element !== null && typeof element.closest === "function"
          && element.closest(".kn-pick-dialog, .kn-sel-bar") !== null) {
          return { ok: false, reason: "in-own-ui" };
        }
        /*
         * **白名单：只有「对话正文」里的选中才算划词** ✓（用户两次强调的语义）。
         *
         * 之前一直是"排除法"（排除输入框 / 侧栏 / 自家弹窗），排除不到的角落就会**凭空弹出浮条** ✗：
         * 用户实测"我什么都没做，它怎么自己弹出来了"—— 例如在右侧面板里选中一段文字，
         * 而面板是 **Shadow DOM**：`closest` 跨不过影子边界，前面几条排除全部判不中 ✗。
         *
         * 宿主在对话内容容器上给了稳定属性（`ConversationContent.tsx:192-194`）：
         * `data-conversation-content` / `data-conversation-region="chat"` / `data-conversation-session`。
         * 对话正文在 **light DOM** ⇒ `closest` 直接可用 ✓；面板/侧栏在 Shadow DOM ⇒ 天然判不中 ✓。
         *
         * **兜底**：整页找不到这个容器时（宿主改了结构、或不是对话页）退回"只用排除法"，
         * 不让功能整个失效 ✗。
         */
        const conversation = document.querySelector("[data-conversation-content]");
        if (conversation !== null && (element === null || typeof element.closest !== "function"
          || element.closest("[data-conversation-content]") === null)) {
          return { ok: false, reason: "outside-conversation" };
        }
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return { ok: false, reason: "no-rect" };
        return { ok: true, text, x: rect.left + rect.width / 2, y: rect.top };
      } catch (error) {
        return { ok: false, reason: `throw:${error instanceof Error ? error.message : String(error)}`.slice(0, 60) };
      }
    };

    const onMouseUp = (event: MouseEvent): void => {
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
       * **这一次按下没有产生新的选区 ⇒ 不许把浮条弹回来** ✓。
       *
       * 用户实测 ✗：选中文字后点右侧栏的放大按钮（或任何按钮），浮条被这次 `mouseup` 又弹了出来。
       * 判据：按下到松开**没移动**（< 4px）且**选区文字没变** ⇒ 那只是一次点击，不是划词 ✓。
       * 按下点在浮条自己身上（`inside`）时同理：交给它自己的 click 处理，这里不收也不重弹 ✓。
       */
      const press = pressRef.current;
      pressRef.current = null;
      if (press !== null) {
        if (press.inside) {
          report("blocked-by-gate", { source: "press-inside-bar" });
          return;
        }
        const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4;
        const sameText = press.text === info.text;
        /*
         * 两种"不是在选新东西"的情况都不许把浮条弹回来：
         *  ① **没移动 + 选区没变** ⇒ 那只是一次点击（老规则 ✓）；
         *  ② **按下点落在已有选区里面 + 选区没变** ⇒ 用户只是在那段**已经选中的文字**上点了一下、
         *     或手抖蹭了几像素（>4px 就会绕过老规则 ✗）—— 用户实测的原话就是
         *     "我什么都没做，它怎么自己弹出来了"：残留选区还在，浮条被这次 `mouseup` 又叫了回来 ✗。
         *
         * 反过来：从选区**外面**起手重新划同一段文字（`sameText` 但 `!insideSelection`）仍然算新划词 ✓，
         * 所以"选一遍 → 点掉 → 再选同一段"这条路没有断 ✓。
         */
        if (sameText && (press.insideSelection || !moved)) {
          report("blocked-by-gate", { source: press.insideSelection ? "press-inside-selection" : "click-not-drag" });
          setBar(null);
          return;
        }
      }
      /*
       * **弹窗已开**：每选一块就追加一个标签 ✓（设计稿：继续划词自动追加 ✓）。
       * 不做门禁、不打宿主 —— 弹窗已经开着，目标在打开时就解析过 ✓。
       */
      if (collecting.current) {
        const text = info.text.trim();
        if (text === "") return;
        setChips((current) => appendChips(current, text));
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

    /**
     * 这个事件是不是发生在**浮条自己身上**？
     *
     * 用 `composedPath()` 而不是 `event.target.closest(...)`：宿主侧栏/面板有 Shadow DOM，
     * 事件穿透出来时 `target` 会被**重定向**成宿主元素 ⇒ 拿不到浮条 ⇒ 判断失效 ✓（实测点侧栏按钮收不掉浮条）。
     */
    const insideBar = (event: Event): boolean => {
      try {
        const path = typeof event.composedPath === "function" ? event.composedPath() : [];
        if (path.some((node) => node instanceof Element && node.classList.contains("kn-sel-bar"))) return true;
      } catch {
        // 忽略：退到下面的 closest 判断
      }
      const target = event.target as Element | null;
      return target !== null && typeof target.closest === "function" && target.closest(".kn-sel-bar") !== null;
    };

    /*
     * **点别处 ⇒ 浮条立即消失，而且不许再弹回来** ✓。
     *
     * 两条纪律（都是实测踩出来的）：
     * 1. 用**捕获阶段**的 `pointerdown`/`mousedown`：侧栏/面板可能在自己的（Shadow）树里
     *    `stopPropagation`，冒泡阶段根本收不到 ✗；而且 Shadow DOM 里 `event.target` 会被**重定向**
     *    成宿主元素，靠它判断"点没点在浮条上"不可靠 ✗ ⇒ 用 `composedPath()` 判断 ✓。
     * 2. 记下这一按的**起点与按下时的选区**：`mouseup` 才是显示浮条的地方，而"点别处"的事件序列是
     *    `按下（收浮条）→ 松开（又弹回来）` ✗ —— 用户实测：选中文字后点右侧栏的放大按钮，浮条又冒出来了。
     *    所以【没移动 + 选区文字没变】就不许再弹（那只是一次点击，不是划词）✓。
     */
    /**
     * 这个点（视口坐标）是否落在**当前选区**的包围盒里？
     *
     * 用来区分两种长得一样但意图相反的序列（见 `onMouseUp` 里那条判据）：
     * 在"已经选中的文字"上点一下（`true`）≠ 从选区外面起手重新划一段（`false`）✓。
     */
    const pointInsideSelection = (x: number, y: number): boolean => {
      try {
        const selection = window.getSelection();
        if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return false;
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      } catch {
        return false;
      }
    };

    const onPressCapture = (event: MouseEvent): void => {
      const inside = insideBar(event);      /* 用户开始新的交互 ⇒ 解除"切换后禁止弹出"（这是新的一次划词机会 ✓） */
      suppressBarRef.current = false;
      pressRef.current = {
        x: event.clientX,
        y: event.clientY,
        text: inside ? "" : normalizeSnippet(window.getSelection()?.toString() ?? "").trim(),
        inside,
        /* 按下那一刻光标是不是已经在**已有选区**里（两种序列的意图完全不同，见 `onMouseUp`）✓ */
        insideSelection: inside ? false : pointInsideSelection(event.clientX, event.clientY),
      };
      if (!inside) setBar(null);
    };
    document.addEventListener("pointerdown", onPressCapture, true);
    /* 某些环境（老浏览器/合成事件）不发 pointerdown ⇒ 再用 mousedown 兜一次（同一个处理器，幂等 ✓） */
    document.addEventListener("mousedown", onPressCapture, true);

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
      document.removeEventListener("pointerdown", onPressCapture, true);
      document.removeEventListener("mousedown", onPressCapture, true);
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

  /**
   * 把弹窗里的**标签**变成写入用的草稿队列。
   *
   * 合并成一层之后 `chips`（界面上看得见的标签）就是唯一事实来源 ✓ —— 不再有第二份草稿副本
   * （两份副本一旦不同步，就会出现"界面上改了名字、写进去的还是旧标题"✗）。
   * 标题为空时回落到 `defaultTitle(text)`，与 `postAdd` 的回落**同一套规则** ✓。
   *
   * @param list - 弹窗里当前的标签（每条标签本身就是它的标题）。
   * @returns 每条草稿：原文 + 标题。
   */
  const draftsOf = (list: readonly string[]): PrereqDraft[] =>
    list.map((text) => ({ text, title: text.trim() === "" ? defaultTitle(text) : text }));

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

  /**
   * 切回「创建独立节点」：把上一次的报错清掉 ✓。
   * 不主动清目标选择 —— 用户可能只是来回比较一下模式，切回来时选择还在更省事 ✓。
   */
  const chooseStandaloneMode = (): void => {
    setAsPrereq(false);
    setError(null);
    report("prereq-mode", { on: false, chips: chips.length });
  };

  /**
   * 勾选「添加为前置」时先把**当前库的节点表**读回来 ✓。
   *
   * 为什么在切换那一刻读而不是打开弹窗就读：没勾之前推荐区是折叠的，没必要为它多打一次宿主请求 ✓；
   * `libraryTitles` 为 `null` 期间一个推荐都不列（避免把别的库残留的 id 当成本库的推荐 ✗）。
   */
  const choosePrereqMode = (): void => {
    setAsPrereq(true);
    setError(null);
    setLibraryTitles(null);
    void loadLibraryNodes();
    report("prereq-mode", { on: true, chips: chips.length });
  };

  /**
   * 「添加为前置」：把这一批标签挂到**选中的目标**下 ✓。
   *
   * 与旧的"先选、再确认添加"是同一条纪律：没选目标就什么都不发（按钮此时也是置灰的 ✓）；
   * 点下去才真的写 `runQueue(target.id, draftsOf(chips), 0)` ✓。
   */
  const confirmPrereq = (): void => {
    const target = selectedTarget;
    if (target === null) return;
    report("confirm-prereq", { count: chips.length, target: target.id.slice(0, 8) });
    void runQueue(target.id, draftsOf(chips), 0);
  };

  /**
   * 「创建独立节点」：逐个建，**提示留在弹窗里**（先建、后关 ✗→✓：关闭后再报错就是"点了没反应" ✗）；
   * 只有**至少成功一个**才清空并关窗 ✓。`busyRef` 兜住连点，避免建出重复节点 ✗。
   */
  const createStandaloneAll = (): void => {
    if (busyRef.current) return;
    const list = [...chips];
    if (list.length === 0) return;
    busyRef.current = true;
    void (async () => {
      let ok = 0;
      try {
        for (const name of list) {
          if (await createStandalone(name)) ok += 1;
        }
      } finally {
        busyRef.current = false;
      }
      if (ok > 0) {
        notifyLibraryChanged();
        closeMulti();
      } else {
        setNote(`创建失败：0/${list.length} 个成功`);
      }
      report("standalone-create", `multi:${ok}/${list.length}`);
    })();
  };

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
              /* 打开弹窗：当前这段文字就是第一个标签 ✓（之后继续划词会往后追加 ✓） */
              setChips(appendChips([], text));
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
        * **收集知识点弹窗**（浮条点开后出现）：形态按设计稿 `knowledgenet-multiselect-design.html` ✓
        * —— 头部（可拖动）→ 「被添加的知识点」标签组 + 末尾新标签输入框 → 说明 → 底部计数与三个动作。
        * 之后每在对话里划一块文字，就自动追加一个标签 ✓（一个标签 = 一个节点）。
        */}
      {multiOpen ? createPortal(
        <div className="kn-sel-mask" role="presentation">
          <div
            className="kn-pick-dialog"
            role="dialog"
            aria-modal="true"
            /*
             * 标题已按用户要求去掉 ⇒ 不能再写 `aria-labelledby`（那个 id 已经不存在，
             * 悬空引用会让读屏念不出弹窗名字 ✗）。
             */
            aria-label={props.copy.multiLabel ?? "被添加的知识点"}
            style={multiPos === null ? undefined : { position: "fixed", left: multiPos.x, top: multiPos.y, margin: 0 }}
          >
            <div
              className="kn-pick-head"
              style={{ cursor: "move", userSelect: "none" }}
              onMouseDown={startDragMulti}
              title="按住拖动可以把它挪开，方便继续在对话里选文字"
            >
              {/*
                * 用户要求去掉「收集知识点」这个标题 ✓。
                * 但**拖拽把手必须留着**：弹窗压住正文时就靠拖开它继续划词 ✓ ——
                * 所以这里保留一条极简的拖动提示条（`.kn-ms-drag`），而不是留一片空白。
                */}
              <div className="kn-ms-drag" aria-hidden="true">⠿ ⠿ ⠿</div>
            </div>

            <div className="kn-pick-content">
              <div className="kn-ms-label-row">
                <span className="kn-pick-label">{props.copy.multiLabel ?? "被添加的知识点"}</span>
                {/* 右侧那行「点击标签可修改名称」用户要求删掉 ✓（标签本身看得出能改，不必写一行说明） */}
              </div>

              <div className="kn-ms-composer">
                {chips.map((name, index) => (
                  /*
                   * key 只用 index：**别把内容拼进 key** —— 内容一变 key 就变，React 会重挂输入框，
                   * 打字打到一半就丢焦点 ✗（输入框是受控的，按 index 复用 DOM 是正确的 ✓）。
                   */
                  <span className="kn-ms-chip" key={index}>
                    <input
                      value={name}
                      aria-label={`第 ${index + 1} 个知识点名称`}
                      /* 宽度跟着内容走（设计稿的做法 ✓），长标题最多 300px */
                      style={{ width: Math.min(300, Math.max(24, name.length * 14 + 8)) }}
                      onChange={(event) => {
                        const value = event.target.value;
                        setChips((current) => current.map((item, i) => (i === index ? value : item)));
                      }}
                    />
                    <button
                      type="button"
                      className="kn-ms-remove"
                      aria-label={`移除 ${name}`}
                      /* 按下别动选区/焦点，免得删一个标签就把对话里的选区弄没 ✓ */
                      onMouseDown={(event) => { event.preventDefault(); }}
                      onClick={() => { setChips((current) => current.filter((_, i) => i !== index)); }}
                    >
                      ×
                    </button>
                  </span>
                ))}
                {/*
                  * **不再提供"手动新增标签"的那个输入框** ✓（用户要求 2026-09）。
                  *
                  * 知识点必须来自**对话里的划词**：这样"界面上看到的标签"与"用户真的选过的原文"
                  * 一一对应，不会出现手打的标题和出处对不上（`text` 才是出处，`title` 只是名字）。
                  * 标签本身仍然可以就地改名 ✓（见上面的 chip 输入框）—— 用户要求保留这一条。
                  */}
                {chips.length === 0 ? (
                  <span className="kn-ms-placeholder">在对话中划词，选中的文字会出现在这里</span>
                ) : null}
              </div>

              {/*
                * 说明行按用户要求**从头部挪到这里**（标签框下面），文案也简化成一句 ✓。
                * 位置在框外：不再暗示"可以在这里输入"，只说明划词会自动追加 ✓。
                */}
              <div className="kn-ms-details">
                {props.copy.multiDetails ?? "继续在对话中划词会自动追加"}
              </div>

              {/*
                * 「是否添加为前置」开关（用户要求 2026-09：**两层弹窗合并成一层** ✓）。
                *
                * 用**整行 label + 单选按钮**，不是 checkbox：这两个选项是互斥的两种结果
                * （建独立节点 ↔ 加为前置），radio 的语义比"勾选/不勾选"更准 ✓；
                * 而且原生 radio 自动带方向键与 Space 操作，键盘可达性不用自己补 ✓。
                */}
              <div className="kn-ms-mode" role="radiogroup" aria-label={props.copy.multiAsPrereq ?? "是否添加为前置"}>
                <label className="kn-ms-radio">
                  <input
                    type="radio"
                    name="kn-ms-mode"
                    checked={!asPrereq}
                    onChange={chooseStandaloneMode}
                  />
                  <span>{props.copy.addStandalone ?? "创建独立节点"}</span>
                </label>
                <label className="kn-ms-radio">
                  <input
                    type="radio"
                    name="kn-ms-mode"
                    checked={asPrereq}
                    onChange={choosePrereqMode}
                  />
                  <span>{props.copy.multiAsPrereq ?? "添加为另一个知识点的前置"}</span>
                </label>
              </div>
              {note === null ? null : <div className="kn-ms-note" style={{ opacity: 1 }}>{note}</div>}

              {/*
                * 选中「添加为前置」后才展开（未选中时这一整块不渲染 ⇒ 收起来 ✓）。
                * 里面的形态与交互沿用设计稿 `knowledgenet-picker-design.html` 那一套：
                * 搜索框（带放大镜）→ 推荐/搜索结果 → 可选中行 ✓。
                */}
              {asPrereq ? (
                <div className="kn-pick-target">
                  <div className="kn-pick-section">{props.copy.targetSection ?? "添加为谁的前置"}</div>

                  {/*
                   * 搜索框上方原本还有一行「搜索知识点」文字，用户要求删掉 ✓。
                   * 去掉可见文字后**可访问性不能跟着掉**：占位符 + `aria-label` 承担搜索框的名字 ✓
                   * （`<label htmlFor>` 也随之撤掉 —— 没有可见文字就不必再占一行）。
                   */}
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
                      border: "1px solid var(--dsw-alias-border-l2)",
                      borderRadius: 7,
                      background: "var(--dsw-alias-bg-layer-1)",
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
                      style={{ flex: "none", width: 16, height: 16, color: "var(--dsw-alias-label-secondary)" }}
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
                      /* 可见标签删掉后，名字改由 aria-label 给（读屏仍能念出"搜索知识点"）✓ */
                      aria-label={props.copy.searchLabel ?? props.copy.searchHint}
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
              ) : null}
            </div>

            <div className="kn-pick-foot">
              <div className="kn-pick-status">
                {/*
                  * 底部状态行两用（设计稿）：
                  * 建独立节点时说明"有几个知识点"；勾了前置时就说明"挂到哪个节点下" ✓
                  * —— 合并成一层之后只剩这一条状态行，信息必须随模式切换 ✓。
                  */}
                {asPrereq
                  ? (selectedTarget === null
                    ? (props.copy.statusPick ?? "请选择要添加到的知识点")
                    : (props.copy.statusSelected?.(selectedTarget.title) ?? `添加为「${selectedTarget.title}」的前置`))
                  : (props.copy.multiCount ? props.copy.multiCount(chips.length) : `${chips.length} 个知识点`)}
              </div>
              <div className="kn-pick-actions">
                <button
                  type="button"
                  className="kn-pick-btn"
                  onClick={() => { closeMulti(); report("multi-cancel", null); }}
                >
                  {props.copy.cancel}
                </button>
                <button
                  type="button"
                  className="kn-pick-btn is-primary"
                  /*
                   * **合并后的唯一动作按钮**（用户要求 2026-09）：
                   * 没勾「添加为前置」⇒「创建独立节点」；勾了 ⇒「添加为前置」，
                   * 且只有**选了目标**才可点 ✓（避免误点就把前置挂到别的节点上 ✗）。
                   *
                   * 置灰理由写在 title 里：空标签 / 空库 / 还没选目标，三种情况用户都该知道为什么点不动 ✓。
                   */
                  disabled={chips.length === 0 || (asPrereq && selectedTarget === null)}
                  title={
                    chips.length === 0 ? "先添加至少一个知识点"
                      : asPrereq && libraryTitles !== null && Object.keys(libraryTitles).length === 0
                        ? "这个知识库还没有任何节点：请先创建独立节点"
                        : undefined
                  }
                  onClick={() => {
                    /*
                     * 点按钮才真的写（纪律不变 ✓）：
                     * - 勾了「添加为前置」⇒ 走 `confirmPrereq()`（选中目标 + 这一批标签，每条用自己的标题 ✓）；
                     * - 没勾 ⇒ 走 `createStandaloneAll()`（逐个建独立节点，提示留在弹窗里 ✓）。
                     */
                    if (asPrereq) confirmPrereq();
                    else createStandaloneAll();
                  }}
                >
                  {asPrereq ? (props.copy.addPrereq ?? "添加为前置…") : (props.copy.addStandalone ?? "创建独立节点")}
                </button>
              </div>
            </div>

            {/*
              * 写入失败的提示留在**这个弹窗里**（不能只在底部状态行里闪一下）：
              * 合并成一层之后弹窗不会再被别的层顶掉，所以这条错误看得见、也等得到用户处理 ✓。
              */}
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
