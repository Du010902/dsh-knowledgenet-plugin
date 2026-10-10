/** Extend Crepe's programmatic menu to list blocks and caret-relative filtering. */
export function patchCrepeSlashMenu(code) {
  const position = code.match(/const pos = (__privateGet[\w$]+\(self, _programmaticallyPos\));/);
  if (!position) throw Error('Crepe slash menu changed: review the programmatic trigger patch.');
  const start = code.lastIndexOf('      shouldShow(view2) {', position.index);
  const end = code.indexOf('      offset:', position.index);
  if (start < 0 || end < start) throw Error('Crepe slash-menu patch target not found.');
  const body = `      shouldShow(view2) {
        if (isInCodeBlock(view2.state.selection)) return false;
        const caret = view2.state.selection.$from;
        for (let depth = caret.depth; depth > 0; depth--) if (["table_cell", "table_header"].includes(caret.node(depth).type.name)) return false;
        const currentText = ["paragraph", "heading"].includes(caret.parent.type.name) ? caret.parent.textContent : null;
        if (currentText == null) return false;
        const pos = ${position[1]};
        if (typeof pos === "number") {
          const selection = view2.state.selection;
          if (!(selection instanceof TextSelection) || !selection.empty || pos > selection.from || pos < 0 || pos > view2.state.doc.content.size) return false;
          if (view2.state.doc.resolve(pos).parent !== selection.$from.parent) { self.hide(); return false; }
          filter.value = view2.state.doc.textBetween(pos, selection.from, "", "");
          return true;
        }
        if (isInList(view2.state.selection) || !isSelectionAtEndOfNode(view2.state.selection)) return false;
        filter.value = currentText.startsWith("/") ? currentText.slice(1) : currentText;
        return currentText.startsWith("/");
      },
`;
  return code.slice(0,start)+body+code.slice(end);
}
