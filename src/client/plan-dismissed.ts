/**
 * 用户按「取消这提案」丢掉的提案 —— **持久**记录（localStorage，一个浏览器档案一份）。
 *
 * 为什么需要它（用户要求 2026-10-10）：提案弹窗只有两个出口 —— **添加节点** 或 **取消这提案**；
 * 取消就是不要它了，所以它**必须立刻消失、并且永不再弹** ✓（刷新页面 / 重启 DSH 也不行 ✗）。
 *
 * 为什么要记 `root`：正常路径下取消是**让宿主删掉计划文件**（`discard-plan` ✓），
 * 但宿主半是**启动时加载**的 —— 刚更新完还没重启时那条路还不存在 ⇒ 这次取消只能先在本地记住 ✓，
 * 下次拉提案列表时再**补删**一次（见 PlanReview 的 `retryDiscarded` ✓）⇒ 磁盘最终也会干净 ✓。
 *
 * 存不下（私密模式 / 配额满 / 没有 localStorage）时静默降级 ✓：最坏结果是这次取消没被记住，
 * 下次可能再弹一次 —— 绝不因为它报错而卡住流程 ✓。
 */

/** 存储键（带前缀与版本 ✓；值是 `{id, root}` 的 JSON 数组 ✓） */
const KEY = "knowledgenet.plan-dismissed.v1";

/** 最多记多少条（提案 id 很短；留个上限免得无限长 ✓） */
const LIMIT = 200;

/** 只用到这两个方法的存储面（测试可直接传假的 ✓） */
export interface DismissedStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 一条"用户取消过"的记录 ✓ */
export interface DismissedPlan {
  id: string;
  /** 提案所在的库根（补删要用 ✓；老记录可能没有） */
  root: string;
}

/** 取存储：显式传（含 `null` 表示"没有存储"）优先，否则用浏览器 `localStorage` ✓ */
function resolveStorage(storage?: DismissedStorage | null): DismissedStorage | null {
  if (storage !== undefined) return storage;
  return typeof localStorage === "undefined" ? null : localStorage;
}

/**
 * 读"用户取消过"的提案。
 * @param storage - 可选：存储面（测试用 ✓）。
 * @returns 记录列表；读不到 / 值坏了都返回空数组 ✓。
 */
export function readDismissedPlans(storage?: DismissedStorage | null): DismissedPlan[] {
  const target = resolveStorage(storage);
  if (target === null) return [];
  try {
    const raw = target.getItem(KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): DismissedPlan[] => {
      if (entry === null || typeof entry !== "object") return [];
      const record = entry as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : "";
      if (id === "") return [];
      return [{ id, root: typeof record.root === "string" ? record.root : "" }];
    });
  } catch {
    return [];
  }
}

function write(entries: readonly DismissedPlan[], target: DismissedStorage): void {
  target.setItem(KEY, JSON.stringify(entries.slice(-LIMIT)));
}

/**
 * 记下"这份提案被用户取消了" ✓（点下按钮就立刻写，不等宿主删成功 ✓）。
 * @param entry - 提案 id 与所在库根。
 * @param storage - 可选：存储面（测试用 ✓）。
 */
export function markPlanDismissed(entry: DismissedPlan, storage?: DismissedStorage | null): void {
  if (entry.id === "") return;
  const target = resolveStorage(storage);
  if (target === null) return;
  try {
    write([...readDismissedPlans(target).filter((item) => item.id !== entry.id), { id: entry.id, root: entry.root }], target);
  } catch {
    /* 存不下就算了：最坏再弹一次 ✓ */
  }
}

/**
 * 宿主那边已经真的删掉了 ⇒ 把本地记录也删掉 ✓（去掉"补删"的负担 ✓）。
 * @param id - 提案 id。
 * @param storage - 可选：存储面（测试用 ✓）。
 */
export function forgetDismissedPlan(id: string, storage?: DismissedStorage | null): void {
  const target = resolveStorage(storage);
  if (target === null) return;
  try {
    write(readDismissedPlans(target).filter((item) => item.id !== id), target);
  } catch {
    /* 同上 ✓ */
  }
}

/** 清空（测试与"重置提示"用 ✓） */
export function clearDismissedPlans(storage?: DismissedStorage | null): void {
  const target = resolveStorage(storage);
  if (target === null) return;
  try {
    target.setItem(KEY, "[]");
  } catch {
    /* 同上 ✓ */
  }
}
