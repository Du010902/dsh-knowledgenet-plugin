import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { NodeQuestion, QuestionSourceInput } from "../shared/node-questions.ts";
import { makeTranslator } from "./card-model.ts";
import { fileQuestionSelection, questionNotice } from "./question-navigation.ts";
import { openEditorNode } from "./open-editor.ts";
import { libraryKeyOf } from "./view-cache.ts";
import {
  normalizedQuestionText, notifyQuestionsChanged, postQuestion,
  QUESTION_ZH, questionSourceLabel, type QuestionContext,
} from "./node-questions-client.ts";

export function QuestionCapture({ source, title: initial, t: locale, onClose }: {
  source: Exclude<QuestionSourceInput, { kind: "note" }>;
  title: string;
  t?: unknown;
  onClose(): void;
}): ReactNode {
  const t = useMemo(() => makeTranslator(locale, QUESTION_ZH), [locale]);
  const [context, setContext] = useState<QuestionContext>();
  const [title, setTitle] = useState(() => normalizedQuestionText(initial).slice(0, 120));
  const [nodeId, setNodeId] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const requestId = useRef("");
  const submitted = useRef(false);
  const sessionId = source.sessionId;
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    const abort = new AbortController();
    void postQuestion<QuestionContext>({ sessionId }, { kind: "list-node-questions" }, fetch, abort.signal)
      .then((result) => {
        if (abort.signal.aborted) return;
        setContext(result);
        const opened = openEditorNode(libraryKeyOf(result));
        const preferred = [opened, result.ownerNodeId].find((candidate) => result.nodes.some((node) => node.id === candidate));
        setNodeId(preferred ?? "");
      })
      .catch((failure: Error) => { if (!abort.signal.aborted) setError(failure.message); });
    return () => abort.abort();
  }, [sessionId, retry]);

  const filtered = context?.nodes.filter((node) => node.id === nodeId || node.title.toLowerCase().includes(query.trim().toLowerCase()));
  return createPortal(<dialog ref={dialog} className="kn-question-capture" aria-label={t("questionCapture")} onCancel={(event) => {
    event.preventDefault();
    if (!busy) onClose();
  }}>
    <style>{`
      .kn-question-capture { width: min(390px, calc(100vw - 32px)); padding: 16px;
        color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
        border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; font: inherit; }
      .kn-question-capture::backdrop { background: rgb(0 0 0 / 20%); }
      .kn-question-capture form, .kn-question-capture label { display: grid; gap: 6px; }
      .kn-question-capture form { gap: 12px; }
      .kn-question-capture input, .kn-question-capture select { min-width: 0; width: 100%; box-sizing: border-box;
        padding: 6px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 5px;
        color: inherit; background: var(--dsw-alias-bg-layer-1); font: inherit; }
      .kn-question-capture small { color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
      .kn-question-capture footer { display: flex; justify-content: flex-end; gap: 8px; }
      .kn-question-capture button { padding: 4px 8px; border-radius: 6px; cursor: pointer; font: inherit;
        color: inherit; border: 1px solid var(--dsw-alias-border-l2); background: transparent; }
      .kn-question-capture button:disabled { opacity: .55; cursor: default; }
    `}</style>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (!context || !nodeId || !title.trim() || submitted.current) return;
      submitted.current = true;
      setBusy(true);
      setError("");
      requestId.current ||= crypto.randomUUID();
      void postQuestion<NodeQuestion[]>({ root: context.root, sessionId }, {
        kind: "add-node-question", nodeId, questionId: requestId.current, title: title.trim(), source,
      }).then(() => {
        notifyQuestionsChanged(context.root, nodeId);
        questionNotice(t("questionRecorded"));
        onClose();
      }).catch((failure: Error) => { setError(failure.message); })
        .finally(() => { submitted.current = false; setBusy(false); });
    }}>
      <strong>{t("questionCapture")}</strong>
      <small>{t(questionSourceLabel(source))}{source.kind === "file"
        ? " · " + source.absolutePath.split(/[\\/]/).at(-1) : ""}</small>
      <label>{t("questionTitle")}<input autoFocus required maxLength={120} value={title} disabled={busy}
        onChange={(event) => setTitle(event.target.value)} /></label>
      {context ? <>
        <input aria-label={t("questionSearchNodes")} placeholder={t("questionSearchNodes")} value={query} disabled={busy}
          onChange={(event) => setQuery(event.target.value)} />
        <label>{t("questionOwner")}<select required value={nodeId} disabled={busy} onChange={(event) => setNodeId(event.target.value)}>
          <option value="">{t("questionChooseNode")}</option>
          {filtered?.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}
        </select></label>
      </> : !error ? <small>{t("questionLoading")}</small> : null}
      {error ? <small role="alert">{error} {!context ? <button type="button"
        onClick={() => { setError(""); setRetry((value) => value + 1); }}>{t("questionRetry")}</button> : null}</small> : null}
      <footer>
        <button type="button" disabled={busy} onClick={onClose}>{t("questionCancel")}</button>
        <button type="submit" disabled={busy || !nodeId || !title.trim()}>{t("questionAdd")}</button>
      </footer>
    </form>
  </dialog>, document.body);
}

export function QuestionDocumentAction({ absolutePath, sessionId, t: locale }: {
  absolutePath?: string;
  sessionId?: string;
  t?: unknown;
}): ReactNode {
  const [capture, setCapture] = useState<{ title: string; source: { kind: "file"; sessionId: string; absolutePath: string; line?: number } }>();
  const t = useMemo(() => makeTranslator(locale, QUESTION_ZH), [locale]);
  if (!absolutePath || !sessionId) return null;
  return <>
    <button type="button" data-question-document-action="" title={t("questionCapture")}
      style={{ padding: "4px 6px", color: "inherit", background: "transparent", border: 0, font: "inherit", cursor: "pointer" }}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        const { text, line } = fileQuestionSelection(event.currentTarget, window.getSelection());
        setCapture({
          title: text || absolutePath.split(/[\\/]/).at(-1) || "",
          source: { kind: "file", absolutePath, sessionId, ...(line === undefined ? {} : { line }) },
        });
      }}>{t("questionCapture")}</button>
    {capture ? <QuestionCapture source={capture.source} title={capture.title} t={locale} onClose={() => setCapture(undefined)} /> : null}
  </>;
}
