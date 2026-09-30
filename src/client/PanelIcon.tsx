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

/**
 * 「刷新」图标：**直接抄 harness 产品图标集的原版**（用户要求 2026-09）。
 *
 * 来源：`packages/client/ui-primitives/src/icons/index.tsx` 的 `IconRefreshOutlineArtwork`
 * （就是浏览器/文件面板那颗刷新按钮用的同一枚字形）。两点都照抄，一个字节都没改：
 * - **几何**：两条 path 的 `d` 原样复制；
 * - **画法**：`viewBox="0 0 16 16"` + `fill="none"` + 每条 path 自带 `stroke="currentColor"`
 *   + `strokeWidth={1}`（`ICON_REGULAR_STROKE`），并且**不设** linecap/linejoin（原版是默认的
 *   butt/miter —— 我上一版自己加了 round 和自算的圆弧，形状就偏了 ✗）。
 *
 * @param size - 边长（px）。宿主按钮里那颗是 15px（`FilesBody.module.css` 的 `.tool svg`）。
 */
export function RefreshRingIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      strokeWidth={1}
    >
      <path
        d="M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799 11.6752 13.5129 10.4875 14.0049C9.29982 14.4968 7.99295 14.6255 6.73212 14.3747C5.4713 14.124 4.31314 13.505 3.4041 12.596C2.49514 11.687 1.87614 10.5288 1.62537 9.26798C1.37459 8.00716 1.50331 6.70028 1.99525 5.51261C2.48719 4.32494 3.32025 3.30981 4.3891 2.59557C5.45795 1.88134 6.71458 1.50008 8.0001 1.5C9.9001 1.5 11.7001 2.3 13.0001 3.6L14.5001 5.1"
        stroke="currentColor"
      />
      <path d="M14.4999 1.5V5.1H10.8999" stroke="currentColor" />
    </svg>
  );
}
