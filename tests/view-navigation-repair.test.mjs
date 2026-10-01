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
  minimapAxesFrom,
  minimapComponents,
  radiusAbout,
  trailSampleStep,
} from "../src/client/interior-navigation.ts";
import { clippedEdgeSegment, pickClippedEdge } from "../src/client/edge-picking.ts";
import {
  cachedView,
  clearViewCache,
  libraryKeyOf,
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
  afterEach(() => { clearViewCache(); });

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

  it("接线：身份**显式**传给实例（面板 → 组件 prop → 引擎选项 → 导航），不再有全局身份", () => {
    /*
     * 复查指出的问题：渲染期写全局、引擎稍后读 ⇒ 两个面板先后渲染时 A 的引擎绑到 B ✗。
     * 现在整条链都是显式参数 ✓：
     *   面板 useMemo 出 libraryKey → `<GraphUniverse libraryKey=…>` →
     *   `new SpaceEngine({ libraryKey })` → `this.knLibraryKey` →
     *   `new SpaceNavigation({ libraryKey })` 与每一次缓存读写 ✓。
     */
    assert.ok(panelSource.includes("libraryKey={libraryKey}"), "面板要把身份作为 prop 传下去");
    assert.ok(panelSource.includes("useMemo(() => libraryKeyOf(payload?.library)"), "身份由载荷算出来（稳定 id 优先 ✓）");
    assert.ok(!/setActiveLibraryKey|activeLibraryKey/.test(panelSource), "面板不该再写全局身份 ✗");
    assert.ok(!/setActiveLibraryKey|activeLibraryKey/.test(controllerSource), "控制器不该再读全局身份 ✗");
    assert.ok(!buildSource.includes("knActiveLibraryKey"), "构建期不该再注入全局身份 ✗");
    assert.ok(buildSource.includes("libraryKey: this.knLibraryKey,"), "引擎要把身份交给导航（重排事件认领用）");
    assert.ok(buildSource.includes("libraryKey: libraryKey ??"), "组件要把 prop 交给引擎（用**解构出来的**变量 ✗ 不能写 props.…）");
    assert.ok(buildSource.includes("  relayoutToken,\\n  libraryKey,\\n  onEnter,"), "解构列表里要收下 libraryKey");
    /* 注：build.mjs 的**注释**里会引用 `props.libraryKey` 讲这个坑，所以只在产物上断言它不存在 ✓ */
    assert.ok(buildSource.includes("libraryKey?: string;"), "引擎选项里要有这个字段");
    /* 每一次缓存读写都带实例身份（布局缓存逐处显式传参 ✓） */
    for (const call of [
      "knCachedView(this.knLibraryKey)",
      "knStoreView(this.knLibraryKey",
      "alignedCachedPositions(graph.ids, this.knLibraryKey)",
      "cachedLayoutReusable(graph.signature, this.knLibraryKey)",
      "this.layoutSettled, this.knLibraryKey)",
      "cachedLayoutSignature(this.knLibraryKey)",
      "dropLayoutCache(this.knLibraryKey)",
    ]) {
      assert.ok(buildSource.includes(call), `缓存读写要带身份：${call}`);
    }
  });

  it("两个控制器各持自己的身份：重排事件只影响对应那一个", () => {
    const a = makeNavigation({ libraryKey: "id:A" });
    const b = makeNavigation({ libraryKey: "id:B" });
    a.element.emit("wheel", { deltaY: -100, deltaMode: 0 });
    b.element.emit("wheel", { deltaY: -100, deltaMode: 0 });
    const bCenterBefore = [...b.navigation.camera.knInterior.center];
    /* 只给 A 发重排请求（走 A 自己的事件通道 ✓） */
    dispatchRelayoutForKey(a.handlers, "id:A");
    a.navigation.fitAll(positionsOf([[100, 0, 0], [200, 0, 0]]), 2, true, "settle");
    b.navigation.fitAll(positionsOf([[700, 0, 0], [800, 0, 0]]), 2, true, "settle");
    assert.ok(Math.abs(a.navigation.camera.knInterior.center[0] - 150) < 1e-6, "A 应当被重设");
    assert.deepEqual(
      [...b.navigation.camera.knInterior.center],
      bCenterBefore,
      "B 没被请求 ⇒ 球心不许变（全局身份那套会被 A 的请求带着动 ✗）",
    );
  });

  it("构建期补丁不许引用作用域里不存在的标识符（踩过 `props.libraryKey` ✗）", () => {
    /*
     * 真实事故：`GraphUniverse` 的 props 是**解构形参**，作用域里没有 `props` 变量 ✗。
     * 补丁写成 `props.libraryKey` ⇒ 引擎构造抛 `ReferenceError: props is not defined`
     * ⇒ 被上游 try/catch 兜住 ⇒ 面板显示"三维绘制已中断"，看起来像 GPU 丢上下文 ✗
     * （排查方向被带偏一次）。这条断言把"引用必须落在解构列表里"钉住 ✓。
     */
    assert.ok(!bundle.includes("props.libraryKey"), "产物里不许出现 props.libraryKey ✗");
    assert.ok(bundle.includes("libraryKey: libraryKey ??"), "引擎构造要用解构出来的变量 ✓");
    const signature = /function GraphUniverse\(\{([^}]*)\}\)/.exec(bundle);
    assert.ok(signature !== null, "产物里应能找到 GraphUniverse 的解构形参");
    assert.ok(
      signature[1].includes("libraryKey"),
      "解构列表里必须有 libraryKey，否则上面的引用就是 ReferenceError ✗",
    );
  });

  it("兜底页把「初始化异常」与「上下文丢失」分开显示（别把代码错误误诊成 GPU ✗）", () => {
    assert.ok(bundle.includes("三维视图初始化失败"), "初始化异常要有自己的标题 ✓");
    assert.ok(bundle.includes("initError"), "要有三分支判定（lost / initError / webgl2）✓");
    assert.ok(bundle.includes('setFailure("lost")'), "上下文丢失仍走 lost ✓");
  });

  it("接线：引擎按实例身份读写缓存、每帧交节点坐标", () => {
    assert.ok(
      buildSource.includes("this.navigation.setFrameContext(bounds, this.viewport, this.positions, count)"),
      "每帧交节点坐标（线段拾取要用世界坐标）",
    );
    for (const needle of ["cachedView", "storeView"]) {
      assert.ok(bundle.includes(needle), `产物里要有分区缓存：${needle}`);
    }
    assert.ok(!bundle.includes("knActiveLibraryKey"), "产物里不该再有全局身份 ✗");
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
  it("**完整按钮链路**：立即取景（旧布局）不采球心，等布局收敛才采新中心", () => {
    /*
     * 复查指出的漏测：按钮点下去会**立刻**发一条 `fitAll`（测的还是重排前的坐标 ✗），
     * 旧实现就在那一次把待办标记消费掉了 ⇒ 新布局真正收敛时球心还是旧值 ✗。
     * 这里把那条链路完整走一遍：先立旧球心 50 → 用户操作 → 请求 → 立即取景 → 收敛取景。
     */
    const { navigation, element } = makeNavigation();
    /* ① 用户操作之前先形成"旧布局中心 50"（初始取景 ✓） */
    navigation.fitAll(positionsOf([[0, 0, 0], [100, 0, 0]]), 2, true, "initial");
    assert.ok(Math.abs(navigation.camera.knInterior.center[0] - 50) < 1e-6, "前置：旧球心 50");
    /* ② 用户操作过 ⇒ 球心冻结 ✓ */
    element.emit("wheel", { deltaY: -100, deltaMode: 0 });

    /* ③ 按钮：广播重排请求，并**立刻**发一次取景（仍旧坐标） */
    dispatchRelayoutForKey(globals.windowHandlers, "");
    navigation.fitAll(positionsOf([[0, 0, 0], [100, 0, 0]]), 2, true, "command");
    assert.ok(
      Math.abs(navigation.camera.knInterior.center[0] - 50) < 1e-6,
      `立即取景测的是旧坐标 ⇒ 球心必须保持 50，实际 ${navigation.camera.knInterior.center[0]}`,
    );

    /* ④ 新布局收敛后的取景 ⇒ 这时候才采新中心 500 */
    navigation.fitAll(positionsOf([[400, 0, 0], [600, 0, 0]]), 2, true, "settle");
    const carried = navigation.camera.knInterior;
    assert.ok(Math.abs(carried.center[0] - 500) < 1e-6, `收敛后应采新中心 500，实际 ${carried.center[0]}`);
    assert.ok(Math.abs(carried.radius - 100) < 1e-6, `半径应是 max|X−C| = 100，实际 ${carried.radius}`);
  });

  it("**引擎链路**：重排完成的通知与自动取景开关分开（否则通知发不出来 ✗）", () => {
    /*
     * 复查指出的漏洞：上游 `relayout()` 会把 `autoFit` 清零 ✗，而"布局结算"的通知
     * 挂在 `if (status === "settled" && this.autoFit)` 里 ⇒ 重排后 `pendingSettleFit`
     * 永远立不起来 ⇒ 插件的 `"settle"` 取景一次都不会被调用 ✗。
     * 修法是另立一条与相机无关的通知链 ⇒ 这里逐段核对它的接线 ✓。
     */
    assert.ok(buildSource.includes("private knAwaitRelayoutSettle = false;"), "要有「等新布局结算」的标记");
    assert.ok(buildSource.includes("private knPendingRelayoutFit = false;"), "要有「待通知插件」的标记");
    assert.ok(buildSource.includes("this.knAwaitRelayoutSettle = true;"), "relayout() 要立起等待标记");
    /* 通知分支必须**自己一个 if**，不能挂在 autoFit 那个分支里 ✗（在产物里核对真实代码 ✓） */
    assert.ok(
      bundle.includes('if (status === "settled" && this.knAwaitRelayoutSettle)'),
      "结算通知必须独立于 autoFit ✓",
    );
    assert.ok(
      bundle.includes("if (this.knPendingRelayoutFit && count > 0)"),
      "下一帧要用最新坐标通知插件 ✓",
    );
    /* 产物里两段都在（构建期补丁真的生效了 ✓） */
    assert.ok(bundle.includes("knAwaitRelayoutSettle"), "产物里要有等待标记");
    assert.ok(bundle.includes("knPendingRelayoutFit"), "产物里要有待通知标记");
    assert.ok(
      (bundle.match(/fitAll\(this\.positions, count, true, "settle"\)/g) ?? []).length >= 2,
      "结算取景与重排通知都要带上 settle 原因 ✓",
    );
  });

  it("**先保存判断再清标记**：重排期间操作过的用户不会被拉走镜头", () => {
    /*
     * 复查指出的次序问题：先 `relayoutPending = false` 再算 `skipFraming` ⇒ 恒为 false ✗。
     * 这里走完整链路：初始取景 → 用户操作 → 重排请求 → 立即取景 → 用户在重排期间再操作
     * → 结算通知 ⇒ 球心照旧复位，但**相机一位都不许动** ✓。
     */
    const { navigation, element, handlers } = makeNavigation();
    navigation.fitAll(positionsOf([[0, 0, 0], [100, 0, 0]]), 2, true, "initial");
    element.emit("wheel", { deltaY: -100, deltaMode: 0 });
    dispatchRelayoutForKey(handlers, "");
    navigation.fitAll(positionsOf([[0, 0, 0], [100, 0, 0]]), 2, true, "command");
    /* 用户在重排期间又操作了一次 ⇒ 结算时不该再取景 ✓ */
    element.emit("pointerdown", { button: 0, pointerId: 1, clientX: 400, clientY: 300, shiftKey: false });
    element.emit("pointermove", { pointerId: 1, clientX: 480, clientY: 320 });
    const before = { ...displayBasisOf(navigation) };
    navigation.fitAll(positionsOf([[400, 0, 0], [600, 0, 0]]), 2, true, "settle");
    const after = displayBasisOf(navigation);
    assert.ok(
      Math.abs(after.position[0] - before.position[0]) < 1e-9
        && Math.abs(after.position[1] - before.position[1]) < 1e-9
        && Math.abs(after.position[2] - before.position[2]) < 1e-9,
      `结算通知不该移动相机（旧实现会拉走 ✗）：${before.position} → ${after.position}`,
    );
    assert.ok(Math.abs(navigation.camera.knInterior.center[0] - 500) < 1e-6, "球心仍要按承诺复位到新中心 ✓");
  });

  it("**引擎链路**（无用户干预）：结算通知真的会把球心采成新布局中心", () => {
    const { navigation, element, handlers } = makeNavigation();
    navigation.fitAll(positionsOf([[0, 0, 0], [100, 0, 0]]), 2, true, "initial");
    element.emit("wheel", { deltaY: -100, deltaMode: 0 });
    dispatchRelayoutForKey(handlers, "");
    navigation.fitAll(positionsOf([[0, 0, 0], [100, 0, 0]]), 2, true, "command");
    navigation.fitAll(positionsOf([[400, 0, 0], [600, 0, 0]]), 2, true, "settle");
    const carried = navigation.camera.knInterior;
    assert.ok(Math.abs(carried.center[0] - 500) < 1e-6, `球心应是 500，实际 ${carried.center[0]}`);
    assert.ok(Math.abs(carried.radius - 100) < 1e-6, `半径应是 100，实际 ${carried.radius}`);
  });

  it("首次取景（initial）在用户没操作过时采球心；操作过之后不再动", () => {
    const fresh = makeNavigation();
    fresh.navigation.fitAll(positionsOf([[100, 0, 0], [200, 0, 0]]), 2, true, "initial");
    assert.ok(Math.abs(fresh.navigation.camera.knInterior.center[0] - 150) < 1e-6, "初次进入按布局中心采一次");
    fresh.element.emit("wheel", { deltaY: -100, deltaMode: 0 });
    fresh.navigation.fitAll(positionsOf([[500, 0, 0], [600, 0, 0]]), 2, true, "initial");
    assert.ok(Math.abs(fresh.navigation.camera.knInterior.center[0] - 150) < 1e-6, "操作过之后 initial 也不许再挪 ✗");
  });

  it("普通适应窗口（command）**不动**已冻结的球心", () => {
    const { navigation, element } = makeNavigation();
    element.emit("wheel", { deltaY: -100, deltaMode: 0 });
    const before = [...navigation.camera.knInterior.center];
    navigation.fitAll(positionsOf([[500, 0, 0], [600, 0, 0]]), 2, true, "command");
    assert.deepEqual(navigation.camera.knInterior.center, before, "没按重新整理就不该挪球心");
  });

  it("重排期间用户又操作了 ⇒ 球心照旧复位，但不再自动取景覆盖他的视角", () => {
    const { navigation, element, handlers } = makeNavigation();
    element.emit("wheel", { deltaY: -100, deltaMode: 0 });
    dispatchRelayoutForKey(handlers, "");
    element.emit("pointerdown", { button: 0, pointerId: 1, clientX: 400, clientY: 300, shiftKey: false });
    element.emit("pointermove", { pointerId: 1, clientX: 470, clientY: 300 });
    const viewBefore = [...navigation.camera.q];
    navigation.fitAll(positionsOf([[100, 0, 0], [200, 0, 0]]), 2, true, "settle");
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

  it("接线：重排走明确事件与明确原因（不再用 smooth 猜），面板按钮两件事一起做", () => {
    assert.ok(controllerSource.includes('RELAYOUT_EVENT = "kn-relayout-request"'), "要有明确的重排事件");
    assert.ok(controllerSource.includes("window.addEventListener(RELAYOUT_EVENT"), "控制器要订阅");
    assert.ok(!controllerSource.includes("const newLayout = !smooth"), "不该再用 smooth 猜重排 ✗");
    assert.ok(controllerSource.includes('reason: FitReason = "command"'), "取景原因要有明确默认值");
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

/* ==================== P2：小地图（已由位置图方案取代） ==================== */

/*
 * 这里的旧断言（"侧向只取 up 分量"、"shouldSampleTrail"）对应的是**上一版**小地图契约 ✗。
 * 那一版虽然去掉了侧向符号翻转，却仍把第三轴丢掉、并对球外做硬限幅
 * （`design/minimap-position-continuity-analysis.md` 指出的空间误差 ✓）。
 * 现在换成"固定参考轴 + 两张正交位置图 + 严格单调压缩"，
 * 相应测试全部搬到 [interior-minimap.test.mjs](./interior-minimap.test.mjs) ✓。
 */

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
    /* 身份**显式**传入（不再有全局身份 ✓） */
    libraryKey: options.libraryKey ?? "",
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
  return { navigation, element, calls, handlers: globals.windowHandlers };
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

function dispatchRelayoutForKey(handlers, libraryKey) {
  const handler = handlers.get(RELAYOUT_EVENT);
  assert.equal(typeof handler, "function", "控制器要订阅重排事件");
  handler({ type: RELAYOUT_EVENT, detail: { libraryKey } });
}

afterEach(() => { globals?.restore(); globals = null; });
