/**
 * 「提案审阅弹窗」的样式 —— **必须和组件同一个模块注入**。
 *
 * 为什么（本仓库踩过两次的坑）：弹窗是 `createPortal(…, document.body)` 渲染的，落在
 * **轻 DOM** 里；而面板自己的 `panel.css` 是注进 Shadow DOM 的 ⇒ portal 里的 `.kn-plan-*`
 * 一条都命中不了，控件会退化成浏览器默认样子（GraphContextMenu 的命名弹窗就这样白过一次 ✗）。
 * 所以这里把弹窗用到的每条规则再写一遍，注到 `document.head` ✓。
 *
 * 颜色一律走宿主 token（`--dsw-alias-*`）⇒ 主题切换自动跟着走 ✓。
 *
 * @returns CSS 文本。
 */
export function planDialogCss(): string {
  const hover = "var(--kn-hover, color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent))";
  return [
    /* 遮罩：把弹窗**悬浮在当前聊天窗口之上**（用户要求 ✓），点背景即取消 ✓ */
    ".kn-pdialog-backdrop {",
    "  position: fixed; inset: 0; z-index: 10002; display: flex;",
    "  align-items: center; justify-content: center; padding: 16px;",
    "  background: rgba(0, 0, 0, 0.28); }",
    ".kn-pdialog {",
    "  box-sizing: border-box; width: min(560px, 100%); max-height: min(78vh, 720px);",
    "  display: flex; flex-direction: column; gap: 10px; padding: 16px 16px 14px;",
    "  border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 14px;",
    "  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);",
    "  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.3); font-size: 13px; }",
    ".kn-pdialog-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }",
    ".kn-pdialog-title { font-size: 14px; font-weight: 600; }",
    ".kn-pdialog-close {",
    "  appearance: none; flex: none; border: 0; background: transparent; color: inherit;",
    "  width: 26px; height: 26px; border-radius: 8px; font-size: 18px; line-height: 1; cursor: pointer; }",
    `.kn-pdialog-close:hover { background: ${hover}; }`,
    ".kn-pdialog-body { display: flex; flex-direction: column; gap: 10px; min-height: 0; overflow: auto; }",
    ".kn-pdialog-card {",
    "  display: flex; flex-direction: column; gap: 6px; padding: 10px 12px;",
    "  border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 10px; }",
    ".kn-pdialog-cardhead { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }",
    ".kn-pdialog-cardtitle { font-size: 13px; font-weight: 600; }",
    ".kn-pdialog-meta { flex: none; font-size: 11px; font-weight: 400; opacity: .6; }",
    ".kn-pdialog-summary { font-size: 12px; opacity: .8; }",
    ".kn-pdialog-items { display: flex; flex-direction: column; gap: 4px; max-height: 280px; overflow: auto; }",
    ".kn-pdialog-item { display: flex; align-items: center; gap: 8px; font-size: 12.5px; cursor: pointer; }",
    ".kn-pdialog-item-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".kn-pdialog-tag {",
    "  flex: none; padding: 1px 7px; border-radius: 999px; font-size: 10.5px;",
    "  border: 0.5px solid var(--dsw-alias-border-l2); opacity: .8; }",
    ".kn-pdialog-tag.is-reuse { opacity: .55; }",
    ".kn-pdialog-actions { display: flex; align-items: center; gap: 10px; }",
    ".kn-pdialog-hint { flex: 1; min-width: 0; font-size: 11.5px; opacity: .55; }",
    ".kn-pdialog-btn {",
    "  appearance: none; flex: none; border: 0.5px solid var(--dsw-alias-border-l2);",
    "  border-radius: 999px; padding: 7px 16px; background: transparent; color: inherit;",
    "  font: inherit; font-size: 13px; cursor: pointer; }",
    `.kn-pdialog-btn:hover { background: ${hover}; }`,
    ".kn-pdialog-btn.is-primary {",
    "  font-weight: 600; border-color: transparent;",
    "  background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-2); }",
    ".kn-pdialog-btn:disabled { opacity: .45; cursor: not-allowed; }",
    ".kn-pdialog-btn:disabled:hover { background: transparent; }",
    ".kn-pdialog-btn.is-primary:disabled:hover { background: var(--dsw-alias-label-primary); }",
    ".kn-pdialog-note { font-size: 12px; opacity: .85; }",
    ".kn-pdialog-error { font-size: 12px; color: var(--dsw-alias-state-idle-primary); }",
  ].join("\n");
}

/** 注入一次即可（多个面板/多次挂载共用 ✓） */
const STYLE_ID = "knowledgenet-plan-dialog-style";

/**
 * 把弹窗样式注进 `document.head`（已注入则跳过 ✓）。
 * @param doc - 目标文档。
 */
export function ensurePlanDialogStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID) !== null) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = planDialogCss();
  doc.head.append(style);
}
