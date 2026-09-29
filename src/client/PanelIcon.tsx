/**
 * 侧栏面板图标。
 *
 * **坐标系与线宽对齐宿主**（`ui-primitives/src/icons/index.tsx`）：
 * 宿主的图标统一是 `viewBox="0 0 16 16"` + `ICON_REGULAR_STROKE = 1`。
 * 我先前用 24 网格、线宽 1.6，换算成实际渲染是 `1.6 × 16/24 ≈ 1.07`，和旁边几颗图标粗细对不上。
 * 用 `currentColor` 描边：图标是单色的，跟随宿主主题与激活态。
 */
export function GraphPanelIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 5.3v5.4" />
      <path d="M8 10.7 4.3 13.4" />
      <path d="M8 10.7 11.7 13.4" />
      <circle cx="8" cy="3.6" r="1.7" />
      <circle cx="3.4" cy="14.4" r="1.5" />
      <circle cx="12.6" cy="14.4" r="1.5" />
    </svg>
  );
}
