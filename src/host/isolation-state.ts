/**
 * 「按会话隐藏工具」的**活动状态**（宿主侧）。
 *
 * 为什么需要它：登记表是由客户端异步同步过来的（见 declared.ts），而 agent 可能在同步到达**之前**
 * 就创建了——那时只能先按普通工作区隐藏 ✗。同步到达后必须能把已创建的会话**重新裁决**一次：
 * 登记过的会话解除限制，没登记的保持隐藏。
 *
 * 所以这里保存"每个会话的隐藏句柄"（`restrict()` 返回的 disposer）与它的工作目录，
 * 由 `reevaluateIsolation()` 在登记表更新后统一重算。工具注册表侧不持有任何结论，
 * 结论永远从登记表实时推导 —— 避免"启动顺序"变成语义。
 */

/** 一个会话的隔离状态 */
interface AgentIsolationState {
  /** 会话工作目录（判定依据） */
  cwd: string;
  /** 施加隐藏（返回 disposer）；宿主没给 agent 作用域工具面时返回 null */
  applyDeny: () => (() => void) | null;
  /** 当前是否已隐藏及其 disposer */
  active: (() => void) | null;
}

const states = new Set<AgentIsolationState>();

/**
 * 登记一个会话，并**立即**按当前判定裁决一次。
 * @param cwd - 会话工作目录。
 * @param applyDeny - 施加隐藏并返回 disposer（拿不到工具面时返回 null）。
 * @param shouldReveal - 是否应当"可见"（true = 不隐藏）。
 * @returns 是否已隐藏。
 */
export function registerAgentIsolation(
  cwd: string,
  applyDeny: () => (() => void) | null,
  shouldReveal: boolean,
): boolean {
  const state: AgentIsolationState = { cwd, applyDeny, active: null };
  states.add(state);
  return applyIfNeeded(state, shouldReveal);
}

function applyIfNeeded(state: AgentIsolationState, shouldReveal: boolean): boolean {
  if (shouldReveal) {
    // 可见：若之前隐藏过就解除
    if (state.active !== null) {
      try {
        state.active();
      } catch {
        // 解除失败不影响会话
      }
      state.active = null;
    }
    return false;
  }
  if (state.active !== null) return true;
  const dispose = state.applyDeny();
  state.active = dispose;
  return dispose !== null;
}

/**
 * 重新裁决所有已登记的会话（登记表更新后调用）。
 * @param shouldReveal - 判定函数：给会话工作目录，返回它是否应当可见。
 * @returns 统计：可见/隐藏的会话数。
 */
export function reevaluateIsolation(shouldReveal: (cwd: string) => boolean): { visible: number; hidden: number } {
  let visible = 0;
  let hidden = 0;
  for (const state of states) {
    if (applyIfNeeded(state, shouldReveal(state.cwd))) hidden += 1;
    else visible += 1;
  }
  return { visible, hidden };
}

/** 仅测试用：清空会话登记 */
export function __resetIsolationStatesForTest(): void {
  for (const state of states) {
    try {
      state.active?.();
    } catch {
      // 忽略
    }
  }
  states.clear();
}
