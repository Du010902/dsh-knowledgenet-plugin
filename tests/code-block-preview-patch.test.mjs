import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {readdirSync} from 'node:fs';
import {
  CODE_BLOCK_PREVIEW_NEEDLE,
  patchCodeBlockPreview,
} from '../scripts/code-block-preview-patch.mjs';

/** 上游 `@milkdown/components` 的实际安装位置（pnpm 目录里带版本后缀 ⇒ 按前缀找 ✓ 不写死版本 ✓） */
function componentsCodePath() {
  const pnpm = new URL('../node_modules/.pnpm/', import.meta.url);
  const entry = readdirSync(pnpm).find(name => name.startsWith('@milkdown+components@'));
  assert.ok(entry !== undefined, '找不到 @milkdown/components（pnpm 目录）');
  return new URL(`${entry}/node_modules/@milkdown/components/lib/code-block/index.js`, pnpm);
}

test('构建补丁：公式块首次输入时不收起源码编辑区；无关/多处匹配明确抛错', async () => {
  const source = await readFile(componentsCodePath(), 'utf8');
  assert.equal(
    source.split(CODE_BLOCK_PREVIEW_NEEDLE).length - 1,
    1,
    '@milkdown/components 源码里应恰好只有这一处预览 watch 结尾',
  );
  const patched = patchCodeBlockPreview(source);
  assert.ok(
    patched.includes('getRootNode') && patched.includes('knActive'),
    '补丁要跨 shadow DOM 看"焦点是否还在 CodeMirror 里"（宿主面板在 shadow 里 ✗ document.activeElement 只是 host）',
  );
  assert.ok(patched.includes('previewOnlyMode.value = false;'), '补丁要把 previewOnlyMode 压回 false（编辑区不收）');
  assert.equal(
    patched.split(CODE_BLOCK_PREVIEW_NEEDLE).length - 1,
    0,
    '补丁点应已被替换（不能原地保留）',
  );
  assert.throws(() => patchCodeBlockPreview('changed'), /target changed/, '无关源码要明确报错');
  assert.throws(
    () => patchCodeBlockPreview(`${CODE_BLOCK_PREVIEW_NEEDLE}\n${CODE_BLOCK_PREVIEW_NEEDLE}`),
    /expected 1 occurrence, found 2/,
    '多处匹配也要报错（不能猜）',
  );
});
