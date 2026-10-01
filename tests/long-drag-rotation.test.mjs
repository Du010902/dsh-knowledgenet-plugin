/**
 * 长距离拖动的**连续事件**回归测试（`design/long-drag-rotation-direction-analysis.md`）。
 *
 * 文档复现的问题：同一个抓取点的屏幕可达范围有限（它始终在半径 r 的轨道球面上），
 * 旧实现却一直追赶一个**几何上到不了**的绝对目标 ⇒ 到达边界后停滞、振荡、甚至回退 ✗
 * （典型是"指针继续向右，抓取点反而向左"）。而且旧实现**无条件提交**每一步旋转，
 * 没有试探与误差回退，也不区分"不可达/病态/停滞"。
 *
 * 修法（文档推荐的两阶段）：
 * 1. **抓取阶段**：带试探更新（残差下降才提交 ✓）+ 可达性预判 ⇒ 到边界如实报告停滞；
 * 2. **连续旋转阶段**：切到相邻事件的增量映射，方向来自最后可信的局部映射，且限幅 ✓。
 *
 * 这里的断言全部是**事件序列**级别的：不能只测一次 10~30 像素的拖动 ✓。
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { InteriorNavigation } from "../src/client/interior-controller.ts";
import {
  anchorReachable,
  displayBasis,
  displayOf,
  dragAnchorTo,
  dragGainAt,
  projectDisplay,
  quatConjugate,
  solveDrag,
  spinStep,
  SPIN_MAX_ANGLE,
} from "../src/client/interior-navigation.ts";
import { quatMultiply, rotateVec } from "../src/client/trackball.ts";
import { projectPoint } from "../src/vendor/upstream/graph3d/camera.ts";

const VIEWPORT = { width: 800, height: 600 };
const FOV = 50;
const BOUNDS = { center: [0, 0, 0], radius: 300, min: [0, 0, 0], max: [0, 0, 0] };

/** 文档里的确定性位形：C=原点、相机 (0,0,900)、半径 300、单位姿态 */
const makeState = () => ({ center: [0, 0, 0], eye: [0, 0, 900], view: [0, 0, 0, 1], scene: [0, 0, 0, 1], radius: 300 });
const screenOf = (state, layout) => projectDisplay(state, VIEWPORT, FOV, displayOf(state, layout));
const distOf = (state, layout) => {
  const d = displayOf(state, layout);
  return Math.hypot(d[0] - state.center[0], d[1] - state.center[1], d[2] - state.center[2]);
};

/* ===================== 第一步：试探更新与状态判定 ===================== */

describe("抓取阶段：试探更新、残差单调、停滞如实上报", () => {
  it("每次提交都让残差下降；**可达**目标最终收敛到容差内", () => {
    const state = makeState();
    const layout = [50, 30, 100];
    const start = screenOf(state, layout);
    /* 目标仍需落在轨道球投影轮廓内（水平约 ±83px ✓）——+30 是可达的 ✓ */
    const result = dragAnchorTo(state, VIEWPORT, FOV, layout, { x: start.x + 30, y: start.y + 10 });
    const end = screenOf(state, layout);
    assert.ok(result.error <= 0.5, `可达目标应收敛，实际残差 ${result.error.toFixed(2)}`);
    assert.ok(result.progressed, "应当报告有进展");
    assert.ok(Math.abs(end.x - (start.x + 30)) < 0.6, "抓取点跟手 ✓");
    assert.equal(result.stalled, false);
    assert.equal(result.lost, false);
  });

  it("**边界**：反复追不可达目标 ⇒ 最终判停滞，且那一次**完全不修改** scene ✗", () => {
    const state = makeState();
    const layout = [50, 30, 100];
    const far = { x: 790, y: screenOf(state, layout).y };
    let stalledAt = null;
    let boundaryX = 0;
    for (let event = 0; event < 40; event += 1) {
      const result = dragAnchorTo(state, VIEWPORT, FOV, layout, far);
      if (result.stalled) {
        stalledAt = event;
        boundaryX = screenOf(state, layout).x;
        break;
      }
      assert.ok(result.progressed, "没判停滞的事件必须有实际进展 ✓");
    }
    assert.ok(stalledAt !== null, "追不可达目标最终必须判停滞（旧实现会一直硬转/回退 ✗）");
    /* 停在投影轮廓上（水平半宽约 83px，画面中心 x=400 ✓） */
    assert.ok(boundaryX > 400 && boundaryX < 400 + 100, `应停在轮廓附近，实际 x=${boundaryX.toFixed(2)}`);
    /*
     * 判停滞的那一次**不许再往前走**：再追一次仍然停滞，且 scene 一位都不动 ✓
     * （注意：不要求"整个事件都没动"——同一次调用里前面成功的步是合法进展 ✓）
     */
    const sceneAtBoundary = [...state.scene];
    const again = dragAnchorTo(state, VIEWPORT, FOV, layout, far);
    assert.equal(again.stalled, true, "边界上再追仍然是停滞 ✓");
    assert.deepEqual(state.scene, sceneAtBoundary, "停滞时不许再提交任何一步 ✗");
    assert.equal(again.progressed, false, "停滞的那次不应报告进展 ✓");
  });

  it("可达性预判：轮廓内可达、远处不可达（偏轴位形用真实射线求交 ✓）", () => {
    const state = makeState();
    const layout = [50, 30, 100];
    const start = screenOf(state, layout);
    assert.equal(anchorReachable(state, VIEWPORT, FOV, layout, start), true, "起点当然可达");
    assert.equal(anchorReachable(state, VIEWPORT, FOV, layout, { x: start.x + 10, y: start.y }), true, "轮廓内可达 ✓");
    assert.equal(anchorReachable(state, VIEWPORT, FOV, layout, { x: 790, y: start.y }), false, "远处不可达 ✓");
    /* 偏轴/滚转姿态下也必须真实求交，而不是拿近似圆糊弄 ✗ */
    const rolled = { ...state, view: [0.2588, 0, 0, 0.9659] };
    assert.equal(anchorReachable(rolled, VIEWPORT, FOV, layout, { x: 790, y: 300 }), false);
  });

  it("可控性用**原始 J** 的奇异值判定（不是加阻尼后的行列式 ✗）", () => {
    const state = makeState();
    const healthy = solveDrag(state, VIEWPORT, FOV, displayOf(state, [50, 30, 100]), 20, 10);
    assert.equal(healthy.illConditioned, false, "常规位形不该判病态");
    assert.ok(healthy.conditioning > 0.01, `条件尺度应可观，实际 ${healthy.conditioning}`);
    assert.ok(healthy.spectrum.max > 0 && healthy.spectrum.min > 0);
    /* 锚点贴在球心上 ⇒ 没有杠杆 ⇒ 病态 ✓ */
    const degenerate = solveDrag(state, VIEWPORT, FOV, [0, 0, 0], 20, 0);
    assert.equal(degenerate.illConditioned, true);
    assert.equal(degenerate.singular, true, "保留旧字段语义 ✓");
  });
});

/* ============ 第二步：连续阶段的增益与步进（方向稳定、限幅） ============ */

describe("连续阶段：增益取自可信映射、方向稳定、单事件限幅", () => {
  it("增益与抓取阶段同一套约定：右拖让内容向右（+up 角），下拖让内容向下（+right 角）", () => {
    const state = makeState();
    const gain = dragGainAt(state, VIEWPORT, FOV, [0, 0, 300]);
    assert.ok(gain !== null, "参考区域应当能建立映射");
    const right = spinStep(state, gain, 10, 0);
    assert.ok(right.angles.up > 0, `右拖应产生正的 up 角，实际 ${right.angles.up}`);
    const down = spinStep(state, gain, 0, 10);
    assert.ok(down.angles.right > 0, `下拖应产生正的 right 角，实际 ${down.angles.right}`);
  });

  it("单事件总转角有上限（防止极值附近巨大转角 ✗）", () => {
    const state = makeState();
    const gain = dragGainAt(state, VIEWPORT, FOV, [0, 0, 300]);
    const huge = spinStep(state, gain, 100000, -100000);
    const magnitude = Math.hypot(huge.angles.right, huge.angles.up);
    assert.ok(magnitude <= SPIN_MAX_ANGLE + 1e-9, `转角必须限幅，实际 ${magnitude}`);
    for (const value of huge.delta) assert.ok(Number.isFinite(value), "不能出现 NaN");
  });

  it("投影极值附近取增益会失败 ⇒ 调用方走兜底而不是取爆掉的逆导数 ✓", () => {
    const state = makeState();
    /* 锚点贴住球心：J 退化 ⇒ 取不到增益 ✓ */
    assert.equal(dragGainAt(state, VIEWPORT, FOV, [0, 0, 0]), null);
  });
});

/* ============ 端到端：一次拖动跨越可达轮廓（文档的确定性复现） ============ */

let globals = null;

function installGlobals() {
  const windowHandlers = new Map();
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
    dispatchEvent: () => true,
  };
  globalThis.document = { hidden: false, activeElement: null, addEventListener: () => {}, removeEventListener: () => {} };
  globalThis.matchMedia = () => ({ matches: true });
  return {
    windowHandlers,
    restore() {
      globalThis.window = previous.window;
      globalThis.document = previous.document;
      globalThis.matchMedia = previous.matchMedia;
      globalThis.CustomEvent = previous.CustomEvent;
    },
  };
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

/** 造一个控制器：初始相机 (0,0,900)、球心原点；`layout` 是"屏幕上那个节点"的布局坐标 ✓ */
function makeNavigation(layout) {
  globals = installGlobals();
  const element = makeElement();
  const navigation = new InteriorNavigation({
    element,
    initial: { target: [0, 0, 0], distance: 900, angle: 0, pitch: 0 },
    edgeLength: 40,
    libraryKey: "",
    /* 投影与渲染同一份基向量 ✓（节点位置固定，锚点布局在按下时就定下来了 ✓） */
    getProjected: () => {
      const screen = projectPoint(layout, navigation.basis(), VIEWPORT, FOV);
      return screen === null
        ? []
        : [{ index: 0, id: "n0", x: screen.x, y: screen.y, depth: screen.depth, radius: 8, visible: true }];
    },
    getEdges: () => [],
    onSelect: () => {},
    onHover: () => {},
    onSelectEdge: () => {},
    onEdgeHover: () => {},
    onContextMenu: () => {},
    onLocate: () => {},
    onCameraChange: () => {},
    onUserCameraInput: () => {},
  });
  navigation.setFrameContext(BOUNDS, VIEWPORT);
  return { navigation, element };
}

/** 从两次 scene 快照里取"绕相机上轴的有符号角增量" ✓ */
function signedUpAngle(before, after) {
  const delta = quatMultiply(after.scene, quatConjugate(before.scene));
  const up = rotateVec(after.view, [0, 1, 0]);
  return 2 * Math.asin(Math.max(-1, Math.min(1, delta[0] * up[0] + delta[1] * up[1] + delta[2] * up[2])));
}

afterEach(() => { globals?.restore(); globals = null; });

describe("端到端：连续向右拖动跨越可达轮廓", () => {
  it("文档复现场景：抓取阶段不反向；越界后连续阶段方向稳定（旧实现在第 ~155 次回退 ✗）", () => {
    const layout = [50, 30, 100];
    const { navigation, element } = makeNavigation(layout);
    const start = projectPoint(layout, navigation.basis(), VIEWPORT, FOV);

    element.emit("pointerdown", { button: 0, pointerId: 1, clientX: start.x, clientY: start.y, shiftKey: false });
    const samples = [];
    let previous = navigation.interiorSnapshot();
    const centerBefore = [...previous.center];
    const eyeBefore = [...previous.eye];
    const viewBefore = [...previous.view];

    /* 每次右移 1 像素，走满 300 次（远远越过文档报出的第 155 次 ✗） */
    for (let step = 1; step <= 300; step += 1) {
      element.emit("pointermove", { pointerId: 1, clientX: start.x + step, clientY: start.y });
      const now = navigation.interiorSnapshot();
      const screen = projectPoint(layout, navigation.basis(), VIEWPORT, FOV);
      samples.push({ phase: now.dragPhase, x: screen === null ? Number.NaN : screen.x, angle: signedUpAngle(previous, now) });
      previous = now;
    }

    /* ① 抓取阶段：抓取点的屏幕 x 不允许回退（旧实现会 ✗） */
    const grabSamples = samples.filter((sample) => sample.phase === "grab");
    for (let index = 1; index < grabSamples.length; index += 1) {
      assert.ok(
        grabSamples[index].x >= grabSamples[index - 1].x - 1e-6,
        `抓取阶段第 ${index} 次出现回退：${grabSamples[index - 1].x.toFixed(3)} → ${grabSamples[index].x.toFixed(3)}`,
      );
    }
    /* ② 必须真的切到连续阶段（否则文档的设计没落地 ✗） */
    const spinSamples = samples.filter((sample) => sample.phase === "spin");
    assert.ok(spinSamples.length > 0, "越过可达轮廓后必须切到连续旋转阶段");

    /* ③ 连续阶段：方向稳定（同一个符号）、单事件限幅、无 NaN ✓
       （过滤掉切换那一步与浮点噪声：那里的角增量是 0/-0，符号没有意义 ✗） */
    const signs = spinSamples
      .filter((sample) => Math.abs(sample.angle) > 1e-6)
      .map((sample) => Math.sign(sample.angle));
    assert.ok(signs.length > 0, "连续阶段应当产生实际转角");
    assert.ok(signs.every((sign) => sign === signs[0]), `连续阶段方向必须稳定，实际 ${[...new Set(signs)].join(",")}`);
    for (const sample of spinSamples) {
      assert.ok(Math.abs(sample.angle) <= SPIN_MAX_ANGLE + 1e-9, "连续阶段单事件转角要限幅");
      assert.ok(Number.isFinite(sample.angle), "不能出现 NaN");
    }

    /* ④ 整个过程里 C / P / Q 都不许动（只改 scene ✓） */
    const final = navigation.interiorSnapshot();
    assert.deepEqual(final.center, centerBefore, "球心不动");
    assert.deepEqual(final.eye, eyeBefore, "相机位置不动");
    assert.deepEqual(final.view, viewBefore, "相机姿态不动");
    assert.notDeepEqual(final.scene, [0, 0, 0, 1], "scene 确实转了");
    element.emit("pointerup", { pointerId: 1, clientX: start.x + 300, clientY: start.y });
    assert.equal(navigation.interiorSnapshot().dragPhase, "none", "松开后阶段状态清干净 ✓");
  });

  it("轴对齐场景（文档第二个例子）：到边界后**继续旋转**而不是停住 ✗", () => {
    const layout = [0, 0, 300];
    const { navigation, element } = makeNavigation(layout);
    const start = projectPoint(layout, navigation.basis(), VIEWPORT, FOV);
    element.emit("pointerdown", { button: 0, pointerId: 1, clientX: start.x, clientY: start.y, shiftKey: false });
    let previous = navigation.interiorSnapshot();
    let spinEvents = 0;
    let totalRotation = 0;
    for (let x = start.x + 10; x <= 900; x += 10) {
      element.emit("pointermove", { pointerId: 1, clientX: x, clientY: start.y });
      const now = navigation.interiorSnapshot();
      if (now.dragPhase === "spin") {
        spinEvents += 1;
        totalRotation += Math.abs(signedUpAngle(previous, now));
      }
      previous = now;
    }
    assert.ok(spinEvents > 5, `越界后应持续旋转（实际 spin 事件 ${spinEvents}）`);
    assert.ok(totalRotation > 0.2, `累计转角应当可观，实际 ${totalRotation.toFixed(3)} 弧度`);
    assert.equal(navigation.interiorSnapshot().dragPhase, "spin", "同一次拖动里不反复重抓 ✓");
  });

  it("滚轮/取消会清掉两个阶段的状态（不留半个连续阶段 ✗）", () => {
    const layout = [50, 30, 100];
    const { navigation, element } = makeNavigation(layout);
    const start = projectPoint(layout, navigation.basis(), VIEWPORT, FOV);
    element.emit("pointerdown", { button: 0, pointerId: 1, clientX: start.x, clientY: start.y, shiftKey: false });
    for (let step = 1; step <= 240; step += 1) {
      element.emit("pointermove", { pointerId: 1, clientX: start.x + step, clientY: start.y });
    }
    assert.equal(navigation.interiorSnapshot().dragPhase, "spin", "前置：已经进入连续阶段");
    element.emit("wheel", { deltaY: -60, deltaMode: 0 });
    assert.equal(navigation.interiorSnapshot().dragPhase, "none", "滚轮打断后阶段状态清干净 ✓");
    /* 打断后继续移动指针不该再转（沿用旧的打断语义 ✓） */
    const sceneAfterWheel = [...navigation.interiorSnapshot().scene];
    element.emit("pointermove", { pointerId: 1, clientX: start.x + 400, clientY: start.y });
    assert.deepEqual([...navigation.interiorSnapshot().scene], sceneAfterWheel, "打断后不该继续旋转 ✗");
  });
});
