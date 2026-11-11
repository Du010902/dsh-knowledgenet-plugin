/**
 * 空间视图的**平面模式**判定（用户 2026-11-11 要求）。
 *
 * 节点数 ≤ `SPACE_FLAT_MAX_NODES` 时：
 * - 布局压到 **z = 0 平面**（`scripts/space-flat-patch.mjs` 的构造期补丁 ✓）；
 * - 相机固定在**正面**（+Z 看向 −Z），拖动**不再旋转图谱** ✓；
 * - 节点的绘制方式与 UI 样式**一律不变**（球体、颜色、标签、光圈、工具栏都照旧 ✓）。
 *
 * 为什么单独成模块：`build.mjs` 注入到上游 `graph3d/engine.ts` 的补丁、插件自有的
 * 导航控制器（`interior-controller.ts`）与单测都要用**同一份阈值** —— 阈值写两处迟早会漂 ✓。
 */

/** 平面模式的节点数上限：**≤ 这个数**就是平面模式 */
export const SPACE_FLAT_MAX_NODES = 3;

/**
 * 节点数是否落在平面模式范围内。
 *
 * 空图（0）不算：它连可展示的内容都没有，走三维那套空场景逻辑即可。
 *
 * @param nodeCount - 当前场景里的节点数。
 * @returns 是否按平面模式展示。
 */
export function isFlatGraph(nodeCount: number): boolean {
  return Number.isFinite(nodeCount) && nodeCount > 0 && nodeCount <= SPACE_FLAT_MAX_NODES;
}
