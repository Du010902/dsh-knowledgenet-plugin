/**
 * 学习栈：从**会话事件流**折叠出「当前学到哪个知识点」。
 *
 * 为什么这么做（而不是维护一个内存变量，也不是注册 session projection）：
 * - 内存变量在 resume / fork / 进程重启后就没了；
 * - session projection 需要 `stateSchema: ZodType`，而本插件解析不到 zod，
 *   为一个「当前节点」把 zod 内联进产物是坏交易；
 * - 而 `agent.session.snapshotEvents()` 是宿主现成的 API：事件流本身就是唯一真相，
 *   折叠出来的栈天然持久、可回放、fork/resume 安全。
 *
 * 折叠规则只认本插件的两个动词：
 * - `kn_enter_node` 把目标压到栈顶（已在栈里则先移除再压，等价于「切到它」）；
 * - `kn_back` 弹栈。
 */
export interface SessionEventLike {
  type?: string;
  data?: { name?: string; arguments?: string };
}

const ENTER_TOOL = "kn_enter_node";
const BACK_TOOL = "kn_back";

function idFromArguments(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const id = (parsed as { id?: unknown }).id;
    return typeof id === "string" && id.trim() !== "" ? id.trim() : null;
  } catch {
    return null;
  }
}

/** 从事件列表折叠出学习栈（栈底在前，栈顶在最后） */
export function foldStack(events: readonly SessionEventLike[]): string[] {
  /*
   * 折叠结果缓存：会话事件是"只追加"的，所以「长度 + 最后一个事件引用」不变 ⇒ 结果不变。
   * 每轮注入都会调它，长会话上反复折叠整段日志是纯浪费（审查指出的本地开销）。
   */
  const last = events.length > 0 ? events[events.length - 1] : null;
  if (foldCache !== null && foldCache.length === events.length && foldCache.last === last) {
    return foldCache.result;
  }
  const stack: string[] = [];
  for (const event of events) {
    if (event === null || typeof event !== "object") continue;
    if (event.type !== "tool/call") continue;
    const name = event.data?.name;
    if (name === ENTER_TOOL) {
      const id = idFromArguments(event.data?.arguments);
      if (id === null) continue;
      const at = stack.indexOf(id);
      if (at >= 0) stack.splice(at, 1);
      stack.push(id);
    } else if (name === BACK_TOOL) {
      stack.pop();
    }
  }
  foldCache = { length: events.length, last, result: stack };
  return stack;
}

/** foldStack 的记忆（长度 + 末事件引用 + 结果）：会话日志只追加，所以这样判等是安全的 */
let foldCache: { length: number; last: unknown; result: string[] } | null = null;

/** 仅测试用：清掉折叠缓存 */
export function __resetFoldCacheForTest(): void {
  foldCache = null;
}

/** 取会话的完整自有事件；拿不到（非 Agent 调用、宿主版本差异）时返回空数组 */
export function eventsOf(session: unknown): readonly SessionEventLike[] {
  const snapshotEvents = (session as { snapshotEvents?: () => readonly SessionEventLike[] } | undefined)
    ?.snapshotEvents;
  if (typeof snapshotEvents !== "function") return [];
  try {
    const events = snapshotEvents.call(session);
    return Array.isArray(events) ? events : [];
  } catch {
    return [];
  }
}

/** 会话当前的学习栈 */
export function stackOf(session: unknown): string[] {
  return foldStack(eventsOf(session));
}

/** 会话当前的知识点 id（栈顶）；空栈返回 null */
export function currentIdOf(session: unknown): string | null {
  const stack = stackOf(session);
  return stack.length > 0 ? stack[stack.length - 1] : null;
}

/** `kn_enter_node` 之后的新栈（当前这次调用还没落盘，所以要自己算一遍） */
export function stackAfterEnter(session: unknown, id: string): string[] {
  const stack = [...stackOf(session)];
  const at = stack.indexOf(id);
  if (at >= 0) stack.splice(at, 1);
  stack.push(id);
  return stack;
}

/** `kn_back` 之后的新栈 */
export function stackAfterBack(session: unknown): { previous: string | null; stack: string[] } {
  const stack = [...stackOf(session)];
  const previous = stack.length > 0 ? stack.pop() ?? null : null;
  return { previous, stack };
}
