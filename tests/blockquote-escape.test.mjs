/**
 * **引用块边缘 Backspace / Delete 退出引用** 的单测（`src/client/blockquote-escape.ts`）。
 *
 * 用户实测：引用里的文字删光后剩下一条清不掉的竖条（空 blockquote）✗。
 * 这里钉住保守规则：空引用整块删掉 / 单段落引用拆壳保留文字 / 其它结构不接管 ✓。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, TextSelection } from '@milkdown/kit/prose/state';
import { unwrapBlockquoteTransaction } from '../src/client/blockquote-escape.ts';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    blockquote: { group: 'block', content: 'block+' },
    text: { group: 'inline' },
    image: { inline: true, group: 'inline', atom: true, attrs: { src: {} } },
  },
  marks: {},
});
const p = text => schema.node('paragraph', null, text ? schema.text(text) : null);
const quote = (...blocks) => schema.node('blockquote', null, blocks);
const docOf = (...blocks) => schema.node('doc', null, blocks);
function stateWith(doc, from, to = from) {
  return EditorState.create({ schema, doc, selection: TextSelection.create(doc, from, to) });
}
/** 找到 textContent 等于 text 的段落，返回“段落内容起点 + offset” */
function textPos(doc, text, offset = 0) {
  let hit;
  doc.descendants((node, pos) => {
    if (hit === undefined && node.type.name === 'paragraph' && node.textContent === text) hit = pos + 1 + offset;
  });
  if (hit === undefined) throw Error('找不到段落：' + JSON.stringify(text));
  return hit;
}
const blockTypes = doc => Array.from({ length: doc.childCount }, (_, i) => doc.child(i).type.name);

test('引用里的图片不能被当作空引用删除', () => {
  const image = schema.node('image', { src: 'note.png' });
  const imageParagraph = schema.node('paragraph', null, image);
  const single = docOf(quote(imageParagraph), p('正文'));
  const transaction = unwrapBlockquoteTransaction(stateWith(single, 2), 'back');
  assert.ok(transaction);
  assert.equal(transaction.doc.firstChild.firstChild.type.name, 'image');
  assert.equal(transaction.doc.firstChild.firstChild.attrs.src, 'note.png');
  const multiple = docOf(quote(p(''), imageParagraph), p('正文'));
  assert.equal(unwrapBlockquoteTransaction(stateWith(multiple, 2), 'back'), null);
});

test('空引用（后面还有块）⇒ 整块删掉，光标落到下一块开头', () => {
  const doc = docOf(quote(p('')), p('正文'));
  const state = stateWith(doc, textPos(doc, ''));
  const transaction = unwrapBlockquoteTransaction(state, 'back');
  assert.notEqual(transaction, null, '空引用要接管');
  const next = state.apply(transaction);
  assert.deepEqual(blockTypes(next.doc), ['paragraph'], '引用块整块消失');
  assert.equal(next.doc.textContent, '正文', '后面的块保留');
  assert.equal(next.selection.empty, true);
  assert.equal(next.selection.$from.parent.textContent, '正文');
  assert.equal(next.selection.$from.parentOffset, 0, '光标在下一块开头');
  assert.equal(next.selection.from, 1);
});

test('空引用是唯一块 ⇒ 换成空段落（文档必须有块）', () => {
  const doc = docOf(quote(p('')));
  const state = stateWith(doc, textPos(doc, ''));
  const transaction = unwrapBlockquoteTransaction(state, 'back');
  assert.notEqual(transaction, null);
  const next = state.apply(transaction);
  assert.deepEqual(blockTypes(next.doc), ['paragraph']);
  assert.equal(next.doc.firstChild.textContent, '');
  assert.equal(next.selection.from, 1, '光标在空段落里');
});

test('单段落引用 back：在开头按 Backspace ⇒ 拆壳、保留文字与段落', () => {
  const doc = docOf(quote(p('引用文字')), p('正文'));
  const state = stateWith(doc, textPos(doc, '引用文字'));
  const transaction = unwrapBlockquoteTransaction(state, 'back');
  assert.notEqual(transaction, null, '单段落引用要接管');
  const next = state.apply(transaction);
  assert.deepEqual(blockTypes(next.doc), ['paragraph', 'paragraph']);
  assert.equal(next.doc.child(0).textContent, '引用文字');
  assert.equal(next.doc.child(1).textContent, '正文');
  assert.equal(next.selection.$from.parent.textContent, '引用文字');
  assert.equal(next.selection.$from.parentOffset, 0);
});

test('单段落引用 forward：在末尾按 Delete ⇒ 同样拆壳，光标落在文字末尾', () => {
  const doc = docOf(quote(p('引用文字')), p('正文'));
  const state = stateWith(doc, textPos(doc, '引用文字', 4));
  const transaction = unwrapBlockquoteTransaction(state, 'forward');
  assert.notEqual(transaction, null, '单段落引用要接管');
  const next = state.apply(transaction);
  assert.deepEqual(blockTypes(next.doc), ['paragraph', 'paragraph']);
  assert.equal(next.doc.child(0).textContent, '引用文字');
  assert.equal(next.selection.$from.parent.textContent, '引用文字');
  assert.equal(next.selection.$from.parentOffset, 4, '光标在文字末尾');
});

test('光标不在引用块边缘 ⇒ 不接管', () => {
  const doc = docOf(quote(p('引用文字')), p('正文'));
  const middle = stateWith(doc, textPos(doc, '引用文字', 2));
  assert.equal(unwrapBlockquoteTransaction(middle, 'back'), null, '中间按 Backspace 不接管');
  assert.equal(unwrapBlockquoteTransaction(middle, 'forward'), null, '中间按 Delete 不接管');
  const atEnd = stateWith(doc, textPos(doc, '引用文字', 4));
  assert.equal(unwrapBlockquoteTransaction(atEnd, 'back'), null, '末尾按 Backspace 不接管');
  const atStart = stateWith(doc, textPos(doc, '引用文字', 0));
  assert.equal(unwrapBlockquoteTransaction(atStart, 'forward'), null, '开头按 Delete 不接管');
});

test('多块引用 / 多段落引用 / 非引用 / 非空选区 ⇒ 不接管', () => {
  const multiBlock = docOf(quote(p('第一段'), p('第二段')));
  assert.equal(unwrapBlockquoteTransaction(stateWith(multiBlock, textPos(multiBlock, '第一段')), 'back'), null, '多块引用不接管');
  const multiBlockForward = stateWith(multiBlock, textPos(multiBlock, '第二段', 3));
  assert.equal(unwrapBlockquoteTransaction(multiBlockForward, 'forward'), null, '多块引用（末尾方向）不接管');
  const plain = docOf(p('普通段落'), p('正文'));
  assert.equal(unwrapBlockquoteTransaction(stateWith(plain, textPos(plain, '普通段落')), 'back'), null, '不在引用里不接管');
  const selected = stateWith(docOf(p('abcdef')), 2, 4);
  assert.equal(unwrapBlockquoteTransaction(selected, 'back'), null, '非空选区不接管');
  assert.equal(unwrapBlockquoteTransaction(selected, 'forward'), null);
});
