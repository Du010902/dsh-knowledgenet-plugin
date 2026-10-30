/**
 * 空间布局的**分量锚点间距**补丁点（上游 `graph3d/topology.ts` 的 `componentAnchors`）。
 *
 * 背景（用户实测 ✗）：分量原本沿黄金角螺旋**一路往外排**，每个占 `radius * 2 + edgeLength * 1.5`，
 * 分量一多，锚点就被摆到越来越远的球壳上：
 * - 孤点：离原点 235…739（主分量云团半径才 ~58）；
 * - 多节点节点群：分量中心同样按 89 / 267 / 419 … 递增。
 *
 * 相机为了把整张图装进视口只能一路拉远 ⇒ 看起来"群与群之间很远，群内部又挤成一团" ✗
 * （用户 2026-10-30 截图：一个 9 点群、一个 5 点群、一个 3 点群 + 4 个孤点）。
 *
 * 修法：**所有分量都放在同一个紧凑薄壳上**（大分量略靠外、小分量略靠里），
 * 锚点半径不再随分量数量线性增长；群内节点间距交给斥力 / 碰撞 / 弹簧去撑开，
 * 群与群之间再靠节点间的普通斥力自然分开 ⇒ 相机可以明显拉近，群内标签不再挤 ✓。
 *
 * 为什么单独一个文件：`build.mjs` 用它做构建期替换，`tests/layout-spacing.test.mjs` 用**同一份字符串**
 * 把补丁应用到临时副本上量结果 —— 补丁点只写一遍，测试量的就是构建时真正用的那一份 ✓。
 */

/** 上游原文（补丁点）：分量沿"累计半径螺旋"一路往外排 */
export const ANCHOR_SPACING_NEEDLE = [
  "  let cursor = 0;",
  "  components.forEach((component, k) => {",
  "    const radius = expectedCloudRadius(params.edgeLength, component.length);",
  "    const gap = params.edgeLength * 1.5;",
  "    const [ux, uy, uz] = unit(k);",
  "    const center: Vec3 = [ux * (cursor + radius), uy * (cursor + radius), uz * (cursor + radius)];",
  "    for (const i of component) {",
  "      anchors[i * 3] = center[0];",
  "      anchors[i * 3 + 1] = center[1];",
  "      anchors[i * 3 + 2] = center[2];",
  "    }",
  "    cursor += radius * 2 + gap;",
  "  });",
  "  return anchors;",
].join("\n");

/**
 * 替换成：所有分量放在同一个紧凑薄壳上，不再沿累计半径越排越远。
 *
 * 半径仍按分量大小区分（多节点分量取云团半径 × 0.85，孤点只占碰撞半径），
 * 但中心距离封顶在 `shell = maxRadius + 0.45 × edgeLength` ✓。
 */
export const ANCHOR_SPACING_PATCHED = [
  "  const radii = components.map((component) => component.length === 1",
  "    ? params.collideRadius * 1.2",
  "    : expectedCloudRadius(params.edgeLength, component.length) * 0.85);",
  "  const maxRadius = Math.max(...radii);",
  "  const gap = params.edgeLength * 0.45;",
  "  /* 孤点很多时，薄壳半径要按黄金角分布的最小弦长兜底，避免锚点挤在一起 ✓ */",
  "  const separationAngle = Math.sqrt((4 * Math.PI) / Math.max(2, components.length));",
  "  const separationRadius = (params.collideRadius * 1.2) / Math.sin(separationAngle / 2);",
  "  const shell = Math.max(maxRadius + gap, separationRadius);",
  "  components.forEach((component, k) => {",
  "    const [ux, uy, uz] = unit(k);",
  "    /* 大分量略靠外、小分量略靠里：总半径由 shell 封顶，不随 k 累加 ✓ */",
  "    const reach = shell + (radii[k] - maxRadius) * 0.3;",
  "    const center: Vec3 = [ux * reach, uy * reach, uz * reach];",
  "    for (const i of component) {",
  "      anchors[i * 3] = center[0];",
  "      anchors[i * 3 + 1] = center[1];",
  "      anchors[i * 3 + 2] = center[2];",
  "    }",
  "  });",
  "  return anchors;",
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
