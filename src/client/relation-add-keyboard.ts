/**
 * 「添加前置」输入框的**回车意图**（纯函数 ⇒ 可直接单测 ✓，不必挂载 `.tsx` 组件 ✓）。
 *
 * 为什么要单独放 `.ts`：Node 的 strip-only TS 处理不了 `.tsx` 里的 JSX ✗，
 * 而"这一下回车到底该不该创建节点"正是本次修复最容易做错的地方 ✓：
 *
 * - **中文输入法组合期间**的 Enter 是"选词确认" ✓，绝不能拿去建节点 ✗
 *   （`nativeEvent.isComposing === true` ✓；个别浏览器组合中只给 `keyCode === 229` ✓，
 *   所以两个都挡 ✓ —— 只挡一个就可能在某个输入法下变成"选词时顺手建了个节点"✗）；
 * - **`busy` / 空标题**的判定必须与「新建「x」并设为前置」按钮的
 *   `disabled={busy || !title.trim()}` **完全一致** ✓；
 *   否则会出现"按钮是灰的、回车却提交了"的割裂 ✗（用户会以为按钮坏了 ✓）。
 *
 * 与 `dialog-keyboard.ts` 的 `dialogKeyboardIntent` **刻意不复用** ✗：
 * 那是"确认弹窗"语义（Enter = 确认 / Esc = 取消 / busy 全冻结 ✓），
 * 套到"搜索框里回车 = 新建节点"上会凭空引入 confirm/cancel 概念 ✓。
 */
export type RelationAddKeyIntent = "create" | "consume" | "ignore";

/**
 * 输入框里按键该做什么。
 *
 * @param key - `event.key`。
 * @param options.title - 输入框当前内容 ✓（空标题按 **trim 后**算 ✓，与按钮的 `!title.trim()` 一致 ✓）。
 * @param options.busy - 正在提交 ✓（与按钮 `disabled={busy || ...}` 一致 ✓）。
 * @param options.isComposing - `event.nativeEvent.isComposing` ✓（输入法组合中 ⇒ 忽略 ✓）。
 * @param options.keyCode - `event.nativeEvent.keyCode` ✓（`229` = 组合中 ✓，老浏览器兜底 ✓）。
 * @returns
 * - `"create"`：Enter ✓ 且按钮此刻可点 ⇒ `preventDefault()` + `add(title.trim(), true)` ✓；
 * - `"consume"`：Enter ✓ 但按钮不可点（busy / 空标题）⇒ 只 `preventDefault()`、**不提交** ✗
 *   （回车被这个输入框消化掉 ✓，但绝不越过按钮 disabled 的判定 ✓）；
 * - `"ignore"`：其它键 / 输入法组合中 ⇒ **连 `preventDefault()` 都不做** ✗
 *   （组合中的 Enter 要留给输入法选词 ✓）。
 */
export function relationAddKeyIntent(
  key: string,
  options: {
    title?: string | undefined;
    busy?: boolean | undefined;
    isComposing?: boolean | undefined;
    keyCode?: number | undefined;
  } = {},
): RelationAddKeyIntent {
  /* 输入法优先于一切：组合中的 Enter 是给输入法的 ✓ */
  if (options.isComposing === true || options.keyCode === 229) return "ignore";
  if (key !== "Enter") return "ignore";
  if (options.busy === true || (options.title ?? "").trim() === "") return "consume";
  return "create";
}
