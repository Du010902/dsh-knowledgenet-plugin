/**
 * 空间视图**平面模式**（节点数 ≤ 3）的回归测试 —— 用户 2026-11-11 要求：
 * 「当节点数小于等于3时，在不改变节点表现形式或者是UI样式的前提下，
 *   以平面的方式展示，即无法用鼠标拖动旋转查看」。
 *
 * 三组断言：
 * 1. **布局**（构造期补丁，`scripts/space-flat-patch.mjs`）：flat 参数下 z 恒为 0
 *    （初始分布、旧坐标、迭代之后都不出现 z）；非 flat 的三维布局照常保留 z ✓；
 * 2. **控制器**：`setFlat(true)` 之后拖动**不旋转**（图谱 S / 相机 Q / 机位都不动）、
 *    相机固定正面、按平面包围盒取景；`setFlat(false)` 后拖动恢复旋转 ✓；
 * 3. **构建接线**：`build.mjs` 挂着平面布局补丁，产物里确实是打过补丁的代码 ✓。
 */
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

import { InteriorNavigation } from "../src/client/interior-controller.ts";
import { SPACE_FLAT_MAX_NODES, isFlatGraph } from "../src/client/space-flat.ts";
import { patchFlatLayoutCore, patchFlatTopology } from "../scripts/space-flat-patch.mjs";
import { boundsOf } from "../src/vendor/upstream/graph3d/camera.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, "..");
const GRAPH3D = path.join(PLUGIN, "src", "vendor", "upstream", "graph3d");

const VIEWPORT = { width: 800, height: 600 };
const FOV = 50;

/* ============================ 构造期补丁：平面布局 ============================ */

/**
 * 用**构建期同一份补丁**（`scripts/space-flat-patch.mjs`）把 graph3d 打到临时副本上，
 * 再导入它量 z 坐标 ✓（上游副本仍然字节一致 ✓）。
 *
 * 临时目录放在插件根下（不是系统临时目录）：`layoutCore.ts` 要解析 `d3-force-3d`，
 * 只有从仓库内的路径向上查找才能命中 `node_modules` ✓。
 */
async function loadPatchedGraph3d() {
  const dir = await mkdtemp(path.join(PLUGIN, "tmp", "space-flat-"));
  try {
    await cp(GRAPH3D, dir, { recursive: true });
    for (const [file, patch] of [["topology.ts", patchFlatTopology], ["layoutCore.ts", patchFlatLayoutCore]]) {
      const target = path.join(dir, file);
      await writeFile(target, patch(await readFile(target, "utf8")), "utf8");
    }
    return {
      topology: await import(pathToFileURL(path.join(dir, "topology.ts")).href),
      layout: await import(pathToFileURL(path.join(dir, "layoutCore.ts")).href),
      types: await import(pathToFileURL(path.join(dir, "types.ts")).href),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const patched = await loadPatchedGraph3d();
const original = {
  topology: await import(pathToFileURL(path.join(GRAPH3D, "topology.ts")).href),
  layout: await import(pathToFileURL(path.join(GRAPH3D, "layoutCore.ts")).href),
  types: await import(pathToFileURL(path.join(GRAPH3D, "types.ts")).href),
};

const IDS = ["a", "b", "c"];
const EDGES = [[0, 1], [1, 2]];
const FLAT_PARAMS = { ...patched.types.DEFAULT_LAYOUT_PARAMS, flat: true };
const SOLID_PARAMS = { ...original.types.DEFAULT_LAYOUT_PARAMS };

/** 全部 z（按节点取） */
function zValues(positions, count) {
  const list = [];
  for (let index = 0; index < count; index += 1) list.push(positions[index * 3 + 2]);
  return list;
}

function xySpread(positions, count) {
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  for (let index = 0; index < count; index += 1) {
    const x = positions[index * 3];
    const y = positions[index * 3 + 1];
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return { width: maxX - minX, height: maxY - minY };
}

describe("平面布局（构造期补丁）：节点都落在 z = 0 平面上", () => {
  it("threshold 口径：≤ 3 平面、4 起三维（阈值只写一处）", () => {
    assert.equal(SPACE_FLAT_MAX_NODES, 3);
    assert.equal(isFlatGraph(0), false, "空图没有可展示的内容，不算平面模式");
    for (const count of [1, 2, 3]) assert.equal(isFlatGraph(count), true, `${count} 个节点应走平面模式`);
    for (const count of [4, 5, 40]) assert.equal(isFlatGraph(count), false, `${count} 个节点应走三维模式`);
  });

  it("flat 的初始分布 z 恒为 0，且在平面上铺得开（不会缩成一个点）", () => {
    const topo = patched.topology.buildTopology(IDS, EDGES, { distances: false });
    const flat = patched.topology.initialPositions(topo, FLAT_PARAMS);
    for (const z of zValues(flat, IDS.length)) assert.equal(z, 0, "平面模式的初始 z 必须是 0");
    const spread = xySpread(flat, IDS.length);
    assert.ok(spread.width > 1 && spread.height > 1, `平面上要铺开：${spread.width.toFixed(1)} × ${spread.height.toFixed(1)}`);
  });

  it("**非** flat 的三维初始分布仍然有 z 深度（补丁只压平面、不压三维 ✗）", () => {
    const topo = original.topology.buildTopology(IDS, EDGES, { distances: false });
    const solid = original.topology.initialPositions(topo, SOLID_PARAMS);
    assert.ok(
      zValues(solid, IDS.length).some((z) => Math.abs(z) > 1e-6),
      "三维初始分布本来就该有深度；如果这里全 0，说明补丁把三维也压平了 ✗",
    );
  });

  it("flat 布局迭代 200 步之后 z 仍然是 0（2D 迭代不产生 z ✓）", () => {
    const runtime = patched.layout.createLayout({
      ids: IDS,
      edges: EDGES,
      previous: null,
      params: FLAT_PARAMS,
    });
    for (let round = 0; round < 10; round += 1) patched.layout.stepLayout(runtime, 20);
    const positions = patched.layout.readPositions(runtime.nodes);
    for (const z of zValues(positions, IDS.length)) assert.equal(z, 0, "平局模式迭代之后 z 必须仍是 0");
    const spread = xySpread(positions, IDS.length);
    assert.ok(spread.width > 1, `收敛后的平面布局要有宽度：${spread.width.toFixed(1)}`);
  });

  it("flat 布局忽略旧坐标的 z（旧坐标可能来自 3D 视图 ⇒ 压平后不能前后错位）", () => {
    const previous = Float32Array.from([0, 0, 40, 40, 0, -60, -30, 30, 25]);
    const runtime = patched.layout.createLayout({
      ids: IDS,
      edges: EDGES,
      previous,
      params: FLAT_PARAMS,
    });
    for (let round = 0; round < 6; round += 1) patched.layout.stepLayout(runtime, 10);
    const positions = patched.layout.readPositions(runtime.nodes);
    for (const z of zValues(positions, IDS.length)) assert.equal(z, 0, "旧坐标的 z 必须被忽略");
  });

  it("**非** flat 的布局仍是三维的（z 不被抹掉 ✓）", () => {
    const runtime = original.layout.createLayout({
      ids: IDS,
      edges: EDGES,
      previous: null,
      params: SOLID_PARAMS,
    });
    original.layout.stepLayout(runtime, 1);
    const positions = original.layout.readPositions(runtime.nodes);
    assert.ok(
      zValues(positions, IDS.length).some((z) => Math.abs(z) > 1e-6),
      "三维布局的 z 不该被平面补丁抹掉 ✗",
    );
  });
});

/* ============================ 控制器：平面模式 ============================ */

/** 极简 DOM 桩：只实现控制器用到的那几个方法 ✓（与 interior-controller.test.mjs 同构） */
function makeElement() {
  const handlers = new Map();
  return {
    dataset: {},
    addEventListener: (type, handler) => { handlers.set(type, handler); },
    removeEventListener: (type) => { handlers.delete(type); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: VIEWPORT.width, height: VIEWPORT.height }),
    focus: () => {},
    contains: () => false,
    setPointerCapture: () => {},
    hasPointerCapture: () => true,
    releasePointerCapture: () => {},
    emit(type, event = {}) {
      const handler = handlers.get(type);
      if (handler === undefined) return false;
      handler({ preventDefault() {}, ...event });
      return true;
    },
    has(type) {
      return handlers.has(type);
    },
  };
}

let globals = null;

/** 装全局桩：控制器构造时会挂 window/document 监听 ✓ */
function installGlobals() {
  const windowHandlers = new Map();
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    matchMedia: globalThis.matchMedia,
  };
  globalThis.window = {
    addEventListener: (type, handler) => { windowHandlers.set(type, handler); },
    removeEventListener: (type) => { windowHandlers.delete(type); },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  };
  globalThis.document = {
    hidden: false,
    activeElement: null,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  /* 关掉动画：定位/取景一步到位，测试不必等 620ms ✓ */
  globalThis.matchMedia = () => ({ matches: true });
  return { windowHandlers, restore() {
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.matchMedia = previous.matchMedia;
  } };
}

beforeEach(() => { globals = installGlobals(); });
afterEach(() => { globals?.restore(); globals = null; });

/** 3 个节点围成的小平面（z 全 0）；重心 (0, 20) */
const FLAT_LAYOUT = Float32Array.from([-80, -30, 0, 80, -30, 0, 0, 70, 0]);
const FLAT_BOUNDS = { center: [0, 20, 0], radius: Math.hypot(80, 50), min: [-80, -30, 0], max: [80, 70, 0] };
const FLAT_COUNT = 3;

/** 造一个控制器（初始相机在 (0,0,900) 朝 −Z） */
function makeNavigation() {
  const element = makeElement();
  const calls = { select: [], hover: [], selectEdge: [], edgeHover: [], context: [], locate: 0, camera: 0, user: 0 };
  const projected = [];
  const navigation = new InteriorNavigation({
    element,
    initial: { target: [0, 0, 0], distance: 900, angle: 0, pitch: 0 },
    edgeLength: 40,
    getProjected: () => projected,
    getEdges: () => [],
    onSelect: (index) => { calls.select.push(index); },
    onHover: (index) => { calls.hover.push(index); },
    onSelectEdge: (index) => { calls.selectEdge.push(index); },
    onEdgeHover: (index) => { calls.edgeHover.push(index); },
    onContextMenu: (hit) => { calls.context.push(hit); },
    onLocate: () => { calls.locate += 1; },
    onCameraChange: () => { calls.camera += 1; },
    onUserCameraInput: () => { calls.user += 1; },
  });
  navigation.setFrameContext(FLAT_BOUNDS, VIEWPORT, FLAT_LAYOUT, FLAT_COUNT);
  return { navigation, element, calls, projected };
}

/** 按引擎的真实顺序进入平面模式：先 setFlat，再逐帧 setFrameContext 取景 ✓ */
function enterFlat(navigation) {
  navigation.setFlat(true);
  navigation.setFrameContext(FLAT_BOUNDS, VIEWPORT, FLAT_LAYOUT, FLAT_COUNT);
  navigation.fitAll(FLAT_LAYOUT, FLAT_COUNT, false, "initial");
}

/** 用控制器自己的等效基把布局点投影成屏幕坐标 */
function project(navigation, point) {
  const basis = navigation.basis();
  const d = [
    point[0] - basis.position[0],
    point[1] - basis.position[1],
    point[2] - basis.position[2],
  ];
  const depth = d[0] * basis.forward[0] + d[1] * basis.forward[1] + d[2] * basis.forward[2];
  assert.ok(depth > 0, "测试点必须在相机前方");
  const focal = 1 / Math.tan((FOV * Math.PI) / 360);
  const scale = (focal * (VIEWPORT.height / 2)) / depth;
  const right = d[0] * basis.right[0] + d[1] * basis.right[1] + d[2] * basis.right[2];
  const up = d[0] * basis.up[0] + d[1] * basis.up[1] + d[2] * basis.up[2];
  return { x: VIEWPORT.width / 2 + right * scale, y: VIEWPORT.height / 2 - up * scale };
}

describe("控制器：节点数 ≤ 3 时平面展示、拖动不旋转", () => {
  it("进入平面模式后相机固定在正面（姿态 = 单位四元数、机位在球心正前方）", () => {
    const { navigation } = makeNavigation();
    enterFlat(navigation);
    const snapshot = navigation.interiorSnapshot();
    assert.deepEqual([...snapshot.scene], [0, 0, 0, 1], "图谱旋转 S 要归位（平面展示 ⇒ 不能带任意朝向 ✓）");
    assert.deepEqual([...snapshot.view], [0, 0, 0, 1], "相机姿态 Q 要归位到正面 ✓");
    assert.deepEqual([...navigation.basis().forward], [0, 0, -1], "视线方向必须是 −Z（正面）");
    assert.equal(navigation.flatMode, true, "控制器要记住自己处在平面模式 ✓");
  });

  it("平面模式拖动 ⇒ 图谱不旋转、相机不动（这就是「无法用鼠标拖动旋转查看」✓）", () => {
    const { navigation, element } = makeNavigation();
    enterFlat(navigation);
    const before = navigation.interiorSnapshot();
    element.emit("pointerdown", { button: 0, pointerId: 1, clientX: 400, clientY: 300, shiftKey: false });
    for (let step = 1; step <= 40; step += 1) {
      element.emit("pointermove", { pointerId: 1, clientX: 400 + step * 12, clientY: 300 + step * 4 });
    }
    element.emit("pointerup", { pointerId: 1, clientX: 880, clientY: 460 });
    const after = navigation.interiorSnapshot();
    assert.deepEqual([...after.scene], [...before.scene], "平面模式拖动不能旋转图谱（S 不动 ✓）");
    assert.deepEqual([...after.view], [...before.view], "平面模式拖动不能改相机姿态（Q 不动 ✓）");
    assert.deepEqual([...after.eye], [...before.eye], "平面模式拖动不能移动相机 ✓");
  });

  it("平面模式拖动之后仍按「拖动」处理（不误触发选中）", () => {
    const { navigation, element, calls } = makeNavigation();
    enterFlat(navigation);
    element.emit("pointerdown", { button: 0, pointerId: 1, clientX: 400, clientY: 300, shiftKey: false });
    element.emit("pointermove", { pointerId: 1, clientX: 460, clientY: 320 });
    element.emit("pointerup", { pointerId: 1, clientX: 460, clientY: 320 });
    assert.deepEqual(calls.select, [], "拖动不该被当成点击选中 ✓");
  });

  it("平面模式短点击节点仍然选中（交互只删旋转、不删选择 ✓）", () => {
    const { navigation, element, projected, calls } = makeNavigation();
    enterFlat(navigation);
    const screen = project(navigation, [0, 70, 0]);
    projected.push({ index: 2, id: "c", x: screen.x, y: screen.y, depth: 100, radius: 6, visible: true });
    element.emit("pointerdown", { button: 0, pointerId: 1, clientX: screen.x, clientY: screen.y, shiftKey: false });
    element.emit("pointerup", { pointerId: 1, clientX: screen.x, clientY: screen.y });
    assert.deepEqual(calls.select, [2], "平面模式下短点击仍要能选中节点 ✓");
  });

  it("平面模式 Shift 拖动仍可平移（只动机位、不改朝向 ✓）", () => {
    const { navigation, element } = makeNavigation();
    enterFlat(navigation);
    const before = navigation.interiorSnapshot();
    element.emit("pointerdown", { button: 0, pointerId: 1, clientX: 400, clientY: 300, shiftKey: true });
    element.emit("pointermove", { pointerId: 1, clientX: 460, clientY: 300 });
    element.emit("pointerup", { pointerId: 1, clientX: 460, clientY: 300 });
    const after = navigation.interiorSnapshot();
    assert.notDeepEqual([...after.eye], [...before.eye], "Shift 拖动应移动机位");
    assert.deepEqual([...after.view], [...before.view], "平移不改朝向 ✓");
  });

  it("离开平面模式（节点变多）⇒ 拖动恢复旋转 ✓", () => {
    const { navigation, element } = makeNavigation();
    enterFlat(navigation);
    navigation.setFlat(false);
    navigation.setFrameContext(FLAT_BOUNDS, VIEWPORT, FLAT_LAYOUT, FLAT_COUNT);
    const before = navigation.interiorSnapshot();
    element.emit("pointerdown", { button: 0, pointerId: 1, clientX: 400, clientY: 300, shiftKey: false });
    element.emit("pointermove", { pointerId: 1, clientX: 470, clientY: 330 });
    const after = navigation.interiorSnapshot();
    assert.equal(navigation.flatMode, false, "已经离开平面模式 ✓");
    assert.notDeepEqual([...after.scene], [...before.scene], "三维模式下拖动应绕球心旋转图谱 ✓");
  });

  it("平面取景：节点撑满可用区域、不被裁切（不缩成中间一小团 ✗）", () => {
    const { navigation } = makeNavigation();
    enterFlat(navigation);
    const points = [[-80, -30, 0], [80, -30, 0], [0, 70, 0]];
    const screens = points.map((point) => project(navigation, point));
    for (const [index, screen] of screens.entries()) {
      assert.ok(screen.x > 12 && screen.x < VIEWPORT.width - 12, `节点 ${index} 横向越界：x=${screen.x.toFixed(1)}`);
      assert.ok(screen.y > 64 && screen.y < VIEWPORT.height - 64, `节点 ${index} 纵向越界：y=${screen.y.toFixed(1)}`);
    }
    const xs = screens.map((screen) => screen.x);
    const ys = screens.map((screen) => screen.y);
    const widthRatio = (Math.max(...xs) - Math.min(...xs)) / VIEWPORT.width;
    const heightRatio = (Math.max(...ys) - Math.min(...ys)) / VIEWPORT.height;
    assert.ok(widthRatio > 0.5, `平面图应撑满画布宽度：${(widthRatio * 100).toFixed(0)}%`);
    assert.ok(heightRatio > 0.3, `平面图应撑开高度：${(heightRatio * 100).toFixed(0)}%`);
    assert.ok(
      navigation.measureCoverage(FLAT_LAYOUT, FLAT_COUNT) > 0.5,
      "平面取景的占比不能退回到「旋转安全球」那种小图 ✗",
    );
  });

  it("布局结算后的复核：平面模式把球心重新对准**最终**几何中心（防插值坐标导致偏心 ✗）", () => {
    /*
     * 真实事故：收敛那次取景读到的是布局快照的**插值坐标**（视觉上比模拟慢约 90ms），
     * 相机又离得近（平面取景），最终坐标多挪的几个世界单位会被放大成「整张图偏上 + 顶部标签被裁」✗。
     * 这里模拟「结算取景用旧坐标、随后最终坐标到位」：复核必须把球心挪到最终包围盒中心 ✓。
     */
    const { navigation } = makeNavigation();
    enterFlat(navigation);
    /* 最终坐标：整体向右 25、向下 -15（相对进入时的图形） */
    const settled = Float32Array.from([
      FLAT_LAYOUT[0] + 25, FLAT_LAYOUT[1] - 15, 0,
      FLAT_LAYOUT[3] + 25, FLAT_LAYOUT[4] - 15, 0,
      FLAT_LAYOUT[6] + 25, FLAT_LAYOUT[7] - 15, 0,
    ]);
    const settledBounds = boundsOf(settled, FLAT_COUNT);
    navigation.setFrameContext(settledBounds, VIEWPORT, settled, FLAT_COUNT);
    navigation.ensureCoverage(settled, FLAT_COUNT);
    const center = navigation.interiorSnapshot().center;
    assert.ok(Math.abs(center[0] - settledBounds.center[0]) < 1e-6, `球心 x 要对准最终中心：${center[0]}`);
    assert.ok(Math.abs(center[1] - settledBounds.center[1]) < 1e-6, `球心 y 要对准最终中心：${center[1]}`);
    const projectedCenter = project(navigation, [settledBounds.center[0], settledBounds.center[1], 0]);
    assert.ok(Math.abs(projectedCenter.x - VIEWPORT.width / 2) < 1, `最终中心应投影在画布中线：${projectedCenter.x.toFixed(1)}`);
    assert.ok(Math.abs(projectedCenter.y - VIEWPORT.height / 2) < 1, `最终中心应投影在画布中线：${projectedCenter.y.toFixed(1)}`);
  });
});

/* ============================ 构建接线 ============================ */

describe("构建接线：补丁真的挂在构建上", () => {
  it("build.mjs 导入并挂载平面布局补丁 + 引擎平面模式接线", async () => {
    const build = await readFile(path.join(PLUGIN, "build.mjs"), "utf8");
    for (const needle of [
      "patchFlatTopology",
      "patchFlatLayoutCore",
      "flatLayoutPatchPlugin()",
      "knIsFlatGraph",
      "setFlat(knFlat)",
      "FLAT_SUBSTITUTIONS",
    ]) {
      assert.ok(build.includes(needle), `build.mjs 里要有：${needle}`);
    }
  });

  it("产物里的布局/引擎/控制器都是打过补丁的那一份", async () => {
    const client = await readFile(path.join(PLUGIN, "client.js"), "utf8");
    for (const [needle, what] of [
      ["params.flat === true ? 2 : 3", "Worker 的 2D 迭代维数"],
      ["out[index * 3 + 2] = params.flat === true ? 0", "初始分布的 z=0"],
      ["z: input.params.flat === true ? 0", "旧坐标的 z 忽略"],
      ["this.navigation.setFlat(knFlat)", "引擎按节点数切换平面模式"],
      ["flatFitDistance", "控制器的平面取景"],
      ["SPACE_FLAT_MAX_NODES", "统一阈值"],
    ]) {
      assert.ok(client.includes(needle), `产物里要有「${what}」：${needle}`);
    }
  });
});
