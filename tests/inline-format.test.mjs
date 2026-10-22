/**
 * **行内格式（第四轮之后）** 的单测。
 *
 * 第四轮用户反馈：右键菜单里的「行内格式」组和"选中文字后的浮动工具栏"重复 ⇒
 * 整个组从右键菜单删掉，行内格式只走**浮动工具栏**（`design/inline-format-fix.md` §8）。
 * 所以这里只剩两件事可测：
 * ① `clearInlineFormat(view)`（工具栏 clear 按钮的实现）；
 * ② `INLINE_FORMAT_LITERAL` 的 key 集合（链接占位 + 工具栏里的「添加前置节点」文案）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, TextSelection } from '@milkdown/kit/prose/state';
import { clearInlineFormat, INLINE_FORMAT_LITERAL } from '../src/client/inline-format.ts';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
  },
  marks: {
    strong: {},
    em: {},
    inlineCode: {},
    strikethrough: {},
    link: { attrs: { href: { default: '' } } },
  },
});
const p = text => schema.node('paragraph', null, text ? schema.text(text) : null);
const marks = () => schema.marks;
function viewOf(...blocks) {
  return {
    editable: true,
    dispatches: 0,
    state: EditorState.create({ schema, doc: schema.node('doc', null, blocks) }),
    dispatch(tr) { this.dispatches += 1; this.state = this.state.apply(tr); },
  };
}
function select(view, from, to) {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
}

test('clearInlineFormat：选区里的 strong/em/行内代码/删除线/链接全部移除，文字与结构不变', () => {
  const marked = schema.text('abcdef', [
    marks().strong.create(),
    marks().em.create(),
    marks().inlineCode.create(),
    marks().strikethrough.create(),
    marks().link.create({ href: 'https://example.com' }),
  ]);
  const view = viewOf(schema.node('paragraph', null, marked));
  select(view, 3, 5);
  clearInlineFormat(view);
  assert.equal(view.state.doc.textContent, 'abcdef', '文字一个都不能少');
  assert.equal(view.state.doc.childCount, 1, '不拆段落');
  assert.equal(view.state.doc.firstChild.type.name, 'paragraph', '块结构不变');
  for (const name of ['strong', 'em', 'inlineCode', 'strikethrough', 'link']) {
    assert.equal(view.state.doc.rangeHasMark(3, 5, marks()[name]), false, name + ' 应被清掉');
  }
  assert.equal(view.state.doc.rangeHasMark(1, 3, marks().strong), true, '选区外的标记不动');
  assert.equal(view.state.doc.rangeHasMark(5, 7, marks().strong), true, '选区外（右侧）的标记不动');
});

test('clearInlineFormat：空光标只清 storedMarks（后续输入不继承格式）', () => {
  const view = viewOf(p('abc'));
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
  view.dispatch(view.state.tr.addStoredMark(marks().strong.create()));
  assert.equal(view.state.storedMarks.length, 1, '先放一个待输入格式');
  clearInlineFormat(view);
  assert.deepEqual(view.state.storedMarks, [], '空光标 clear 后不继承格式');
  assert.equal(view.state.doc.textContent, 'abc', '正文不能被改');
  assert.equal(view.state.doc.childCount, 1, '不拆段落');
});

test('clearInlineFormat：只读 / 非编辑器视图 ⇒ no-op（不 dispatch）', () => {
  const view = viewOf(p('abc'));
  select(view, 1, 3);
  const before = view.dispatches;
  const document = view.state.doc;
  view.editable = false;
  clearInlineFormat(view);
  assert.equal(view.dispatches, before, '只读时不能 dispatch');
  assert.equal(view.state.doc, document, '只读时文档不能变');
});

test('INLINE_FORMAT_LITERAL：只剩 2 个 key（链接占位 / 添加前置节点）', () => {
  assert.deepEqual(Object.keys(INLINE_FORMAT_LITERAL).sort(), ['inlineLinkPlaceholder', 'relAddFromSelection']);
  assert.equal(INLINE_FORMAT_LITERAL.inlineLinkPlaceholder, '粘贴链接…');
  assert.match(INLINE_FORMAT_LITERAL.relAddFromSelection, /添加前置节点/);
  for (const [key, text] of Object.entries(INLINE_FORMAT_LITERAL)) assert.ok(text.length > 0, key + ' 不能是空文案');
});

test('INLINE_FORMAT_LITERAL 的两个 key 在中英两份词典里都齐全', () => {
  const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client');
  const source = readFileSync(path.join(clientDir, 'index.ts'), 'utf8');
  const zh = source.slice(source.indexOf('const DICT_ZH'), source.indexOf('const DICT_EN'));
  const en = source.slice(source.indexOf('const DICT_EN'));
  for (const key of Object.keys(INLINE_FORMAT_LITERAL)) {
    assert.ok(zh.includes(`${key}:`), `中文词典要有 ${key}`);
    assert.ok(en.includes(`${key}:`), `英文词典要有 ${key}`);
  }
});
