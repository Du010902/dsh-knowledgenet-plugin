/** Read and restore visible sidebar tabs through the host controller. */
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
