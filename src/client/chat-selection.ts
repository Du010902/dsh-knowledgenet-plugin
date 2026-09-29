/**
 * 「在对话里划词 → 添加前置」的纯逻辑（可单测）。
 *
 * 视图只负责交互，这里负责所有"算"的事：
 * - 片段归一化与去重（同一句话被划两次不该变成两条）；
 * - 默认标题（从原文里取一小段，用户可以改）；
 * - **目标节点推荐**：结合"最近聚焦过的节点"与"最近被添加过前置的节点"，
 *   按优先级去重后给 2–3 个；没有合适的就让用户搜索。
 */

/** 一个划词片段 */
export interface Snippet {
  /** 归一化后的原文（写进关系 evidence） */
  text: string;
  /** 来自哪条消息（可选，来源记录用） */
  messageId?: string | null;
}

/** 最多攒几个片段 */
export const MAX_SNIPPETS = 8;
/** 单段原文写入 evidence 的上限（宿主侧也会再截一次） */
export const MAX_SNIPPET_CHARS = 600;
/** 默认标题取多少个字 */
export const TITLE_CHARS = 24;

/**
 * 归一化：折叠空白、去掉行首列表符号、截断长度。
 * @param raw - 原始选区文本。
 * @returns 归一化后的文本（可能为空串）。
 */
export function normalizeSnippet(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  const collapsed = raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*+>]|\d+[.)])\s*/, "").trim())
    .filter((line) => line !== "")
    .join(" ")
    .replace(/\s+/g, " ")   // 空格/制表/换行折叠成一个空格（只折叠 2 个以上会漏掉单个制表符）
    .trim();
  return collapsed.slice(0, MAX_SNIPPET_CHARS);
}

/**
 * 追加一个片段（按归一化文本去重，超出上限丢弃）。
 * @param list - 已有片段。
 * @param raw - 新选区原文。
 * @param messageId - 来源消息 id（可选）。
 * @returns 新数组（不修改入参）。
 */
export function appendSnippet(
  list: readonly Snippet[],
  raw: string | null | undefined,
  messageId?: string | null,
): Snippet[] {
  const text = normalizeSnippet(raw);
  if (text === "") return [...list];
  if (list.some((item) => item.text === text)) return [...list];
  if (list.length >= MAX_SNIPPETS) return [...list];
  const next: Snippet = { text };
  if (messageId !== undefined && messageId !== null && messageId !== "") next.messageId = messageId;
  return [...list, next];
}

/**
 * 把若干片段合成一段（写进 evidence 时用空行分隔）。
 * @param list - 片段列表。
 * @returns 合并后的文本。
 */
export function joinSnippets(list: readonly Snippet[]): string {
  return list.map((item) => item.text).filter((text) => text !== "").join("\n\n").slice(0, MAX_SNIPPET_CHARS * 2);
}

/**
 * 默认标题：取原文开头的若干字，遇到句读就停。
 * @param snippet - 归一化后的原文。
 * @returns 建议标题。
 */
export function defaultTitle(snippet: string): string {
  const text = normalizeSnippet(snippet);
  if (text === "") return "";
  const cut = text.search(/[。！？!?；;：:，,、]/);
  const head = cut > 0 && cut <= TITLE_CHARS ? text.slice(0, cut) : text.slice(0, TITLE_CHARS);
  return head.trim();
}

/** 一条待落地的「前置」：原文（进 evidence）+ 节点标题（可以被用户改） */
export interface PrereqDraft {
  /** 归一化后的原文（写进关系的 evidence.snippet） */
  text: string;
  /** 要新建 / 复用的节点标题 */
  title: string;
}

/**
 * 把「弹窗里的每一行」变成各自的草稿（一行为一个节点）。
 *
 * 为什么必须分开算标题（真实 bug ✗）：界面上只有**一个**标题输入框，
 * 多行时如果所有行都用它，点「添加为前置」就会拿同一个标题发 N 次请求 ——
 * 第 1 次建点，后面 N-1 次精确命中同一个节点、又被关系去重吃掉
 * （`addEdge` 对同 (from,to,type) 直接返回已有边）⇒ **除了第一行，其余全丢，还没有任何提示** ✗。
 *
 * 规则：**单行**才用用户改过的标题（空则回落到默认标题）；**多行**每行各用自己的默认标题。
 *
 * @param lines - 弹窗文本切出来的行（未归一化，内部会归一化 + 去重 + 截断）。
 * @param editedTitle - 用户在标题框里改过的标题（只在单行时有意义）。
 * @returns 草稿列表（顺序与首次出现顺序一致）。
 */
export function draftPrereqs(lines: readonly string[], editedTitle?: string | null): PrereqDraft[] {
  let list: Snippet[] = [];
  for (const line of lines) list = appendSnippet(list, line);
  const edited = normalizeSnippet(editedTitle ?? "");
  const single = list.length === 1;
  return list.map((item) => ({
    text: item.text,
    title: single && edited !== "" ? edited : defaultTitle(item.text),
  }));
}

/** 推荐用的记忆（都是节点 id） */
export interface TargetMemory {
  /** 最近聚焦/聊到的节点，越靠前越新 */
  recentFocus?: readonly string[];
  /** 最近被添加过前置的节点（A → B 里的 A） */
  recentPrereqTargets?: readonly string[];
  /** 当前学习/聚焦节点 */
  current?: string | null;
}

/**
 * 推荐目标节点：当前节点 → 最近被加过前置的 → 最近聚焦的，去重后取前 n 个。
 *
 * 为什么这个顺序：用户此刻多半是在给"正在学的那个点"补前置；其次是他刚补过的那个点
 * （连续补几条很常见）；最后才是更早看过、可能相关的点。
 *
 * @param memory - 记忆（全部是节点 id）。
 * @param limit - 推荐个数（默认 3）。
 * @returns 去重后的 id 列表。
 */
export function recommendTargets(memory: TargetMemory, limit = 3): string[] {
  const out: string[] = [];
  const push = (id: unknown): void => {
    if (typeof id !== "string") return;
    const value = id.trim();
    if (value === "" || out.includes(value) || out.length >= limit) return;
    out.push(value);
  };
  push(memory.current);
  for (const id of memory.recentPrereqTargets ?? []) push(id);
  for (const id of memory.recentFocus ?? []) push(id);
  return out;
}

/**
 * 从推荐里**只留下当前库确实存在**的节点，并截断到 `limit` 个。
 *
 * 为什么必须做这一步（用户实测 ✗）：记忆（MRU）是**跨库共用**的（一个 localStorage 键），
 * 标题缓存（`knowledgenet.nodeTitles` / 面板发布的"最近一次标题表"）同样是跨库的**最后值** ✗
 * ⇒ 换一个知识库之后，"推荐"里会冒出**别的库**的节点，而且显示的还是别的库的标题
 * （看起来完全像本库的节点 ✗），点下去宿主只会答"找不到节点"。
 *
 * 所以规矩是：**确认存在才显示**；`known === null`（还不知道当前库有哪些节点）时
 * **一个都不显示** —— 宁可少显示，也不误显示 ✓。
 *
 * @param candidates - 记忆给出的候选 id（已按优先级排好）。
 * @param known - 当前库的 id→标题 表；`null` = 还不知道。
 * @param limit - 最多显示几个。
 * @returns 过滤后的 id 列表。
 */
export function keepKnownTargets(
  candidates: readonly string[],
  known: Record<string, string> | null | undefined,
  limit = 3,
): string[] {
  if (known === null || known === undefined) return [];
  const out: string[] = [];
  for (const id of candidates) {
    if (out.length >= limit) break;
    if (typeof id === "string" && Object.prototype.hasOwnProperty.call(known, id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** 记忆的存储键 */
export const MRU_KEY = "knowledgenet.targetMemory";
/** 每类记忆最多保留多少条 */
export const MRU_LIMIT = 12;

/** 记忆的存储形状 */
export interface StoredMemory {
  recentFocus: string[];
  recentPrereqTargets: string[];
}

/**
 * 往 MRU 里推进一个 id（去重 + 头插 + 截断）。
 * @param list - 原列表。
 * @param id - 新 id。
 * @returns 新列表。
 */
export function rememberId(list: readonly string[], id: string | null | undefined): string[] {
  if (typeof id !== "string" || id.trim() === "") return [...list];
  const value = id.trim();
  return [value, ...list.filter((item) => item !== value)].slice(0, MRU_LIMIT);
}

/** 当前会话 id 的存储键：root 作用域的组件拿不到 `sessionId`，靠 session 作用域的组件写、这里读 */
export const SESSION_KEY = "knowledgenet.lastSessionId";

/** 可注入的存储面（测试用） */
export interface SessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * 记下"当前会话 id"（由 session 作用域的组件调用：面板 / 入口卡片都拿得到 `sessionId`）。
 * @param id - 会话 id。
 * @param storage - 存储面（默认 localStorage）。
 */
export function rememberSessionId(id: string | null | undefined, storage?: SessionStorage | null): void {
  if (typeof id !== "string" || id.trim() === "") return;
  try {
    const target = storage === undefined ? (typeof localStorage === "undefined" ? null : localStorage) : storage;
    target?.setItem(SESSION_KEY, id.trim());
  } catch {
    // 存不下就算了
  }
}

/**
 * 读回"当前会话 id"。
 * @param storage - 存储面（默认 localStorage）。
 * @returns 会话 id；没有则 null。
 */
export function readLastSessionId(storage?: SessionStorage | null): string | null {
  try {
    const target = storage === undefined ? (typeof localStorage === "undefined" ? null : localStorage) : storage;
    const value = target?.getItem(SESSION_KEY);
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  } catch {
    return null;
  }
}
