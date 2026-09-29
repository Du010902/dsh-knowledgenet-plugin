/**
 * 节点右键菜单的事件约定
 *
 * 单独一个模块：三种观察视图通过它请求打开右键菜单，而菜单本身由画布统一渲染。
 * 拆出来的另一个好处是视图组件不必依赖任何画布框架，测试可以单独渲染它。
 */

/** 请求打开节点右键菜单（由画布统一渲染菜单，避免每个节点各挂一个） */
export const NODE_CONTEXT_MENU_EVENT = "knowledgenet:node-context-menu";

export interface NodeContextMenuRequest {
  nodeId: string;
  x: number;
  y: number;
}

/**
 * 请求打开**空白画布**的右键菜单。
 *
 * 和节点菜单分开，是因为它们回答的是两个不同的问题：节点菜单问「拿这个节点怎么办」，
 * 画布菜单问「在这张网上再放一个点」。建立知识点的入口就在这里——
 * 搜索框只负责搜索，新建不再混在里面。
 */
export const CANVAS_CONTEXT_MENU_EVENT = "knowledgenet:canvas-context-menu";

export interface CanvasContextMenuRequest {
  x: number;
  y: number;
}

/**
 * 请求打开**依赖关系**（连线）的右键菜单。
 *
 * 第三种菜单：节点菜单问「拿这个节点怎么办」、画布菜单问「在这张网上再放一个点」，
 * 这条问的是「这条依赖还要不要」。分开的理由与另两种一样——它们回答的不是同一个问题，
 * 混成一个菜单就得先猜用户点到了什么。
 *
 * 聚焦视图（SVG 命中层）与空间视图（屏幕空间线段拾取）都通过它请求，
 * 菜单本体由画布统一渲染，与节点菜单同一个层级。
 */
export const EDGE_CONTEXT_MENU_EVENT = "knowledgenet:edge-context-menu";

export interface EdgeContextMenuRequest {
  /** 关系 ID：菜单据此找到两端标题与来源记录 */
  edgeId: string;
  x: number;
  y: number;
}

/**
 * 请求打开「AI 设置」。
 *
 * 设置入口在顶栏，而弹窗本体由节点工作区渲染（它同时要从对话里的
 * 「去设置」打开）。用一个事件把两者解开：谁触发都不用把弹窗提到应用外壳，
 * 也就不必让外壳认识对话与设置的状态。
 */
export const AI_SETTINGS_EVENT = "knowledgenet:open-ai-settings";

export function requestAiSettings(): void {
  window.dispatchEvent(new CustomEvent(AI_SETTINGS_EVENT));
}

/**
 * 请求打开「知识库」弹窗。
 *
 * 弹窗本体由工作台外壳渲染（顶栏按钮、导航抽屉、命令面板三处都要用它）。
 * 应用外壳顶部的库状态条在 Provider 之外，用一个事件把两者解开，
 * 而不是为了一个按钮把整棵树的层级重排。
 */
export const LIBRARY_DIALOG_EVENT = "knowledgenet:open-library-dialog";

export function requestLibraryDialog(): void {
  window.dispatchEvent(new CustomEvent(LIBRARY_DIALOG_EVENT));
}
