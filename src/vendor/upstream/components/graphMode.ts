/**
 * 画布顶层观察方式与两种视图共用的常量
 *
 * - `focus`：二维聚焦（只画当前知识点的一跳关系，DOM 卡片 + SVG 连线）
 * - `space`：三维空间图谱（环绕观察，Three.js + Web Worker 布局）
 *
 * 单独一个模块，是为了让两个视图组件、工具栏与测试都用同一份定义：
 * 观察方式的文案与「缩放上下限」不应该各写一份。
 */
export type SpaceMode = "focus" | "space";

export const SPACE_MODE_LABEL: Record<SpaceMode, string> = {
  focus: "聚焦",
  space: "空间",
};

/** 二维聚焦的缩放上下限（三维相机不使用它，见《空间图谱技术方案》8.1） */
export const MIN_ZOOM = 0.6;
export const MAX_ZOOM = 1.5;
