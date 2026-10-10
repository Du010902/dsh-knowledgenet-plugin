/** Slash-menu trigger and safe insertion into existing text blocks. */
import { Fragment } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";
import { TextSelection, type EditorState } from "@milkdown/kit/prose/state";

/** Crepe 的块菜单 API 切片名（`utils.$ctx(..., "menuAPICtx")` ✓） */
export const SLASH_MENU_SLICE = "menuAPICtx";

/** Crepe 的块菜单 API（我们只用到这两个动作 ✓） */
export interface SlashMenuApi {
  show?: (pos: number) => void;
  hide?: () => void;
}

/** ctx 上我们用到的那一点点形状（只为按名字取切片 ✓，避免把 milkdown 的内部类型写死 ✗） */
export interface SlashMenuCtx {
  use: (key: unknown) => { get: () => unknown };
}

/**
 * 从编辑器 ctx 上取 Crepe 的块菜单 API ✓。
 * @param ctx - milkdown 的 ctx（`crepe.editor.action(...)` 给的 ✓）。
 * @returns API；拿不到（宿主半/版本不对 ✓）返回 `null` ✓ —— 调用方必须容忍它缺席 ✓。
 */
export function readSlashMenuApi(ctx: unknown): SlashMenuApi | null {
  if (ctx === null || typeof ctx !== "object") return null;
  const probe = ctx as Partial<SlashMenuCtx>;
  if (typeof probe.use !== "function") return null;
  try {
    const slice = probe.use(SLASH_MENU_SLICE);
    const value = typeof slice?.get === "function" ? slice.get() : null;
    if (value === null || typeof value !== "object") return null;
    const api = value as SlashMenuApi;
    return typeof api.show === "function" || typeof api.hide === "function" ? api : null;
  } catch {
    /* 切片不存在 ⇒ 这条路走不通 ✓（调用方会退回"什么都不做" ✓） */
    return null;
  }
}

/** Return the caret at a command boundary, excluding literal-code and table contexts. */
export function shouldOpenSlashMenu(state: EditorState): number | null {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const { $from } = selection;
  if (!["paragraph", "heading"].includes($from.parent.type.name)) return null;
  if (($from.marks()).some(mark => mark.type.name === "inlineCode" || mark.type.name === "code" || mark.type.name === "link")) return null;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if (["code_block", "table_cell", "table_header"].includes($from.node(depth).type.name)) return null;
  }
  const prefix = $from.parent.textBetween(0, $from.parentOffset, "", "\ufffc");
  const token = prefix.split(/\s/).at(-1) ?? "";
  if (/[\\/:]/.test(token)) return null;
  if (prefix !== "" && !/\s$/.test(prefix) && !/[\u3000-\u9fff]$/.test(prefix)) return null;
  return selection.from;
}

/** Isolate the chosen block at the trigger, preserving surrounding text and container structure. */
export function prepareSlashInsertion(view: EditorView, anchor: number): boolean {
  const { selection, doc, schema } = view.state;
  if (!(selection instanceof TextSelection) || !selection.empty || anchor < 0 || anchor > selection.from) return false;
  if (doc.resolve(anchor).parent !== selection.$from.parent) return false;
  const tr = view.state.tr.delete(anchor, selection.from);
  const caret = tr.doc.resolve(anchor);
  if (caret.parent.content.size === 0 && caret.parent.type.name === "paragraph") { view.dispatch(tr); return true; }
  const before = caret.parent.cut(0, caret.parentOffset);
  const after = caret.parent.cut(caret.parentOffset);
  const empty = schema.nodes.paragraph!.create();
  const nodes = [...(before.content.size ? [before] : []), empty, ...(after.content.size ? [after] : [])];
  const parent = caret.node(caret.depth - 1);
  if (!parent.canReplace(caret.index(caret.depth - 1), caret.index(caret.depth - 1) + 1, Fragment.fromArray(nodes))) return false;
  const from = caret.before();
  tr.replaceWith(from, caret.after(), nodes);
  tr.setSelection(TextSelection.create(tr.doc, from + (before.content.size ? before.nodeSize : 0) + 1));
  view.dispatch(tr);
  return true;
}
