/**
 * 「当前会话上下文」的**发布/读取**（按会话 id 归档，纯逻辑，可单测）。
 *
 * 为什么需要它：本插件两个组件拿到的信息不对等——
 *
 * - **面板**（`sidebar.right.pane.tab`，**session 作用域**）：宿主给它 `sessionId` + `useWorkspaces`，
 *   它按会话 cwd 取数成功（实测：`source:"context"` 时 pathTail 就是知识库目录 ✓）；
 * - **划词浮条**（`sidebar.footer.action`，**root 作用域**）：拿不到 `sessionId`，切工作区后 props
 *   也可能不刷新；但它能从宿主的对话容器读到**当前聊天会话 id**
 *   （`data-conversation-session`，见 `ui-conversation/src/ConversationContent.tsx:193`）✓。
 *
 * 于是：**面板按自己的会话 id 发布**，**浮条按 DOM 读到的会话 id 精确取**。
 * 好处是"陈旧值不会串会话"——查不到当前会话就保守不显示（宁可少显示，也不误显示）。
 */

/** 当前上下文快照 */
export interface CurrentContext {
  /** 发布它的会话 id（空串表示"不知道会话"的匿名发布） */
  sessionId: string;
  /** 该会话的工作区路径 */
  workspacePath: string;
  /** 面板已解析出的**库根**（`<库>/.dsh_knowledge` 的绝对路径）；没库时为空串 ✓。
   *  浮条拿它当写入目标，就不必自己猜工作区路径（实测那条链在某些会话里会拿不到 ✗）*/
  libraryRoot: string;
  /** 该工作区是不是知识库（登记过 ∧ 目录本身是库） */
  library: boolean;
  /** 节点 id → 标题（面板顺手发布，供浮条的"推荐"显示真名而不是 id） */
  titles: Record<string, string>;
  /** 发布时间（毫秒） */
  at: number;
}

/** 会话 id → 上下文（按会话归档，避免 A 会话的判断被 B 会话读到） */
const bySession = new Map<string, CurrentContext>();
/** 匿名发布（拿不到 sessionId 时）；只在按 id 查不到时兜底 */
let anonymous: CurrentContext | null = null;
/**
 * **最近一次发布的 id→标题表**（跨会话保留）。
 *
 * 标题是"库级"信息、与哪个会话无关；而发布方的会话 id 未必等于浮条读到的聊天会话 id
 * （实测：按会话精确取会落空，推荐项就只剩 id 前 8 位、看着像乱码）。所以标题单独留一份最近值。
 */
let lastTitles: Record<string, string> = {};
/**
 * **最近一次发布的工作区路径**（跨会话保留）。
 *
 * 同样是为了"不依赖会话 id 对得上"：实测客户端拿到的会话 id 交给宿主路由取数会失败
 * （`?sessionId=…` 一律答"找不到库"），而**面板用工作区路径取数是成功的**。
 * 所以浮条补标题/兜底判定时用这份路径（`?root=<path>`）。
 */
let lastWorkspacePath = "";

/**
 * 读最近一次发布的工作区路径。
 * @returns 路径；没有则空串。
 */
export function readLastWorkspacePath(): string {
  return lastWorkspacePath;
}

/**
 * 按节点 id 取标题（供推荐项显示真名）。
 * @param id - 节点 id。
 * @returns 标题；没有则 null。
 */
export function readNodeTitle(id: string | null | undefined): string | null {
  if (typeof id !== "string" || id === "") return null;
  const hit = lastTitles[id];
  return typeof hit === "string" && hit !== "" ? hit : null;
}

/**
 * 发布（由 session 作用域的面板调用；每次渲染刷新）。
 * @param next - 会话/工作区/是否知识库。
 * @param now - 时间戳（可注入，便于测试）。
 */
export function publishCurrentContext(
  next: {
    sessionId?: string | null;
    workspacePath?: string | null;
    libraryRoot?: string | null;
    library: boolean;
    /** 节点 id → 标题（推荐项要显示真名） */
    titles?: Record<string, string> | null;
  },
  now: number = Date.now(),
): void {
  const context: CurrentContext = {
    sessionId: typeof next.sessionId === "string" ? next.sessionId : "",
    workspacePath: typeof next.workspacePath === "string" ? next.workspacePath : "",
    libraryRoot: typeof next.libraryRoot === "string" ? next.libraryRoot : "",
    library: next.library === true,
    titles: next.titles ?? {},
    at: now,
  };
  if (context.workspacePath !== "") lastWorkspacePath = context.workspacePath;
  if (context.sessionId === "") {
    anonymous = context;
    if (Object.keys(context.titles).length > 0) lastTitles = context.titles;
    return;
  }
  bySession.set(context.sessionId, context);
  if (Object.keys(context.titles).length > 0) lastTitles = context.titles;
}

/**
 * 读取某个会话的上下文。
 * @param sessionId - 会话 id；空/未给时读匿名发布。
 * @param now - 当前时间（用于陈旧判断）。
 * @param maxAgeMs - 超过这个时长视为陈旧；0/负数表示不判陈旧。
 * @returns 上下文；没有或已陈旧时 null。
 */
export function readCurrentContext(
  sessionId?: string | null,
  now: number = Date.now(),
  maxAgeMs = 0,
): CurrentContext | null {
  const key = typeof sessionId === "string" ? sessionId.trim() : "";
  const hit = key === "" ? anonymous : (bySession.get(key) ?? null);
  if (hit === null) return null;
  if (maxAgeMs > 0 && now - hit.at > maxAgeMs) return null;
  return hit;
}

/**
 * 清掉某个会话的发布（面板卸载时调用）。
 * @param sessionId - 会话 id；不传则清空全部（含匿名）。
 */
export function clearCurrentContext(sessionId?: string | null): void {
  const key = typeof sessionId === "string" ? sessionId.trim() : "";
  if (key === "") {
    bySession.clear();
    anonymous = null;
    return;
  }
  bySession.delete(key);
}

/** 仅测试用：当前归档了多少个会话 */
export function __publishedSessionCountForTest(): number {
  return bySession.size;
}

/** 仅测试用：直接重置 */
export function __resetCurrentContextForTest(): void {
  bySession.clear();
  anonymous = null;
}
/**
 * **"库内容变了"的跨组件通知** ✓。
 *
 * 为什么需要：划词浮条挂在 root 作用域、图谱面板是另一个组件 ✓ —— 浮条建完节点后，
 * 面板不知道要重新取数，更不会重新取景 ⇒ 用户看到的是"节点建了但视图里没有" ✗。
 * 用 window 事件做通道（与右键菜单同一套做法 ✓），面板收到就刷新 + 重新布局 + 重新取景 ✓。
 */
export const LIBRARY_CHANGED_EVENT = "knowledgenet:library-changed";

/** 广播"库内容变了"（浮条/菜单在改动成功后调用 ✓）。 */
export function notifyLibraryChanged(): void {
  try {
    window.dispatchEvent(new CustomEvent(LIBRARY_CHANGED_EVENT));
  } catch {
    // 非浏览器环境忽略
  }
}