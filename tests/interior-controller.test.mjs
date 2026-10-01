/**
 * 内部导航**控制器**的接线测试（DOM 打桩，不需要真实浏览器）。
 *
 * 数学层已由 `interior-navigation.test.mjs` 覆盖；这里验证事件接线与端到端行为：
 * - 滚轮 = 沿视线前进/后退，**只动相机**，球心 C 与图谱姿态不变 ✓；
 * - 拖动 = 抓取点跟手（用控制器给出的 `basis()` 投影复核）✓；
 * - 短点击仍然选中节点、拖动后不误触发选中 ✓；
 * - Shift 拖动 = 平移；右键 = 菜单；取消 = 丢弃抓取 ✓；
 * - dispose 之后不再响应事件 ✓。
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { InteriorNavigation } from "../src/client/interior-controller.ts";
import { projectPoint } from "../src/vendor/upstream/graph3d/camera.ts";

const VIEWPORT = { width: 800, height: 600 };
const FOV = 50;
const BOUNDS = { center: [0, 0, 0], radius: 300, min: [0, 0, 0], max: [0, 0, 0] };

/** 极简 DOM 桩：只实现控制器用到的那几个方法 ✓ */
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

/** 造一个控制器：初始相机在 (0,0,900) 朝 −Z，球心在原点、半径 300 */
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
  navigation.setFrameContext(BOUNDS, VIEWPORT);
  return { navigation, element, calls, projected };
}

/** 用控制器自己的等效基把布局点投影成"上游会给出的那一条投影结果" */
function projectWith(navigation, layout) {
  return projectPoint(layout, navigation.basis(), VIEWPORT, FOV);
}

function pushNode(projected, index, screen) {
  projected.push({ index, id: `n${index}`, x: screen.x, y: screen.y, depth: screen.depth, radius: 8, visible: true });
}

describe("控制器接线：滚轮只推相机", () => {
  it("向前滚 ⇒ 相机沿视线靠近球心；球心与图谱姿态、视角都不变", () => {
    const { navigation, element, calls } = makeNavigation();
    const before = navigation.basis().position;
    const centerBefore = [...navigation.camera.target];
    const viewBefore = [...navigation.camera.q];
    assert.equal(element.emit("wheel", { deltaY: -100, deltaMode: 0 }), true);
    const after = navigation.basis().position;
    assert.ok(after[2] < before[2], `应沿 −Z 前进（${before[2]} → ${after[2]}）`);
    assert.deepEqual(navigation.camera.target, centerBefore, "球心不动");
    assert.deepEqual([...navigation.camera.q], viewBefore, "视角/图谱姿态不动");
    assert.equal(calls.user, 1, "要通知上层「用户自己动了相机」");
    assert.ok(calls.camera >= 1, "要触发相机变更回调");
  });

  it("滚轮位置无关：同一输入在画布不同位置产生相同位移", () => {
    const a = makeNavigation();
    const b = makeNavigation();
    a.element.emit("wheel", { deltaY: -100, deltaMode: 0, clientX: 10, clientY: 10 });
    b.element.emit("wheel", { deltaY: -100, deltaMode: 0, clientX: 700, clientY: 500 });
    assert.deepEqual(a.navigation.basis().position, b.navigation.basis().position, "位移必须与光标位置无关");
  });

  it("滚轮会打断进行中的抓取（不继续旋转）", () => {
    const { navigation, element, projected } = makeNavigation();
    const screen = projectWith(navigation, [0, 0, 700]);
    pushNode(projected, 0, screen);
    element.emit("pointerdown", { button: 0, pointerId: 1, clientX: screen.x, clientY: screen.y, shiftKey: false });
    element.emit("pointermove", { pointerId: 1, clientX: screen.x + 40, clientY: screen.y });
    const rotated = [...navigation.camera.q];
    element.emit("wheel", { deltaY: -60, deltaMode: 0 });
    element.emit("pointermove", { pointerId: 1, clientX: screen.x + 90, clientY: screen.y });
    assert.deepEqual([...navigation.camera.q], rotated, "滚轮之后拖动不该继续转图谱");
  });
});

describe("控制器接线：拖动抓取点跟手", () => {
  for (const [name, layout] of [["球心前方", [0, 0, 700]], ["球心后方", [0, 0, -250]]]) {
    it(`${name}的节点：按下再拖 ⇒ 它的投影跟着指针走`, () => {
      const { navigation, element, projected, calls } = makeNavigation();
      const screen = projectWith(navigation, layout);
      assert.ok(screen !== null && screen.depth > 0, `前置条件：${name}的节点在相机前方`);
      pushNode(projected, 0, screen);
      element.emit("pointerdown", { button: 0, pointerId: 1, clientX: screen.x, clientY: screen.y, shiftKey: false });
      element.emit("pointermove", { pointerId: 1, clientX: screen.x + 30, clientY: screen.y + 12 });
      const after = projectWith(navigation, layout);
      assert.ok(after !== null, "跟手后仍应可投影");
      assert.ok(Math.abs(after.x - (screen.x + 30)) < 1.5, `x 应跟到指针（期望 ${screen.x + 30}，实际 ${after.x}）`);
      assert.ok(Math.abs(after.y - (screen.y + 12)) < 1.5, `y 应跟到指针（期望 ${screen.y + 12}，实际 ${after.y}）`);
      assert.deepEqual(calls.select, [], "拖动不能顺手改选中");
    });
  }

  it("空白处按下再拖 ⇒ 用操作包围球当抓取点（仍有旋转）", () => {
    const { navigation, element } = makeNavigation();
    const before = navigation.basis();
    element.emit("pointerdown", { button: 0, pointerId: 1, clientX: 120, clientY: 120, shiftKey: false });
    element.emit("pointermove", { pointerId: 1, clientX: 180, clientY: 140 });
    const after = navigation.basis();
    assert.notDeepEqual(after.right, before.right, "空白拖动也要能转图谱");
    for (const value of after.position) assert.ok(Number.isFinite(value), "不能出现 NaN");
  });

  it("Shift 拖动 = 平移：相机位置横向移动，朝向不变", () => {
    const { navigation, element } = makeNavigation();
    const before = navigation.basis();
    element.emit("pointerdown", { button: 0, pointerId: 1, clientX: 400, clientY: 300, shiftKey: true });
    element.emit("pointermove", { pointerId: 1, clientX: 460, clientY: 300 });
    const after = navigation.basis();
    assert.notDeepEqual(after.position, before.position, "相机位置应移动");
    assert.deepEqual(after.right, before.right, "朝向不该变");
  });

  it("短点击节点 ⇒ 仍然选中它（拖动才抑制选中）", () => {
    const { navigation, element, projected, calls } = makeNavigation();
    const screen = projectWith(navigation, [0, 0, 700]);
    pushNode(projected, 3, screen);
    element.emit("pointerdown", { button: 0, pointerId: 1, clientX: screen.x, clientY: screen.y, shiftKey: false });
    element.emit("pointerup", { pointerId: 1, clientX: screen.x, clientY: screen.y });
    assert.deepEqual(calls.select, [3], "短点击应选中该节点");
  });

  it("拖动之后的 pointerup / dblclick 不触发选中", () => {
    const { navigation, element, projected, calls } = makeNavigation();
    const screen = projectWith(navigation, [0, 0, 700]);
    pushNode(projected, 3, screen);
    element.emit("pointerdown", { button: 0, pointerId: 1, clientX: screen.x, clientY: screen.y, shiftKey: false });
    element.emit("pointermove", { pointerId: 1, clientX: screen.x + 60, clientY: screen.y + 20 });
    element.emit("pointerup", { pointerId: 1, clientX: screen.x + 60, clientY: screen.y + 20 });
    element.emit("dblclick", { clientX: screen.x + 60, clientY: screen.y + 20 });
    assert.deepEqual(calls.select, [], "拖动后不该被当成点击/双击");
  });

  it("右键 ⇒ 上报命中（节点菜单）并把它设为当前选中", () => {
    const { element, projected, calls } = makeNavigation();
    const navigationHolder = makeNavigation();
    const screen = projectWith(navigationHolder.navigation, [0, 0, 700]);
    pushNode(projected, 5, screen);
    element.emit("contextmenu", { clientX: screen.x, clientY: screen.y });
    assert.deepEqual(calls.context, [{ kind: "node", index: 5 }]);
    assert.deepEqual(calls.select, [5], "右键节点也要把它设为当前选中（与上游一致）");
  });
});

describe("控制器接线：生命周期", () => {
  it("F 键只在画布持有焦点时定位", () => {
    const { navigation, element, calls } = makeNavigation();
    const keydown = globals.windowHandlers.get("keydown");
    assert.equal(typeof keydown, "function", "控制器要监听 window 的 keydown");
    globalThis.document.activeElement = { tagName: "INPUT" };
    keydown({ code: "KeyF", preventDefault() {} });
    assert.equal(calls.locate, 0, "焦点在输入框里时不该飞镜头");
    globalThis.document.activeElement = element;
    keydown({ code: "KeyF", preventDefault() {} });
    assert.equal(calls.locate, 1, "画布持有焦点时 F 才定位");
    navigation.dispose();
  });

  it("dispose 之后事件不再生效，且可重复调用", () => {
    const { navigation, element } = makeNavigation();
    navigation.dispose();
    assert.equal(element.has("wheel"), false, "滚轮监听器要摘掉");
    assert.equal(element.emit("wheel", { deltaY: -100, deltaMode: 0 }), false);
    navigation.dispose();
  });

  it("cancelPointer 之后移动指针不会突然转一下", () => {
    const { navigation, element } = makeNavigation();
    element.emit("pointerdown", { button: 0, pointerId: 1, clientX: 400, clientY: 300, shiftKey: false });
    element.emit("pointermove", { pointerId: 1, clientX: 430, clientY: 300 });
    const rotated = [...navigation.camera.q];
    navigation.cancelPointer();
    element.emit("pointermove", { pointerId: 1, clientX: 500, clientY: 300 });
    assert.deepEqual([...navigation.camera.q], rotated, "取消后不该继续响应同一次拖动");
    assert.equal(element.dataset.dragging, undefined, "拖拽状态要清掉（否则手型光标一直挂着）");
  });
});
