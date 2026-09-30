/**
 * 右侧栏标签页（Right Sidebar tab type）：把知识库图谱放进**会话右侧那一栏**。
 *
 * 注册两件事（契约见 docs/subsystems/sidebar-right.md §「Tab-type registration」）：
 * 1. `ctx.sidebarRightTabs.register(definition)` —— 静态类型定义（形状见 tab-definition.ts）；
 * 2. `sidebar.right.pane.tab` 槽位里按定义 `id` 注册的 keyed 视图 —— 标签页本体。
 *
 * 两个已经踩过的点：
 * - 定义里的 `guide` 必须是**数组**（shipped 写法）；写成对象会在注册时抛错，
 *   而抛错的表现只是「什么都没出现」——所以这里把失败原因原样打到 console。
 * - 服务要通过 `ctx.inject(['sidebarRightTabs'], …)` 取（它由别的行提供）；
 *   写进 `inject` 会让整个客户端半在服务缺席时 pending。
 */
import {
  graphTabDefinition,
  guideEntryInject,
  prefersEnglish,
  type SidebarRightNavigation,
} from "./tab-definition.ts";
import { reportDiag } from "./diag.ts";
import { GraphPanelIcon } from "./PanelIcon.tsx";
import { GraphTabTitle } from "./GraphTabTitle.tsx";
import { GraphPanel } from "./GraphPanel.tsx";

interface SlotsFace {
  inject(key: string, callback: () => unknown): unknown;
  register(options: Record<string, unknown>, component: unknown): unknown;
}

interface TabContext {
  inject?(names: string[], callback: (scoped: unknown) => unknown): unknown;
  effect?(callback: () => unknown, label?: string): unknown;
  slots?: SlotsFace;
  get?(name: string): unknown;
  sidebarRightTabs?: { register?: (definition: unknown) => unknown };
  sidebarRight?: SidebarRightNavigation;
}

/** 在给定作用域里注册类型定义与标签页本体；返回失败原因（成功时为 undefined） */
function registerIn(scoped: TabContext, locale: string | undefined): string | undefined {
  const tabs = scoped.get?.("sidebarRightTabs") ?? scoped.sidebarRightTabs;
  const registry = tabs as { register?: (definition: unknown) => unknown } | undefined;
  const slots = scoped.slots;
  if (typeof registry?.register !== "function") return "看不到 sidebarRightTabs 服务";
  if (slots === undefined) return "看不到 slots 服务";

  const withLocale = (options: Record<string, unknown>): Record<string, unknown> =>
    locale === undefined ? options : { ...options, locale };

  // 传图标：宿主用它在 + 菜单与指南卡片里渲染条目（缺了会走无图标兜底样式，外观不一致）
  const definition = graphTabDefinition(prefersEnglish(), GraphPanelIcon as unknown);
  const registerDefinition = (): unknown => registry.register?.(definition);
  // shipped 插件都把注册包在 effect 里（生命期与插件一致，卸载即注销）
  if (typeof scoped.effect === "function") scoped.effect(registerDefinition, "knowledgenet: right sidebar tab type");
  else registerDefinition();

  slots.inject("sidebar.right.pane.tab", () => slots.register(
    withLocale({ name: "sidebar.right.pane.tab", key: definition.id }),
    GraphPanel,
  ));
  /*
   * **芯片里的标题也要自己注册**（否则芯片只有纯文字、没有图标 ✗）。
   *
   * 宿主 `SidebarRight.tsx:246` 的 `titlesFor` 会先找这个座位；找不到就回落到
   * "打开标签时记下的那串文字"。所以"把 definition.icon 换成图谱图标"这件事
   * **不会**改变芯片的外观 —— 用户实测反馈"这里没变啊"就是这个原因 ✓。
   * 写法照抄 shipped 的 `ui-sidebar-files/src/client/index.ts:76`。
   */
  slots.inject("sidebar.right.pane.tab.title", () => slots.register(
    withLocale({ name: "sidebar.right.pane.tab.title", key: definition.id }),
    GraphTabTitle,
  ));
  /*
   * 自己画入口卡片（保留"只有知识库工作区才显示"的能力），但**与宿主 `.entry` 同规格**：
   * 裸 `<button>` + 注进 head 的 `guideEntryCss()`，逐项照抄 GuideBody.module.css 的
   * 尺寸/边框/圆角/字号，因此看起来与「工作区文件 / 新建终端 / 浏览器」一致。
   */
  const navigation = (scoped.get?.("sidebarRight")
    ?? (scoped as { sidebarRight?: unknown }).sidebarRight) as SidebarRightNavigation | undefined;
  return undefined;
}

/** 注册右侧栏标签页；返回是否成功（失败不影响其它注册） */
export function registerGraphTab(ctx: TabContext, locale: string | undefined): boolean {
  let failure: string | undefined;
  let done = false;
  let settled = false;

  const attempt = (scoped: unknown): void => {
    try {
      failure = registerIn((scoped ?? ctx) as TabContext, locale);
      done = failure === undefined;
    } catch (error) {
      done = false;
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      settled = true;
      void reportDiag("tab-type", done ? "registered" : "failed", failure ?? null);
    }
  };

  if (typeof ctx.inject === "function") {
    try {
      ctx.inject(["sidebarRightTabs"], attempt);
    } catch (error) {
      failure = `ctx.inject('sidebarRightTabs') 失败：${error instanceof Error ? error.message : String(error)}`;
      settled = true;
      void reportDiag("tab-type", "failed", failure);
    }
  } else {
    attempt(ctx);
  }

  /*
   * `ctx.inject` 的回调可能在服务就绪后才跑，所以**不能**在调用后立刻判定失败——
   * 那样会打出"未注册"的误报（实测就这么误报过一次）。这里等一拍再判定，
   * 并把结论走诊断通道交给宿主（由 `kn_status` 读出），而不是只喊一句 console。
   */
  if (!settled) {
    setTimeout(() => {
      if (settled) return;
      try {
        console.error(
          "[KnowledgeNet] 右侧栏标签页仍未注册（等待 sidebarRightTabs 超过 2 秒）："
          + (failure ?? "服务始终不可见"),
        );
      } catch {
        // 没有 console 就算了
      }
      void reportDiag("tab-type", "never-registered", failure ?? "sidebarRightTabs 不可见");
    }, 2000);
  }
  return done;
}