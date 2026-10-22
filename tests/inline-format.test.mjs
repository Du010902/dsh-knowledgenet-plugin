import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, TextSelection } from '@milkdown/kit/prose/state';
import {
  INLINE_FORMAT_LITERAL,
  inlineFormatGroup,
  insertInlineCodeAtCaret,
  prepareInlineFormat,
  resolveInlineAnchorPos,
} from '../src/client/inline-format.ts';
import { blockMenuGroupTextKey, blockMenuTextKey, BLOCK_MENU_LITERAL } from '../src/client/block-insert.ts';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' }, paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' }, code_block: { group: 'block', content: 'text*', code: true },
  },
  marks: { strong: {}, em: {}, inlineCode: {}, strikethrough: {} },
});
const p = text => schema.node('paragraph', null, text ? schema.text(text) : null);
const code = text => schema.node('code_block', null, schema.text(text));
function viewOf(...blocks) {
  return { editable: true, state: EditorState.create({ schema, doc: schema.node('doc', null, blocks) }),
    dispatch(tr) { this.state = this.state.apply(tr); } };
}
function caret(view, pos) {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
}
function select(view, from, to) {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
}

test('inline range and cursor preserve the paragraph, surrounding text and selection', () => {
  const view = viewOf(p('前文x^2后文'));
  const doc = view.state.doc;
  assert.equal(prepareInlineFormat(view, 3, 6), true);
  assert.equal(view.state.doc, doc);
  assert.equal(view.state.doc.textBetween(view.state.selection.from, view.state.selection.to), 'x^2');
  assert.equal(prepareInlineFormat(view, 6), true);
  assert.equal(view.state.selection.empty, true);
  assert.equal(view.state.doc.childCount, 1);
});

test('invalid positions, code and read-only edits do not dispatch', () => {
  const view = viewOf(p('abc'));
  for (const range of [[-1, 2], [3, 2], [1, 99], [0, 1]]) assert.equal(prepareInlineFormat(view, ...range), false);
  view.editable = false;
  assert.equal(prepareInlineFormat(view, 1, 2), false);
  const codeBlock = viewOf(code('abc'));
  assert.equal(prepareInlineFormat(codeBlock, 1, 2), false);
});

test('resolveInlineAnchorPos: keeps middle / normalizes block boundaries and end-of-document', () => {
  const doc = schema.node('doc', null, [p('前文后文')]);
  assert.equal(resolveInlineAnchorPos(doc, 3), 3, '段落中间原样返回');
  assert.equal(resolveInlineAnchorPos(doc, 0), 1, '块前边界收进段落起点');
  assert.equal(resolveInlineAnchorPos(doc, doc.content.size), 5, '文末边界收进段落末尾');
  assert.equal(resolveInlineAnchorPos(doc, 5), 5, '段落内位置不变');
});

test('resolveInlineAnchorPos: code blocks have no inline range', () => {
  const doc = schema.node('doc', null, [code('abc')]);
  for (const pos of [1, 2, 3, 4, doc.content.size]) assert.equal(resolveInlineAnchorPos(doc, pos), null, '代码块 ' + pos);
  const mixed = schema.node('doc', null, [p('ab'), code('abc')]);
  assert.equal(resolveInlineAnchorPos(mixed, 4), 3, '紧挨代码块的块边界 ⇒ 退回段落末尾'); // p('ab') 结束于 3；4 是 code_block 起点
});

test('insertInlineCodeAtCaret: selected placeholder keeps the inlineCode mark while typing', () => {
  const view = viewOf(p('ab'));
  caret(view, 2);
  assert.equal(insertInlineCodeAtCaret(view, '代码'), true);
  const doc = view.state.doc;
  assert.equal(doc.childCount, 1, '不能拆段落');
  assert.equal(doc.textContent, 'a代码b');
  const { from, to, empty } = view.state.selection;
  assert.equal(empty, false, '占位要整段被选中（浏览器替换时才留得住 code 标记）');
  assert.equal(doc.textBetween(from, to), '代码');
  assert.ok(doc.rangeHasMark(from, to, schema.marks.inlineCode));
  const blank = viewOf(p(''));
  caret(blank, 1);
  assert.equal(insertInlineCodeAtCaret(blank, '  '), true);
  assert.equal(blank.state.doc.textContent, 'code', '空占位用英文兜底，避免插一个空 text 节点');
});

test('insertInlineCodeAtCaret: non-empty selection / code block / read-only refuse', () => {
  const selected = viewOf(p('abc'));
  select(selected, 1, 2);
  assert.equal(insertInlineCodeAtCaret(selected, '代'), false, '非空选区交给 Milkdown 自己的命令');
  const codeBlock = viewOf(code('abc'));
  caret(codeBlock, 2);
  assert.equal(insertInlineCodeAtCaret(codeBlock, '代'), false, '代码块里不能再套行内代码');
  const readOnly = viewOf(p('ab'));
  caret(readOnly, 2);
  readOnly.editable = false;
  assert.equal(insertInlineCodeAtCaret(readOnly, '代'), false);
});

test('multi-paragraph formatting remains possible, math conversion stays within one paragraph', () => {
  const view = viewOf(p('abc'), p('def'));
  assert.equal(prepareInlineFormat(view, 2, 8), true);
  assert.equal(view.state.doc.childCount, 2);
  assert.ok(!inlineFormatGroup(false).items.some(item => item.key === 'inline-math'));
  assert.ok(inlineFormatGroup().items.some(item => item.key === 'inline-math'));
  for (const item of inlineFormatGroup().items) assert.ok(BLOCK_MENU_LITERAL[blockMenuTextKey(item.key)]);
});

test('inline group and dictionary keys line up with the block-menu mapping (7 entries)', () => {
  const group = inlineFormatGroup();
  assert.equal(group.key, 'inline');
  assert.equal(blockMenuGroupTextKey(group.key), 'inlineFormat');
  assert.ok('inlineFormat' in BLOCK_MENU_LITERAL, '分组标题的中文字面兜底在 BLOCK_MENU_LITERAL（菜单渲染同一条链）');
  assert.deepEqual(
    group.items.map(item => item.key),
    ['inline-bold', 'inline-italic', 'inline-strike', 'inline-code', 'inline-math', 'inline-link', 'inline-clear'],
  );
  for (const item of group.items) {
    const key = blockMenuTextKey(item.key);
    assert.notEqual(key, null, item.key + ' 要在 block-insert 的映射里');
    assert.ok(key in BLOCK_MENU_LITERAL, item.key + ' 的词典键 ' + key + ' 要在 BLOCK_MENU_LITERAL 里');
  }
  /* INLINE_FORMAT_LITERAL = 输入框占位 / 空光标提示（与条目标签分开两份 ✓） */
  assert.deepEqual(Object.keys(INLINE_FORMAT_LITERAL).sort(), [
    'inlineBoldOn', 'inlineCleared', 'inlineCodePlaceholder', 'inlineItalicOn', 'inlineLinkPlaceholder', 'inlineStrikeOn',
  ]);
  for (const [key, text] of Object.entries(INLINE_FORMAT_LITERAL)) assert.ok(text.length > 0, key + ' 不能是空文案');
});

test('clear formatting removes selected marks and leaves text and surrounding marks intact', () => {
  const bold = schema.mark('strong');
  const view = viewOf(schema.node('paragraph', null, schema.text('abcdef', [bold])));
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3, 5)));
  inlineFormatGroup().items.find(item => item.key === 'inline-clear').onRun({ get: () => view });
  assert.equal(view.state.doc.textContent, 'abcdef');
  assert.equal(view.state.doc.rangeHasMark(3, 5, schema.marks.strong), false);
  assert.equal(view.state.doc.rangeHasMark(1, 3, schema.marks.strong), true);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
  inlineFormatGroup().items.find(item => item.key === 'inline-clear').onRun({ get: () => view });
  assert.deepEqual(view.state.storedMarks, [], 'clearing at a cursor resets formatting for subsequent typing');
});
