/**
 * **公式块 / 预览型代码块：首次输入时不要把「编辑源码」界面收起来** ✓（用户实测 ✓）。
 *
 * 现象：右键插入「公式块」后编辑源码 → 输入第一个字符 ⇒ 编辑区立刻被隐藏、只剩预览里刚输入的那个字符 ✗，
 * 用户得再点一次「编辑源码」才能继续（后续输入其实还在生效，但看不到了 ✗）。
 *
 * 根因（上游 `@milkdown/components` 的 code-block 组件 ✓）：
 * - `previewOnlyMode` 初始化为 `previewOnlyByDefault` ✓（本插件为了"打开笔记默认只看结果"设成了 true ✓）；
 * - **空**公式块的预览是 `null` ⇒ CodeMirror 编辑区可见（用户看到的就是编辑界面 ✓）；
 * - 输入第一个字符 ⇒ 预览变成非空 ⇒ 渲染时 `preview.value && previewOnlyMode` 给编辑区加上 `hidden` ✗ ——
 *   而 `previewOnlyMode` 从初始化起一直是 true，于是"第一次输入"就被切走 ✗。
 *
 * 修法（构建期补丁 ✓，与仓库其它上游补丁同一规矩 ✓）：预览更新后若**焦点仍在 CodeMirror 里**
 * （用户正在源码编辑区输入 ✓），强制把 `previewOnlyMode` 置回 `false` ✓ —— 编辑区不收、
 * 预览照常更新；用户主动点「结果」时才切到预览 ✓。打开已有块的默认预览行为不受影响 ✓
 * （那种情况焦点不在 CodeMirror 里 ✓），异步预览（mermaid）晚到时也不会打断输入 ✓。
 *
 * 匹配不到目标就抛错 ✓（依赖升级后要么更新补丁、要么确认它已消失 ✓）。
 */

/** 上游源码里的补丁点（watch 回调结尾 ✓；必须恰好一次 ✓） */
export const CODE_BLOCK_PREVIEW_NEEDLE = [
  "        if (result === null) {",
  "          preview.value = null;",
  "        }",
  "      },",
  "      { immediate: true }",
  "    );",
].join("\n");

const REPLACEMENT = [
  "        if (result === null) {",
  "          preview.value = null;",
  "        }",
  "        /*",
  "         * kn-patch: 用户正在源码编辑区里输入时，预览刚出现也不能把编辑区收起来（公式块首字被切走 ✗）。",
  "         * 注意：编辑器在宿主面板里跑在 **shadow DOM** 里 ✗ —— document.activeElement 只会是 shadow host，",
  "         * 真正的焦点元素在 getRootNode().activeElement 上 ✓，所以不能只看 document ✗。",
  "         */",
  "        if (preview.value) {",
  "          const knRoot = codemirrorHostRef.value?.getRootNode?.();",
  '          const knActive = knRoot && "activeElement" in knRoot ? knRoot.activeElement : document.activeElement;',
  "          if (knActive && codemirrorHostRef.value?.contains(knActive)) {",
  "            previewOnlyMode.value = false;",
  "          }",
  "        }",
  "      },",
  "      { immediate: true }",
  "    );",
].join("\n");

/**
 * 应用补丁 ✓。
 * @param code - 上游 `@milkdown/components/lib/code-block/index.js` 源码 ✓。
 * @returns 打了补丁的源码 ✓。
 */
export function patchCodeBlockPreview(code) {
  if (typeof code !== "string") throw new Error("Code-block preview patch needs source text");
  const occurrences = code.split(CODE_BLOCK_PREVIEW_NEEDLE).length - 1;
  if (occurrences !== 1) {
    throw new Error(`Code-block preview patch target changed (expected 1 occurrence, found ${occurrences})`);
  }
  return code.replace(CODE_BLOCK_PREVIEW_NEEDLE, REPLACEMENT);
}
