/**
 * 「知识库图谱」的图标：**三个节点 + 三条连线**（用户 2026-10 指定的那枚）。
 *
 * 来源：用户给的 `dsh-graph-tab.html` 里 `<symbol id="graph" viewBox="0 0 24 24">` ——
 * **几何与画法逐字照抄**（24 网格 + 线宽 1.5 + 圆头/圆角 + `currentColor`），不自己改 ✓。
 *
 * 为什么 24 网格 / 1.5 线宽在这里正好：宿主机图标是 16 网格 + 线宽 1，而实际渲染尺寸是 16px，
 * 于是 1.5 × 16/24 = 1.0 —— 与旁边几颗图标**同一粗细** ✓（我上一版自己换算过，效果一致）。
 *
 * 两处必须用**同一个字形**（用户要求"一致"）：
 * 1. 右侧栏标签页芯片（`tab.ts` 把本组件交给 `graphTabDefinition`）；
 * 2. 「开始」页入口卡片（guide 条目的 `icon`；宿主 `GuideBody` 的逻辑是 `entry.icon ?? CubeGlyph`）✓。
 *
 * @param props.size - 边长（px），默认 16；宿主卡片会按 22 / 26 传。
 * @param props.className - 宿主可能加的类名，原样透传 ✓。
 */
export function GraphPanelIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8.2 6.8 15.8 10.2M7.5 8.5l2 7M15.8 13.8l-4.4 3.4" />
      <circle cx="6" cy="6" r="3" />
      <circle cx="19" cy="12" r="3" />
      <circle cx="10" cy="19" r="3" />
    </svg>
  );
}

/**
 * 「重新整理」图标：**设计稿那枚"层级树"字形**（用户 2026-09 给的 HTML 里那颗）。
 *
 * 几何**原样照抄**设计稿（三个圆角方块 + 一条分叉干线）：
 * ```
 * <rect x="6" y="1.5" width="4" height="3" rx=".7"/>   上节点
 * <rect x="1" y="11.5" width="4" height="3" rx=".7"/>  左下节点
 * <rect x="11" y="11.5" width="4" height="3" rx=".7"/> 右下节点
 * <path d="M8 4.5v3M3 11.5v-4h10v4"/>                  主干 + 分叉
 * ```
 * 画法沿用面板其它图标那一套（`fill="none"` + `currentColor` + 线宽 1 + round 端点/圆角）——
 * 设计稿页面里那个 `stroke-width: 1.5` 是它**整页**的统一样式（连标签页里的文件夹/地球也一起套），
 * 不是这一枚的专属参数；这里保持与右边那颗刷新（宿主原版，线宽 1、15px）同一粗细 ✓。
 *
 * @param size - 边长（px），默认 16（网格尺寸；按钮里按 15px 渲染，与宿主图标一致）。
 */
export function RelayoutTreeIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="6" y="1.5" width="4" height="3" rx=".7" />
      <rect x="1" y="11.5" width="4" height="3" rx=".7" />
      <rect x="11" y="11.5" width="4" height="3" rx=".7" />
      <path d="M8 4.5v3M3 11.5v-4h10v4" />
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

/**
 * 搜索框里的**放大镜**：同样抄自 harness 产品图标集
 * （`packages/client/ui-primitives/src/icons/index.tsx` 的 `IconSearchOutlineArtwork`）。
 *
 * 几何与画法逐字复制（16 网格 + 每条 path 自带 `stroke="currentColor"` + 线宽 1）。
 *
 * @param size - 边长（px），默认 14（输入框里的小图标）。
 */
export function SearchGlyphIcon({ size = 14 }: { size?: number }) {
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
        d="M6.58727 11.8586C9.55061 11.8586 11.9529 9.45637 11.9529 6.49304C11.9529 3.5297 9.55061 1.12744 6.58727 1.12744C3.62394 1.12744 1.22168 3.5297 1.22168 6.49304C1.22168 9.45637 3.62394 11.8586 6.58727 11.8586Z"
        stroke="currentColor"
      />
      <path d="M10.2991 10.3933L14.7783 14.8725" stroke="currentColor" />
    </svg>
  );
}

/**
 * 搜索框右侧的**提交箭头**：抄自 harness 的 `IconRightUpOutlineArtwork`
 * （浏览器面板里那颗"在外部打开"用的就是它；这里借来做"搜过去"的动作图标）。
 *
 * 注意原版是"一条填充 path + 一条描边 path"，`fill="currentColor"` 那条要**保持填充** ✓。
 *
 * @param size - 边长（px），默认 14。
 */
export function SubmitArrowIcon({ size = 14 }: { size?: number }) {
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
        d="M11.7256 2.77441C12.5538 2.77469 13.2256 3.44616 13.2256 4.27441V10.1416H12.2256V4.27441C12.2256 3.99844 12.0015 3.77469 11.7256 3.77441H5.7207V2.77441H11.7256Z"
        fill="currentColor"
      />
      <path d="M2.77441 13.2255L12.3756 3.62427" stroke="currentColor" />
    </svg>
  );
}
