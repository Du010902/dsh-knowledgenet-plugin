/** Keep host focus tied to the visible plugin view; no chat creation or model requests occur here. */
import { useEffect, useRef } from "react";
import { GRAPH_API_ROUTE } from "../shared/routes.ts";
import { reportDiag } from "./diag.ts";

export function useViewFocus(options: {
  sessionId?: string; root?: string; nodeId: string | null; source: "editor" | "graph";
  element: HTMLElement | null;
}): void {
  const viewId = useRef<string>(globalThis.crypto.randomUUID());
  const sequence = useRef(0);
  useEffect(() => {
    const { sessionId, root, nodeId, source, element } = options;
    if (!sessionId || !root || !element) return;
    let disposed = false; let timer: ReturnType<typeof setTimeout> | undefined;
    // The first reply negotiates the configurable host lease. This is only a reconnect retry delay.
    let retryMs = 15000;
    const visible = () => {
      const rect = element.getBoundingClientRect();
      return element.isConnected && rect.width > 0 && rect.height > 0 &&
        rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth &&
        element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && document.visibilityState === "visible";
    };
    let failure: string | undefined;
    const diagnose = (code: string | undefined, detail?: string) => {
      if (code === failure) return;
      failure = code;
      /*
       * 带上宿主给的原因 ✓（用户实测 2026-10-11：面板里开着笔记，AI 却说"没有当前节点" ✗，
       * 宿主回的是 `focus_scope_mismatch` —— 把那句话一起报出来，`kn_status` 里直接能看见原因 ✓）。
       * 只截一小段 ✗：那是两条路径，不是正文 ✓。
       */
      void reportDiag("view-focus", code ? "rejected" : "recovered", {
        code: code ?? "ok", source, activeNode: nodeId !== null,
        ...(detail === undefined || detail === "" ? {} : { detail: detail.slice(0, 180) }),
      });
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
        if (result.ok === true) {
          if (typeof result.leaseMs === "number" && result.leaseMs >= 3000) retryMs = Math.floor(result.leaseMs / 3);
          diagnose(undefined);
        } else diagnose(
          typeof result.error?.code === "string" ? result.error.code : "invalid_response",
          typeof result.error?.message === "string" ? result.error.message : undefined,
        );
      } catch (error) { void error; diagnose("transport_failed"); }
      if (!disposed && sentSequence === sequence.current) timer = setTimeout(() => { void send(visible(), false); }, retryMs);
    };
    const activate = () => { void send(visible(), true); };
    const resume = () => { void send(visible(), false); };
    const deactivate = () => { void send(false, false); };
    const pointer = (event: PointerEvent) => {
      if (event.composedPath().includes(element)) activate();
    };
    window.addEventListener("focus", resume);
    window.addEventListener("blur", resume);
    window.addEventListener("pagehide", deactivate);
    document.addEventListener("visibilitychange", resume);
    document.addEventListener("pointerdown", pointer);
    const observer = new ResizeObserver(resume);
    observer.observe(element);
    activate();
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      observer.disconnect();
      window.removeEventListener("focus", resume);
      window.removeEventListener("blur", resume);
      window.removeEventListener("pagehide", deactivate);
      document.removeEventListener("visibilitychange", resume);
      document.removeEventListener("pointerdown", pointer);
      void send(false, false);
    };
  }, [options.sessionId, options.root, options.nodeId, options.source, options.element]);
}
