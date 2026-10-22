/**
 * 行内格式的**共享部分** ✓。
 *
 * 第四轮用户反馈之后，这里只保留两件事 ✓：
 * 1. **清除文字格式**（选中文字后的浮动工具栏上的按钮 ✓）；
 * 2. 两份给工具栏 / 链接输入框用的字面兜底文案 ✓。
 *
 * 为什么删掉了"右键菜单里的行内格式组" ✗（`design/inline-format-fix.md` §2.6/§8 ✓）：
 * 选中文字后浮动工具栏已经能加粗 / 斜体 / 删除线 / 行内代码 / 行内公式 / 链接 / 清除格式 ✓，
 * 右键菜单再列一遍就是**重复**（用户第四轮截图反馈 ✓）⇒ 右键菜单恢复成纯"块插入" ✓。
 * 连带删掉的还有：空光标行内代码占位 + `handleTextInput` 接管、插入公式后自动聚焦、
 * 空光标格式化的 1.6s 短提示、右键锚点归一化 ✓（这些只为那个菜单服务 ✓）。
 */
import type { EditorView } from "@milkdown/kit/prose/view";

/**
 * 清除选中文字的格式（加粗 / 斜体 / 删除线 / 行内代码 / 链接 / 公式标记 ✓）。
 *
 * 空光标时只清 `storedMarks` ✓（"接下来输入的文字"不继承格式 ✓）；
 * 有选区时同时移除区间内所有标记 ✓。**不删文字、不拆段落** ✓。
 *
 * @param view - 编辑器视图 ✓。
 */
export function clearInlineFormat(view: EditorView): void {
  if (!view.editable) return;
  const { from, to, empty } = view.state.selection;
  const transaction = view.state.tr;
  if (!empty) transaction.removeMark(from, to);
  transaction.setStoredMarks([]);
  view.dispatch(transaction);
}

/**
 * **组件内字面兜底字典** ✓（`tests/plugin-locale.test.mjs` 会核对：每个 key 在中英两份词典里都有 ✓）。
 * 宿主 `t` 与插件 `bind` 都拿不到时，界面不能空着 ✓（仓库既有口径 ✓）。
 */
export const INLINE_FORMAT_LITERAL: Record<string, string> = {
  inlineLinkPlaceholder: "粘贴链接…",
  /** 并进浮动工具栏的「添加前置节点」按钮名（与 NoteRelations 同一条词典 ✓） */
  relAddFromSelection: "＋ 添加前置节点",
};
