/** Keep host focus tied to the visible plugin view; no chat creation or model requests occur here. */
import { useEffect, useRef, type RefObject } from "react";
import { GRAPH_API_ROUTE } from "../shared/routes.ts";

export function useViewFocus(options: {
  sessionId?: string; root?: string; nodeId: string | null; source: "editor" | "graph";
  element: RefObject<HTMLElement | null>;
}): void {
  const viewId = useRef<string>(globalThis.crypto.randomUUID());
  const sequence = useRef(0);
  useEffect(() => {
    const { sessionId, root, nodeId, source, element } = options;
    if (!sessionId || !root) return;
    let disposed = false; let timer: ReturnType<typeof setTimeout> | undefined;
    // The first reply negotiates the configurable host lease. This is only a reconnect retry delay.
    let retryMs = 15000;
    const visible = () => {
      const view = element.current;
      const rect = view?.getBoundingClientRect();
      return !!view && !!rect && rect.width > 0 && rect.height > 0 && view.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && document.visibilityState === "visible" && document.hasFocus();
    };
    const send = async (active: boolean, claim: boolean) => {
      if (timer !== undefined) clearTimeout(timer);
      const sentSequence = ++sequence.current;
      try {
        const response = await fetch(GRAPH_API_ROUTE, {
          method: "POST", headers: { "content-type": "application/json" }, keepalive: true,
          body: JSON.stringify({ kind: "view-focus", sessionId, root, viewId: viewId.current, sequence: sentSequence, nodeId, focusKind: source, active, claim }),
        });
        const result = await response.json();
        if (result.ok === true && typeof result.leaseMs === "number" && result.leaseMs >= 3000) retryMs = Math.floor(result.leaseMs / 3);
      } catch (error) { void error; /* A disconnected optional focus channel must not block editing. */ }
      if (!disposed && sentSequence === sequence.current) timer = setTimeout(() => { void send(visible(), false); }, retryMs);
    };
    const activate = () => { void send(visible(), true); };
    const resume = () => { void send(visible(), false); };
    const deactivate = () => { void send(false, false); };
    const pointer = (event: PointerEvent) => {
      if (event.composedPath().includes(element.current?.getRootNode() as EventTarget)) activate();
    };
    window.addEventListener("focus", resume);
    window.addEventListener("blur", deactivate);
    window.addEventListener("pagehide", deactivate);
    document.addEventListener("visibilitychange", resume);
    document.addEventListener("pointerdown", pointer);
    const observer = new ResizeObserver(resume);
    if (element.current) observer.observe(element.current);
    activate();
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      observer.disconnect();
      window.removeEventListener("focus", resume);
      window.removeEventListener("blur", deactivate);
      window.removeEventListener("pagehide", deactivate);
      document.removeEventListener("visibilitychange", resume);
      document.removeEventListener("pointerdown", pointer);
      void send(false, false);
    };
  }, [options.sessionId, options.root, options.nodeId, options.source, options.element]);
}
