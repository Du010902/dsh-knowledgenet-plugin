/**
 * **关掉 Crepe 自带的斜杠菜单** ✓（`design/editor-block-menu-redesign.md` ✓）。
 *
 * 为什么改依赖源码 ✗：用户反馈输入 `/` 唤起块菜单"有时候会误判" ✓，
 * 触发入口要改成**右键弹窗 + ＋ 块手柄** ✓。但 Crepe 的 BlockEdit 把 `/` 触发写死在
 * SlashProvider 的 `shouldShow` 里 ✗（官方 `slashMenu` 配置只开放 root/offset/middleware/
 * floatingUIOptions ✓，没有 shouldShow ✓）⇒ 只能在构建期把那个方法体换成 `return false` ✓。
 *
 * 只动这一处 ✓：拖拽手柄、菜单组件挂载、`buildMenu` 快照（我们靠它取条目 ✓）都不受影响 ✓ ——
 * 菜单只是不会再自己弹出来 ✓。
 *
 * 匹配不到目标（Crepe 升级改了这段 ✓）⇒ **构建失败** ✓：
 * 要么更新这个补丁 ✓，要么确认上游已经提供关闭开关 ✓，不许静默放行 ✗。
 *
 * @param code - `@milkdown/crepe/lib/esm/index.js` 的源码 ✓。
 * @returns 打过补丁的源码 ✓。
 */
export function patchCrepeBlockMenu(code) {
  const position = code.match(/const pos = (__privateGet[\w$]+\(self, _programmaticallyPos\));/);
  if (!position) throw Error('Crepe slash menu changed: review the block-menu patch.');
  const start = code.lastIndexOf('      shouldShow(view2) {', position.index);
  const end = code.indexOf('      offset:', position.index);
  if (start < 0 || end < start) throw Error('Crepe slash-menu patch target not found.');
  const body = '      shouldShow() {\n        return false;\n      },\n';
  const patched = code.slice(0, start) + body + code.slice(end);
  if (patched.includes("currentText.startsWith('/')")) {
    throw Error('Crepe slash-menu trigger was not removed: review the block-menu patch.');
  }
  return patched;
}
