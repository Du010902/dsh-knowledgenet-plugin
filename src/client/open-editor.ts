/**
 * 「这个知识库现在开着哪篇笔记的编辑器」——按**库身份**记，不是按会话/面板实例记。
 *
 * 为什么必须放在组件外（用户实测）：
 * DSH 的右侧栏（含里面打开的标签）是**每个会话一份**的停靠面，`GraphPanel` 因此也是
 * "每会话一个实例"。从笔记里点「打开新对话」如果换了会话，旧实例会被整体卸载 ⇒
 * 组件 state 里那份"编辑器开着哪个节点"带不过去，表现就是
 * **"侧边栏和标签都还在，编辑笔记的弹窗却没了"** ✗。
 *
 * 语义（照用户的要求）：只要用户**没有主动关掉**编辑器、也没有改去编辑另一篇，
 * 这个库的编辑器就算"还开着"——面板在哪个会话重新挂起来，它就跟着回来 ✓。
 * 关掉/换一篇由 `GraphPanel` 显式写回这里（见那边的同步 effect ✓）。
 *
 * 纯内存、不持久化：刷新页面即忘（与草稿缓存不同——草稿要保命，这个只是"窗口还开着"✓）。
 */

/** 库身份 → 正在编辑的节点 id */
const openEditors = new Map<string, string>();

/**
 * 记下"这个库的编辑器开着哪个节点"。
 * @param libraryKey - 库身份键（`libraryKeyOf` 的结果，空串表示还没认出库 ⇒ 不记 ✓）。
 * @param nodeId - 正在编辑的节点 id。
 */
export function rememberOpenEditor(libraryKey: string, nodeId: string): void {
  if (libraryKey === "" || nodeId === "") return;
  openEditors.set(libraryKey, nodeId);
}

/**
 * 读"这个库的编辑器开着哪个节点"。
 * @param libraryKey - 库身份键（空串一律答"没开"✓）。
 * @returns 节点 id；没开着时 null。
 */
export function openEditorNode(libraryKey: string): string | null {
  if (libraryKey === "") return null;
  return openEditors.get(libraryKey) ?? null;
}

/**
 * 忘掉这个库的编辑器（**用户明确关掉时**必须调用 ✗）：
 * 否则面板会读到"库里还开着"、又把编辑器恢复出来 ✓。
 * @param libraryKey - 库身份键。
 */
export function forgetOpenEditor(libraryKey: string): void {
  openEditors.delete(libraryKey);
}

/** 清空全部记录（测试用 ✓） */
export function clearOpenEditors(): void {
  openEditors.clear();
}
