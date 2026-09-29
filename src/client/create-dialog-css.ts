/**
 * 「创建知识库」对话框的样式 —— 布局照宿主「创建项目」对话框：
 * 标题 + 右上 ×／带图标的名称输入／「位置」区块（已选项 + 添加文件夹行）／底部 取消 + 主按钮。
 *
 * 颜色一律用宿主 token（`--dsw-alias-*`），所以主题切换跟着走；层级在面板之上。
 *
 * @returns CSS 文本。
 */
export function createLibraryDialogCss(): string {
  return [
    ".kn-create-dialog {",
    "  position: fixed; z-index: 10003; left: 50%; top: 50%; transform: translate(-50%, -50%);",
    "  width: min(560px, calc(100vw - 48px)); box-sizing: border-box; padding: 22px 24px 18px;",
    "  border: 0.5px solid var(--dsw-alias-border-l3, #d6e0dd);",
    "  border-radius: 16px; background: var(--dsw-alias-bg-layer-2, #ffffff);",
    "  color: var(--dsw-alias-label-primary, #192523);",
    "  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.38); font-size: 13px; }",
    ".kn-create-head { display: flex; align-items: center; justify-content: space-between; }",
    ".kn-create-title { font-size: 20px; font-weight: 600; line-height: 1.3; }",
    ".kn-create-close {",
    "  appearance: none; border: 0; background: transparent; color: inherit;",
    "  width: 28px; height: 28px; border-radius: var(--dsw-radius-sm, 6px);",
    "  font-size: 18px; line-height: 1; cursor: pointer; }",
    ".kn-create-close:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06)); }",
    ".kn-create-field {",
    "  display: flex; align-items: center; gap: 10px; margin-top: 18px;",
    "  border: 0.5px solid var(--dsw-alias-border-l3, #d6e0dd);",
    "  border-radius: 10px; padding: 0 12px; height: 48px; box-sizing: border-box; }",
    ".kn-create-field-icon { display: flex; flex: none; color: var(--dsw-alias-label-secondary, #526663); }",
    ".kn-create-input {",
    "  flex: 1; min-width: 0; border: 0; outline: none; background: transparent;",
    "  color: inherit; font: inherit; font-size: 15px; }",
    ".kn-create-input::placeholder { color: var(--dsw-alias-label-tertiary, #778a87); }",
    /* 区块标题行：左「位置」，右「此电脑」提示 */
    ".kn-create-section-row { display: flex; align-items: center; justify-content: space-between; margin-top: 20px; }",
    ".kn-create-section { font-size: 14px; font-weight: 600; }",
    ".kn-create-section-hint { display: inline-flex; align-items: center; gap: 6px;",
    "  font-size: 13px; color: var(--dsw-alias-label-secondary, #526663); }",
    /* 已选文件夹列表：一个圆角框，行与行之间一条 0.5px 分隔线 */
    ".kn-create-list {",
    "  margin-top: 10px; box-sizing: border-box;",
    "  border: 0.5px solid var(--dsw-alias-border-l3, #d6e0dd);",
    "  border-radius: 12px; overflow: hidden; }",
    ".kn-create-item {",
    "  display: flex; align-items: center; gap: 10px; width: 100%; box-sizing: border-box;",
    "  height: 52px; padding: 0 14px; background: transparent; color: inherit;",
    "  border: 0; font: inherit; font-size: 14px; text-align: left; }",
    ".kn-create-item-icon { display: flex; flex: none; color: var(--dsw-alias-label-secondary, #526663); }",
    ".kn-create-item-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".kn-create-item-remove {",
    "  appearance: none; flex: none; border: 0; background: transparent; color: inherit;",
    "  width: 24px; height: 24px; border-radius: var(--dsw-radius-sm, 6px);",
    "  font-size: 15px; line-height: 1; cursor: pointer; opacity: .75; }",
    ".kn-create-item-remove:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06)); opacity: 1; }",
    ".kn-create-divider { height: 0.5px; background: var(--dsw-alias-border-l3, #d6e0dd); }",
    ".kn-create-item-add { cursor: pointer; }",
    ".kn-create-item-add:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.04)); }",
    // 正在选位置（原生选择器已弹出）时置灰，避免连点叠出多个窗口
    ".kn-create-item-add:disabled { opacity: .5; cursor: default; }",
    ".kn-create-error { margin-top: 8px; font-size: 12px; color: var(--dsw-alias-label-tertiary, #778a87); }",
    ".kn-create-preview { margin-top: 8px; font-size: 12px; color: var(--dsw-alias-label-tertiary, #778a87);",
    "  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".kn-create-actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 22px; }",
    ".kn-create-cancel {",
    "  appearance: none; border: 0; border-radius: 999px; padding: 8px 18px;",
    "  background: transparent; color: inherit; font: inherit; font-size: 14px; cursor: pointer; }",
    ".kn-create-cancel:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06)); }",
    /* 主按钮：照宿主那块浅色胶囊（深色主题下是浅底深字） */
    ".kn-create-primary {",
    "  appearance: none; border: 0; border-radius: 999px; padding: 9px 22px;",
    "  background: var(--dsw-alias-label-primary, #f5f7f6);",
    "  color: var(--dsw-alias-bg-layer-2, #1b1d1c);",
    "  font: inherit; font-size: 14px; font-weight: 500; cursor: pointer; }",
    ".kn-create-primary:disabled { opacity: .4; cursor: not-allowed; }",
  ].join("\n");
}

