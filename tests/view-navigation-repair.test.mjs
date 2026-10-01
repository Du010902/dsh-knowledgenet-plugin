/**
 * `design/view-navigation-repair-plan.md` 的回归测试。
 *
 * 每组对应文档里的一条缺陷，断言的是**修复后的行为**；多数用例在旧实现上会失败：
 * 球面求交返回 null ✗、动画提前提交终点 ✗、重排不重设球心 ✗、
 * 一端在身后的边点不中 ✗、小地图侧向符号跳变 ✗、缓存不分库 ✗。
 *
 * 文档要求"新的回归测试必须驱动插件实际使用的控制器及构建接线" ✓ ——
 * 所以这里一律用 `InteriorNavigation` 与真实产物接线，不碰上游 `SpaceNavigation` ✓。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

import { InteriorNavigation, RELAYOUT_EVENT } from "../src/client/interior-controller.ts";
import {
  anchorFromRay,
  displayBasis,
  effectiveBasis,
  minimapPoint,
  radiusAbout,
  shouldSampleTrail,
} from "../src/client/interior-navigation.ts";
import { clippedEdgeSegment, pickClippedEdge } from "../src/client/edge-picking.ts";
import {
  activeLibraryKey,
  cachedView,
  clearViewCache,
  libraryKeyOf,
  setActiveLibraryKey,
  storeView,
  viewCacheKeys,
} from "../src/client/view-cache.ts";
import { rotateVec } from "../src/client/trackball.ts";
import { projectPoint } from "../src/vendor/upstream/graph3d/camera.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const buildSource = await readFile(path.join(HERE, "..", "build.mjs"), "utf8");
const bundle = await readFile(path.join(HERE, "..", "client.js"), "utf8");
const panelSource = await readFile(path.join(HERE, "..", "src", "client", "GraphPanel.tsx"), "utf8");
const minimapSource = await readFile(path.join(HERE, "..", "src", "client", "InteriorMinimap.tsx"), "utf8");
const controllerSource = await readFile(path.join(HERE, "..", "src", "client", "interior-controller.ts"), "utf8");
const navigationSource = await readFile(path.join(HERE, "..", "src", "client", "interior-navigation.ts"), "utf8");
const edgePickingSource = await readFile(path.join(HERE, "..", "src", "client", "edge-picking.ts"), "utf8");

const VIEWPORT = { width: 800, height: 600 };
const FOV = 50;
const BOUNDS = { center: [0, 0, 0], radius: 300, min: [0, 0, 0], max: [0, 0, 0] };
const positionsOf = (points) => Float32Array.from(points.flat());

/* ============================ P1：跨库缓存隔离 ============================ */

describe("P1 视图缓存：按知识库身份分区", () => {
  afterEach(() => { clearViewCache(); setActiveLibraryKey(""); });

  it("身份优先用稳定 libraryId，退回库根路径，都没有则为空", () => {
    assert.equal(libraryKeyOf({ libraryId: "01H", root: "/a" }), "id:01H", "id 优先于根路径（换根目录仍沿用视角 ✓）");
    assert.equal(libraryKeyOf({ root: "/a" }), "root:/a", "没有 id 时用根路径");
    assert.equal(libraryKeyOf({ libraryId: "  ", root: "/a" }), "root:/a", "空白 id 不算");
    assert.equal(libraryKeyOf({}), "");
    assert.equal(libraryKeyOf(null), "");
  });

  it("A 库的视图不会被 B 库取到（含「两库共享同一批节点 ID」的情形）", () => {
    const cameraOf = (distance) => ({ target: [1, 2, 3], distance, angle: 0.1, pitch: 0.2, q: [0, 0, 0, 1] });
    storeView("id:A", cameraOf(111), true);
    storeView("id:B", cameraOf(222), true);
    assert.equal(cachedView("id:A").distance, 111, "A 拿自己的");
    assert.equal(cachedView("id:B").distance, 222, "B 拿自己的");
    assert.equal(cachedView("id:C"), null, "没存过的库拿 null（旧实现会拿到最后一个 ✗）");
    assert.deepEqual(viewCacheKeys().sort(), ["id:A", "id:B"]);
  });

  it("没收敛的视图不算数（沿用上游规则）；读写都深复制", () => {
    storeView("id:A", { target: [0, 0, 0], distance: 300, angle: 0, pitch: 0 }, false);
    assert.equal(cachedView("id:A"), null, "布局没收敛时存的相机只是自动取景 ✗");
    const camera = { target: [1, 2, 3], distance: 300, angle: 0, pitch: 0, q: [0, 0, 0, 1], knInterior: { center: [9, 9, 9] } };
    storeView("id:B", camera, true);
    camera.target[0] = 999;
    camera.knInterior.center[0] = 999;
    const got = cachedView("id:B");
    assert.equal(got.target[0], 1, "写入时要深复制");
    got.target[1] = 777;
    assert.equal(cachedView("id:B").target[1], 2, "读出来也要是副本");
  });

  it("冻结标记随缓存恢复：恢复后 fitAll 不再挪动已冻结的球心", () => {
    const frozen = {
      target: [0, 0, 0],
      distance: 900,
      angle: 0,
      pitch: 0,
      q: [0, 0, 0, 1],
      knInterior: { center: [0, 0, 0], eye: [0, 0, 900], view: [0, 0, 0, 1], scene: [0, 0, 0, 1], radius: 300, frozen: true },
    };
    const { navigation } = makeNavigation({ initial: frozen });
    navigation.fitAll(positionsOf([[500, 0, 0], [600, 0, 0]]), 2, true);
    assert.deepEqual(navigation.camera.knInterior.center, [0, 0, 0], "恢复出来的球心不能又被当成「还没操作过」✗");
  });

  it("接线：引擎按实例身份读写缓存、每帧交节点坐标；面板交出库身份", () => {
    assert.ok(buildSource.includes("knCachedView(this.knLibraryKey)"), "恢复要走分区缓存");
    assert.ok(buildSource.includes("knStoreView(this.knLibraryKey"), "保存要走分区缓存");
    assert.ok(
      buildSource.includes("this.navigation.setFrameContext(bounds, this.viewport, this.positions, count)"),
      "每帧交节点坐标（线段拾取要用世界坐标）",
    );
    assert.ok(buildSource.includes("knActiveLibraryKey()"), "布局缓存也带身份");
    for (const needle of ["cachedView", "storeView", "activeLibraryKey"]) {
      assert.ok(bundle.includes(needle), `产物里要有分区缓存：${needle}`);
    }
    assert.ok(panelSource.includes("libraryKeyOf(payload?.library)"), "面板要交出库身份");
    assert.ok(panelSource.includes("setActiveLibraryKey"), "面板要在渲染图谱前绑定身份");
  });
});

/* ======================== P2：恰好位于球面 ======================== */

describe("P2 球面求交：站在球面上朝内也能抓到空白", () => {
  const at = (eye) => ({ center: [0, 0, 0], eye, view: [0, 0, 0, 1], scene: [0, 0, 0, 1], radius: 300 });

  it("相机**刚好在球面上**朝内看 ⇒ 取前方内壁（旧实现返回 null ✗）", () => {
    const anchor = anchorFromRay(at([0, 0, 300]), VIEWPORT, FOV, VIEWPORT.width / 2, VIEWPORT.height / 2);
    assert.ok(anchor !== null, "球面朝内必须能建立虚拟抓取点");
    assert.ok(Math.abs(anchor.display[2] + 300) < 1e-3, `应落在对面内壁（z≈−300），实际 ${anchor.display[2]}`);
    assert.ok(Math.abs(Math.hypot(...anchor.display) - 300) < 1e-3, "仍在球面上");
  });

  it("球面内外 epsilon 都有解；朝外看过球体则如实返回 null", () => {
    assert.ok(anchorFromRay(at([0, 0, 299.9]), VIEWPORT, FOV, 400, 300) !== null, "球内贴着球面");
    assert.ok(anchorFromRay(at([0, 0, 300.1]), VIEWPORT, FOV, 400, 300) !== null, "球外贴着球面");
    /* 相机在球外、视线朝外（姿态绕 X 轴 180° ⇒ forward = +Z）⇒ 球体在身后 ✓ */
    const away = anchorFromRay({ ...at([0, 0, 600]), view: [1, 0, 0, 0] }, VIEWPORT, FOV, 400, 300);
    assert.equal(away, null, "朝外看：没有前方交点，别硬造一个 ✗");
  });

  it("控制器：球面上按下再拖，真的转了图谱，而球心不动", () => {
    const { navigation, element } = makeNavigation({ initial: cameraAt([0, 0, 300]) });
    const centerBefore = [...navigation.camera.target];
    const basisBefore = [...navigation.basis().right];
    element.emit("pointerdown", { button: 0, pointerId: 1, clientX: 400, clientY: 300, shiftKey: false });
    element.emit("pointermove", { pointerId: 1, clientX: 470, clientY: 320 });
    assert.notDeepEqual([...navigation.basis().right], basisBefore, "空白拖动必须能转图谱");
    assert.deepEqual(navigation.camera.target, centerBefore, "球心不动");
  });
});

/* ===================== P2：重新整理必须重设球心 ===================== */

describe("P2 重新整理：球心与半径按新布局重采", () => {
  it("用户操作过之后，明确重排 ⇒ 采用新布局中心，半径按 max|X−C| 量", () => {
    const { navigation, element } = makeNavigation();
    element.emit("wheel", { deltaY: -100, deltaMode: 0 }); /* 用户操作 ⇒ 球心冻结 ✓ */
    dispatchRelayout("");
    navigation.fitAll(positionsOf([[100, 0, 0], [200, 0, 0]]), 2, true);
    const carried = navigation.camera.knInterior;
    assert.ok(Math.abs(carried.center[0] - 150) < 1e-6, `球心应复位到新布局中心 150，实际 ${carried.center[0]}`);
    assert.ok(Math.abs(carried.radius - 50) < 1e-6, `半径应是 max|X−C| = 50，实际 ${carried.radius}`);
  });

  it("普通适应窗口**不动**已冻结的球心", () => {
    const { navigation, element } = makeNavigation();
    element.emit("wheel", { deltaY: -100, deltaMode: 0 });
    const before = [...navigation.camera.knInterior.center];
    navigation.fitAll(positionsOf([[500, 0, 0], [600, 0, 0]]), 2, true);
    assert.deepEqual(navigation.camera.knInterior.center, before, "没按重新整理就不该挪球心");
  });

  it("重排期间用户又操作了 ⇒ 球心照旧复位，但不再自动取景覆盖他的视角", () => {
    const { navigation, element } = makeNavigation();
    element.emit("wheel", { deltaY: -100, deltaMode: 0 });
    dispatchRelayout("");
    element.emit("pointerdown", { button: 0, pointerId: 1, clientX: 400, clientY: 300, shiftKey: false });
    element.emit("pointermove", { pointerId: 1, clientX: 470, clientY: 300 });
    const viewBefore = [...navigation.camera.q];
    navigation.fitAll(positionsOf([[100, 0, 0], [200, 0, 0]]), 2, true);
    assert.ok(Math.abs(navigation.camera.knInterior.center[0] - 150) < 1e-6, "球心仍按承诺复位");
    assert.deepEqual([...navigation.camera.q], viewBefore, "不该再自动取景");
  });

  it("半径测量：绕**固定球心**算 max|X−C|（不是绕包围体中心）", () => {
    const positions = positionsOf([[100, 0, 0], [-100, 0, 0], [0, 0, 0]]);
    assert.equal(radiusAbout(positions, 3, [0, 0, 0]), 100);
    assert.equal(radiusAbout(positions, 3, [50, 0, 0]), 150, "球心偏了，半径必须跟着变大才包得住");
    assert.equal(radiusAbout(new Float32Array(0), 0, [0, 0, 0]), 0);
    assert.equal(radiusAbout(Float32Array.from([Number.NaN, 0, 0]), 1, [0, 0, 0]), 0, "非法坐标不参与");
  });

  it("接线：重排走明确事件，不再用 smooth 猜；面板按钮广播它", () => {
    assert.ok(controllerSource.includes('RELAYOUT_EVENT = "kn-relayout-request"'), "要有明确的重排事件");
    assert.ok(controllerSource.includes("window.addEventListener(RELAYOUT_EVENT"), "控制器要订阅");
    assert.ok(!controllerSource.includes("const newLayout = !smooth"), "不该再用 smooth 猜重排 ✗");
    assert.ok(panelSource.includes("window.dispatchEvent(new CustomEvent(RELAYOUT_EVENT"), "按钮要广播");
  });
});

/* ======================= P2：动画终点提前提交 ======================= */

describe("P2 定位动画：命令之后、首帧之前状态仍在出发点", () => {
  const focusCommand = { seq: 1, type: "focusNode", nodeId: "n0", source: "toolbar" };

  it("正常动画模式：命令后状态不动，update() 才推进，收尾落在目标", () => {
    const { navigation } = makeNavigation({ reducedMotion: false });
    const start = [...navigation.basis().position];
    navigation.command(focusCommand, 0, positionsOf([[500, 0, 0]]), 1);
    const afterCommand = [...navigation.basis().position];
    for (let i = 0; i < 3; i += 1) {
      assert.ok(Math.abs(afterCommand[i] - start[i]) < 1e-6, `命令后必须还停在出发点（分量 ${i}）`);
    }
    const now = performance.now();
    assert.equal(navigation.update(now + 300), true, "动画中");
    navigation.update(now + 5000);
    const end = [...displayBasisOf(navigation).position];
    /* 目标 (500,0,0)：停在它前方 clamp(40×2.6,40,max(60,300)) = 104 处 ⇒ (500,0,104) ✓ */
    assert.ok(Math.hypot(end[0] - 500, end[1], end[2] - 104) < 1.5, `最终应停在目标前方，实际 ${end}`);
  });

  it("命令后立刻滚轮取消动画 ⇒ 不会从终点开始", () => {
    const { navigation, element } = makeNavigation({ reducedMotion: false });
    const start = [...displayBasisOf(navigation).position];
    navigation.command(focusCommand, 0, positionsOf([[500, 0, 0]]), 1);
    element.emit("wheel", { deltaY: -100, deltaMode: 0 });
    const after = [...displayBasisOf(navigation).position];
    const toTarget = Math.hypot(after[0] - 500, after[1], after[2] - 104);
    const moved = Math.hypot(after[0] - start[0], after[1] - start[1], after[2] - start[2]);
    assert.ok(toTarget > 300, `旧实现会从终点附近开始（离目标很近），实际距离 ${toTarget.toFixed(1)}`);
    assert.ok(moved < 60, `应只在出发点附近稍作推进，实际位移 ${moved.toFixed(1)}`);
  });

  it("减少动态效果 ⇒ 立即同步到位且不留待执行动画", () => {
    const { navigation } = makeNavigation({ reducedMotion: true });
    navigation.command(focusCommand, 0, positionsOf([[500, 0, 0]]), 1);
    const end = [...displayBasisOf(navigation).position];
    assert.ok(Math.hypot(end[0] - 500, end[1], end[2] - 104) < 1.5, `应立即到位，实际 ${end}`);
    assert.equal(navigation.update(performance.now() + 100), false, "不该还有动画在跑");
  });
});

/* ==================== P2：内部可见连线拾取 ==================== */

describe("P2 线段拾取：一端在相机后面也要能点中", () => {
  const cameraState = { center: [0, 0, 0], eye: [0, 0, 900], view: [0, 0, 0, 1], scene: [0, 0, 0, 1], radius: 300 };
  const basis = effectiveBasis(cameraState);

  it("两端都在前方 ⇒ 按屏幕线段命中，远离则不命中", () => {
    const positions = positionsOf([[-200, 0, 800], [200, 0, 800]]);
    const a = projectPoint([-200, 0, 800], basis, VIEWPORT, FOV);
    const b = projectPoint([200, 0, 800], basis, VIEWPORT, FOV);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    assert.equal(pickClippedEdge(positions, [{ from: 0, to: 1 }], basis, VIEWPORT, FOV, mid.x, mid.y), 0);
    assert.equal(
      pickClippedEdge(positions, [{ from: 0, to: 1 }], basis, VIEWPORT, FOV, mid.x, mid.y + 120),
      null,
      "远离线段不命中",
    );
  });

  it("一端在相机后方 ⇒ 裁剪后仍可命中（上游那套会整条跳过 ✗）", () => {
    const positions = positionsOf([[0, 0, 1200], [300, 0, 300]]);
    const segment = clippedEdgeSegment([0, 0, 1200], [300, 0, 300], basis, VIEWPORT, FOV);
    assert.ok(segment !== null, "有可见部分 ⇒ 必须给出裁剪线段");
    const mid = { x: (segment.a.x + segment.b.x) / 2, y: (segment.a.y + segment.b.y) / 2 };
    assert.equal(
      pickClippedEdge(positions, [{ from: 0, to: 1 }], basis, VIEWPORT, FOV, mid.x, mid.y),
      0,
      "屏幕上看得见的那一段必须能点中",
    );
  });

  it("两端都在相机后方 ⇒ 如实返回 null（不可见的部分不许命中）", () => {
    const positions = positionsOf([[0, 0, 1200], [100, 0, 1500]]);
    assert.equal(clippedEdgeSegment([0, 0, 1200], [100, 0, 1500], basis, VIEWPORT, FOV), null);
    assert.equal(pickClippedEdge(positions, [{ from: 0, to: 1 }], basis, VIEWPORT, FOV, 400, 300), null);
  });

  it("接线：控制器改用自有线段拾取，近裁剪阈值与投影统一", () => {
    assert.ok(controllerSource.includes("pickClippedEdge(this.positions"), "用自有实现");
    /* 近裁剪阈值统一定义在导航模块，线段拾取与投影都引用它 ✓（不再各写一份 ✗） */
    assert.ok(navigationSource.includes("export const NEAR_PLANE"), "导航模块要导出统一阈值");
    assert.ok(edgePickingSource.includes("NEAR_PLANE"), "线段拾取用同一阈值");
    assert.ok(!navigationSource.includes("if (!(depth > 1e-6)) return null;"), "投影不该再用 1e-6 那套 ✗");
  });
});

/* ==================== P2：小地图连续性与轨迹 ==================== */

describe("P2 小地图：侧向符号连续、轨迹存世界坐标", () => {
  const section = { forward: [0, 0, -1], up: [0, 1, 0], radius: 300, center: [0, 0, 0] };
  const pointAt = (eye) => minimapPoint({ ...section, eye });

  it("侧向只用 up 分量 ⇒ 跨越 up=0 不再从 +100 跳到 −100（旧实现 ✗）", () => {
    const a = pointAt([100, 0.001, 100]);
    const b = pointAt([100, -0.001, 100]);
    assert.ok(Math.abs(a.lateral - b.lateral) < 0.01, `侧向必须连续，实际 ${a.lateral} → ${b.lateral}`);
    assert.ok(Math.abs(a.lateral - 0.001) < 1e-9, "侧向 = dot(P−C, up)");
    const right = pointAt([250, 0, 0]);
    assert.ok(Math.abs(right.lateral) < 1e-9, "纯右向偏移在纵向上没有分量（图上不可表示 ⇒ 另给距离读数 ✓）");
    assert.equal(right.distance, 250, "距离读数仍然准确");
  });

  it("轨迹去重：同一位置反复广播不追加，真正移动才追加", () => {
    assert.equal(shouldSampleTrail(null, [0, 0, 300], 300), true, "第一次要记");
    assert.equal(shouldSampleTrail([0, 0, 300], [0, 0, 300], 300), false, "原地不动不记");
    assert.equal(shouldSampleTrail([0, 0, 300], [0, 0, 300.5], 300), false, "小于阈值不记");
    assert.equal(shouldSampleTrail([0, 0, 300], [0, 0, 260], 300), true, "明显移动要记");
  });

  it("接线：轨迹存世界坐标、绘制时按当前截面重投影；带距离读数", () => {
    assert.ok(minimapSource.includes("eye: [number, number, number]"), "轨迹要存世界坐标（否则换朝向就连成假轨迹 ✗）");
    assert.ok(minimapSource.includes("trailSnapshot"), "绘制时按当前截面重投影");
    assert.ok(minimapSource.includes("shouldSampleTrail"), "重复广播要去重");
    assert.ok(minimapSource.includes("kn-minimap-distance"), "要有距离读数");
  });
});

/* ==================== 开发备注：两项一致性 ==================== */

describe("开发备注：对外姿态与基向量一致 / 推进沿视线截断", () => {
  it("camera.q 与 basis() 是同一个姿态（旧实现用 scene×view，与渲染不一致 ✗）", () => {
    const { navigation, element } = makeNavigation();
    element.emit("pointerdown", { button: 0, pointerId: 1, clientX: 400, clientY: 300, shiftKey: false });
    element.emit("pointermove", { pointerId: 1, clientX: 470, clientY: 340 });
    const q = navigation.camera.q;
    const basis = navigation.basis();
    const axes = [["right", [1, 0, 0], basis.right], ["up", [0, 1, 0], basis.up], ["forward", [0, 0, -1], basis.forward]];
    for (const [name, axis, want] of axes) {
      const got = rotateVec(q, axis);
      for (let i = 0; i < 3; i += 1) {
        assert.ok(Math.abs(got[i] - want[i]) < 1e-9, `${name} 分量 ${i} 不一致：${got[i]} vs ${want[i]}`);
      }
    }
  });

  it("推进超过范围时沿视线截断，不产生横向漂移", () => {
    const { navigation, element } = makeNavigation({ initial: cameraAt([0, 0, 1000]) });
    const before = [...displayBasisOf(navigation).position];
    const forward = [...displayBasisOf(navigation).forward];
    for (let i = 0; i < 40; i += 1) element.emit("wheel", { deltaY: -1000, deltaMode: 0 });
    const after = [...displayBasisOf(navigation).position];
    const delta = [after[0] - before[0], after[1] - before[1], after[2] - before[2]];
    const cross = [
      delta[1] * forward[2] - delta[2] * forward[1],
      delta[2] * forward[0] - delta[0] * forward[2],
      delta[0] * forward[1] - delta[1] * forward[0],
    ];
    assert.ok(Math.hypot(...cross) < 1e-6, `位移必须沿视线，实际叉积 ${Math.hypot(...cross)}`);
    assert.ok(Math.hypot(after[0], after[1], after[2]) <= 1200 + 1e-6, "不该越界");
  });
});

/* ------------------------------ 测试脚手架 ------------------------------ */

let globals = null;

function installGlobals(reducedMotion) {
  const windowHandlers = new Map();
  const dispatched = [];
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    matchMedia: globalThis.matchMedia,
    CustomEvent: globalThis.CustomEvent,
  };
  globalThis.CustomEvent = class {
    constructor(type, init) { this.type = type; this.detail = init?.detail; }
  };
  globalThis.window = {
    addEventListener: (type, handler) => { windowHandlers.set(type, handler); },
    removeEventListener: (type) => { windowHandlers.delete(type); },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    dispatchEvent: (event) => {
      dispatched.push(event);
      const handler = windowHandlers.get(event.type);
      if (handler !== undefined) handler(event);
      return true;
    },
  };
  globalThis.document = { hidden: false, activeElement: null, addEventListener: () => {}, removeEventListener: () => {} };
  globalThis.matchMedia = () => ({ matches: reducedMotion });
  return { windowHandlers, dispatched, restore() {
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.matchMedia = previous.matchMedia;
    globalThis.CustomEvent = previous.CustomEvent;
  } };
}

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
  };
}

/** 相机在 (0,0,|eye|) 朝 −Z 看向原点 ✓（只有轴向机位，够这些用例用） */
function cameraAt(eye) {
  return { target: [0, 0, 0], distance: Math.hypot(...eye), angle: 0, pitch: 0, q: [0, 0, 0, 1] };
}

function makeNavigation(options = {}) {
  globals = installGlobals(options.reducedMotion === true);
  const element = makeElement();
  const calls = { camera: 0, user: 0 };
  const navigation = new InteriorNavigation({
    element,
    initial: options.initial ?? cameraAt([0, 0, 900]),
    edgeLength: 40,
    getProjected: () => [],
    getEdges: () => [],
    onSelect: () => {},
    onHover: () => {},
    onSelectEdge: () => {},
    onEdgeHover: () => {},
    onContextMenu: () => {},
    onLocate: () => {},
    onCameraChange: () => { calls.camera += 1; },
    onUserCameraInput: () => { calls.user += 1; },
  });
  navigation.setFrameContext(BOUNDS, VIEWPORT);
  return { navigation, element, calls };
}

/** 从控制器广播的状态事件里取当前相机几何（state 是私有的，事件是官方出口 ✓） */
function displayBasisOf(navigation) {
  void navigation;
  const event = [...globals.dispatched].reverse().find((item) => item.type === "kn-interior-state");
  assert.ok(event !== undefined, "控制器应当已经广播过状态");
  return {
    position: event.detail.eye,
    forward: event.detail.forward,
    up: event.detail.up,
    center: event.detail.center,
    radius: event.detail.radius,
  };
}

function dispatchRelayout(libraryKey) {
  const handler = globals.windowHandlers.get(RELAYOUT_EVENT);
  assert.equal(typeof handler, "function", "控制器要订阅重排事件");
  handler({ type: RELAYOUT_EVENT, detail: { libraryKey } });
}

afterEach(() => { globals?.restore(); globals = null; });
