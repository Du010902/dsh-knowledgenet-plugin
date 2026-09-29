/**
 * 孤点（独立节点）的**分量锚点间距** —— 用户实测 ✗：「建了几个独立节点之后，它们之间离得太远了」。
 *
 * 根因在上游 `graph3d/topology.ts` 的 `componentAnchors`：每个孤点自成一个分量，而分量是沿黄金角螺旋
 * **一路往外排**的，每个占 `radius*2 + gap = 3.5 × edgeLength`，于是孤点被摆到离原点 235…739 处
 * （主分量的云团半径才 ~58），相机为了把它们装进视口只能一路拉远。
 *
 * 这条测试用**构建期同一份补丁字符串**（`scripts/layout-anchor-patch.mjs`）把补丁应用到 graph3d 的临时副本上，
 * 直接量锚点坐标：数字一退回去就红 ✓（上游副本仍然字节一致 ✓）。
 */
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import { patchAnchorSpacing } from "../scripts/layout-anchor-patch.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, "..");
const GRAPH3D = path.join(PLUGIN, "src", "vendor", "upstream", "graph3d");

const { DEFAULT_LAYOUT_PARAMS } = await import(pathToFileURL(path.join(GRAPH3D, "types.ts")).href);
const original = await import(pathToFileURL(path.join(GRAPH3D, "topology.ts")).href);

/** 把补丁打到 graph3d 的临时副本上，再导入它 */
async function patchedTopology() {
  const dir = await mkdtemp(path.join(tmpdir(), "kn-anchor-"));
  try {
    await cp(GRAPH3D, dir, { recursive: true });
    const target = path.join(dir, "topology.ts");
    await writeFile(target, patchAnchorSpacing(await readFile(target, "utf8")), "utf8");
    return await import(pathToFileURL(target).href);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const patched = await patchedTopology();

const params = DEFAULT_LAYOUT_PARAMS;
const at = (anchors, i) => [anchors[i * 3], anchors[i * 3 + 1], anchors[i * 3 + 2]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const topoOf = (components) => ({
  ids: components.flat().map((i) => String(i).padStart(8, "0")),
  components,
});

/** 统计：这组节点之间最近/最远距离，以及离原点最远的一个 */
function spread(anchors, nodes) {
  let min = Infinity;
  let max = 0;
  let farthest = 0;
  for (let i = 0; i < nodes.length; i += 1) {
    farthest = Math.max(farthest, dist(at(anchors, nodes[i]), [0, 0, 0]));
    for (let j = i + 1; j < nodes.length; j += 1) {
      const d = dist(at(anchors, nodes[i]), at(anchors, nodes[j]));
      min = Math.min(min, d);
      max = Math.max(max, d);
    }
  }
  return { min, max, farthest };
}

/** 用户截图那种形状：1 个 3 点分量 + 5 个孤点 */
const MIXED = topoOf([[0, 1, 2], [3], [4], [5], [6], [7]]);
const SINGLES = [3, 4, 5, 6, 7];

describe("孤点的锚点间距（回归：独立节点之间离得太远）", () => {
  it("孤点之间的最近/最远距离至少收窄到原来的 1/4", () => {
    const before = spread(original.componentAnchors(MIXED, params), SINGLES);
    const after = spread(patched.componentAnchors(MIXED, params), SINGLES);
    assert.ok(after.min * 4 < before.min, `最近 ${before.min.toFixed(0)} → ${after.min.toFixed(0)}，收得不够`);
    assert.ok(after.max * 5 < before.max, `最远 ${before.max.toFixed(0)} → ${after.max.toFixed(0)}，收得不够`);
  });

  it("孤点不再被螺旋推到画布边缘（落在主分量外侧的一层薄壳上）", () => {
    const before = spread(original.componentAnchors(MIXED, params), SINGLES);
    const after = spread(patched.componentAnchors(MIXED, params), SINGLES);
    assert.ok(after.farthest * 7 < before.farthest, `离原点最远 ${before.farthest.toFixed(0)} → ${after.farthest.toFixed(0)}`);
    assert.ok(after.farthest < params.edgeLength * 3, `孤点最远 ${after.farthest.toFixed(0)}，应与 Ledge=${params.edgeLength} 同量级`);
  });

  it("孤点之间仍留出碰撞半径的余地（不会挤成一坨）", () => {
    const cases = [
      Array.from({ length: 6 }, (_, i) => [i]),
      Array.from({ length: 30 }, (_, i) => [i]),
    ];
    for (const components of cases) {
      const nodes = components.flat();
      const stats = spread(patched.componentAnchors(topoOf(components), params), nodes);
      assert.ok(stats.min > params.collideRadius * 2, `最近距离必须大于两个碰撞半径（${components.length} 个孤点，实际 ${stats.min.toFixed(1)}）`);
      assert.ok(stats.farthest < params.edgeLength * 3, `孤点必须留在紧凑范围里（${components.length} 个孤点，实际 ${stats.farthest.toFixed(1)}）`);
    }
  });

  it("补丁真的挂在构建里，而且产物就是打过补丁的那份", async () => {
    const build = await readFile(path.join(PLUGIN, "build.mjs"), "utf8");
    assert.ok(build.includes("anchorSpacingPatchPlugin()"), "build.mjs 必须把孤点间距补丁挂到构建上");
    const client = await readFile(path.join(PLUGIN, "client.js"), "utf8");
    assert.ok(client.includes("params.collideRadius * 1.2"), "产物里的布局 Worker 源码必须是打过补丁的");
    assert.equal(client.includes("params.edgeLength * 1.5"), false, "产物里不该再有旧的锚点间距写法");
  });
});
