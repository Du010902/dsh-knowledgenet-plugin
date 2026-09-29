/**
 * 空间布局的**分量锚点间距**补丁点（上游 `graph3d/topology.ts` 的 `componentAnchors`）。
 *
 * 背景（用户实测 ✗）：孤点（单节点分量）原来按 `expectedCloudRadius(edgeLength, 1) = edgeLength` 铺开，
 * 间隔是 `radius * 2 + edgeLength * 1.5 = 3.5 × 36 = 126` 世界单位；而主分量（3 个点）的云团半径才 ~68。
 * 于是一张「一个 3 点分量 + 5 个孤点」的图上，孤点锚点被摆到离原点 235 / 361 / 487 / 613 / 739 处，
 * 彼此最近也有 528 —— 相机为了把它们全装进视口只能一路拉远，看起来就是"孤点离得离谱地远" ✗。
 *
 * 修法：**孤点只占 `collideRadius` 那么大一块地方**（11 的碰撞半径 ⇒ 给 1.2 倍就够，节点不会重叠 ✓），
 * 分量之间的间隙也从 `1.5 Ledge` 收到 `0.45 Ledge`；顺带把多节点分量的锚点半径乘 0.85 收一点。
 * 孤点于是落在 13 / 56 / 98 / 141 / 183 处，与主分量同一量级 ✓。
 *
 * 为什么单独一个文件：`build.mjs` 用它做构建期替换，`tests/layout-spacing.test.mjs` 用**同一份字符串**
 * 把补丁应用到临时副本上量结果 —— 补丁点只写一遍，测试量的就是构建时真正用的那一份 ✓。
 */

/** 上游原文（补丁点）：分量的锚点半径、分量间间隙、以及"沿螺旋一路往外推"的落点 */
export const ANCHOR_SPACING_NEEDLE = [
  "    const radius = expectedCloudRadius(params.edgeLength, component.length);",
  "    const gap = params.edgeLength * 1.5;",
  "    const [ux, uy, uz] = unit(k);",
  "    const center: Vec3 = [ux * (cursor + radius), uy * (cursor + radius), uz * (cursor + radius)];",
].join("\n");

/**
 * 替换成：孤点只占碰撞半径量级的一块，而且**锚定在一个固定的薄壳上**（不再跟着螺旋越走越远）。
 *
 * `shell` = `collideRadius × 1.2 + edgeLength × 2.2` ≈ 92（edgeLength 36）：
 * 恰好落在主分量（3 点云团半径 ~58）外侧一点点，孤点之间由黄金角方向自然分开 ✓。
 * 多节点分量仍按原来的螺旋推进（它们确实需要各自的空间），只是云团半径乘 0.85、间隙收到 0.45 Ledge。
 */
export const ANCHOR_SPACING_PATCHED = [
  "    /* 孤点（单节点分量）：不参与\"沿螺旋往外排\"——每多一个独立节点就把画布撑大一截是实测的毛病 ✗ */",
  "    const singleton = component.length === 1;",
  "    const radius = singleton",
  "      ? params.collideRadius * 1.2",
  "      : expectedCloudRadius(params.edgeLength, component.length) * 0.85;",
  "    const gap = singleton ? params.collideRadius * 2 : params.edgeLength * 0.45;",
  "    const [ux, uy, uz] = unit(k);",
  "    const shell = params.collideRadius * 1.2 + params.edgeLength * 2.2;",
  "    const reach = singleton ? Math.min(cursor + radius, shell) : cursor + radius;",
  "    const center: Vec3 = [ux * reach, uy * reach, uz * reach];",
].join("\n");

/**
 * 应用补丁；补丁点找不到就抛（构建期与测试共用同一份判定 ✓）。
 * @param code - 上游 `topology.ts` 的源码。
 * @returns 打过补丁的源码。
 */
export function patchAnchorSpacing(code) {
  if (!code.includes(ANCHOR_SPACING_NEEDLE)) {
    throw new Error(
      "上游 topology.ts 的分量锚点写法变了：请同步更新 scripts/layout-anchor-patch.mjs 的补丁点。\n"
      + `期望片段：\n${ANCHOR_SPACING_NEEDLE}`,
    );
  }
  return code.replace(ANCHOR_SPACING_NEEDLE, ANCHOR_SPACING_PATCHED);
}
