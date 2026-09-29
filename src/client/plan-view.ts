/**
 * 面板「提案审阅」用的**纯逻辑**（可单测）。
 *
 * 这一层决定了"用户看到什么、默认勾选什么"——正是可控性的落点：
 * - 未落地的提案要显眼地摆出来；
 * - **默认不会全选**：一份 30 条的提案默认只勾前 `APPLY_DEFAULT_LIMIT` 条，避免"点一下又建一堆"；
 * - 已落地且确实新建过节点的提案，才提供「撤销」。
 */

/** 路由返回的提案摘要（与 host `list-plans` 的形状一致） */
export interface PlanSummary {
  id: string;
  createdAt: number;
  summary: string;
  itemCount: number;
  applied: boolean;
  createdCount: number;
  items: Array<{ id: string; fromId: string; title: string; reuse: boolean }>;
}

/** 落地结果（与 host `apply-plan` 的形状一致） */
export interface ApplyOutcome {
  created?: Array<{ title?: string }>;
  reused?: Array<{ title?: string }>;
  failed?: Array<{ message?: string }>;
}

/** 默认勾选上限：再多也默认只勾这么多（用户仍可手动全选） */
export const APPLY_DEFAULT_LIMIT = 10;

/**
 * 待审阅的提案（未落地）。
 * @param plans - 提案列表。
 * @returns 未落地的那些。
 */
export function pendingPlans(plans: readonly PlanSummary[]): PlanSummary[] {
  return plans.filter((plan) => plan.applied !== true && plan.itemCount > 0);
}

/**
 * 可撤销的提案（已落地且确实新建过节点；纯复用的没有东西可撤）。
 * @param plans - 提案列表。
 * @returns 可撤销的那些。
 */
export function undoablePlans(plans: readonly PlanSummary[]): PlanSummary[] {
  return plans.filter((plan) => plan.applied === true && plan.createdCount > 0);
}

/**
 * 一份提案的**默认勾选**：前 `APPLY_DEFAULT_LIMIT` 条。
 * @param plan - 提案。
 * @returns 默认勾选的条目 id。
 */
export function defaultSelection(plan: PlanSummary): string[] {
  return plan.items.slice(0, APPLY_DEFAULT_LIMIT).map((item) => item.id);
}

/**
 * 合并"用户已有勾选"与"新拉到的提案列表"。
 *
 * **刷新不能丢掉用户已做的选择**：面板只要数据一刷新就会重新拉提案，如果每次都重置成默认
 * 前 N 条，用户勾了第 11 条也会被下一拍抹掉，表现就是"点了选不上"（实测反馈）。
 * 规则：见过的提案沿用原勾选；第一次见到的才套默认。
 *
 * @param prev - 之前的选择（planId → 勾选条目 id）。
 * @param plans - 新拉到的提案列表。
 * @returns 合并后的选择。
 */
export function mergeSelection(
  prev: Readonly<Record<string, readonly string[]>>,
  plans: readonly PlanSummary[],
): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  for (const plan of plans) {
    const kept = prev[plan.id];
    next[plan.id] = Array.isArray(kept) ? [...kept] : defaultSelection(plan);
  }
  return next;
}

/**
 * 勾选情况的说明文字（给按钮用）。
 * @param selected - 已勾选数量。
 * @param total - 总条数。
 * @returns 例如 `创建选中的 3 条`；一条没勾时返回空串（调用方据此禁用按钮）。
 */
export function selectionLabel(selected: number, total: number): string {
  if (selected <= 0) return "";
  return selected >= total ? `创建全部 ${total} 条` : `创建选中的 ${selected} 条`;
}

/**
 * 落地结果的中文描述。
 * @param outcome - 路由返回的落地结果。
 * @returns 例如 `新建 2 个 · 复用 1 个`；有失败则追加 `· 失败 1 条`。
 */
export function describeApply(outcome: ApplyOutcome): string {
  const created = outcome.created?.length ?? 0;
  const reused = outcome.reused?.length ?? 0;
  const failed = outcome.failed?.length ?? 0;
  const parts: string[] = [];
  if (created > 0) parts.push(`新建 ${created} 个`);
  if (reused > 0) parts.push(`复用 ${reused} 个`);
  if (parts.length === 0 && failed === 0) parts.push("没有变化");
  if (failed > 0) parts.push(`失败 ${failed} 条`);
  return parts.join(" · ");
}

/**
 * 提案的时间显示（本地时间，分钟精度）。
 * @param at - 毫秒时间戳。
 * @returns 例如 `2025-01-02 03:04`。
 */
export function formatPlanTime(at: number): string {
  try {
    const date = new Date(at);
    const pad = (value: number): string => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  } catch {
    return "";
  }
}
