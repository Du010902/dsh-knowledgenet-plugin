/**
 * 「新建节点配额」——把"模型一次建一堆节点"这件事**用代码**挡住（轻量模块，便于单测）。
 *
 * 为什么单独拆出来：`tools.ts` 会连带导入 `library.ts` → `node-vfs.ts`，而后者用了
 * TypeScript 参数属性（Node 的类型剥离模式不支持），单测一导入就报
 * `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。配额是本层策略，与库访问无关，拆开正好。
 *
 * 语义：同一会话在 `CREATION_WINDOW_MS` 窗口内最多新建 `CREATION_QUOTA` 个节点；
 * 超出则拒绝，并要求模型改用 `kn_propose_prerequisites` 提案、由用户在面板落地。
 */

/** 同一会话在**一轮**里最多新建多少个节点（超了拒绝，让模型改用提案） */
export const CREATION_QUOTA = 3;
/** 兜底窗口：即使"轮"的边界没被识别到，也不会在短时间里无限新建 */
export const CREATION_WINDOW_MS = 10 * 60 * 1000;

/** 会话 → 最近新建节点的时间戳 */
const creationLog = new Map<string, number[]>();
/** 测试可调的上限（默认走 CREATION_QUOTA） */
let quotaOverride: number | null = null;

/**
 * 新一轮开始：清掉该会话的配额（由逐轮注入在每轮开头调用）。
 *
 * 为什么按轮而不是按时间窗：时间窗会误伤"用户明确同意了的连续创建"，
 * 而"一轮"恰好就是模型自主行动的最小单位——正是要挡的范围。
 *
 * @param sessionId - 会话 id；不传则清空全部。
 */
export function resetCreationQuotaForTurn(sessionId?: string | null): void {
  if (sessionId === undefined || sessionId === null) {
    creationLog.clear();
    return;
  }
  creationLog.delete(sessionId);
}

/** 仅测试用：临时改上限（null 恢复默认） */
export function __setCreationQuotaForTest(limit: number | null): void {
  quotaOverride = limit;
}

/**
 * 取一次新建配额。
 * @param sessionId - 会话 id（null 归入匿名桶）。
 * @param now - 当前时间（可注入，便于测试）。
 * @returns 是否放行 + 本轮已用量。
 */
export function takeCreationQuota(sessionId: string | null, now: number = Date.now()): { ok: boolean; used: number } {
  const limit = quotaOverride ?? CREATION_QUOTA;
  const key = sessionId ?? "(anonymous)";
  const recent = (creationLog.get(key) ?? []).filter((at) => now - at < CREATION_WINDOW_MS);
  if (recent.length >= limit) {
    creationLog.set(key, recent);
    return { ok: false, used: recent.length };
  }
  recent.push(now);
  creationLog.set(key, recent);
  return { ok: true, used: recent.length };
}

/** 仅测试用：清空记录 */
export function __resetCreationQuotaForTest(): void {
  creationLog.clear();
  quotaOverride = null;
}
