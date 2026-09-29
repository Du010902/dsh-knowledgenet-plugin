/**
 * 右侧栏 tab type 的定义（纯数据，不依赖 React/JSX，方便单测）。
 *
 * 契约见 docs/subsystems/sidebar-right.md §「Tab-type registration」；
 * 字段形状对着 shipped 的 `ui-sidebar-files/src/client/definition.tsx` 抄：
 * **`guide` 是数组**，每条必须带 `id`（注册时会校验条目 id 唯一），`order` 决定在「开始」页的次序。
 * 写错这里不会崩，只会“什么都没出现”——所以单独抽出来并由测试钉住形状。
 */
import { PANEL_ID } from "../shared/routes.ts";

/** `openTab(kind)` 用它点名；也是「开始」页卡片打开的那个页面 */
export const GRAPH_TAB_KIND = PANEL_ID;
/** 注册身份：同时是 `sidebar.right.pane.tab` 槽位的 key */
export const GRAPH_TAB_ID = PANEL_ID;
/** 「开始」页里入口卡片的位置（shipped 的卡片是 10/20/30 量级，这里排在其后） */
export const GRAPH_GUIDE_ORDER = 40;
/** 卡片条目自身的 id（在提供者内唯一） */
export const GRAPH_GUIDE_ENTRY_ID = "graph";

/** 只取用到的那一个方法，避免依赖 ui-sidebar-right 的类型声明 */
export interface SidebarRightNavigation {
  openTabIn?(sessionId: string, kind: string, options?: unknown): void;
}

/**
 * 入口卡片的 `inject` face：由注册处绑定一个「打开我的标签页」的回调。
 *
 * 为什么不让组件自己点开：`useTabInfo()` 是 React hook，**只能在渲染期调用**；
 * 在点击回调里调会抛 `Invalid hook call`，而这种异常很容易被 catch 吞掉 → 表现成
 * 「点了没反应」（实测踩到）。服务这条路不依赖 hook，作为主路径更稳。
 *
 * @param sessionId - 插槽框架给会话作用域注入的会话 id。
 * @param navigation - `ctx.sidebarRight`（拿不到时，返回的回调只会答"打不开"）。
 * @returns 组件收到的 props 片段。
 */
export function guideEntryInject(
  sessionId: string,
  navigation: SidebarRightNavigation | undefined,
): { openGraph: (kind: string) => boolean } {
  return {
    openGraph: (kind: string): boolean => {
      if (typeof navigation?.openTabIn !== "function") return false;
      try {
        navigation.openTabIn(sessionId, kind, { replaceTab: true });
        return true;
      } catch {
        return false;
      }
    },
  };
}

export interface GraphTabDefinition {
  id: string;
  kind: string;
  priority: "extension";
  keepMounted: boolean;
  title: () => string;
  /** 标签/菜单里的图标组件（宿主用它在 + 菜单与指南卡片里渲染条目） */
  icon?: unknown;
  guide: Array<{
    id: string;
    order: number;
    title: () => string;
    description: () => string;
    icon?: unknown;
  }>;
}

/** 是否偏好英文（跟随宿主设置的语言） */
export function prefersEnglish(): boolean {
  try {
    const lang = typeof document === "undefined" ? "" : document.documentElement.lang ?? "";
    return lang.toLowerCase().startsWith("en");
  } catch {
    return false;
  }
}

/** 组装 tab type 定义；`english` 显式传入以便测试与运行期一致 */
export function graphTabDefinition(english: boolean, icon?: unknown): GraphTabDefinition {
  const title = english ? "Knowledge graph" : "知识库图谱";
  const description = english
    ? "Focus and space views of the knowledge library, docked beside the conversation"
    : "在右侧栏里看知识库的聚焦视图与空间视图";
  return {
    id: GRAPH_TAB_ID,
    kind: GRAPH_TAB_KIND,
    priority: "extension",
    /*
     * **切走标签页就卸载**（不再 keepMounted）。
     *
     * 代价：切回来会重建场景与面板内状态（相机回默认视角，可用「重新整理」重排；
     * 聚焦节点、提案勾选会重置）。收益：切走后立刻停止三维 requestAnimationFrame 与取数 ✓。
     *
     * 注意：这一条**只覆盖"切换标签页"** ✗ —— DSH 在**侧栏收起**时仍可能保留选中标签的挂载
     * （代码审查指出 ✓）。那种情况由面板内部的 IntersectionObserver 可见性门禁兜住 ✓
     * （不可见时不取数、不渲染三维 ⇒ rAF 一起停 ✓）。
     */
    keepMounted: false,
    // 标签芯片的文字：在打开时被捕获一次
    title: () => title,
    ...(icon === undefined ? {} : { icon }),
    // 「开始」页上的入口卡片（数组！每条要 id）
    guide: [{
      id: GRAPH_GUIDE_ENTRY_ID,
      order: GRAPH_GUIDE_ORDER,
      title: () => title,
      description: () => description,
    }],
  };
}
