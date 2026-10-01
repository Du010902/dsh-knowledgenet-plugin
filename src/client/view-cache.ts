/**
 * 插件自有的**按知识库身份分区**的视图缓存，外加"当前库身份"这个开关。
 *
 * 为什么需要（`design/view-navigation-repair-plan.md` P1）：
 * 上游 `session.ts` 的相机缓存是**模块级单槽位**、没有任何库身份 ✗ ——
 * 于是「A 库的球心 / 相机位置 / 图谱姿态」会被「B 库」直接采用；
 * 新库还可能因为 `cameraRestored = true` 而**不再自动取景**，
 * 两个图谱面板同时存在时后保存的会覆盖另一个 ✗。
 *
 * 做法：身份**优先用返回数据里的稳定 `libraryId`**，没有才退回库根路径 ✓
 * （两者都没有 ⇒ 空串，等于"不分区"，与上游行为一致 ✓）。
 * 面板在渲染图谱子组件**之前**设置当前身份；引擎在构造时**绑定一次**并全程用它读写缓存
 * ⇒ 两个面板并存也互不干扰 ✓（不依赖"全局身份在读取那一刻是谁"）。
 */
import type { CameraState } from "../vendor/upstream/graph3d/types.ts";

/** 缓存里存的一份视图：相机状态 + 「存的时候布局是否已收敛」 */
interface ViewEntry {
  state: CameraState;
  settled: boolean;
}

/** 视图缓存：库身份 → 那一份视图。序列化用不上，纯内存 ✓ */
const views = new Map<string, ViewEntry>();

/** 当前库身份（由面板在渲染图谱前设置；引擎构造时取一次并绑定） */
let activeKey = "";

/**
 * 从面板载荷里推出**稳定**的库身份。
 *
 * 规则（文档要求"明确根路径变更的复用规则"）：
 * - 有 `libraryId` ⇒ 只认它：同一个库换了挂载根目录（例如工作区搬家）**仍然沿用**视角 ✓；
 * - 没有 ⇒ 退回库根路径：至少能区分不同目录下的两个库 ✓；
 * - 都没有 ⇒ 空串（不分区）✓。
 *
 * @param library - 面板载荷里的 `library` 字段。
 * @returns 库身份键。
 */
export function libraryKeyOf(library: { libraryId?: unknown; root?: unknown } | null | undefined): string {
  const id = library?.libraryId;
  if (typeof id === "string" && id.trim() !== "") return `id:${id.trim()}`;
  const root = library?.root;
  if (typeof root === "string" && root.trim() !== "") return `root:${root.trim()}`;
  return "";
}

/** 设置当前库身份（面板渲染图谱前调用；空串 = 不分区） */
export function setActiveLibraryKey(key: string | null | undefined): void {
  activeKey = typeof key === "string" ? key : "";
}

/** 当前库身份 */
export function activeLibraryKey(): string {
  return activeKey;
}

/** 深复制一份相机状态（含自由姿态与挂在它上面的内部导航状态 ✓） */
function cloneState(state: CameraState): CameraState {
  const extra = state as CameraState & { knInterior?: unknown };
  return {
    target: [...state.target],
    distance: state.distance,
    angle: state.angle,
    pitch: state.pitch,
    ...(state.q === undefined ? {} : { q: [...state.q] }),
    /* 内部导航状态（C/P/Q/S + 冻结标记）都是普通数字/布尔 ⇒ JSON 往返即深复制 ✓ */
    ...(extra.knInterior === undefined
      ? {}
      : { knInterior: JSON.parse(JSON.stringify(extra.knInterior)) }),
  } as CameraState;
}

/**
 * 取出某个库的缓存视图。
 * 只有「布局已收敛时存下的那一份」才算数（沿用上游规则：未收敛的相机往往只是自动取景 ✗）。
 *
 * @param key - 库身份键。
 * @returns 深复制过的相机状态；没有可用缓存 ⇒ null。
 */
export function cachedView(key: string): CameraState | null {
  const entry = views.get(key);
  if (entry === undefined || !entry.settled) return null;
  return cloneState(entry.state);
}

/**
 * 存下某个库的视图。
 * @param key - 库身份键。
 * @param state - 相机状态（会被深复制，调用方之后改它不影响缓存 ✓）。
 * @param settled - 存的时候布局是否已收敛。
 */
export function storeView(key: string, state: CameraState, settled: boolean): void {
  views.set(key, { state: cloneState(state), settled });
}

/** 清掉全部视图缓存（导入备份/整体替换工作区时调用） */
export function clearViewCache(): void {
  views.clear();
}

/** 当前缓存了哪些库（诊断与测试用） */
export function viewCacheKeys(): string[] {
  return [...views.keys()];
}
