/**
 * 「重新整理」把**旋转中心**收回来：行为测试（用户要求 2026-09）。
 *
 * 背景：聚焦过某个节点后，环绕观察的中心会停在那个节点上；用户希望点「重新整理」时把它**初始化**。
 * 上游 `engine.relayout()` 是刻意"相机保持不动"的（它只重排布局），所以我们这一层在同一次点击里
 * 补发一条 `fitAll` 相机命令 —— 也就是 `engine.runCommand → navigation.command → navigation.fitAll()`。
 *
 * 这条测试**真的驱动上游 `SpaceNavigation`**（不需要 WebGL），把两件事钉死：
 * 1. `focusOn(index)` 确实会把中心钉到**那个节点**上（这就是用户看到的现象）；
 * 2. `fitAll(positions, count)` 会把中心移到**全部节点的包围盒中心** —— 与聚焦的那个节点无关 ✓。
 *
 * 于是"点击 → 发 fitAll"（静态守门在 `panel-icon-buttons.test.mjs`）＋"fitAll 回全图中心"（这里）
 * 合起来证明：点一下「重新整理」，环绕中心不再停在聚焦节点上 ✓。
 *
 * 为什么要绕一下（读源码 → 小改写 → 落到系统 temp 再 import）：
 * `navigation.ts` 的构造函数用了 **TS 参数属性**（`constructor(private readonly options: ...)`），
 * 而 Node 的 strip-only 模式不支持它（`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`）。
 * 所以这里把那一行展开成普通字段赋值，并把它那两条**运行时**相对导入改成绝对路径；
 * 改写只落在系统临时目录，**冻结的上游副本一个字节都不动** ✓（`vendor-drift` 测试照旧守着）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

/* --------------------------- 最小 DOM 桩（构造函数要挂监听） --------------------------- */
globalThis.window = { addEventListener() {}, removeEventListener() {}, clearTimeout() {} };
globalThis.document = { addEventListener() {}, removeEventListener() {} };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(HERE, "..", "src", "vendor", "upstream", "graph3d");
const NAV_SOURCE = path.join(VENDOR, "navigation.ts");
const CAMERA_URL = pathToFileURL(path.join(VENDOR, "camera.ts")).href;
const TYPES_URL = pathToFileURL(path.join(VENDOR, "types.ts")).href;

const workspace = mkdtempSync(path.join(tmpdir(), "kn-nav-"));
after(() => { rmSync(workspace, { recursive: true, force: true }); });

const NAV_TMP = path.join(workspace, "navigation.ts");
{
  const raw = readFileSync(NAV_SOURCE, "utf8");
  const parameterProperty = "constructor(private readonly options: NavigationOptions) {";
  assert.ok(raw.includes(parameterProperty), "上游 navigation.ts 的构造函数写法变了：请同步更新本测试的改写点");
  writeFileSync(
    NAV_TMP,
    raw
      /* 展开参数属性（strip-only 不支持它） */
      .replace(parameterProperty, "constructor(options: NavigationOptions) {\n    this.options = options;")
      /* 运行时相对导入 → 绝对路径（临时文件不在原目录里） */
      .replaceAll('"./camera.ts"', JSON.stringify(CAMERA_URL))
      .replaceAll('"./types.ts"', JSON.stringify(TYPES_URL)),
    "utf8",
  );
}

const { SpaceNavigation } = await import(pathToFileURL(NAV_TMP).href);
const { boundsOf } = await import(CAMERA_URL);

/** 三个节点：被"聚焦"的 A 在 (100,0,0)，另有 B(-50,0,0) 与 C(0,60,0) */
const POSITIONS = new Float32Array([100, 0, 0, -50, 0, 0, 0, 60, 0]);
const COUNT = 3;

function makeNavigation() {
  const element = {
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  };
  return new SpaceNavigation({
    element,
    initial: { target: [0, 0, 0], distance: 200, angle: 0.6, pitch: 0.3 },
    edgeLength: 40,
    getProjected: () => [],
    getEdges: () => [],
    onSelect() {},
    onHover() {},
    onContextMenu() {},
    onLocate() {},
    onCameraChange() {},
  });
}

/** 把定位/取景动画一次推到底（`update` 里 t 会被 clamp 到 1） */
function settle(nav) {
  nav.setFrameContext(boundsOf(POSITIONS, COUNT), { width: 800, height: 600 });
  assert.equal(nav.update(performance.now() + 10_000), true, "应当有动画在推进");
  return [...nav.camera.target].map((value) => Number(value.toFixed(3)));
}

const round3 = (vec) => vec.map((value) => Number(value.toFixed(3)));

describe("旋转中心：聚焦 vs 复位", () => {
  it("`focusOn(0)` 会把环绕中心钉在**那个节点**上（用户看到的现象）", () => {
    const nav = makeNavigation();
    nav.focusOn(0, POSITIONS);
    assert.deepEqual(settle(nav), [100, 0, 0], "中心应停在节点 A 上");
    nav.dispose();
  });

  it("`fitAll` 会把环绕中心移到**整张图的包围盒中心**（与聚焦节点无关）", () => {
    const nav = makeNavigation();
    /* 先复现"停在 A 上"的状态，再发 fitAll —— 与「点重新整理」的时序一致（先 relayout、后 fitAll） */
    nav.focusOn(0, POSITIONS);
    settle(nav);
    assert.deepEqual([...nav.camera.target], [100, 0, 0], "前置条件：此刻中心还在 A 上");

    nav.fitAll(POSITIONS, COUNT, true);
    const center = round3([...boundsOf(POSITIONS, COUNT).center]);
    const after = settle(nav);

    assert.deepEqual(after, center, "中心应回到整张图的包围盒中心");
    assert.notDeepEqual(after, [100, 0, 0], "不能还停在聚焦的那个节点上");
    /* 独立算一遍期望值，避免"用实现验证实现"：包围盒中心 = x/y 的 (min+max)/2 */
    assert.deepEqual(after, [25, 30, 0], "包围盒 x∈[-50,100] ⇒ 25；y∈[0,60] ⇒ 30");
    nav.dispose();
  });

  it("`fitAll` 只动中心与距离，不动使用者当前的旋转姿态", () => {
    const nav = makeNavigation();
    const before = { angle: nav.camera.angle, pitch: nav.camera.pitch };
    nav.fitAll(POSITIONS, COUNT, true);
    settle(nav);
    assert.equal(nav.camera.angle, before.angle, "角度是使用者的观看方向，不该被复位");
    assert.equal(nav.camera.pitch, before.pitch, "俯仰同理");
    nav.dispose();
  });
});
