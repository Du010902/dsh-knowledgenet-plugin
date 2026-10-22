/**
 * **修 Crepe 内联公式编辑框在“空公式”上崩溃** ✓（`design/inline-format-fix.md` ✓）。
 *
 * 现象：在空光标处插入内联公式时，Crepe 的 `ToggleLatex` 命令会创建一个
 * `value: ""` 的 `math_inline` 节点 ✓；随后 `LatexInlineTooltip.#shouldShow` 用
 * `schema.text(node.attrs.value)` 建一个临时文档，空字符串触发 ProseMirror
 * `RangeError: Empty text nodes are not allowed` ✗ —— 事务已经落地、编辑框却永远不显示 ✓
 * ⇒ 用户看到的是“插了个看不见的公式、也不能输入” ✗。
 *
 * 修法：空值时不创建 text 节点（`paragraph.create(null, null)` = 空段落 ✓），
 * 编辑框照常出现、空内容可输入 ✓。非空值行为完全不变 ✓。
 *
 * 匹配不到目标（Crepe 升级改了这段 ✓）⇒ **构建失败** ✓：
 * 要么更新这个补丁、要么确认上游已修 ✓，不许静默放行 ✗。
 *
 * @param code - `@milkdown/crepe/lib/esm/index.js` 的源码 ✓。
 * @returns 打过补丁的源码 ✓。
 */
export function patchLatexInlineTooltip(code) {
  const needle = 'schema.text(node.attrs.value)';
  const occurrences = code.split(needle).length - 1;
  if (occurrences !== 1) {
    throw Error(`Crepe latex inline tooltip changed: expected 1 "${needle}" but found ${occurrences}. Review the inline-tooltip patch.`);
  }
  return code.replace(needle, '(node.attrs.value ? schema.text(node.attrs.value) : null)');
}
