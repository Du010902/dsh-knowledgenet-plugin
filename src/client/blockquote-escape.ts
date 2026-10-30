/**
 * **在引用块边缘按 Backspace / Delete 时"退出引用"** ✓
 * （用户实测：引用块删空后变成一条清不掉的竖条 ✗ —— 截图里的空引用块 ✓）。
 *
 * 上游行为（Crepe 7.22.2 / commonmark keymap ✓）：`blockquoteKeymap` 只有"包进引用" ✓，
 * 没有"退出引用" ✗；把引用里的文字删光后剩下一个空 blockquote（序列化成 `> <br />` ✓），
 * 光标在最前面按 Backspace 什么都不会发生 ✗。这里补一条**保守**规则：
 *
 * 1. 光标在文本块**最开头**按 Backspace（或**最末尾**按 Delete）✓；
 * 2. 最近的祖先是 blockquote ✓；
 * 3. 分两种：
 *    - **空引用**（没有文字；可能只剩空段落 / hardbreak）⇒ 整块删掉：
 *      后面还有块就把光标落到下一块开头 ✓（不留下 `<br />` 空段落 ✗）；
 *      引用是最后一块 / 唯一一块 ⇒ 换成一个空段落 ✓（文档必须有块 ✓）。
 *    - **单段落引用**（任意内容）⇒ 拆掉引用壳、保留段落与文字 ✓（"取消引用" ✓）。
 * 4. 多块引用、嵌套结构复杂等情况**不接管** ✗ ⇒ 交回原有按键行为 ✓（宁可少改，不搞坏结构 ✗）。
 *
 * 纯函数：返回一个已带选区的 `Transaction` ✓（调用方负责 dispatch ✓），便于单测 ✓。
 */
import { TextSelection, type EditorState, type Transaction } from "@milkdown/kit/prose/state";

/** 在引用块边缘按的是哪个方向 ✓（Backspace 往左退 ⇒ `"back"`；Delete 往右删 ⇒ `"forward"`） */
export type BlockquoteEscapeDirection = "back" | "forward";

/**
 * 计算"退出引用块"的事务 ✓。
 * @param state - 当前编辑器状态 ✓。
 * @param direction - 触发方向 ✓。
 * @returns 可 dispatch 的事务；不该接管 ⇒ `null` ✓。
 */
export function unwrapBlockquoteTransaction(
  state: EditorState,
  direction: BlockquoteEscapeDirection,
): Transaction | null {
  const selection = state.selection;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const { $from } = selection;
  if (direction === "back") {
    if ($from.parentOffset !== 0) return null;
  } else if ($from.parentOffset !== $from.parent.content.size) {
    return null;
  }
  /* 最近的引用块祖先 ✓（从内到外找第一个 ✓） */
  let depth = -1;
  for (let current = $from.depth; current > 0; current -= 1) {
    if ($from.node(current).type.name === "blockquote") {
      depth = current;
      break;
    }
  }
  if (depth < 0) return null;
  const quote = $from.node(depth);
  const from = $from.before(depth);
  const to = $from.after(depth);
  // Images, formulas and other non-text nodes can have empty textContent.
  // Only paragraphs containing whitespace/hard breaks count as an empty quote.
  let empty = true;
  quote.descendants((node) => {
    if (!["paragraph", "text", "hardbreak"].includes(node.type.name)
      || (node.isText && node.textContent.trim() !== "")) empty = false;
  });
  if (empty) {
    /* 空引用：后面还有块 ⇒ 直接删掉、光标落到下一块；否则换成一个空段落（文档必须有块 ✓） */
    if (to < state.doc.content.size) {
      const transaction = state.tr.delete(from, to);
      transaction.setSelection(TextSelection.near(transaction.doc.resolve(Math.min(from, transaction.doc.content.size))));
      return transaction;
    }
    const paragraph = state.schema.nodes.paragraph?.createAndFill();
    if (paragraph === null || paragraph === undefined) return null;
    const transaction = state.tr.replaceWith(from, to, paragraph);
    transaction.setSelection(TextSelection.create(transaction.doc, from + 1));
    return transaction;
  }
  /* 非空：只处理"单段落引用"⇒ 去掉引用壳、保留段落 ✓（多块引用不动 ✗） */
  if (quote.childCount !== 1) return null;
  const child = quote.firstChild;
  if (child === null || child.type.name !== "paragraph") return null;
  const transaction = state.tr.replaceWith(from, to, child.copy(child.content));
  const caret = from + 1 + Math.min($from.parentOffset, child.content.size);
  transaction.setSelection(TextSelection.create(transaction.doc, caret));
  return transaction;
}
