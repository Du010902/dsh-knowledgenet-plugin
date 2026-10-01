/**
 * 确认弹窗的**键盘意图**（纯函数 ⇒ 可直接单测，不必挂载组件 ✓）。
 *
 * 为什么要单独放在 `.ts` 里：Node 的 strip-only TS 处理不了 `.tsx` 的 JSX ✗，
 * 而"Esc 该不该取消、Enter 该不该确认"是这次复查最容易搞错的语义点 ✓，
 * 必须能被**可执行测试**覆盖，而不是只断言源码里出现过某个参数名 ✗。
 *
 * 规则（父面板与弹窗共用同一套 ✓，复查 P1-5）：
 * - **正在写盘**（`busy`）⇒ 一切都冻结 ✗（不能"嘴上说放弃了、磁盘上却在写"）；
 * - **确认不可用**（`confirmDisabled`，例如缺指纹 / 载入失败）⇒ **只**挡 Enter ✗；
 *   Esc / 点背景照常取消 ⇒ 用户能回到编辑器处理问题或明确放弃 ✓。
 */
export type DialogKeyboardIntent = "confirm" | "cancel" | "ignore";

/**
 * 键盘该怎么响应。
 * @param key - `event.key`。
 * @param options.busy - 正在写盘（一切都冻结 ✓）。
 * @param options.confirmDisabled - 确认不可用（只挡 Enter ✓）。
 * @returns 该做什么 ✓。
 */
export function dialogKeyboardIntent(
  key: string,
  options: { busy?: boolean | undefined; confirmDisabled?: boolean | undefined } = {},
): DialogKeyboardIntent {
  if (options.busy === true) return "ignore";
  if (key === "Escape") return "cancel";
  if (key === "Enter") return options.confirmDisabled === true ? "ignore" : "confirm";
  return "ignore";
}
