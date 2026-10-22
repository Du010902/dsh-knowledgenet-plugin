import { commandsCtx, editorViewCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { toggleStrongCommand, toggleEmphasisCommand, toggleInlineCodeCommand } from "@milkdown/kit/preset/commonmark";
import { toggleStrikethroughCommand } from "@milkdown/kit/preset/gfm";
import { toggleLinkCommand } from "@milkdown/kit/component/link-tooltip";
import type { Node as ProseMirrorNode } from "@milkdown/kit/prose/model";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { BlockMenuGroupData, BlockMenuItemData } from "./block-insert.ts";

/**
 * Restore the actual text range; inline actions must never split its paragraph.
 *
 * @param view - editor view.
 * @param from - selection start (document position).
 * @param to - selection end; defaults to `from` (caret).
 * @returns whether the range is an editable inline range (a selection was dispatched).
 */
export function prepareInlineFormat(view: EditorView, from: number, to = from): boolean {
  const { doc } = view.state;
  if (!view.editable || from < 0 || to < from || to > doc.content.size) return false;
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  if (!$from.parent.inlineContent || !$to.parent.inlineContent || $from.parent.type.spec.code || $to.parent.type.spec.code) return false;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, from, to)));
  return true;
}

/**
 * Find an inline-editable document position near `pos`.
 *
 * Right-click coordinates sometimes resolve to a **block boundary** (the padding left/right of a
 * paragraph, an empty line, the end of the document). Resolving there gives `parent === doc`, which
 * is not `inlineContent` — the inline group would silently disappear. This helper searches the
 * position itself then one step forward/backward, and clamps into the nearest paragraph/heading
 * text range, so the inline items are available wherever the pointer visually is on a line.
 *
 * @param doc - current document.
 * @param pos - raw document position from `posAtCoords` / the trailing-paragraph fallback.
 * @returns an inline text position, or `null` when no paragraph/heading is nearby.
 */
export function resolveInlineAnchorPos(doc: ProseMirrorNode, pos: number): number | null {
  const tryResolve = (raw: number): number | null => {
    const clamped = Math.min(Math.max(raw, 0), doc.content.size);
    const $pos = doc.resolve(clamped);
    for (let depth = $pos.depth; depth > 0; depth -= 1) {
      const node = $pos.node(depth);
      if (node.type.spec.code) return null;
      if (node.isTextblock) return Math.min(Math.max(clamped, $pos.start(depth)), $pos.end(depth));
    }
    return null;
  };
  return tryResolve(pos) ?? tryResolve(pos + 1) ?? tryResolve(pos - 1);
}

/** The inline code mark is `inclusive: false`; a selected placeholder keeps it while typing over it. */
const CODE_PLACEHOLDER_FALLBACK = "code";

/**
 * Insert an inline-code span at an empty caret.
 *
 * Why not just call Milkdown's `ToggleInlineCode` — it explicitly refuses an empty selection
 * (`if (selection.empty) return false`), and the inline-code mark is `inclusive: false`, so a bare
 * stored mark would end after the first typed character. Instead this inserts a **selected**
 * placeholder inside the code mark: the browser keeps the `<code>` wrapper while typing over the
 * selection, so ProseMirror reads the new text back as inline code (verified in the browser E2E).
 *
 * @param view - editor view.
 * @param placeholder - visible placeholder (localized), replaced as soon as the user types.
 * @returns whether a placeholder was inserted.
 */
export function insertInlineCodeAtCaret(view: EditorView, placeholder: string): boolean {
  if (!view.editable) return false;
  const { state } = view;
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  const { $from } = selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if (["code_block", "table_cell", "table_header"].includes($from.node(depth).type.name)) return false;
  }
  const markType = state.schema.marks.inlineCode;
  if (markType === undefined) return false;
  const text = placeholder.trim() === "" ? CODE_PLACEHOLDER_FALLBACK : placeholder;
  const from = selection.from;
  const tr = state.tr.insertText(text, from);
  tr.addMark(from, from + text.length, markType.create());
  tr.setSelection(TextSelection.create(tr.doc, from, from + text.length));
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** What the inline group needs from the host, so this module stays pure logic (no i18n / React). */
export interface InlineFormatOptions {
  /** Placeholder inserted by `inline-code` at a caret; replaced by typing. */
  codePlaceholder?: string;
}

/**
 * **组件内字面兜底字典** ✓（`tests/plugin-locale.test.mjs` 会核对：每个 key 在中英两份词典里都有 ✓）。
 * 宿主 `t` 与插件 `bind` 都拿不到时，界面不能空着 ✓（仓库既有口径 ✓）。
 */
export const INLINE_FORMAT_LITERAL: Record<string, string> = {
  inlineCodePlaceholder: "代码",
  inlineLinkPlaceholder: "粘贴链接…",
  inlineBoldOn: "已开启加粗，继续输入即可",
  inlineItalicOn: "已开启斜体，继续输入即可",
  inlineStrikeOn: "已开启删除线，继续输入即可",
  inlineCleared: "已清除文字格式",
};

/**
 * The inline-format entries shown in the right-click menu.
 *
 * Commands are the same ones Crepe's own floating toolbar uses, so selection behavior and
 * Markdown serialization stay identical. Two caret-only cases need extra wiring:
 * - `inline-code`: Milkdown's toggle refuses a caret ⇒ insert a selected placeholder instead.
 * - `inline-math`: `ToggleLatex` inserts an empty node; the tooltip that edits it opens through
 *   Crepe's plugin view (see `agent` note in `MarkdownRichEditor`).
 *
 * @param singleTextblock - whether the anchor is a single text block (the math command converts
 *   selected text into one inline node, so it is hidden for multi-block selections).
 * @param options - host-provided localization/details.
 * @returns one menu group (`key: "inline"`).
 */
export function inlineFormatGroup(singleTextblock = true, options: InlineFormatOptions = {}): BlockMenuGroupData {
  const commands = [
    ["bold", toggleStrongCommand.key],
    ["italic", toggleEmphasisCommand.key],
    ["strike", toggleStrikethroughCommand.key],
    ["code", toggleInlineCodeCommand.key],
    ["math", "ToggleLatex"],
    ["link", toggleLinkCommand.key],
  ] as const;
  const entries: BlockMenuItemData[] = commands
    .filter(([key]) => singleTextblock || key !== "math")
    .map(([key, command]) => ({
      key: `inline-${key}`,
      label: key,
      icon: "",
      onRun: (ctx: unknown) => {
        const app = ctx as Ctx;
        if (key === "code") {
          const view = app.get(editorViewCtx) as EditorView;
          if (insertInlineCodeAtCaret(view, options.codePlaceholder ?? CODE_PLACEHOLDER_FALLBACK)) return;
        }
        app.get(commandsCtx).call(command);
      },
    }));
  entries.push({
    key: "inline-clear",
    label: "Clear formatting",
    icon: "",
    onRun: (ctx: unknown) => {
      const view = (ctx as Ctx).get(editorViewCtx) as EditorView;
      const { from, to, empty } = view.state.selection;
      const tr = view.state.tr;
      if (!empty) tr.removeMark(from, to);
      tr.setStoredMarks([]);
      view.dispatch(tr);
    },
  });
  return {
    key: "inline",
    label: "行内格式",
    items: entries,
  };
}
