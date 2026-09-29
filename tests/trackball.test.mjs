/**
 * 自由旋转（四元数 trackball）的行为测试。
 *
 * 背景（用户报的 bug）：上游用欧拉角 `(angle, pitch)` + `WORLD_UP` 叉乘推 right，
 * 越过天顶时 right 会翻转 → 上下拖到一定角度会"跳一下"。这里断言修复后的关键性质：
 * **连续小步拖拽时，相邻姿态的角增量恒定**（没有突变），且跨过极点也如此。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  currentQuat,
  freeBasis,
  quatFromEuler,
  rotateVec,
  trackballStep,
} from "../src/client/trackball.ts";

const angleBetween = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
const norm = (v) => Math.hypot(v[0], v[1], v[2]);

describe("欧拉角兼容（会话持久化 / 初始机位）", () => {
  it("quatFromEuler 复现上游机位公式 d·(cosP·sinA, sinP, cosP·cosA)", () => {
    for (const [a, p] of [[0, 0], [0.7, 0.3], [-1.2, -0.9], [2.5, 1.2]]) {
      const got = rotateVec(quatFromEuler(a, p), [0, 0, 1]);
      const want = [Math.cos(p) * Math.sin(a), Math.sin(p), Math.cos(p) * Math.cos(a)];
      for (let i = 0; i < 3; i += 1) assert.ok(Math.abs(got[i] - want[i]) < 1e-9, `分量 ${i}`);
    }
  });

  it("没有 q 时由 angle/pitch 播种；identity 时基向量是标准朝向", () => {
    const basis = freeBasis({ distance: 100, angle: 0, pitch: 0 }, [1, 2, 3]);
    assert.deepEqual(basis.position, [1, 2, 103]);
    assert.ok(Math.abs(basis.forward[2] + 1) < 1e-12, "forward = -Z");
    assert.ok(Math.abs(basis.right[0] - 1) < 1e-12);
    assert.ok(Math.abs(basis.up[1] - 1) < 1e-12);
  });
});

describe("四元数 trackball", () => {
  it("drag 之后姿态是单位四元数，基向量正交且单位长", () => {
    const state = { distance: 100, angle: 0, pitch: 0 };
    trackballStep(state, 0.3, 0.2);
    const q = currentQuat(state);
    assert.ok(Math.abs(Math.hypot(q[0], q[1], q[2], q[3]) - 1) < 1e-12, "四元数必须是单位长");

    const basis = freeBasis(state, [0, 0, 0]);
    for (const v of [basis.forward, basis.right, basis.up]) {
      assert.ok(Math.abs(norm(v) - 1) < 1e-9, "单位长度");
    }
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    assert.ok(Math.abs(dot(basis.forward, basis.right)) < 1e-9);
    assert.ok(Math.abs(dot(basis.forward, basis.up)) < 1e-9);
    assert.ok(Math.abs(dot(basis.right, basis.up)) < 1e-9);
  });

  it("**跨过天顶也连续**：上下各 4 弧度的小步拖拽，相邻角增量恒定（这就是原来的「跳一下」）", () => {
    const step = 0.01;
    for (const direction of [1, -1]) {
      const state = { distance: 100, angle: 0, pitch: 0 };
      const forwards = [];
      // 4 弧度 ≈ 229°，必然越过 ±90° 的奇点
      for (let i = 0; i < 400; i += 1) {
        trackballStep(state, 0, step * direction);
        forwards.push(rotateVec(currentQuat(state), [0, 0, -1]));
      }
      const deltas = [];
      for (let i = 1; i < forwards.length; i += 1) {
        deltas.push(angleBetween(forwards[i - 1], forwards[i]));
      }
      const max = Math.max(...deltas);
      const min = Math.min(...deltas);
      assert.ok(
        Math.abs(max - step) < 1e-6 && Math.abs(min - step) < 1e-6,
        `方向 ${direction}：每步应恒为 ${step} 弧度，实际 [${min.toFixed(6)}, ${max.toFixed(6)}]`,
      );
      assert.ok(deltas.every((d) => Number.isFinite(d)), "不得出现 NaN");
    }
  });

  it("**方向不随机位翻转**：相机位移在自身屏幕轴上的分量，任何机位都同号同值", () => {
    /*
     * 这是"有时候旋转方向与拖动方向相反"的严格刻画。
     *
     * 判据不能用屏幕投影：轨道相机里"侧面的点"在水平旋转时位移是二阶量，测不出方向。
     * 正确判据是把相机位移投影到**它自己的 right/up** 上——
     * 右拖应让相机沿着自己的 right **负向**绕（内容向右转），
     * 下拖应让相机沿着自己的 up **正向**绕（内容向下移）。
     * 若两条轴都是机身轴，这两个分量应当**在所有机位下完全相等**（不依赖朝向）。
     */
    const orientations = [
      ["identity", 0, 0],
      ["pitch=1.0", 0, 1.0],
      ["天顶 1.55", 0, 1.55],
      ["越过天顶 1.75", 0, 1.75],
      ["倒过来 3.2", 0, 3.2],
      ["斜 1.2/2.0", 1.2, 2.0],
      ["-2.5", 0.4, -2.5],
    ];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const lat = [];
    const ver = [];
    for (const [name, angle, pitch] of orientations) {
      const base = freeBasis({ distance: 340, angle, pitch }, [0, 0, 0]);
      const right = { distance: 340, angle, pitch };
      trackballStep(right, 0.08, 0);
      const vertical = { distance: 340, angle, pitch };
      trackballStep(vertical, 0, 0.08);
      const bR = freeBasis(right, [0, 0, 0]);
      const bV = freeBasis(vertical, [0, 0, 0]);
      const delta = (a, b) => [b.position[0] - a.position[0], b.position[1] - a.position[1], b.position[2] - a.position[2]];
      lat.push({ name, value: dot(delta(base, bR), base.right) });
      ver.push({ name, value: dot(delta(base, bV), base.up) });
    }
    for (const { name, value } of lat) assert.ok(value < -1e-6, `${name}: 右拖应让相机沿自身 right 负向绕，实际 ${value}`);
    for (const { name, value } of ver) assert.ok(value > 1e-6, `${name}: 下拖应让相机沿自身 up 正向绕，实际 ${value}`);
    // 机身轴 ⇒ 各机位的分量必须一致（不是"大致同号"，是同一个数）
    const spread = (list) => Math.max(...list.map((x) => x.value)) - Math.min(...list.map((x) => x.value));
    assert.ok(spread(lat) < 1e-9, `水平方向在各机位应完全一致，实际跨度 ${spread(lat)}`);
    assert.ok(spread(ver) < 1e-9, `垂直方向在各机位应完全一致，实际跨度 ${spread(ver)}`);
  });

  it("水平整圈与斜向长拖都连续（任意方向都不受限）", () => {
    const state = { distance: 100, angle: 0, pitch: 0 };
    let prev = rotateVec(currentQuat(state), [0, 0, -1]);
    const deltas = [];
    for (let i = 0; i < 700; i += 1) {
      trackballStep(state, 0.05, 0.02); // 斜向，绕两轴复合
      const now = rotateVec(currentQuat(state), [0, 0, -1]);
      deltas.push(angleBetween(prev, now));
      prev = now;
    }
    // 斜向（两个轴不完全正交，复合旋转略大于两分量平方和）：关键是"没有跳变"，远小于 0.1
    assert.ok(deltas.every((d) => Number.isFinite(d) && d < 0.1), "斜向长拖也应平稳");
    assert.ok(deltas.length === 700);
  });

  it("angle/pitch 会随四元数同步（供会话持久化取出等价姿态）", () => {
    const state = { distance: 100, angle: 0, pitch: 0 };
    for (let i = 0; i < 50; i += 1) trackballStep(state, 0.02, 0.03);
    const fromState = quatFromEuler(state.angle, state.pitch);
    const direct = currentQuat(state);
    const forwardA = rotateVec(fromState, [0, 0, -1]);
    const forwardB = rotateVec(direct, [0, 0, -1]);
    assert.ok(angleBetween(forwardA, forwardB) < 1e-6, "两种表示应给出同一朝向");
  });
});
