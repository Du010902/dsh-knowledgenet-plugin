/**
 * 右下角实时截面小地图：映射数学 + 接线。
 *
 * 用户手绘的那张平面图（大圆 = 空间球体、中间黑点 = 固定转动中心、一排眼睛 = 视角的位置）
 * 要变成界面右下角的实时图。这里钉住两件不能错的事：
 * 1. **位置比例是真的**：眼睛到圆心的图上距离 = `|P − C| / 半径`，不是示意 ✓
 *    —— 所以"滚轮深入、穿过黑点、继续往外"在图上直接看得见；
 * 2. **转图谱不影响它**：拖动只转 S，视角没动 ⇒ 小地图上的眼睛不许动 ✓
 *    （如果这里用了 `effectiveBasis` 就会跟着乱动 ✗）。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  advanceEye,
  applySceneRotation,
  displayBasis,
  dragAnchorTo,
  displayOf,
  layoutOf,
  minimapPoint,
} from "../src/client/interior-navigation.ts";
import { quatFromAxisAngle } from "../src/client/trackball.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const minimapSource = await readFile(path.join(HERE, "..", "src", "client", "InteriorMinimap.tsx"), "utf8");
const panelSource = await readFile(path.join(HERE, "..", "src", "client", "GraphPanel.tsx"), "utf8");
const controllerSource = await readFile(path.join(HERE, "..", "src", "client", "interior-controller.ts"), "utf8");
const css = await readFile(path.join(HERE, "..", "src", "client", "panel.css"), "utf8");

const state = (overrides = {}) => ({
  center: [0, 0, 0],
  eye: [0, 0, 900],
  view: [0, 0, 0, 1],
  scene: [0, 0, 0, 1],
  radius: 300,
  ...overrides,
});
/** 从状态取截面坐标（用显示世界的相机朝向 ✓） */
const pointOf = (s) => {
  const basis = displayBasis(s);
  return minimapPoint({ center: s.center, eye: s.eye, forward: basis.forward, up: basis.up, radius: s.radius });
};

describe("截面坐标：真实比例、深度方向、内外判定", () => {
  it("球外近侧：深度为正（球心在相机前方）、在球外", () => {
    const point = pointOf(state());
    assert.ok(point.depth > 0, `球心在前方 ⇒ 深度应正，实际 ${point.depth}`);
    assert.ok(Math.abs(point.depth - 900) < 1e-9, "没有侧向偏移时深度 = 到球心的距离");
    assert.equal(point.outside, true, "900 > 半径 300 ⇒ 在球外");
  });

  it("站在球心上：坐标正好是圆心", () => {
    const point = pointOf(state({ eye: [0, 0, 0] }));
    assert.ok(Math.abs(point.depth) < 1e-12 && Math.abs(point.lateral) < 1e-12);
    assert.equal(point.distance, 0);
    assert.equal(point.outside, false);
  });

  it("穿过球心到另一侧：深度变负（图上会跑到圆心另一侧）", () => {
    const point = pointOf(state({ eye: [0, 0, -200] }));
    assert.ok(point.depth < 0, `越过球心 ⇒ 深度为负，实际 ${point.depth}`);
    assert.ok(Math.abs(point.distance - 200) < 1e-9);
  });

  it("纵轴 = `dot(P−C, up)`（连续），距离另给读数（文档 P2 改的就是这里）", () => {
    /*
     * 旧契约是"图上距离 = 真实距离"，但侧向取的是**垂直分量的模长** ✗ ——
     * 只要 up 分量过零，符号就整体翻转（+100 跳 −100 ✗，文档 P2）。
     * 现在纵轴就是 up 分量本身：连续、不会跳 ✓；代价是图上距离不再是真实距离，
     * 由 `distanceRatio` 单独给读数 ✓。
     */
    for (const eye of [[0, 0, 900], [120, 0, 600], [0, -220, 40], [-90, 160, -700]]) {
      const view = quatFromAxisAngle([0.4, 1, 0.2], 0.8);
      const point = pointOf(state({ eye, view }));
      const up = displayBasis(state({ eye, view })).up;
      const expected = eye[0] * up[0] + eye[1] * up[1] + eye[2] * up[2];
      assert.ok(Math.abs(point.lateral - expected) < 1e-9, `纵轴必须是 up 分量（eye=${eye}）`);
      /* 真实距离仍然准确，而且不小于纵轴分量 ✓ */
      const distance = Math.hypot(eye[0], eye[1], eye[2]);
      assert.ok(Math.abs(point.distance - distance) < 1e-9, "距离读数必须准确");
      assert.ok(Math.abs(point.lateral) <= distance + 1e-9);
    }
  });

  it("侧向偏移：相机上方向为正、相反方向为负", () => {
    const up = pointOf(state({ eye: [0, 150, 600] }));
    assert.ok(up.lateral > 0, "沿相机上方向偏移 ⇒ 正的侧向值");
    const down = pointOf(state({ eye: [0, -150, 600] }));
    assert.ok(down.lateral < 0, "相反方向 ⇒ 负值");
  });

  it("**转图谱不影响它**：拖动只转 S ⇒ 小地图上的眼睛不动", () => {
    const before = state({ eye: [0, 0, 240] });
    const marker = pointOf(before);
    const anchorLayout = layoutOf(before, displayOf(before, [0, 0, -20]));
    dragAnchorTo(before, { width: 800, height: 600 }, 50, anchorLayout, { x: 430, y: 300 });
    assert.notDeepEqual(before.scene, [0, 0, 0, 1], "前置条件：确实转了图谱");
    const after = pointOf(before);
    assert.ok(Math.abs(after.depth - marker.depth) < 1e-9, "深度不该变");
    assert.ok(Math.abs(after.lateral - marker.lateral) < 1e-9, "侧向不该变");
  });

  it("滚轮深入球体：图上眼睛朝圆心移动并越过它", () => {
    const s = state({ eye: [0, 0, 500] });
    const start = pointOf(s).depth;
    advanceEye(s, 260, 4000);
    const middle = pointOf(s).depth;
    advanceEye(s, 400, 4000);
    const past = pointOf(s).depth;
    assert.ok(middle < start, "前进 ⇒ 图上深度减小（往圆心走）");
    assert.ok(past < 0, "继续前进 ⇒ 越过圆心（深度为负）");
  });
});

describe("接线：控制器广播、面板认领并画在右下角", () => {
  it("控制器把状态打成一个窗口事件（合并到下一帧）", () => {
    assert.ok(controllerSource.includes('INTERIOR_STATE_EVENT = "kn-interior-state"'), "要有对外事件名");
    assert.ok(controllerSource.includes("new CustomEvent<InteriorStateDetail>(INTERIOR_STATE_EVENT"), "要派发状态事件");
    assert.ok(controllerSource.includes("stateEventPending"), "同一帧的多次变化要合并（拖动时每个 move 都同步一次 ✗）");
    assert.ok(controllerSource.includes("host: this.options.element"), "负载要带宿主元素，供面板认领");
  });

  it("面板：挂在小地图宿主容器里，并按 contains 认领属于自己那块画布", () => {
    assert.ok(panelSource.includes("<InteriorMinimap hostRef={graphHostRef} active={visible}"), "图区要渲染小地图");
    assert.ok(minimapSource.includes("container.contains(detail.host)"), "只认自己画布里的事件（多视图不串）");
    assert.ok(minimapSource.includes("window.addEventListener(INTERIOR_STATE_EVENT"), "要订阅控制器的事件");
    assert.ok(minimapSource.includes("window.removeEventListener(INTERIOR_STATE_EVENT"), "卸载要摘掉监听");
    assert.ok(minimapSource.includes("if (!active)"), "不可见时清掉旧位置（免得留着上一个库的点 ✗）");
  });

  it("样式：右下角、不吃指针事件、球/中心点/眼睛都有各自的类", () => {
    assert.match(css, /\.kn-minimap \{[\s\S]{0,200}position: absolute;[\s\S]{0,120}right: 12px;[\s\S]{0,80}bottom: 12px;/);
    assert.match(css, /\.kn-minimap \{[\s\S]{0,300}pointer-events: none/, "仪表不能吃掉画布的拖动/滚轮 ✗");
    for (const cls of ["kn-minimap-ball", "kn-minimap-center", "kn-minimap-eye-outline", "kn-minimap-pupil", "kn-minimap-trail", "kn-minimap-clamped"]) {
      assert.ok(minimapSource.includes(cls) && css.includes(`.${cls}`), `${cls} 要既有元素也有样式`);
    }
  });

  it("图形比例：球半径与画布尺寸在组件里是常量，眼睛按归一化坐标定位", () => {
    assert.ok(minimapSource.includes("const SIZE = 100") && minimapSource.includes("const BALL_RADIUS = 33"));
    assert.ok(minimapSource.includes("point.depth / detail.radius"), "用**操作球半径**归一化（真实比例 ✓）");
    assert.ok(!minimapSource.includes("effectiveBasis"), "不许用等效基：转图谱会让眼睛乱动 ✗");
  });
});
