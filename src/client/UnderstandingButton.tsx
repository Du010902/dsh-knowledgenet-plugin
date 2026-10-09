import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { GRAPH_API_ROUTE } from "../shared/routes.ts";
import type { DocumentTarget } from "./node-document-client.ts";
import { makeTranslator } from "./card-model.ts";

/** 即时保存理解标记；失败时保留原状态并在按钮旁显示错误。 */
export function UnderstandingButton(props: { nodeId: string; understood: boolean; target?: DocumentTarget; t?: unknown; onSaved: (states: Record<string, boolean>) => void }): ReactNode {
  const t = useMemo(() => makeTranslator(props.t, { understood: "已理解", notUnderstood: "未理解", understandingSaving: "保存中…", understandingFailed: "保存失败，请重试" }), [props.t]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const identity = JSON.stringify([props.target?.root, props.target?.sessionId, props.nodeId]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const pending = useRef(false);
  useEffect(() => { setError(""); }, [identity]);
  const toggle = async (): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true); setError("");
    try {
      const response = await fetch(GRAPH_API_ROUTE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "set-understanding", ...props.target, nodeId: props.nodeId, understood: !props.understood }) });
      const text = await response.text();
      let body: unknown;
      try { body = JSON.parse(text); }
      catch { throw new Error(`${t("understandingFailed")} (HTTP ${response.status})`); }
      if (body && typeof body === "object" && "error" in body && body.error && typeof body.error === "object" && "message" in body.error && typeof body.error.message === "string") {
        throw new Error(`${t("understandingFailed")}: ${body.error.message}`);
      }
      if (!body || typeof body !== "object" || !("ok" in body) || body.ok !== true || !("understanding" in body) || !body.understanding || typeof body.understanding !== "object" || Array.isArray(body.understanding)) throw new Error(t("understandingFailed"));
      const states: Record<string, boolean> = {};
      for (const [id, value] of Object.entries(body.understanding)) {
        if (typeof value !== "boolean") throw new Error(t("understandingFailed"));
        states[id] = value;
      }
      if (!response.ok) throw new Error(t("understandingFailed"));
      if (currentIdentity.current === identity) props.onSaved(states);
    } catch (e) { if (currentIdentity.current === identity) setError(e instanceof Error ? e.message : t("understandingFailed")); }
    finally { pending.current = false; setBusy(false); }
  };
  return <span className="kn-understanding-control"><button className="kn-understanding-button" type="button" aria-pressed={props.understood} disabled={busy} onClick={() => { void toggle(); }}><span aria-hidden="true" className="kn-understanding-dot" />{busy ? t("understandingSaving") : t(props.understood ? "understood" : "notUnderstood")}</button>{error ? <span role="alert" className="kn-editor-error">{error}</span> : null}</span>;
}
