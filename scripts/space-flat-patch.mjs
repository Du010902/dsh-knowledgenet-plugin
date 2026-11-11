/**
 * 空间视图**平面模式**的布局补丁点（上游 `graph3d/topology.ts` + `graph3d/layoutCore.ts`）。
 *
 * 背景（用户 2026-11-11 要求）：节点数 ≤ 3 时「以平面的方式展示，即无法用鼠标拖动旋转查看」。
 * 平面展示不只是锁相机 —— 三维布局会把两三个节点摆出真实的 z 深度，正面看仍会前后错位、
 * 甚至沿视线方向叠在一起。因此布局本身也要压成平面：
 *
 * - `initialPositions()`：平面模式下初始坐标的 z 恒为 0（不再从球面分布取 z）✓；
 * - `createNodes()`：平面模式下即使带着旧坐标（z 非 0）也从 z = 0 起步 ✓；
 * - `forceSimulation(nodes, 3)` → 平面模式传 **2**：d3-force-3d 只迭代 x/y，
 *   z 不再被积分，自定义力写进去的 vz 也不会生效 ✓（`forceSimulation.tick()` 的
 *   `nDim > 2` 分支不执行）。
 *
 * 为什么补丁在构造期而不是运行期改 `positions`：布局缓存、插值、拾取、标签全都读同一份
 * 坐标数组；只在渲染前压平会让「物理里在远处」的节点投影到近处（互相穿插 ✗）。
 *
 * 为什么单独一个文件：`build.mjs` 用它做构造期替换，`tests/space-flat.test.mjs` 用**同一份字符串**
 * 把补丁应用到临时副本上量 z 坐标 —— 补丁点只写一遍，测试量的就是构建时真正用的那一份 ✓。
 */

/** `topology.ts` 的 `initialPositions()`：平面模式不动 z（补丁点） */
export const FLAT_INITIAL_Z_NEEDLE =
  "      out[index * 3 + 2] = anchors[index * 3 + 2]! + Math.sin(theta) * r * local;";

/** 替换成：平面模式 z 恒为 0；三维模式保持原样 ✓ */
export const FLAT_INITIAL_Z_PATCHED = [
  "      /* 平面模式：初始分布就落在 z = 0 平面上（2D 迭代不会再把 z 抬起来 ✓） */",
  "      out[index * 3 + 2] = params.flat === true ? 0 : anchors[index * 3 + 2]! + Math.sin(theta) * r * local;",
].join("\n");

/** `layoutCore.ts` 的 `createNodes()`：平面模式从 z = 0 起步（补丁点） */
export const FLAT_NODE_Z_NEEDLE =
  "      z: known ? previous![i * 3 + 2]! : initial[i * 3 + 2]!,";

/** 替换成：平面模式忽略旧坐标的 z（旧坐标可能来自 3D 视图 ✓） */
export const FLAT_NODE_Z_PATCHED =
  "      z: input.params.flat === true ? 0 : known ? previous![i * 3 + 2]! : initial[i * 3 + 2]!,";

/**
 * `layoutCore.ts` 的 `forceSimulation(nodes, 3)`（补丁点）。
 *
 * 2 个维度 = 只在 x/y 上迭代：这是 d3-force-3d 自己的 `numDimensions` 语义，
 * 不是「把 z 速度清零」这种近似 ✓。
 */
export const FLAT_SIMULATION_NEEDLE = "  const simulation = forceSimulation<LayoutNode>(nodes, 3)";

/** 替换成：平面模式用 2 维迭代 ✓ */
export const FLAT_SIMULATION_PATCHED = [
  "  /* 平面模式：d3-force-3d 只在 x/y 上迭代（z 恒为 0，节点不会前后错位 ✓） */",
  "  const simulation = forceSimulation<LayoutNode>(nodes, params.flat === true ? 2 : 3)",
].join("\n");

/**
 * 应用 `topology.ts` 的平面补丁；补丁点找不到就抛（构造期与测试共用同一份判定 ✓）。
 *
 * @param code - 上游 `topology.ts` 的源码。
 * @returns 打过补丁的源码。
 */
export function patchFlatTopology(code) {
  if (!code.includes(FLAT_INITIAL_Z_NEEDLE)) {
    throw new Error(
      "上游 topology.ts 的 initialPositions 写法变了：请同步更新 scripts/space-flat-patch.mjs 的补丁点。\n"
      + `期望片段：\n${FLAT_INITIAL_Z_NEEDLE}`,
    );
  }
  return code.replace(FLAT_INITIAL_Z_NEEDLE, FLAT_INITIAL_Z_PATCHED);
}

/**
 * 应用 `layoutCore.ts` 的平面补丁（节点 z 起点 + 迭代维数）；补丁点找不到就抛 ✓。
 *
 * @param code - 上游 `layoutCore.ts` 的源码。
 * @returns 打过补丁的源码。
 */
export function patchFlatLayoutCore(code) {
  for (const [needle, what] of [
    [FLAT_NODE_Z_NEEDLE, "createNodes 的 z 坐标"],
    [FLAT_SIMULATION_NEEDLE, "forceSimulation 的维数"],
  ]) {
    if (!code.includes(needle)) {
      throw new Error(
        `上游 layoutCore.ts 的${what}写法变了：请同步更新 scripts/space-flat-patch.mjs 的补丁点。\n`
        + `期望片段：\n${needle}`,
      );
    }
  }
  return code
    .replace(FLAT_NODE_Z_NEEDLE, FLAT_NODE_Z_PATCHED)
    .replace(FLAT_SIMULATION_NEEDLE, FLAT_SIMULATION_PATCHED);
}
