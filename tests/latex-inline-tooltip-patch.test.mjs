import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {patchLatexInlineTooltip} from '../scripts/latex-inline-tooltip-patch.mjs';
test('构建补丁：Crepe 内联公式编辑框的空值守卫；无关/多处匹配明确抛错',async()=>{
  const needle='schema.text(node.attrs.value)';
  const guard='(node.attrs.value ? schema.text(node.attrs.value) : null)';
  const source=await readFile(new URL('../node_modules/@milkdown/crepe/lib/esm/index.js',import.meta.url),'utf8');
  assert.equal(source.split(needle).length-1,1,'Crepe 源码里应恰好只有这一处空值直传');
  const patched=patchLatexInlineTooltip(source);
  assert.ok(patched.includes(guard),'应写成空值守卫（空段落文本节点不创建，编辑框仍会出现）');
  assert.ok(!patched.replace(guard,'').includes(needle),'守卫之外不许再留空值直传');
  assert.throws(()=>patchLatexInlineTooltip('changed'),/Crepe latex inline tooltip changed/,'无关源码要明确报错');
  assert.throws(()=>patchLatexInlineTooltip(`${needle} ${needle}`),/expected 1/,'多处匹配也要报错（不能猜）');
});
