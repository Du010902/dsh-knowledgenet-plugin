/**
 * 内部导航（固定球心 C + 相机位置 P + 视角 Q + 图谱旋转 S）的**投影行为**测试。
 *
 * 依 `design/knowledgenet-interior-navigation.md`：修复的验收标准是"**被抓取点的投影沿指针方向移动**"，
 * 而不是"四元数数值变了"。所以这里的断言全部走投影：
 * - 等效基向量：布局点用 `effectiveBasis` 投影 ≡ 显示点用 `displayBasis` 投影 ✓；
 * - 滚轮：只改相机位置 P（同一输入在画布不同 x 处行程相同、不横移球心）✓；
 * - 拖动：锚点**在球心前方与后方**都必须朝指针方向移动 ✓（旧轨道模型下"球背面必然反向"✗）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  advanceEye,
  anchorFromRay,
  applySceneRotation,
  cursorRay,
  displayBasis,
  displayOf,
  dragAnchorTo,
  effectiveBasis,
  grabAnchor,
  hasLever,
  layoutOf,
  projectDisplay,
  recenterOn,
  solveDrag,
  wheelTravel,
} from "../src/client/interior-navigation.ts";
import { quatFromAxisAngle, rotateVec } from "../src/client/trackball.ts";
import { projectPoint } from "../src/vendor/upstream/graph3d/camera.ts";

const VIEWPORT = { width: 800, height: 600 };
const FOV = 50;

/** 初始状态：C 在原点、相机在 (0,0,900) 朝 −Z（identity 姿态）、球半径 300 */
function makeState(overrides = {}) {
  return {
    center: [0, 0, 0],
    eye: [0, 0, 900],
    view: [0, 0, 0, 1],
    scene: [0, 0, 0, 1],
    radius: 300,
    ...overrides,
  };
}

const screenOf = (state, displayPoint) => projectDisplay(state, VIEWPORT, FOV, displayPoint);

describe("等效基向量：布局坐标照旧渲染，却等于图谱真的转了", () => {
  it("`effectiveBasis` 投影 ≡ 显示坐标用 `displayBasis` 投影（含任意 S）", () => {
    const scene = quatFromAxisAngle([0.3, 1, 0.2], 0.9);
    const state = makeState({ scene });
    const layoutPoint = [120, -40, 260];
    const viaEffective = projectPoint(layoutPoint, effectiveBasis(state), VIEWPORT, FOV);
    const viaDisplay = projectPoint(displayOf(state, layoutPoint), displayBasis(state), VIEWPORT, FOV);
    assert.ok(viaEffective !== null && viaDisplay !== null);
    assert.ok(Math.abs(viaEffective.x - viaDisplay.x) < 1e-9, "x 必须一致");
    assert.ok(Math.abs(viaEffective.y - viaDisplay.y) < 1e-9, "y 必须一致");
    assert.ok(Math.abs(viaEffective.depth - viaDisplay.depth) < 1e-9, "深度也必须一致（否则标签会飘）");
  });

  it("S 为单位四元数时等效基就是相机本身（不引入额外偏移）", () => {
    const state = makeState();
    const basis = effectiveBasis(state);
    assert.deepEqual(basis.position, [0, 0, 900]);
    assert.deepEqual(displayOf(state, [1, 2, 3]), [1, 2, 3]);
    assert.deepEqual(layoutOf(state, [1, 2, 3]), [1, 2, 3]);
  });
});

describe("滚轮：只推相机，不动球心与图谱姿态", () => {
  it("同一标准化输入在画布不同位置产生**相同**位移（不再朝光标横移）", () => {
    const left = makeState();
    const right = makeState();
    const travel = wheelTravel(-100, 0, VIEWPORT.height);
    advanceEye(left, travel, 4000);
    advanceEye(right, travel, 4000);
    assert.deepEqual(left.eye, right.eye, "相机位移与光标位置无关 ✓");
    assert.deepEqual(left.center, [0, 0, 0], "球心不动");
    assert.deepEqual(left.scene, [0, 0, 0, 1], "图谱姿态不动");
    assert.deepEqual(left.view, [0, 0, 0, 1], "视角不动");
  });

  it("向前滚 = 前进（deltaY < 0 ⇒ 沿视线靠近球心）", () => {
    const state = makeState();
    advanceEye(state, wheelTravel(-120, 0, VIEWPORT.height), 4000);
    assert.ok(state.eye[2] < 900, `应沿 −Z 前进，实际 z=${state.eye[2]}`);
  });

  it("三种 deltaMode 都换算，且单事件行程限幅", () => {
    /* 用很小的输入比较单位换算：大输入会一起撞到 maxStep，比不出大小 ✗ */
    const pixel = wheelTravel(-1, 0, VIEWPORT.height);
    const line = wheelTravel(-1, 1, VIEWPORT.height);
    const page = wheelTravel(-1, 2, VIEWPORT.height);
    assert.ok(pixel > 0, "向前滚必须是正行程（前进）");
    assert.ok(line > pixel && page > line, "行/页单位必须比像素大");
    assert.equal(wheelTravel(-100000, 0, VIEWPORT.height), 400, "像素单位的大增量要限幅到 maxStep");
    assert.equal(wheelTravel(-100000, 2, VIEWPORT.height), 400, "页单位同样限幅（不能把页当像素）");
    assert.equal(wheelTravel(0, 0, VIEWPORT.height), 0);
    assert.equal(wheelTravel(Number.NaN, 0, VIEWPORT.height), 0);
  });

  it("可以穿过球心继续前进（进退连续，不因越过 C 失去推进能力）", () => {
    const step = wheelTravel(-100, 0, VIEWPORT.height) * 6; /* 一次约 300 单位，几步就能穿过 */
    const state = makeState({ eye: [0, 0, 500] });
    for (let i = 0; i < 6; i += 1) advanceEye(state, step, 4000);
    assert.ok(state.eye[2] < 0, `应已越过球心（z=${state.eye[2]}）`);
    assert.ok(Number.isFinite(state.eye[2]) && Math.abs(state.eye[2]) < 4000, "且不越界");
    /* 后退同样连续 */
    const back = makeState({ eye: [0, 0, -500] });
    for (let i = 0; i < 6; i += 1) advanceEye(back, -step, 4000);
    assert.ok(back.eye[2] > 0, `应已退回球心另一侧（z=${back.eye[2]}）`);
  });

  it("|P − C| 有有限上限（不会一路飞出场景）", () => {
    const state = makeState();
    for (let i = 0; i < 100; i += 1) advanceEye(state, 400, 2000);
    const distance = Math.hypot(state.eye[0], state.eye[1], state.eye[2]);
    assert.ok(distance <= 2000 + 1e-6, `超出上限：${distance}`);
  });
});

describe("拖动求解：抓取点沿指针方向移动（球前、球后都要）", () => {
  /*
   * 文档的验收口径是"**被抓取点的投影与指针方向一致**"。
   * 注意锚点的**布局坐标**在整次拖动里固定：只能从拖动**开始前**的状态反投影一次
   * （`layoutOf` 与 `displayOf` 用同一个状态是恒等变换，别拿它当"旋转后的位置" ✗）。
   */
  for (const [name, layout] of [
    ["球心前方（近侧）", [0, 0, 800]],
    ["球心后方（远侧，旧轨道模型下必然反向 ✗）", [0, 0, -200]],
    ["侧上方", [220, 180, 300]],
  ]) {
    it(`${name}：右拖 24px ⇒ 锚点投影正好跟到指针处`, () => {
      const state = makeState();
      const anchorLayout = layoutOf(state, displayOf(state, layout));
      const before = screenOf(state, displayOf(state, anchorLayout));
      const result = dragAnchorTo(state, VIEWPORT, FOV, anchorLayout, { x: before.x + 24, y: before.y });
      const after = screenOf(state, displayOf(state, anchorLayout));
      assert.ok(after !== null, "跟手后锚点仍在相机前方");
      assert.ok(Math.abs(after.x - (before.x + 24)) < 0.6, `x 应跟到指针处，实际 ${(after.x - before.x).toFixed(2)}px`);
      assert.ok(Math.abs(after.y - before.y) < 0.6, `y 不应漂移，实际 ${(after.y - before.y).toFixed(2)}px`);
      assert.ok(result.iterations <= 6, "迭代应在上限内收敛");
      assert.ok(result.error <= 0.5, `残差应小于容差，实际 ${result.error.toFixed(3)}px`);
    });

    it(`${name}：下拖 24px ⇒ 锚点投影正好跟到指针处`, () => {
      const state = makeState();
      const anchorLayout = layoutOf(state, displayOf(state, layout));
      const before = screenOf(state, displayOf(state, anchorLayout));
      dragAnchorTo(state, VIEWPORT, FOV, anchorLayout, { x: before.x, y: before.y + 24 });
      const after = screenOf(state, displayOf(state, anchorLayout));
      assert.ok(Math.abs(after.y - (before.y + 24)) < 0.6, `y 应跟到指针处，实际 ${(after.y - before.y).toFixed(2)}px`);
      assert.ok(Math.abs(after.x - before.x) < 0.6, `x 不应漂移，实际 ${(after.x - before.x).toFixed(2)}px`);
    });
  }

  it("单步求解方向正确：近侧与远侧都要朝 +x（符号由投影给出，不靠整体取反）", () => {
    for (const layout of [[0, 0, 800], [0, 0, -200]]) {
      const state = makeState();
      /* 锚点布局坐标只从**拖动前**的状态反投影一次（layoutOf ∘ displayOf 用同一状态是恒等 ✗） */
      const anchorLayout = layoutOf(state, displayOf(state, layout));
      const before = screenOf(state, displayOf(state, anchorLayout));
      const solution = solveDrag(state, VIEWPORT, FOV, displayOf(state, anchorLayout), 24, 0);
      applySceneRotation(state, solution.delta);
      const after = screenOf(state, displayOf(state, anchorLayout));
      assert.ok(after !== null);
      /* 单步会被限幅，但方向必须朝 +x ✓ */
      assert.ok(after.x > before.x, `深度 ${layout[2]} 的锚点单步方向反了`);
    }
  });

  it("多步连续拖动：每一步都继续跟手（不积累反向）", () => {
    const state = makeState();
    const anchorLayout = layoutOf(state, displayOf(state, [60, -30, 500]));
    let pointer = screenOf(state, displayOf(state, anchorLayout));
    for (let step = 0; step < 8; step += 1) {
      pointer = { x: pointer.x + 10, y: pointer.y + 4 };
      dragAnchorTo(state, VIEWPORT, FOV, anchorLayout, pointer);
      const now = screenOf(state, displayOf(state, anchorLayout));
      assert.ok(Math.abs(now.x - pointer.x) < 0.6, `第 ${step} 步 x 没跟上（差 ${(now.x - pointer.x).toFixed(2)}px）`);
      assert.ok(Math.abs(now.y - pointer.y) < 0.6, `第 ${step} 步 y 没跟上（差 ${(now.y - pointer.y).toFixed(2)}px）`);
    }
  });

  it("锚点贴在球心上时没有杠杆 ⇒ 报奇异而不是给出 NaN", () => {
    const state = makeState();
    const solution = solveDrag(state, VIEWPORT, FOV, [0, 0, 0], 30, 0);
    assert.equal(solution.singular, true);
    assert.deepEqual(solution.delta, [0, 0, 0, 1], "退化为不动，不产生垃圾旋转");
    /* 跟不动时如实返回残差（> 容差），并且**不产生任何旋转** ✓ */
    const result = dragAnchorTo(state, VIEWPORT, FOV, [0, 0, 0], { x: 100, y: 100 });
    assert.ok(result.error > 0.5, "应如实报告「没跟上」");
    assert.deepEqual(state.scene, [0, 0, 0, 1], "奇异时不许乱转");
    for (const value of state.scene) assert.ok(Number.isFinite(value), "不能是 NaN");
  });

  it("姿态带滚转时依然按**屏幕**轴求解（不是世界轴）", () => {
    const rolled = makeState({ view: quatFromAxisAngle([0, 0, -1], 0.6) });
    const anchorLayout = layoutOf(rolled, displayOf(rolled, [0, 0, 700]));
    const before = screenOf(rolled, displayOf(rolled, anchorLayout));
    dragAnchorTo(rolled, VIEWPORT, FOV, anchorLayout, { x: before.x + 20, y: before.y + 8 });
    const after = screenOf(rolled, displayOf(rolled, anchorLayout));
    assert.ok(Math.abs(after.x - (before.x + 20)) < 0.6, "滚转下右拖仍应跟手");
    assert.ok(Math.abs(after.y - (before.y + 8)) < 0.6, "滚转下下拖仍应跟手");
  });
});

describe("空白拖动：射线 ∩ 操作包围球", () => {
  it("相机在球外 ⇒ 取近侧交点（球面上、朝相机那一面）", () => {
    const state = makeState();
    const anchor = anchorFromRay(state, VIEWPORT, FOV, VIEWPORT.width / 2, VIEWPORT.height / 2);
    assert.ok(anchor !== null, "视线穿过球心 ⇒ 必有交点");
    const offset = Math.hypot(
      anchor.display[0] - state.center[0],
      anchor.display[1] - state.center[1],
      anchor.display[2] - state.center[2],
    );
    assert.ok(Math.abs(offset - state.radius) < 1e-6, `应落在球面上，实际半径 ${offset}`);
    assert.ok(anchor.display[2] > 0, "应该是靠相机那一侧（近侧）");
  });

  it("相机在球内 ⇒ 取前方退出交点（内壁）", () => {
    const state = makeState({ eye: [0, 0, 100] });
    const anchor = anchorFromRay(state, VIEWPORT, FOV, VIEWPORT.width / 2, VIEWPORT.height / 2);
    assert.ok(anchor !== null);
    assert.ok(anchor.display[2] < 0, `应落在前方内壁（z<0），实际 z=${anchor.display[2]}`);
    const offset = Math.hypot(...anchor.display);
    assert.ok(Math.abs(offset - state.radius) < 1e-6, "仍在球面上");
  });

  it("指针偏离球的屏幕轮廓 ⇒ 夹到轮廓上再求交（仍有旋转杠杆）", () => {
    const state = makeState();
    const centerScreen = screenOf(state, state.center);
    const anchor = anchorFromRay(state, VIEWPORT, FOV, VIEWPORT.width - 2, VIEWPORT.height - 2);
    assert.ok(anchor !== null, "球外空白也必须有虚拟抓取点");
    const offset = Math.hypot(
      anchor.display[0] - state.center[0],
      anchor.display[1] - state.center[1],
      anchor.display[2] - state.center[2],
    );
    assert.ok(Math.abs(offset - state.radius) < 1e-3, "夹到轮廓 ⇒ 仍落在球面上");
    assert.ok(anchor.screen.x !== centerScreen.x, "屏幕位置不应该退化成球心投影");
    /* 夹紧后的锚点仍在相机前方（可投影） */
    assert.ok(screenOf(state, anchor.display) !== null);
  });

  it("半径为 0 / 相机位置等于球心且朝向退化 ⇒ 不抛错、不返回 NaN", () => {
    assert.equal(anchorFromRay(makeState({ radius: 0 }), VIEWPORT, FOV, 10, 10), null);
    const degenerate = makeState({ eye: [0, 0, 0], radius: 10 });
    const anchor = anchorFromRay(degenerate, VIEWPORT, FOV, 400, 300);
    if (anchor !== null) {
      for (const value of anchor.display) assert.ok(Number.isFinite(value), "不能是 NaN");
    }
  });

  it("节点优先：光标压在节点上时用**节点**当锚点，而不是球面", () => {
    const state = makeState();
    const layout = [0, 0, 700];
    const projected = screenOf(state, displayOf(state, layout));
    const anchor = grabAnchor(
      state,
      VIEWPORT,
      FOV,
      [{ x: projected.x, y: projected.y, depth: projected.depth, radius: 8, visible: true }],
      projected.x,
      projected.y,
    );
    assert.ok(anchor !== null);
    const layoutBack = layoutOf(state, anchor.display);
    for (let i = 0; i < 3; i += 1) {
      assert.ok(Math.abs(layoutBack[i] - layout[i]) < 1e-6, `应反投影回节点布局坐标（分量 ${i}）`);
    }
  });
});

describe("整张图谱绕固定球心作刚体旋转（用户截面图要求的行为）", () => {
  /*
   * 用户的截面图：相机（眼睛）沿视线深入球体内部；中间的黑点是**固定转动中心** C；
   * 拖动 = 用鼠标"扒住"抓取点，让整张图谱绕 C 旋转，抓取点跟着鼠标走。
   *
   * 这套模型的三条硬性质：
   * 1. **刚体**：旋转只改姿态，任何节点到 C 的距离都不变 ✓；
   * 2. **抓取点跟手**：不论它在相机与 C 之间、在 C 附近、还是在 C 的另一侧 ✓；
   * 3. **没有整体反号**：不再有"深度超过轴心就反向"那种补丁式行为 ✓
   *    （近侧/远侧的**视差**是绕轴旋转本来的样子——像转盘：近处往右、远处往左 —— 但被抓住的那一点永远不反 ✓）。
   */
  const distTo = (point, center) => Math.hypot(
    point[0] - center[0],
    point[1] - center[1],
    point[2] - center[2],
  );

  it("刚体：每个节点到球心 C 的距离都不变（不论在 C 的哪一侧）", () => {
    const state = makeState({ eye: [0, 0, 240] });
    const nodes = [[140, 40, 190], [-160, 60, -120], [30, -180, -40], [0, 0, -260]];
    const anchorLayout = layoutOf(state, displayOf(state, [40, 20, 160]));
    const before = nodes.map((node) => distTo(displayOf(state, node), state.center));
    const result = dragAnchorTo(state, VIEWPORT, FOV, anchorLayout, { x: 430, y: 260 });
    assert.ok(result.error <= 0.5, "求解应收敛");
    const after = nodes.map((node) => distTo(displayOf(state, node), state.center));
    before.forEach((distance, index) => {
      assert.ok(Math.abs(distance - after[index]) < 1e-6, `节点 ${index} 到球心的距离变了 ⇒ 不是刚体`);
    });
  });

  it("球心前后的抓取点都不反号：挨个跟手（视角前方近处 / 对面内壁）", () => {
    for (const [name, anchorLayout] of [
      ["视角前方近处", [0, 0, 200]],
      ["对面内壁附近", [0, 0, -280]],
    ]) {
      const state = makeState({ eye: [0, 0, 240] });
      const before = screenOf(state, displayOf(state, anchorLayout));
      assert.ok(before !== null, `前置条件：${name}的锚点要在相机前方`);
      const result = dragAnchorTo(state, VIEWPORT, FOV, anchorLayout, {
        x: before.x + 36,
        y: before.y - 18,
      });
      const after = screenOf(state, displayOf(state, anchorLayout));
      assert.ok(Math.abs(after.x - (before.x + 36)) < 0.6, `${name}：x 没跟手`);
      assert.ok(Math.abs(after.y - (before.y - 18)) < 0.6, `${name}：y 没跟手`);
      assert.ok(result.iterations <= 6, `${name}：迭代应在上限内收敛`);
    }
  });

  it("拖动**只转图谱**：视角（相机位置与朝向）与球心都不动", () => {
    /*
     * 用户 2026-10-01 的澄清（配合截面图）：
     * 「也不是让视角旋转，可以说是视角是不动的，但是鼠标确实扒住视角所在的位置，
     *   让整个球体围绕旋转中心来旋转。」
     * ⇒ 拖动期间 P（相机位置）与 Q（相机姿态）必须逐分量不变，只有 S 变 ✓。
     */
    const state = makeState({ eye: [0, 0, 240] });
    const eyeBefore = [...state.eye];
    const viewBefore = [...state.view];
    const centerBefore = [...state.center];
    const anchorLayout = layoutOf(state, displayOf(state, [40, 20, 160]));
    const before = screenOf(state, displayOf(state, anchorLayout));
    dragAnchorTo(state, VIEWPORT, FOV, anchorLayout, { x: before.x + 40, y: before.y + 16 });
    assert.deepEqual(state.eye, eyeBefore, "相机位置不能动（视角不动）");
    assert.deepEqual(state.view, viewBefore, "相机朝向不能动（视角不动）");
    assert.deepEqual(state.center, centerBefore, "转动中心不能动");
    assert.notDeepEqual(state.scene, [0, 0, 0, 1], "变的只有图谱旋转 S");
  });

  it("杠杆不足的锚点会被换成球面抓取点（贴近球心时不硬拽）", () => {
    const state = makeState({ eye: [0, 0, 240] });
    const centerNode = screenOf(state, displayOf(state, [0, 0, -20]));
    const projected = [{
      x: centerNode.x,
      y: centerNode.y,
      depth: centerNode.depth,
      radius: 8,
      visible: true,
    }];
    /* 节点几乎压在球心上：杠杆 < 半径的 6% ⇒ 文档要求改用虚拟球面锚点 ✓ */
    const grabbed = grabAnchor(state, VIEWPORT, FOV, projected, centerNode.x, centerNode.y);
    assert.ok(grabbed !== null);
    assert.ok(hasLever(state, grabbed), "换来的锚点必须有杠杆");
    const offset = Math.hypot(
      grabbed.display[0] - state.center[0],
      grabbed.display[1] - state.center[1],
      grabbed.display[2] - state.center[2],
    );
    assert.ok(Math.abs(offset - state.radius) < 1e-3, "虚拟锚点落在操作球面上");
  });

  it("有杠杆的普通节点仍然优先用节点当锚点（不会被球面顶掉）", () => {
    const state = makeState({ eye: [0, 0, 240] });
    const node = screenOf(state, displayOf(state, [0, 0, -280]));
    const grabbed = grabAnchor(
      state,
      VIEWPORT,
      FOV,
      [{ x: node.x, y: node.y, depth: node.depth, radius: 8, visible: true }],
      node.x,
      node.y,
    );
    assert.ok(grabbed !== null);
    const layout = grabbed.layout;
    for (let i = 0; i < 3; i += 1) {
      assert.ok(Math.abs(layout[i] - [0, 0, -280][i]) < 1e-6, `应反投影回节点本身（分量 ${i}）`);
    }
  });

  it("光标停在画布中心（视角正前方那一点）拖动，同样跟手", () => {
    const state = makeState({ eye: [0, 0, 240] });
    const anchor = anchorFromRay(state, VIEWPORT, FOV, VIEWPORT.width / 2, VIEWPORT.height / 2);
    assert.ok(anchor !== null, "球内朝前必有内壁交点");
    assert.ok(anchor.display[2] < 0, "从球内看，命中的是前方内壁 ✓");
    const before = screenOf(state, anchor.display);
    dragAnchorTo(state, VIEWPORT, FOV, anchor.layout, { x: before.x + 30, y: before.y + 10 });
    const after = screenOf(state, displayOf(state, anchor.layout));
    assert.ok(Math.abs(after.x - (before.x + 30)) < 0.6, "x 应跟手");
    assert.ok(Math.abs(after.y - (before.y + 10)) < 0.6, "y 应跟手");
  });

  it("深入球体后仍可继续前进/后退（眼睛穿过黑点，C 与图谱姿态都不变）", () => {
    const state = makeState({ eye: [0, 0, 260] });
    const centerBefore = [...state.center];
    const sceneBefore = [...state.scene];
    const viewBefore = [...state.view];
    /* 一路推到球心另一侧 */
    for (let i = 0; i < 8; i += 1) advanceEye(state, 120, 4000);
    assert.ok(state.eye[2] < 0, `应已穿到球心另一侧（z=${state.eye[2]}）`);
    assert.deepEqual(state.center, centerBefore, "球心不动");
    assert.deepEqual(state.scene, sceneBefore, "图谱姿态不动");
    assert.deepEqual(state.view, viewBefore, "视角朝向不动");
  });
});

describe("光标射线与姿态轴", () => {  it("画布中心的光标射线 = 视线方向；姿态带滚转时右/上轴随之旋转", () => {
    const state = makeState();
    const centerRay = cursorRay(state, VIEWPORT, FOV, VIEWPORT.width / 2, VIEWPORT.height / 2);
    for (let i = 0; i < 3; i += 1) {
      assert.ok(Math.abs(centerRay.direction[i] - displayBasis(state).forward[i]) < 1e-9, `分量 ${i}`);
    }
    const rolled = makeState({ view: quatFromAxisAngle([0, 0, -1], 0.6) });
    const rolledRight = displayBasis(rolled).right;
    assert.ok(Math.abs(rolledRight[1]) > 0.3, "滚转后右轴应有明显的 y 分量（说明用的是姿态轴）");
    assert.ok(Math.abs(rotateVec(rolled.view, [1, 0, 0])[1] - rolledRight[1]) < 1e-12);
  });
});

/* ============ 换转动中心（双击/定位节点）：画面不跳，之后绕它转 ============ */

describe("把转动中心搬到某个节点上", () => {
  it("换中心那一刻**画面逐像素不动**（布局空间里的相机与朝向都不变 ✓）", () => {
    const state = makeState({ scene: quatFromAxisAngle([0, 1, 0.3], 0.7) });
    const before = effectiveBasis(state);
    const pictureBefore = [...before.position];
    const axesBefore = { right: [...before.right], up: [...before.up], forward: [...before.forward] };

    recenterOn(state, [120, -40, 60]);

    const after = effectiveBasis(state);
    for (let i = 0; i < 3; i += 1) {
      assert.ok(Math.abs(after.position[i] - pictureBefore[i]) < 1e-9, `相机位置分量 ${i} 不许变 ✗`);
      assert.ok(Math.abs(after.right[i] - axesBefore.right[i]) < 1e-12, "右轴不许变 ✗");
      assert.ok(Math.abs(after.up[i] - axesBefore.up[i]) < 1e-12, "上轴不许变 ✗");
      assert.ok(Math.abs(after.forward[i] - axesBefore.forward[i]) < 1e-12, "视线不许变 ✗");
    }
    /* 中心确实搬过去了 ✓，而且 S / Q 一位都没动 ✗ */
    assert.deepEqual(state.center, [120, -40, 60], "中心要落在目标点上 ✓");
    assert.deepEqual(state.scene, quatFromAxisAngle([0, 1, 0.3], 0.7), "图谱旋转不许变 ✗");
  });

  it("搬完之后，图谱绕**新中心**作刚体旋转（旧中心的相对关系不再保持 ✗）", () => {
    const state = makeState();
    recenterOn(state, [50, 0, 0]);
    const node = [150, 0, 0];
    const before = displayOf(state, node);
    applySceneRotation(state, quatFromAxisAngle([0, 1, 0], 0.5));
    const after = displayOf(state, node);
    /* 绕 (50,0,0) 转 0.5 弧度：距离不变 ✓ */
    const d0 = Math.hypot(before[0] - 50, before[1], before[2]);
    const d1 = Math.hypot(after[0] - 50, after[1], after[2]);
    assert.ok(Math.abs(d0 - d1) < 1e-9, "到新中心的距离应当守恒 ✓");
    assert.ok(Math.abs(d0 - 100) < 1e-9, "节点到新中心 100 ✓");
    assert.ok(Math.hypot(after[0] - before[0], after[2] - before[2]) > 10, "确实绕新中心转了 ✓");
  });
});
