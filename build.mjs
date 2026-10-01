/**
 * 构建两个半：
 * - `index.js`   Host 半（Node ESM；内联 vendor 的 v2 引擎，external 只有宿主包与 Node 内建）
 * - `client.js`  Client 半（浏览器 CJS → DSH 的 `window.__ModuleLoader__.load({...})` 工厂形态）
 *
 * 四个刻意的约束：
 * 1. **自包含**：构建结束会断言没有任何输入模块来自项目源码（`../src/**`）；
 *    第三方 npm 包（three / d3-force-3d）允许，因为它们被**内联进产物**，运行时不依赖它们。
 * 2. **上游副本保持字节一致**：3D 布局 Worker 那条 Vite 专用分支
 *    （`new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" })`）
 *    在插件里必须换成 Blob Worker，但**不修改上游副本**——这里用一个只替换那一个表达式的
 *    转换插件，并且表达式一旦变化就直接构建失败（比复制一份 overlay 更安全：不会悄悄偏离）。
 * 3. **打包器来自项目已有依赖**：vite 8 自带 rolldown，不额外安装任何东西；
 *    找不到时给出可操作的错误，而不是静默降级。
 * 4. **客户端包装照抄仓内预设**（packages/client/tsdown.client.ts:618-624 的
 *    banner/intro/footer），React 等基线模块保持 external，由宿主模块表提供。
 *
 * 用法：node build.mjs
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { readdir, readFile, rmdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { patchAnchorSpacing } from "./scripts/layout-anchor-patch.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = HERE;
/**
 * 构建只从「父项目」取一样东西：`node_modules/.pnpm` 下的 rolldown（打包器）。
 * 插件从 `<项目>/dsh-plugin` 独立成仓库后，父目录不再是项目 ⇒ 用 `KN_PROJECT` 显式指定：
 *   $env:KN_PROJECT='D:\资料\file_useless\test\KnowledgeNet'; node build.mjs
 */
const PROJECT = path.resolve(process.env.KN_PROJECT ?? path.join(HERE, ".."));
const UPSTREAM = path.join(PLUGIN, "src/vendor/upstream");

const HOST_ENTRY = path.join(PLUGIN, "src/host/index.ts");
const CLIENT_ENTRY = path.join(PLUGIN, "src/client/index.ts");
const WORKER_ENTRY = path.join(UPSTREAM, "graph3d/layout.worker.ts");
const PACKAGE_NAME = "@local/dsh-knowledgenet";

/** 上游 layoutClient.ts 里那条 Vite 专用 worker 构造表达式（补丁点） */
const WORKER_CONSTRUCT =
  'new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" })';

/** 上游 navigation.ts 里那处欧拉角拖拽 + 俯仰限位（补丁点）：改成四元数 trackball */
const PITCH_CLAMP = [
  "    this.camera.angle -= dx * 0.006;",
  "    this.camera.pitch = clampPitch(this.camera.pitch + dy * 0.006);",
].join("\n");
/** 替换成绕"当前屏幕轴"旋转（任何方向都连续，没有上下限） */
const TRACKBALL_CALL =
  "    knTrackballStep(this.camera as unknown as never, dx * 0.006, dy * 0.006);";

/** 上游 camera.ts 的环绕基向量（补丁点）：有自由姿态时直接由四元数给出，避开天顶奇点 */
const ORBIT_BASIS_HEAD = [
  "export function orbitBasis(state: CameraState): CameraBasis {",
  "  const cosPitch = Math.cos(state.pitch);",
].join("\n");
const ORBIT_BASIS_PATCHED = [
  "export function orbitBasis(state: CameraState): CameraBasis {",
  "  const free = (state as unknown as { q?: unknown }).q;",
  "  if (free !== undefined && free !== null) {",
  "    return knFreeBasis(state as unknown as never, state.target as unknown as never) as unknown as CameraBasis;",
  "  }",
  "  const cosPitch = Math.cos(state.pitch);",
].join("\n");

/** 上游 renderer.ts 的连线透明度（补丁点）：选中节点后"无关边"会被压暗 + 按深度衰减 */
const EDGE_ALPHA_NEEDLE = [
  "      const alpha = emphasized",
  "        ? 0",
  "        : (focus !== null ? EDGE_ALPHA_DIMMED : EDGE_ALPHA) * depthFade;",
].join("\n");
/**
 * 统一成"**与选中节点相关的边走强调色（强调层不变），其余一律正常色**"。
 *
 * 用户的要求：选中节点后不该出现"有的粗有的细、有的浓有的淡"。
 * 相关边本来就由强调层（2px + 箭头）单独画，这里只需让**其余边**不再被压暗、
 * 也不再按深度衰减——即恒定用 `EDGE_ALPHA`。
 */
const EDGE_ALPHA_PATCHED = "      const alpha = emphasized ? 0 : EDGE_ALPHA;";

/**
 * 选中变化时把**引擎自己的事实**派发出去（只读上报，不改渲染行为）。
 *
 * 用途：回答"图上四条边都连着选中节点，为什么看起来只有三条被强调"。
 * 已确认（第一版上报）：引擎边数 = 仪表盘磁盘一致、`relatedEdges` 四条齐全 —— 数据侧没问题。
 * 所以这一版补上**决定性的量**：每条相关边在**细线层**的 alpha（>0 = 真的被细线层画出来了）
 * 与在**强调层**里的 RGB，再加上两层材质的 `vertexColors` 开关与调色板实际取值。
 * 一次即可判定"谁被哪一层画、用的什么颜色"。
 */
const SELECTION_NEEDLE = [
  "    this.relatedEdges = relatedEdges;",
  "    this.syncArrowPool(relatedEdges.length);",
].join("\n");
const SELECTION_PATCHED = [
  "    this.relatedEdges = relatedEdges;",
  "    this.syncArrowPool(relatedEdges.length);",
  "    try {",
  "      if (typeof window !== \"undefined\") {",
  "        const __ids = this.graph?.ids ?? [];",
  "        const __idOf = (i) => __ids[i] ?? String(i);",
  "        const __edgeList = this.graph?.edges ?? [];",
  "        const __base = this.edges?.geometry?.getAttribute?.(\"color\")?.array;",
  "        const __activeColors = this.activeColors;",
  "        const __round = (rgb) => rgb ? [Number(rgb[0].toFixed(4)), Number(rgb[1].toFixed(4)), Number(rgb[2].toFixed(4))] : null;",
  "        const __detail = relatedEdges.map((pair, i) => {",
  "          const index = __edgeList.findIndex((item) => item.from === pair[0] && item.to === pair[1]);",
  "          const alpha = (__base && index >= 0) ? __base[index * 8 + 3] : null;",
  "          const rgb = __activeColors ? [__activeColors[i * 6], __activeColors[i * 6 + 1], __activeColors[i * 6 + 2]] : null;",
  "          return { from: __idOf(pair[0]).slice(0, 8), to: __idOf(pair[1]).slice(0, 8), baseAlpha: alpha === null ? null : Number(alpha.toFixed(4)), activeRgb: __round(rgb) };",
  "        });",
  "        window.dispatchEvent(new CustomEvent(\"knowledgenet:selection\", { detail: {",
  "          selected: selected === null ? null : __idOf(selected).slice(0, 8),",
  "          engineEdges: __edgeList.length,",
  "          paletteEdge: __round(this.palette.edgeRgb),",
  "          paletteActive: __round(this.palette.edgeActiveRgb),",
  "          paletteAccent: __round(this.palette.accentRgb),",
  "          lineVertexColors: this.activeMaterial?.vertexColors === true,",
  "          baseVertexColors: this.edgeMaterial?.vertexColors === true,",
  "          activeVisible: this.activeEdges?.visible === true,",
  "          activeCount: this.activeEdges?.geometry?.instanceCount ?? null,",
  "          arrows: this.arrowPool?.length ?? null,",
  "          edges: __detail,",
  "        } }));",
  "      }",
  "    } catch (error) {",
  "      /* 诊断失败绝不能影响渲染 */",
  "    }",
].join("\n");

/**
 * 上游 renderer.ts 的强调层颜色记忆化（补丁点）——**上游 bug**：
 *
 * ```ts
 * const colorKey = `${accent[0]},${accent[1]},${accent[2]}`;
 * if (this.activeColorKey !== colorKey) { …按当时的 length 写逐实例颜色… }
 * ```
 * key 里没有 `length`：第一次只有 1 条相关边时写过颜色，之后强调集合涨到 4 条，
 * 颜色没变 → 这段循环被跳过 → 新增实例保持缓冲初始值 `[0,0,0]`（黑）。
 * 实测：4 条相关边里 1 条是正确强调色、3 条是黑色，正是用户看到的"有的青有的黑"。
 *
 * 修法：把 `length` 并进 key（每实例颜色相同，按条数失效足够）。
 */
const ACTIVE_COLOR_KEY_NEEDLE = "    const colorKey = `${accent[0]},${accent[1]},${accent[2]}`;";
const ACTIVE_COLOR_KEY_PATCHED = "    const colorKey = `${accent[0]},${accent[1]},${accent[2]},${length}`;";

/**
 * 强调色（与选中节点相关的边 + 它们的箭头）按**主题**取色：
 * - 黑主题：**浅蓝**（约 #99c7f2）——深色背景上要"亮且有色相"才显眼；
 * - 亮主题：**深灰**（约 #383d40）——浅色背景上要"深"才显眼。
 *
 * 上游 `edgeActiveRgb` 取 `--accent`（青绿 #24786b），与正常边色（灰绿 ≈ #849995）在小线宽下
 * 不易区分；箭头原本也直接用 `--accent`，所以一并改成同一颜色，避免"线一个色、箭头另一个色"。
 *
 * 想微调只改这两个数组的 0..1 分量（红、绿、蓝）：
 * 更浅 → 三个都抬；更饱和 → 压红、抬蓝；偏青 → 压红、抬绿蓝。
 */
const EMPHASIS_RGB_NEEDLE = '  edgeActiveRgb: parseColor(css("--accent"), "#24786b"),';
const EMPHASIS_RGB_PATCHED =
  "  edgeActiveRgb: isDark ? [0.38, 0.7, 1.0] : [0.09, 0.32, 0.62],";
const ARROW_CREATE_NEEDLE =
  "    this.arrowMaterial = new MeshBasicMaterial({ color: toColor(palette.accentRgb) });";
const ARROW_CREATE_PATCHED =
  "    this.arrowMaterial = new MeshBasicMaterial({ color: toColor(palette.edgeActiveRgb) });";
const ARROW_REFRESH_NEEDLE = "    this.arrowMaterial.color.copy(toColor(palette.accentRgb));";
const ARROW_REFRESH_PATCHED = "    this.arrowMaterial.color.copy(toColor(this.palette.edgeActiveRgb));";

/**
 * 强调线**加粗**（2px → 3px）。
 *
 * 为什么要动：浅蓝在 2px 细线上会被暗背景稀释成"发白"，连续反馈"看不出颜色"。
 * 线宽只有宽线层（`LineSegments2`）真正生效——普通线段的 `linewidth` 在多数平台被忽略。
 */

/** 星尘是装饰性微粒：用户要求不自绘装饰，直接关掉（0 个点等于不渲染） */
const DUST_NEEDLE = "const DUST_COUNT = 95;";
const DUST_PATCHED = "const DUST_COUNT = 0;";
const ACTIVE_WIDTH_NEEDLE = "const ACTIVE_LINE_WIDTH = 2;";
const ACTIVE_WIDTH_PATCHED = "const ACTIVE_LINE_WIDTH = 3;";

/*
 * 节点大小（用户要求）：
 * - **统一尺寸**：原来按连接数加权（hub ≤ 1.5×）且根节点 ×1.22 ⇒ 大小不一致；
 *   现在一律等大，选中的节点**不再放大**，改用既有的光圈（renderer 的 RING_GLOW）区分；
 * - **整体调小**：屏幕半径上限 22px 太大（直径 44px）⇒ 降到 13px。
 */
const NODE_SIZE_NEEDLE = [
  "    const hub = 1 + Math.min(0.5, 0.055 * Math.log2(1 + degree));",
  "    const root = ids[i] === rootId ? 1.22 : 1;",
  "    radius[i] = baseRadius * hub * root;",
].join("\n");
const NODE_SIZE_PATCHED = [
  "    // 等大：大小不再暗示「枢纽/根」（用户要求），选中靠光圈区分",
  "    const hub = 1;",
  "    const root = 1;",
  "    radius[i] = baseRadius * hub * root;",
].join("\n");
const NODE_PIXELS_NEEDLE = [
  "export const NODE_MIN_PIXELS = 2.6;",
  "export const NODE_MAX_PIXELS = 22;",
].join("\n");
const NODE_PIXELS_PATCHED = [
  "export const NODE_MIN_PIXELS = 2;",
  "export const NODE_MAX_PIXELS = 13;",
].join("\n");

/*
 * **布局收拢**（用户反馈：新建的孤立节点离得太远 ✗）。
 *
 * 上游默认：`centering: 0.02`（居中很弱）+ `chargeStrength: 90`（斥力较强）
 * ⇒ 没有连线的节点会被一路推开、落在大老远 ✓（截图：两个相连节点在中间，孤立节点在很远处 ✓）。
 * 这里只动这两个参数：居中加强、斥力减半 ⇒ 整体更聚拢，孤立节点也落在附近 ✓；
 * **不动**边界/碰撞等参数（那会在大图上带来挤压风险 ✗）。
 */
const LAYOUT_TIGHTEN_NEEDLE = [
  "  centering: 0.02,",
  "  chargeStrength: 90,",
].join("\n");
const LAYOUT_TIGHTEN_PATCHED = [
  "  centering: 0.08,",
  "  chargeStrength: 45,",
].join("\n");

/*
 * **节点屏幕半径固定**（用户要求：看起来一样大）。
 *
 * 只统一"世界半径"不够 ✗：屏幕半径 = 世界半径 × **投影缩放**，而投影缩放随节点离相机远近变化
 * ⇒ 靠前的节点看起来就是更大（再加光圈又大一档）—— 实测反馈"这俩还是不一样大" ✓。
 * 所以直接固定绘制半径：远近与缩放都不再改变大小；命中半径用的是同一个 `node.radius` ⇒ 也统一 ✓。
 */
const NODE_SCREEN_RADIUS_NEEDLE = [
  "    const radius = projected",
  "      ? clamp(radii[i]! * projected.scale, NODE_MIN_PIXELS, NODE_MAX_PIXELS)",
  "      : 0;",
].join("\n");
const NODE_SCREEN_RADIUS_PATCHED = [
  "    // 大小几乎恒定：投影缩放取 0.03 次方 ⇒ 同一跨度下差距约 6%（肉眼等同），但缩放仍有一点点反馈",
  "    const radius = projected",
  "      ? clamp(7 * Math.pow(projected.scale, 0.03), NODE_MIN_PIXELS, NODE_MAX_PIXELS)",
  "      : 0;",
].join("\n");

/*
 * 选中光圈：**保持收敛后的紧凑样式**（用户确认不用恢复原样 ✓）。
 * 上游是"外环 +9px / 辉光 +5px" ⇒ 节点半径约 7px 时视觉宽差近 2.3 倍 ✗；
 * 现在外环 +4px、辉光 +2px ⇒ 仍能一眼看出"选中"，但不再把节点衬得很大 ✓。
 */
const RING_NEEDLE = [
  "const RING_OUTER_OFFSET = 9;",
  "const RING_OUTER_HALF = 0.7;",
  "const RING_OUTER_ALPHA = 0.25;",
  "const RING_GLOW_OFFSET = 5;",
  "const RING_GLOW_HALF = 2.5;",
].join("\n");
const RING_PATCHED = [
  "const RING_OUTER_OFFSET = 4;",
  "const RING_OUTER_HALF = 0.7;",
  "const RING_OUTER_ALPHA = 0.3;",
  "const RING_GLOW_OFFSET = 2;",
  "const RING_GLOW_HALF = 1.5;",
].join("\n");

/*
 * **选中/悬停的放大系数**（用户反馈："选中某个节点时会让它变得很大" ✓）。
 *
 * 上游：选中 ×1.35、悬停 ×1.16 ⇒ 再加上外扩 9px 的光环，视觉上大得离谱 ✗。
 * 现在：选中 ×1.12（能看出"大了一点"，但不再夸张 ✓）、悬停 ×1.06 ✓。
 * 注意这两行在 renderer.ts 里，与节点半径（camera.ts）是**两套**逻辑 ⇒ 必须分别补 ✓。
 */
const SELECT_SCALE_NEEDLE = [
  "const SELECTED_SCALE = 1.35;",
  "const HOVER_SCALE = 1.16;",
].join("\n");
const SELECT_SCALE_PATCHED = [
  "const SELECTED_SCALE = 1.12;",
  "const HOVER_SCALE = 1.06;",
].join("\n");

/** 补丁注入的辅助模块（插件自己的实现，与上游副本无关） */
const TRACKBALL_IMPORT =  'import { freeBasis as knFreeBasis, trackballStep as knTrackballStep } from "../../../client/trackball.ts";\n';

/**
 * `engine.ts` 的导航入口（补丁点）：把上游 `SpaceNavigation` 换成插件自有的
 * **内部导航控制器**（固定球心 C + 相机位置 P + 视角 Q + 图谱旋转 S，
 * 见 `design/knowledgenet-interior-navigation.md` 与 `src/client/interior-controller.ts`）。
 *
 * 只换实现、不换接口：`camera` / `basis()` / `command()` / `fitAll()` / `setFrameContext()` /
 * `update()` / `cancelPointer()` / `dispose()` 全部照旧，引擎侧一行都不用改 ✓。
 * 滚轮（只推相机、可穿过球心）与拖动（抓取点投影约束求解）都在控制器里，
 * 所以上游 `navigation.ts` 的滚轮/按下补丁**已经全部移除** ✓
 * （`ContextHit` 仍从上游取，但那只是类型，编译期就擦除了 ✓）。
 */
const NAV_IMPORT_NEEDLE = 'import { SpaceNavigation, type ContextHit } from "./navigation.ts";';
const NAV_IMPORT_PATCHED = [
  'import { type ContextHit } from "./navigation.ts";',
  'import { InteriorNavigation as SpaceNavigation } from "../../../client/interior-controller.ts";',
].join("\n");

/** 视图缓存（按库身份分区）的导入：与上面那条导入一起注入 ✓ */
const VIEW_CACHE_IMPORT = 'import { cachedView as knCachedView, storeView as knStoreView } from "../../../client/view-cache.ts";';

/**
 * `GraphUniverse.tsx`：把库身份从插件**显式**接过来、交给引擎（补丁点）✓
 * 这样身份不再依赖"渲染期设的全局变量"，A 的引擎绝不会绑到 B 上 ✗。
 *
 * 注意：这个组件的 props 是**解构形参** ✗ —— 作用域里**没有** `props` 这个变量，
 * 所以必须同时改解构列表并使用 `libraryKey`，不能写 `props.libraryKey`。
 * （踩过：写成 `props.libraryKey` ⇒ 引擎构造抛 `ReferenceError: props is not defined`
 *  ⇒ 被上游 try/catch 兜住 ⇒ 面板显示成「三维绘制已中断」，看起来像 GPU 丢了上下文 ✗。）
 */
const UNIVERSE_PROPS_NEEDLE = "  /** 「重新整理布局」指令：数值变一次执行一次（不是相机命令，相机保持不动） */\n  relayoutToken: number;";
const UNIVERSE_PROPS_PATCHED = [
  "  /** 「重新整理布局」指令：数值变一次执行一次（不是相机命令，相机保持不动） */",
  "  relayoutToken: number;",
  "  /**",
  "   * 知识库身份（插件显式传入）。",
  "   * 视图/布局缓存都按它分区，引擎构造时绑定到实例 ✓。",
  "   */",
  "  libraryKey?: string;",
].join("\n");

/** 解构列表里也要收下它，否则作用域里没有这个变量 ✗ */
const UNIVERSE_DESTRUCTURE_NEEDLE = "  relayoutToken,\n  onEnter,";
const UNIVERSE_DESTRUCTURE_PATCHED = "  relayoutToken,\n  libraryKey,\n  onEnter,";

const UNIVERSE_ENGINE_NEEDLE = "      engine = new SpaceEngine({\n        host,";
const UNIVERSE_ENGINE_PATCHED = [
  "      engine = new SpaceEngine({",
  "        host,",
  "        libraryKey: libraryKey ?? \"\",",
].join("\n");

/**
 * 兜底页：**去掉"回到二维聚焦"**（补丁点）。
 *
 * 上游组件在渲染失败/上下文丢失时给两条路：重试 + "回到二维聚焦" ✓ ——
 * 但**本插件早已没有二维聚焦视图** ✗（图谱只挂在右侧栏标签页上）。
 * 那句话与那颗按钮照搬过来就是误导：用户点了什么也不会发生 ✗。
 * 这里改成说清"能做什么"（重试 / 刷新面板），并把按钮删掉 ✓。
 */
const FALLBACK_COPY_NEEDLE = [
  "            {lost",
  "              ? \"图形上下文已经停止。可以重试一次；如果仍然失败，请回到二维聚焦继续使用。\"",
  "              : \"三维空间视图需要 WebGL 2。回到二维聚焦同样能完成定位与关系核对，那里没有这个限制。\"}",
].join("\n");
const FALLBACK_COPY_PATCHED = [
  "            {lost",
  "              ? \"三维空间视图的图形上下文已经停止。可以先点「重试」重建；仍然失败时刷新面板或切换标签页后再试一次。\"",
  "              : initError !== null",
  "                ? `三维视图初始化时出错：${initError}。可以先点「重试」；若一直失败，请把这条消息反馈给插件作者。`",
  "                : \"这个环境不支持 WebGL 2，三维知识图无法显示。数据本身没有问题：搜索、右键菜单与对话里的划词都照常可用。\"}",
].join("\n");

/**
 * 把「初始化异常」与「上下文丢失」分开显示（补丁点）。
 *
 * 上游写的是 `const lost = failure !== "webgl2"` ✗ —— 于是**任何**初始化报错
 * （例如插件补丁引入的 `ReferenceError`）都会被显示成"三维绘制已中断"，
 * 看上去像 GPU 丢了上下文，白白把人引到错方向 ✗（我们就这么绕过一次）。
 * 这里改成三分支：上下文丢失 / 初始化异常（把原因原样显示出来 ✓）/ 不支持 WebGL2 ✓。
 */
const FALLBACK_LOST_NEEDLE = "    const lost = failure !== \"webgl2\";";
const FALLBACK_LOST_PATCHED = [
  "    /* 三种失败要分开：上下文丢失（lost）/ 初始化异常（initError）/ 环境不支持 WebGL2 ✓ */",
  "    const lost = failure === \"lost\";",
  "    const initError = !lost && failure !== \"webgl2\" ? failure : null;",
].join("\n");

const FALLBACK_TITLE_NEEDLE = "          <h3>{lost ? \"三维绘制已中断\" : \"当前环境未能启动 WebGL 2\"}</h3>";
const FALLBACK_TITLE_PATCHED = [
  "          <h3>{lost ? \"三维绘制已中断\" : initError !== null ? \"三维视图初始化失败\" : \"当前环境未能启动 WebGL 2\"}</h3>",
].join("\n");

/** 初始化异常也要能点「重试」（否则用户没有任何出路 ✗） */
const FALLBACK_RETRY_NEEDLE = "            {lost && (";
const FALLBACK_RETRY_PATCHED = "            {(lost || initError !== null) && (";

const FALLBACK_ACTION_NEEDLE = [
  "            <button type=\"button\" className=\"btn primary\" onClick={onFallback}>",
  "              <Icon name=\"focus\" />",
  "              回到二维聚焦",
  "            </button>",
].join("\n");

/** `onFallback` 随之变成可选：本插件没有"另一条视图"可回退 ✓ */
const FALLBACK_PROP_NEEDLE = "  onFallback(): void;";
const FALLBACK_PROP_PATCHED = [
  "  /**",
  "   * 兜底页上的「另一条路」。",
  "   * 本插件没有二维聚焦视图 ⇒ 兜底页不再渲染那颗按钮，这个回调保留为可选 ✓。",
  "   */",
  "  onFallback?(): void;",
].join("\n");

/**
 * `engine.ts` 的**视图缓存接线**（补丁点）：按知识库身份分区读写。
 *
 * 上游 `session.ts` 的 `cameraCache` 是模块级单槽位、没有库身份 ✗
 * （`design/view-navigation-repair-plan.md` P1）：A 库的球心/姿态会被 B 库采用，
 * 两个面板并存时还会互相覆盖。这里把读/写都换成 `src/client/view-cache.ts` 里
 * **按身份分区**的实现（身份优先用稳定 `libraryId`，退回库根路径 ✓）。
 *
 * 身份在**构造时绑定一次**到实例上：之后无论"当前库身份"被谁改，这个引擎都只认自己那一个 ✓
 * ⇒ 多实例天然隔离，不依赖读取那一刻的全局状态 ✓。
 */
const CAMERA_RESTORE_NEEDLE = "    const restored = cachedCamera();";
const CAMERA_RESTORE_PATCHED = [
  "    this.knLibraryKey = this.options.libraryKey ?? \"\";",
  "    const restored = knCachedView(this.knLibraryKey);",
].join("\n");

/**
 * 引擎选项里加一个**显式的库身份**（补丁点）。
 *
 * 之前身份是从一个插件全局变量里读的 ✗ —— 面板在渲染期设置它、引擎在**子组件 effect 里**
 * 才创建，而 React 的效果是"子先父后"⇒ 两个面板先后渲染时，A 的引擎会绑定到 B 的身份 ✗
 * （文档 P1 要求"将身份从 GraphPanel 传入引擎适配层" ✓，不是靠全局约定）。
 */
const ENGINE_OPTIONS_FIELD_NEEDLE = "export interface SpaceEngineOptions {\n  host: HTMLElement;";
const ENGINE_OPTIONS_FIELD_PATCHED = [
  "export interface SpaceEngineOptions {",
  "  host: HTMLElement;",
  "  /**",
  "   * 知识库身份（由插件**显式**传入，构造时绑定到实例）。",
  "   * 视图缓存与布局缓存都按它分区 ⇒ 两个面板并存也不会串库 ✓。",
  "   */",
  "  libraryKey?: string;",
].join("\n");

/** 导航也要知道自己的库身份：重新整理事件要按它认领 ✓ */
const NAV_OPTIONS_NEEDLE = "      element: options.host,\n      initial,";
const NAV_OPTIONS_PATCHED = [
  "      element: options.host,",
  "      initial,",
  "      libraryKey: this.knLibraryKey,",
].join("\n");

/** 布局缓存的读写都要带上实例身份 ✓（**逐处显式传参**，不再读全局 ✗） */
const LAYOUT_KEY_SUBSTITUTIONS = [
  ["storeLayout(this.graph.ids, this.positions, this.graph.signature, this.layoutSettled);",
    "storeLayout(this.graph.ids, this.positions, this.graph.signature, this.layoutSettled, this.knLibraryKey);"],
  ["storeLayout(graph!.ids, this.positions, graph!.signature, this.layoutSettled);",
    "storeLayout(graph!.ids, this.positions, graph!.signature, this.layoutSettled, this.knLibraryKey);"],
  ["alignedCachedPositions(graph.ids)", "alignedCachedPositions(graph.ids, this.knLibraryKey)"],
  ["cachedLayoutReusable(graph.signature)", "cachedLayoutReusable(graph.signature, this.knLibraryKey)"],
  ["cachedSignature: () => cachedLayoutSignature(),", "cachedSignature: () => cachedLayoutSignature(this.knLibraryKey),"],
  ["dropLayoutCache();", "dropLayoutCache(this.knLibraryKey);"],
];

/**
 * 取景的**原因**显式传给导航（补丁点）。
 *
 * 上游在三个不同时机调用 `fitAll`：初次取景、布局**收敛后**取景、以及工具栏的"适应窗口/重新整理"
 * 立即取景 ✗ —— 只靠 `smooth` 参数区分不了它们（它只表示要不要动画 ✗），
 * 于是"重新整理"的待办标记会被**按钮那一次立即取景**顺手消费掉，
 * 新布局真正收敛时就不再重设球心 ✗（文档 P2 复现的正是这个）。
 */
const FIT_REASON_SUBSTITUTIONS = [
  ["      this.navigation.fitAll(this.positions, count, false);",
    "      this.navigation.fitAll(this.positions, count, false, \"initial\");"],
  ["      this.navigation.fitAll(this.positions, count, true);",
    "      this.navigation.fitAll(this.positions, count, true, \"settle\");"],
];

const CAMERA_FIELD_NEEDLE = "  private layoutSettled = false;";
const CAMERA_FIELD_PATCHED = [
  "  private layoutSettled = false;",
  "  /** 本实例绑定的知识库身份（构造时取一次）：缓存读写都按它分区 ✓ */",
  "  private knLibraryKey = \"\";",
].join("\n");

const CAMERA_STORE_NEEDLE = "    storeCamera(this.navigation.camera, this.layoutSettled);";
const CAMERA_STORE_PATCHED = "    knStoreView(this.knLibraryKey, this.navigation.camera, this.layoutSettled);";

/**
 * 每帧把**节点坐标**一起交给导航（补丁点）。
 *
 * 关系拾取要在相机空间里按近平面裁剪线段 ⇒ 需要端点的世界坐标 ✗
 * （`getProjected()` 只有屏幕坐标，端点跑到相机后面时那就只是一堆无效值 ✗）。
 * 控制器本来只有 `command()` 时能拿到坐标，频率太低；这里搭上本来就每帧调用的
 * `setFrameContext()` ✓（多传两个参数，上游签名不变，运行期无碍 ✓）。
 */
const FRAME_CONTEXT_NEEDLE = "    this.navigation.setFrameContext(bounds, this.viewport);";
const FRAME_CONTEXT_PATCHED = "    this.navigation.setFrameContext(bounds, this.viewport, this.positions, count);";

/**
 * `session.ts` 的**布局缓存**也带上身份（补丁点）。
 *
 * 布局缓存本来就是按结构签名校验的，但那只能防"结构不同"✗ ——
 * 两个库**共享同一批节点 ID 与连线结构**时签名相同，仍会串用坐标 ✓（文档要求一并隔离）。
 * 这里给缓存项加一个 `key` 字段，读的时候要求与当前身份一致 ✓。
 */
const LAYOUT_CACHE_FIELD_NEEDLE = "  /** 这份坐标是否已经收敛：收敛过就不必再跑一轮布局 */\n  settled: boolean;\n}";
const LAYOUT_CACHE_FIELD_PATCHED = [
  "  /** 这份坐标是否已经收敛：收敛过就不必再跑一轮布局 */",
  "  settled: boolean;",
  "  /** 属于哪个知识库（由插件按身份分区；老缓存缺失时视作空串 ✓） */",
  "  key?: string;",
  "}",
].join("\n");

/** session.ts 的布局缓存：**身份由调用方显式传入**（不再读全局 ✗） */
const LAYOUT_SIGNATURE_NEEDLE = [
  "export function cachedLayoutSignature(): string | null {",
  "  return layoutCache?.signature ?? null;",
  "}",
].join("\n");
const LAYOUT_SIGNATURE_PATCHED = [
  "export function cachedLayoutSignature(key = \"\"): string | null {",
  "  /* 别的库留下的坐标不算（按身份分区 ✓） */",
  "  if ((layoutCache?.key ?? \"\") !== key) return null;",
  "  return layoutCache?.signature ?? null;",
  "}",
].join("\n");

/** 复用判断：签名一致**且**属于同一个库 ✓ */
const LAYOUT_REUSABLE_NEEDLE = [
  "export function cachedLayoutReusable(signature: string): boolean {",
  "  return layoutCache !== null && layoutCache.settled && layoutCache.signature === signature;",
  "}",
].join("\n");
const LAYOUT_REUSABLE_PATCHED = [
  "export function cachedLayoutReusable(signature: string, key = \"\"): boolean {",
  "  return layoutCache !== null && layoutCache.settled && layoutCache.signature === signature",
  "    && (layoutCache.key ?? \"\") === key;",
  "}",
].join("\n");

/** 坐标对齐：别的库留下的坐标一律不用 ✓ */
const LAYOUT_ALIGN_NEEDLE = [
  "export function alignedCachedPositions(ids: string[]): Float32Array | null {",
  "  if (!layoutCache || ids.length === 0) return null;",
].join("\n");
const LAYOUT_ALIGN_PATCHED = [
  "export function alignedCachedPositions(ids: string[], key = \"\"): Float32Array | null {",
  "  if (!layoutCache || ids.length === 0) return null;",
  "  /* 别的库留下的坐标不许拿来对齐（按身份分区）✓ */",
  "  if ((layoutCache.key ?? \"\") !== key) return null;",
].join("\n");

/** 写布局缓存：记下身份 ✓ */
const LAYOUT_STORE_NEEDLE = "  layoutCache = { ids: [...ids], positions: new Float32Array(positions), signature, settled };";
const LAYOUT_STORE_PATCHED = "  layoutCache = { ids: [...ids], positions: new Float32Array(positions), signature, settled, key };";

/** storeLayout 的签名要收下身份 ✓ */
const LAYOUT_STORE_SIGNATURE_NEEDLE = [
  "export function storeLayout(",
  "  ids: string[],",
  "  positions: Float32Array,",
  "  signature: string,",
  "  settled: boolean,",
  "): void {",
].join("\n");
const LAYOUT_STORE_SIGNATURE_PATCHED = [
  "export function storeLayout(",
  "  ids: string[],",
  "  positions: Float32Array,",
  "  signature: string,",
  "  settled: boolean,",
  "  key = \"\",",
  "): void {",
].join("\n");

/** 丢布局缓存：只丢自己那一份 ✓ */
const LAYOUT_DROP_NEEDLE = [
  "/** 只丢布局缓存（「重新整理」用）：相机是使用者的观看状态，不该跟着一起清 */",
  "export function dropLayoutCache(): void {",
  "  layoutCache = null;",
  "}",
].join("\n");
const LAYOUT_DROP_PATCHED = [
  "/** 只丢布局缓存（「重新整理」用）：相机是使用者的观看状态，不该跟着一起清 */",
  "export function dropLayoutCache(key = \"\"): void {",
  "  if (key === \"\" || (layoutCache?.key ?? \"\") === key) layoutCache = null;",
  "}",
].join("\n");


/** 宿主模块表提供的基线模块（packages/client/web/src/platform.ts:8-14），一律 external */
const CLIENT_BASELINE = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-store",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-dockkit",
];

async function loadRolldown() {
  // 项目根 node_modules 里没有顶层 rolldown（vite 的依赖在 .pnpm 下），按版本目录解析
  const pnpmDir = path.join(PROJECT, "node_modules/.pnpm");
  const candidates = [];
  try {
    for (const entry of await readdir(pnpmDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("rolldown@")) continue;
      candidates.push(path.join(pnpmDir, entry.name, "node_modules/rolldown/dist/index.mjs"));
    }
  } catch {
    // 交给下面的错误信息
  }
  for (const candidate of candidates) {
    try {
      await stat(candidate);
      return await import(pathToFileURL(candidate).href);
    } catch {
      // 试下一个
    }
  }
  try {
    const require = createRequire(path.join(PROJECT, "package.json"));
    return await import(pathToFileURL(require.resolve("rolldown")).href);
  } catch {
    throw new Error(
      "找不到 rolldown：本插件复用项目里 vite 自带的打包器（node_modules/.pnpm/rolldown@*）。"
      + "先在项目根执行一次 pnpm install，再重跑 node build.mjs。",
    );
  }
}

/**
 * 打包期间把**父项目的 `node_modules`** 挂到插件目录下（Windows 用 junction，其他平台用目录链接）。
 *
 * 为什么需要：插件原来住在 `<项目>/dsh-plugin`，Node 的向上查找自然命中项目的依赖 ✓；
 * 独立成仓库后父目录没有 `node_modules` ⇒ 打包器把 `three` / `d3-force-3d` 静默当成 external ✗
 * （终端只留一行 "Module not found"）⇒ 产物运行时 `require("three")` 直接炸
 * （`tests/selfcontained.test.mjs` 抓的正是这个 ✓）。
 *
 * 为什么不用自定义 `resolveId` 自己解析：手写解析只能拿到 CJS 条件（`three.cjs` 只是个 631 字节的壳），
 * 打包器接着去 require 它的 core ⇒ 产物从 1.76 MB 涨到 2.38 MB（实测）。**原生解析才是对的**，
 * 所以这里只负责让原生向上查找能命中。
 *
 * 只有当插件目录**没有** `node_modules` 时才创建，并且 `finally` 里只删这一个链接（绝不递归删）。
 */
async function withProjectModules(run) {
  const local = path.join(PLUGIN, "node_modules");
  const upstream = path.join(PROJECT, "node_modules");
  if (existsSync(local) || !existsSync(upstream)) return await run();
  let linked = false;
  try {
    await symlink(upstream, local, process.platform === "win32" ? "junction" : "dir");
    linked = true;
    return await run();
  } finally {
    if (linked) {
      try {
        await rmdir(local);
      } catch {
        try {
          await unlink(local);
        } catch {
          // 删不掉就留着（下一次构建会复用），总比删错东西好
        }
      }
    }
  }
}

/** 解析 `@/...`（上游源码里用的路径别名）到 vendor 目录 */
function atAliasPlugin() {
  const tryFiles = async (base) => {
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, path.join(base, "index.ts")]) {
      try {
        const info = await stat(candidate);
        if (info.isFile()) return candidate;
      } catch {
        // 继续
      }
    }
    return null;
  };
  return {
    name: "kn-at-alias",
    async resolveId(source) {
      if (!source.startsWith("@/")) return null;
      return await tryFiles(path.join(UPSTREAM, source.slice(2)));
    },
  };
}

/**
 * 把面板 CSS 作为虚拟模块注入客户端半。
 *
 * 为什么不用 `define`：rolldown 1.2 的 InputOptions 不接受 `define`（会静默忽略），
 * 未知标识符会留在产物里、运行时炸在 ShadowRoot 上。虚拟模块是确定性的做法。
 */
function panelCssPlugin(css) {
  const VIRTUAL = "\0kn-panel-css";
  return {
    name: "kn-panel-css",
    resolveId(source) {
      return source === "kn-panel-css" ? VIRTUAL : null;
    },
    load(id) {
      if (id !== VIRTUAL) return null;
      return `export const KN_PANEL_CSS = ${JSON.stringify(css)};`;
    },
  };
}

/**
 * **分量锚点间距**补丁（上游 `topology.ts`）：孤点不再按 `edgeLength` 铺开。
 *
 * 这里只做"把补丁点替换掉"这一件事，补丁点字符串住在 `scripts/layout-anchor-patch.mjs`
 * —— 同一个文件也被 `tests/layout-spacing.test.mjs` 用来在临时副本上量结果 ✓。
 * 注意它必须挂在**布局 Worker 那次构建**上（`topology.ts` 只被 Worker 的 layoutCore 引用 ✓）。
 */
function anchorSpacingPatchPlugin() {
  return {
    name: "kn-anchor-spacing",
    transform(code, id) {
      const clean = String(id).split("?")[0].replaceAll("\\", "/");
      if (!clean.endsWith("/vendor/upstream/graph3d/topology.ts")) return null;
      return { code: patchAnchorSpacing(code), map: null };
    },
  };
}

/**
 * **只在布局 Worker 里生效**的补丁：节点半径统一（大小不再由连接数/根节点决定）。
 *
 * 为什么单独一个插件：`adapter.ts`（`buildSpaceGraph` 算半径的地方）只被 **Worker** 构建引用 ✗，
 * 而 Worker 那次构建只挂了 `atAliasPlugin()` ⇒ 之前把补丁点加在主构建里，**永远不会执行** ✓
 * （实测：产物里仍是 `hub = 1 + Math.min(...)` ✗）。窄插件比把整套 free-rotation 搬进 Worker 更安全 ✓。
 */
function nodeSizePatchPlugin() {
  return {
    name: "kn-node-size",
    transform(code, id) {
      const clean = String(id).split("?")[0].replaceAll("\\", "/");
      if (!clean.endsWith("/vendor/upstream/graph3d/adapter.ts")) return null;
      if (!code.includes(NODE_SIZE_NEEDLE)) {
        throw new Error(
          "上游 adapter.ts 的节点半径写法变了：请同步更新 build.mjs 的补丁点。\n"
          + `期望片段：\n${NODE_SIZE_NEEDLE}`,
        );
      }
      return { code: code.replace(NODE_SIZE_NEEDLE, NODE_SIZE_PATCHED), map: null };
    },
  };
}

/** 布局 Worker 的源码以虚拟模块注入（Blob Worker 用），并提供一个构造工厂 */
function layoutWorkerPlugin(source) {
  const VIRTUAL = "\0kn-layout-worker";
  return {
    name: "kn-layout-worker",
    resolveId(source) {
      return source === "kn-layout-worker" ? VIRTUAL : null;
    },
    load(id) {
      if (id !== VIRTUAL) return null;
      return [
        `export const KN_LAYOUT_WORKER_SOURCE = ${JSON.stringify(source)};`,
        "let objectUrl = null;",
        "export function createKnLayoutWorker() {",
        '  if (objectUrl === null) objectUrl = URL.createObjectURL(new Blob([KN_LAYOUT_WORKER_SOURCE], { type: "text/javascript" }));',
        "  return new Worker(objectUrl);",
        "}",
      ].join("\n");
    },
  };
}

/**
 * 只替换上游 `layoutClient.ts` 里的那一条 worker 构造表达式。
 *
 * 关键点：**表达式找不到就抛错**。上游改了写法，这里必须有人来更新补丁点，
 * 而不是让一个静默失效的 Worker 把三维视图变成「布局不可用」。
 */
function layoutClientPatchPlugin() {
  return {
    name: "kn-layout-client-patch",
    transform(code, id) {
      const clean = String(id).split("?")[0].replaceAll("\\", "/");
      if (!clean.endsWith("/vendor/upstream/graph3d/layoutClient.ts")) return null;
      if (!code.includes(WORKER_CONSTRUCT)) {
        throw new Error(
          "上游 layoutClient.ts 的 worker 构造表达式变了：请同步更新 build.mjs 的补丁点。\n"
          + `期望表达式：${WORKER_CONSTRUCT}`,
        );
      }
      return {
        code: `import { createKnLayoutWorker } from "kn-layout-worker";\n`
          + code.replace(WORKER_CONSTRUCT, "createKnLayoutWorker()"),
        map: null,
      };
    },
  };
}

/**
 * 把空间视图的旋转换成**四元数 trackball**（用户要求"任意方向拖拽都无限连贯"）。
 *
 * 两个补丁点，都只替换上游的**原表达式/函数头**，找不到就构建失败：
 * 1. `navigation.ts` 的 `rotate()`：原本是欧拉角 `angle -= …` + `pitch = clampPitch(…)`，
 *    换成绕"当前屏幕轴"的一次四元数旋转；
 * 2. `camera.ts` 的 `orbitBasis()`：有自由姿态时直接由四元数取出 position/forward/right/up，
 *    不再用 `WORLD_UP` 叉乘推 right —— 那个叉乘在天顶会翻转，正是"跳一下"的来源。
 *
 * 辅助实现放在插件自己的 `src/client/trackball.ts`（纯数学、有单测），通过 import 注入被补丁的模块；
 * **上游副本仍然字节一致**。
 */
function freeRotationPatchPlugin() {
  const patch = (code, needle, replacement, what) => {
    if (!code.includes(needle)) {
      throw new Error(
        `上游 ${what} 的写法变了：请同步更新 build.mjs 的补丁点。\n期望片段：\n${needle}`,
      );
    }
    return TRACKBALL_IMPORT + code.replace(needle, replacement);
  };
  return {
    name: "kn-free-rotation",
    transform(code, id) {
      const clean = String(id).split("?")[0].replaceAll("\\", "/");
      if (clean.endsWith("/vendor/upstream/graph3d/engine.ts")) {
        /* 换导航实现 + 显式库身份 + 分区缓存 + 取景原因 ✓ */
        for (const [needle, what] of [
          [NAV_IMPORT_NEEDLE, "导航导入"],
          [ENGINE_OPTIONS_FIELD_NEEDLE, "选项接口"],
          [CAMERA_FIELD_NEEDLE, "实例字段"],
          [CAMERA_RESTORE_NEEDLE, "相机恢复"],
          [CAMERA_STORE_NEEDLE, "相机保存"],
          [FRAME_CONTEXT_NEEDLE, "每帧上下文"],
          [NAV_OPTIONS_NEEDLE, "导航选项"],
        ]) {
          if (!code.includes(needle)) {
            throw new Error(
              `上游 engine.ts 的${what}写法变了：请同步更新 build.mjs 的补丁点。\n期望片段：\n${needle}`,
            );
          }
        }
        let patched = code
          .replace(NAV_IMPORT_NEEDLE, `${NAV_IMPORT_PATCHED}\n${VIEW_CACHE_IMPORT}`)
          .replace(ENGINE_OPTIONS_FIELD_NEEDLE, ENGINE_OPTIONS_FIELD_PATCHED)
          .replace(CAMERA_FIELD_NEEDLE, CAMERA_FIELD_PATCHED)
          .replace(CAMERA_RESTORE_NEEDLE, CAMERA_RESTORE_PATCHED)
          .replace(CAMERA_STORE_NEEDLE, CAMERA_STORE_PATCHED)
          .replace(FRAME_CONTEXT_NEEDLE, FRAME_CONTEXT_PATCHED)
          .replace(NAV_OPTIONS_NEEDLE, NAV_OPTIONS_PATCHED);
        for (const [needle, replacement] of [...LAYOUT_KEY_SUBSTITUTIONS, ...FIT_REASON_SUBSTITUTIONS]) {
          if (!patched.includes(needle)) {
            throw new Error(
              "上游 engine.ts 的缓存/取景调用点写法变了：请同步更新 build.mjs 的补丁点。\n"
              + `期望片段：\n${needle}`,
            );
          }
          patched = patched.split(needle).join(replacement);
        }
        return { code: patched, map: null };
      }
      if (clean.endsWith("/vendor/upstream/components/GraphUniverse.tsx")) {
        /* 库身份从插件显式接进来 + 兜底页去掉"回到二维聚焦" ✓ */
        for (const [needle, what] of [
          [UNIVERSE_PROPS_NEEDLE, "props 定义"],
          [UNIVERSE_DESTRUCTURE_NEEDLE, "props 解构"],
          [UNIVERSE_ENGINE_NEEDLE, "引擎构造"],
          [FALLBACK_LOST_NEEDLE, "兜底页失败分类"],
          [FALLBACK_TITLE_NEEDLE, "兜底页标题"],
          [FALLBACK_COPY_NEEDLE, "兜底页文案"],
          [FALLBACK_ACTION_NEEDLE, "兜底页按钮"],
          [FALLBACK_RETRY_NEEDLE, "重试按钮条件"],
          [FALLBACK_PROP_NEEDLE, "兜底回调声明"],
        ]) {
          if (!code.includes(needle)) {
            throw new Error(
              `上游 GraphUniverse.tsx 的${what}写法变了：请同步更新 build.mjs 的补丁点。\n期望片段：\n${needle}`,
            );
          }
        }
        return {
          code: code
            .replace(UNIVERSE_PROPS_NEEDLE, UNIVERSE_PROPS_PATCHED)
            .replace(UNIVERSE_DESTRUCTURE_NEEDLE, UNIVERSE_DESTRUCTURE_PATCHED)
            .replace(UNIVERSE_ENGINE_NEEDLE, UNIVERSE_ENGINE_PATCHED)
            .replace(FALLBACK_LOST_NEEDLE, FALLBACK_LOST_PATCHED)
            .replace(FALLBACK_TITLE_NEEDLE, FALLBACK_TITLE_PATCHED)
            .replace(FALLBACK_COPY_NEEDLE, FALLBACK_COPY_PATCHED)
            .replace(FALLBACK_ACTION_NEEDLE, "")
            .replace(FALLBACK_RETRY_NEEDLE, FALLBACK_RETRY_PATCHED)
            .replace(FALLBACK_PROP_NEEDLE, FALLBACK_PROP_PATCHED),
          map: null,
        };
      }
      if (clean.endsWith("/vendor/upstream/graph3d/session.ts")) {
        /* 布局缓存改成**显式传身份**：所有读写都按参数分区，不再依赖全局 ✗ */
        for (const [needle, what] of [
          [LAYOUT_CACHE_FIELD_NEEDLE, "布局缓存结构"],
          [LAYOUT_STORE_SIGNATURE_NEEDLE, "写缓存函数签名"],
          [LAYOUT_SIGNATURE_NEEDLE, "签名读取"],
          [LAYOUT_REUSABLE_NEEDLE, "复用判断"],
          [LAYOUT_ALIGN_NEEDLE, "坐标对齐"],
          [LAYOUT_STORE_NEEDLE, "写布局缓存"],
          [LAYOUT_DROP_NEEDLE, "丢布局缓存"],
        ]) {
          if (!code.includes(needle)) {
            throw new Error(
              `上游 session.ts 的${what}写法变了：请同步更新 build.mjs 的补丁点。\n期望片段：\n${needle}`,
            );
          }
        }
        return {
          code: code
            .replace(LAYOUT_CACHE_FIELD_NEEDLE, LAYOUT_CACHE_FIELD_PATCHED)
            .replace(LAYOUT_STORE_SIGNATURE_NEEDLE, LAYOUT_STORE_SIGNATURE_PATCHED)
            .replace(LAYOUT_SIGNATURE_NEEDLE, LAYOUT_SIGNATURE_PATCHED)
            .replace(LAYOUT_REUSABLE_NEEDLE, LAYOUT_REUSABLE_PATCHED)
            .replace(LAYOUT_ALIGN_NEEDLE, LAYOUT_ALIGN_PATCHED)
            .replace(LAYOUT_STORE_NEEDLE, LAYOUT_STORE_PATCHED)
            .replace(LAYOUT_DROP_NEEDLE, LAYOUT_DROP_PATCHED),
          map: null,
        };
      }
      if (clean.endsWith("/vendor/upstream/graph3d/navigation.ts")) {
        /*
         * 上游导航类已经被 `InteriorNavigation` 取代（引擎的导入被换掉了）⇒
         * 滚轮缩放与按下重设轴心的补丁**全部移除**（文档要求）✓。
         * 这里只剩自由旋转那一处：万一该文件仍被打进产物（例如别的模块引用了它），
         * 它的 `rotate()` 也保持四元数连续、不会退化回欧拉角奇点 ✓。
         */
        return { code: patch(code, PITCH_CLAMP, TRACKBALL_CALL, "navigation.ts 的 rotate()"), map: null };
      }
      if (clean.endsWith("/vendor/upstream/graph3d/types.ts")) {
        if (!code.includes(LAYOUT_TIGHTEN_NEEDLE)) {
          throw new Error(
            "上游 types.ts 的布局参数变了：请同步更新 build.mjs 的补丁点。\n"
            + `期望片段：\n${LAYOUT_TIGHTEN_NEEDLE}`,
          );
        }
        return { code: code.replace(LAYOUT_TIGHTEN_NEEDLE, LAYOUT_TIGHTEN_PATCHED), map: null };
      }
      if (clean.endsWith("/vendor/upstream/graph3d/adapter.ts")) {
        if (!code.includes(NODE_SIZE_NEEDLE)) {
          throw new Error(
            "上游 adapter.ts 的节点半径写法变了：请同步更新 build.mjs 的补丁点。\n"
            + `期望片段：\n${NODE_SIZE_NEEDLE}`,
          );
        }
        return { code: patch(code, NODE_SIZE_NEEDLE, NODE_SIZE_PATCHED, "adapter.ts 的节点半径"), map: null };
      }
      if (clean.endsWith("/vendor/upstream/graph3d/camera.ts")) {
        if (!code.includes(NODE_PIXELS_NEEDLE)) {
          throw new Error(
            "上游 camera.ts 的节点像素钳制写法变了：请同步更新 build.mjs 的补丁点。\n"
            + `期望片段：\n${NODE_PIXELS_NEEDLE}`,
          );
        }
        /*
         * 注意：`patch()` 每次都会前置注入 trackball 导入 ⇒ 只能调用一次。
         * 所以像素钳制先用普通 replace，第二处才走 patch ✓（两次调用会导致重复导入 ✗）。
         */
        if (!code.includes(NODE_SCREEN_RADIUS_NEEDLE)) {
          throw new Error(
            "上游 camera.ts 的节点屏幕半径写法变了：请同步更新 build.mjs 的补丁点。\n"
            + `期望片段：\n${NODE_SCREEN_RADIUS_NEEDLE}`,
          );
        }
        const sized = code
          .replace(NODE_PIXELS_NEEDLE, NODE_PIXELS_PATCHED)
          .replace(NODE_SCREEN_RADIUS_NEEDLE, NODE_SCREEN_RADIUS_PATCHED);
        return { code: patch(sized, ORBIT_BASIS_HEAD, ORBIT_BASIS_PATCHED, "camera.ts 的 orbitBasis()"), map: null };
      }
      if (clean.endsWith("/vendor/upstream/graph3d/renderer.ts")) {
        if (!code.includes(EDGE_ALPHA_NEEDLE)) {
          throw new Error(
            "上游 renderer.ts 的连线透明度写法变了：请同步更新 build.mjs 的补丁点。\n"
            + `期望片段：\n${EDGE_ALPHA_NEEDLE}`,
          );
        }
        if (!code.includes(SELECTION_NEEDLE)) {
          throw new Error(
            "上游 renderer.ts 的强调集合写法变了：请同步更新 build.mjs 的补丁点。\n"
            + `期望片段：\n${SELECTION_NEEDLE}`,
          );
        }
        if (!code.includes(ACTIVE_COLOR_KEY_NEEDLE)) {
          throw new Error(
            "上游 renderer.ts 的强调层颜色记忆化写法变了：请同步更新 build.mjs 的补丁点。\n"
            + `期望片段：\n${ACTIVE_COLOR_KEY_NEEDLE}`,
          );
        }
        if (!code.includes(SELECT_SCALE_NEEDLE)) {
          throw new Error(
            "上游 renderer.ts 的选中/悬停放大系数变了：请同步更新 build.mjs 的补丁点。\n"
            + `期望片段：\n${SELECT_SCALE_NEEDLE}`,
          );
        }
        if (!code.includes(ARROW_CREATE_NEEDLE) || !code.includes(ARROW_REFRESH_NEEDLE)) {
          throw new Error(
            "上游 renderer.ts 的箭头颜色写法变了：请同步更新 build.mjs 的补丁点。",
          );
        }
        if (!code.includes(ACTIVE_WIDTH_NEEDLE)) {
          throw new Error(
            "上游 renderer.ts 的强调线宽写法变了：请同步更新 build.mjs 的补丁点。\n"
            + `期望片段：\n${ACTIVE_WIDTH_NEEDLE}`,
          );
        }

        if (!code.includes(RING_NEEDLE)) {
          throw new Error(
            "上游 renderer.ts 的选中光圈参数变了：请同步更新 build.mjs 的补丁点。\n"
            + `期望片段：\n${RING_NEEDLE}`,
          );
        }
        // 这个文件不需要 trackball 的 import
        return {
          code: code
            .replace(EDGE_ALPHA_NEEDLE, EDGE_ALPHA_PATCHED)
            .replace(SELECTION_NEEDLE, SELECTION_PATCHED)
            .replace(ACTIVE_COLOR_KEY_NEEDLE, ACTIVE_COLOR_KEY_PATCHED)
            .replace(ARROW_CREATE_NEEDLE, ARROW_CREATE_PATCHED)
            .replace(ARROW_REFRESH_NEEDLE, ARROW_REFRESH_PATCHED)
            .replace(ACTIVE_WIDTH_NEEDLE, ACTIVE_WIDTH_PATCHED)
            .replace(DUST_NEEDLE, DUST_PATCHED)
            .replace(RING_NEEDLE, RING_PATCHED)
            .replace(SELECT_SCALE_NEEDLE, SELECT_SCALE_PATCHED),
          map: null,
        };
      }
      if (clean.endsWith("/vendor/upstream/graph3d/palette.ts")) {
        if (!code.includes(EMPHASIS_RGB_NEEDLE)) {
          throw new Error(
            "上游 palette.ts 的 edgeActiveRgb 写法变了：请同步更新 build.mjs 的补丁点。\n"
            + `期望片段：\n${EMPHASIS_RGB_NEEDLE}`,
          );
        }
        return { code: code.replace(EMPHASIS_RGB_NEEDLE, EMPHASIS_RGB_PATCHED), map: null };
      }
      return null;
    },
  };
}

function modulesOf(chunk) {
  if (chunk.modules === undefined) return [];
  return Object.keys(chunk.modules);
}

/**
 * 断言没有引用项目源码。
 *
 * 允许：`dsh-plugin/` 内的文件、以及任意 `node_modules` 下的第三方包（它们被内联进产物）。
 * 拒绝：项目里除 node_modules 之外的任何文件（也就是 `src/**`、`src-tauri/**` 等）。
 */
function assertSelfContained(label, output) {
  const outside = [];
  for (const chunk of output) {
    if (chunk.type !== "chunk") continue;
    for (const id of modulesOf(chunk)) {
      const abs = path.isAbsolute(id) ? id : path.resolve(PLUGIN, id);
      const inPlugin = !path.relative(PLUGIN, abs).startsWith("..");
      const inNodeModules = abs.includes(`${path.sep}node_modules${path.sep}`);
      if (!inPlugin && !inNodeModules) outside.push(id);
    }
  }
  if (outside.length > 0) {
    throw new Error(`${label} 构建引用了项目源码（只允许插件目录 + 内联的第三方包）：\n  ${outside.join("\n  ")}`);
  }
}

async function buildHost(rolldown) {
  const bundle = await rolldown({
    input: HOST_ENTRY,
    platform: "node",
    external: (id) => id.startsWith("@deepseek-ai/") || id.startsWith("node:"),
    plugins: [atAliasPlugin()],
  });
  try {
    const { output } = await bundle.generate({ format: "esm", entryFileNames: "index.js" });
    assertSelfContained("Host 半", output);
    const chunk = output.find((item) => item.type === "chunk");
    if (chunk === undefined) throw new Error("Host 半没有产出 chunk");
    await writeFile(path.join(PLUGIN, "index.js"), chunk.code, "utf8");
    return { bytes: Buffer.byteLength(chunk.code, "utf8"), modules: modulesOf(chunk).length };
  } finally {
    await bundle.close();
  }
}

/** 先单独打包布局 Worker 的源码字符串，供 Blob Worker 使用 */
async function buildWorkerCode(rolldown) {
  const bundle = await rolldown({
    input: WORKER_ENTRY,
    platform: "browser",
    // 上游 engine.ts 里有 `import.meta.env.DEV` 的调试分支；显式置 false（define 的值必须是字符串）
    transform: { define: { "import.meta.env.DEV": "false" } },
    // 节点半径在这里补：adapter.ts 只被 Worker 构建引用（见 nodeSizePatchPlugin 注释）
    // 分量锚点间距也在这里补：topology.ts 只被 Worker 的 layoutCore 引用（见 anchorSpacingPatchPlugin 注释）
    plugins: [atAliasPlugin(), nodeSizePatchPlugin(), anchorSpacingPatchPlugin()],
  });
  try {
    const { output } = await bundle.generate({ format: "iife", entryFileNames: "kn-layout-worker.js" });
    assertSelfContained("布局 Worker", output);
    const chunks = output.filter((item) => item.type === "chunk");
    if (chunks.length !== 1) throw new Error(`布局 Worker 应该只有一个 chunk，实际 ${chunks.length} 个`);
    /*
     * **硬断言**：产物里**不得**再出现旧的节点半径公式。
     *
     * 为什么断言"旧公式消失"而不是"新代码存在"：补丁里的 `const hub = 1;` 会被打包器
     * 常量折叠掉（`baseRadius * 1 * 1` ⇒ 直接内联）✗ —— 拿文本找新代码会假失败 ✓。
     * 而"旧公式不存在"是稳定可观测的 ✓，正好把"文件参与了构建但没被补丁"变成构建失败 ✓
     * （这次踩的坑：补丁点挂在了不会执行的构建里，静默失效 ✗）。
     */
    for (const [label, code] of [["布局 Worker", chunks[0].code]]) {
      if (code.includes("0.055 * Math.log2") || code.includes("=== rootId ? 1.22 : 1")) {
        throw new Error(
          `${label} 产物里仍有旧的节点半径公式（按连接数加权 / 根节点 ×1.22）⇒ 补丁没生效。\n`
          + "请检查 nodeSizePatchPlugin 挂在了哪次构建上（adapter.ts 走的是主线程 bundle）。",
        );
      }
    }
    return chunks[0].code;
  } finally {
    await bundle.close();
  }
}

async function buildClient(rolldown, css, workerSource) {
  const bundle = await rolldown({
    input: CLIENT_ENTRY,
    platform: "browser",
    external: CLIENT_BASELINE,
    // 同上：上游 3D 引擎里的 `import.meta.env.DEV` 分支在插件里应当是关闭的
    transform: { define: { "import.meta.env.DEV": "false" } },
    plugins: [
      panelCssPlugin(css),
      layoutWorkerPlugin(workerSource),
      layoutClientPatchPlugin(),
      freeRotationPatchPlugin(),
      /* 客户端这一侧也挂上：万一 topology.ts 也进了主图，锚点间距必须是同一套 ✓ */
      anchorSpacingPatchPlugin(),
      atAliasPlugin(),
    ],
  });
  try {
    const { output } = await bundle.generate({
      format: "cjs",
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`,
      intro: "var module = { exports: {} }; var exports = module.exports;",
      footer: "return module.exports; } });",
    });
    assertSelfContained("Client 半", output);
  // 节点半径补丁同样要落在客户端产物里（adapter.ts 在主线程 bundle，不在 Worker）
  {
    const text = output.filter((item) => item.type === "chunk").map((item) => item.code).join("\n");
    if (text.includes("0.055 * Math.log2") || text.includes("=== rootId ? 1.22 : 1") || text.includes("* projected.scale, NODE_MIN_PIXELS") || LAYOUT_TIGHTEN_NEEDLE.split("\n").some((line) => text.includes(line))) {
      throw new Error(
        "客户端产物里仍有旧的节点半径公式（按连接数加权 / 根节点 ×1.22）⇒ 节点大小补丁没生效。",
      );
    }
  }    const chunks = output.filter((item) => item.type === "chunk");
    const entry = chunks.find((item) => item.isEntry === true) ?? chunks[0];
    if (entry === undefined) throw new Error("Client 半没有产出 chunk");
    if (chunks.length > 1) {
      throw new Error(
        `Client 半产出了 ${chunks.length} 个 chunk：DSH 的一次请求只取 <包名>/client.js，`
        + "包内动态分块需要额外的 chunk 路由支持，本阶段不支持。",
      );
    }
    const code = entry.code;
    if (!code.startsWith("window.__ModuleLoader__.load(")) {
      throw new Error("Client 半产物开头不是模块加载器注册调用");
    }
    if (!code.trimEnd().endsWith("});")) {
      throw new Error("Client 半产物结尾不是注册调用的收尾");
    }
    await writeFile(path.join(PLUGIN, "client.js"), code, "utf8");
    return { bytes: Buffer.byteLength(code, "utf8"), modules: modulesOf(entry).length };
  } finally {
    await bundle.close();
  }
}

const rolldownModule = await loadRolldown();
const rolldown = rolldownModule.rolldown ?? rolldownModule.default;
if (typeof rolldown !== "function") {
  throw new Error("rolldown 导出里没有 rolldown() 工厂函数，版本可能不兼容");
}

const panelCss = await readFile(path.join(PLUGIN, "src/client/panel.css"), "utf8");
const graphCss = await readFile(path.join(UPSTREAM, "styles/graph.css"), "utf8");
const css = `${panelCss}\n${graphCss}`;

/*
 * 三次构建都在「插件目录下临时挂了父项目 node_modules」的作用域里跑：
 * 这样 `three` / `d3-force-3d` 由打包器**按原生规则**解析并内联，而不是被静默当成 external ✓。
 */
const { host, workerCode, client } = await withProjectModules(async () => {
  const hostHalf = await buildHost(rolldown);
  const workerSource = await buildWorkerCode(rolldown);
  const clientHalf = await buildClient(rolldown, css, workerSource);
  return { host: hostHalf, workerCode: workerSource, client: clientHalf };
});

console.log(`Host 半    index.js  ${host.bytes} 字节，${host.modules} 个模块`);
console.log(`布局 Worker 源码      ${Buffer.byteLength(workerCode, "utf8")} 字节（内联为 Blob）`);
console.log(`Client 半  client.js ${client.bytes} 字节，${client.modules} 个模块`);
console.log("自包含检查通过：没有引用项目源码（第三方包已内联）");
