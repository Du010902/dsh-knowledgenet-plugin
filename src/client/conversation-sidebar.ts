/** Read and restore visible sidebar tabs through the host controller. */
import { reportDiag } from "./diag.ts";

export interface ConversationSidebar {
  mounted?: { getSnapshot(): string | undefined; subscribe?(listener: () => void): () => void };
  openTabs?: { subscribe(listener: () => void): () => void };
  tabsIn?(sessionId: string): readonly { id: string; kind: string; contentId: string }[];
  active?(): { id: string } | undefined;
  isExpanded?(): boolean;
  toggleExpanded?(): void;
  focus?(tabId: string): void;
  tabDomain?: { occurrence(sessionId: string, tab: { id: string }): { navigation: { getSnapshot(): { params?: unknown } } } };
  openTab?(kind: string, options?: { params?: unknown }): void;
  openResource?(address: string, options?: { kind?: string; params?: unknown; revealIfOpened?: boolean }): void;
  openTabIn?(sessionId: string, kind: string, options?: { params?: unknown }): void;
}

/**
 * `dsh-resource://<kind>/session/<会话 id>/…` 里那个**属主会话** ✓；不是这个形状就返回 `undefined` ✓。
 *
 * 为什么要认它（用户实测 2026-10-11，最关键的一条证据：**卸掉插件控制台就不再报错** ✓）：
 * DSH 自己的「修改审阅」标签地址正是 `dsh-resource://changes-review/session/<id>/<seq>/<turn>` ✓，
 * 它一挂载就去读 `/api/changes.summary?sessionId=<id>&seq=<seq>` ✓；那份摘要是**宿主内存里**的
 * （会话 dispose、或 DSH 重启就没了 ✓）⇒ 只要把它**重开一次**，就换来一条 `404` 红字 ✗。
 * 而"换会话时把侧栏标签带过去"偏偏会把它**原样重开**到新会话里 ✗ ⇒ 每次换会话都刷一遍 404 ✓
 * （卸掉插件就没人重开它 ⇒ 控制台干净 ✓ 完全对得上 ✓）。
 *
 * 结论：**属于别的会话的资源标签不跟着走** ✗ —— 那本来就是"那一轮改动"的审阅 ✓，
 * 它自己的会话里还在，跨会话重开既没意义、又会去要一份宿主已经不再提供的摘要 ✗。
 *
 * @param contentId - 标签的内容地址（`tab.contentId` ✓）。
 * @returns 属主会话 id；不是"会话绑定的资源地址"时 `undefined` ✓（那种照旧带走 ✓）。
 */
export function resourceSessionId(contentId: string): string | undefined {
  if (!contentId.startsWith("dsh-resource://")) return undefined;
  const parts = contentId.split("/");
  /* `dsh-resource://` 会split出两个空段 ⇒ kind 在 2、`session` 在 3、id 在 4 ✓ */
  if (parts[3] !== "session") return undefined;
  const owner = parts[4];
  if (owner === undefined || owner === "") return undefined;
  try {
    return decodeURIComponent(owner);
  } catch {
    /* 坏的百分号转义 ⇒ 当成"认不出属主" ✓（照旧带走，绝不因为解析失败丢用户的标签 ✗） */
    return undefined;
  }
}

/** Capture before navigation; restore once the destination sidebar store is usable, without closing its tabs. */
export function carryConversationSidebar(sidebar: ConversationSidebar | undefined, target: string): { restore(): boolean; cancel(): void; watch(listener: () => void): () => void } {
  const source = sidebar?.mounted?.getSnapshot();
  const expanded = sidebar?.isExpanded?.() ?? true;
  const active = sidebar?.active?.()?.id;
  const tabs = source ? (sidebar?.tabsIn?.(source) ?? []).map(tab => ({ ...tab, params: sidebar?.tabDomain?.occurrence(source, tab).navigation.getSnapshot().params })) : [];
  let cancelled = false;
  let finished = false;
  let restoring = false;
  const restoredIds = new Map<string, string>();
  /** 已经报过"跨会话不带走"的标签 id ✓（`restore` 会被 watch 反复调 ⇒ 一条只报一次 ✗） */
  const skipped = new Set<string>();
  return {
    watch(listener) {
      let disposed = false;
      let frame: number | undefined;
      const tick = () => {
        if (disposed || cancelled || finished) return;
        listener();
        if (!disposed && !cancelled && !finished && typeof requestAnimationFrame === "function") schedule();
      };
      const schedule = () => {
        if (frame === undefined) frame = requestAnimationFrame(() => { frame = undefined; tick(); });
      };
      const stops = [sidebar?.mounted?.subscribe?.(tick), sidebar?.openTabs?.subscribe(tick)];
      // The installed host announces selection before adopting the destination store.
      // An empty adoption need not change open-tab metadata, so check again next frame.
      if (!finished && typeof requestAnimationFrame === "function") schedule();
      return () => { disposed = true; if (frame !== undefined) cancelAnimationFrame(frame); for (const stop of stops) stop?.(); };
    },
    cancel() { cancelled = true; },
    restore() {
      if (cancelled || finished || !sidebar) return true;
      if (restoring) return false;
      const mounted = sidebar.mounted?.getSnapshot();
      if (mounted !== target) return mounted !== undefined && mounted !== source;
      if (source === target) { finished = true; return true; }
      const restored = new Set(restoredIds.values());
      const available = (sidebar.tabsIn?.(target) ?? []).filter(tab => !restored.has(tab.id));
      restoring = true;
      try {
        for (const tab of tabs) {
          if (restoredIds.has(tab.id)) continue;
          /*
           * **属于别的会话的资源标签不重开** ✗（用户实测：卸掉插件就不再报 404 的那条 ✓）。
           * 典型就是 DSH 的「修改审阅」：地址里带着旧会话与事件序号 ✓，一挂载就去读宿主
           * **内存里**的改动摘要 ✗ ⇒ 摘要早没了（重启 / 会话 dispose ✓）⇒ 每次都换一条 404 ✓。
           * 详见 `resourceSessionId` 的注释 ✓。
           */
          const owner = resourceSessionId(tab.contentId);
          if (owner !== undefined && owner !== target) {
            if (!skipped.has(tab.id)) {
              skipped.add(tab.id);
              void reportDiag("sidebar-carry", "skipped-cross-session", { kind: tab.kind });
            }
            continue;
          }
          const match = available.findIndex(item => item.kind === tab.kind && item.contentId === tab.contentId);
          if (match >= 0) { restoredIds.set(tab.id, available.splice(match, 1)[0]!.id); continue; }
          const before = new Set((sidebar.tabsIn?.(target) ?? []).map(item => item.id));
          if (tab.contentId.startsWith('dsh-resource://')) sidebar.openResource?.(tab.contentId, { kind: tab.kind, params: tab.params, revealIfOpened: false });
          else if (sidebar.openTab) sidebar.openTab(tab.kind, { params: tab.params });
          else sidebar.openTabIn?.(target, tab.kind, { params: tab.params });
          const restored = sidebar.tabsIn?.(target).find(item => !before.has(item.id) && item.kind === tab.kind);
          if (restored) restoredIds.set(tab.id, restored.id);
        }
        const focused = active && restoredIds.get(active);
        if (focused) sidebar.focus?.(focused);
        if (sidebar.isExpanded && sidebar.isExpanded() !== expanded) sidebar.toggleExpanded?.();
        finished = true;
        return true;
      } catch (error) {
        if (error instanceof Error && error.message === "sidebarRight: no session surface is mounted") return false;
        throw error;
      } finally { restoring = false; }
    },
  };
}
