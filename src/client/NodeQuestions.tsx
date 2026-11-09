import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { NodeQuestion, NoteQuestionSource, QuestionSource } from "../shared/node-questions.ts";
import { GRAPH_API_ROUTE } from "../shared/routes.ts";
import { searchKey, type GraphSnapshot } from "../vendor/upstream/data/types.ts";
import { makeTranslator } from "./card-model.ts";
import type { DocumentTarget, FetchLike } from "./node-document-client.ts";
import { postQuestion, QUESTION_ZH, questionSourceLabel, watchQuestions } from "./node-questions-client.ts";

export interface NoteQuestionDraft {
  id: string;
  title: string;
  source?: NoteQuestionSource;
}

export function NodeQuestions(props: {
  id: string;
  nodeId: string;
  nodeTitle: string;
  root?: string;
  target?: DocumentTarget;
  graph?: GraphSnapshot;
  draft?: NoteQuestionDraft | null;
  fetcher?: FetchLike;
  t?: unknown;
  onLocate(item: NodeQuestion & { source: QuestionSource }, signal: AbortSignal): void | Promise<void>;
  onPromoted(): void;
}): ReactNode {
  const t = useMemo(() => makeTranslator(props.t, QUESTION_ZH), [props.t]);
  const [items, setItems] = useState<NodeQuestion[] | null>(null);
  const [draft, setDraft] = useState<NoteQuestionDraft | null>(props.draft ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const revision = useRef(0);
  const inFlight = useRef(false);
  const scope = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const addButton = useRef<HTMLButtonElement | null>(null);
  const appliedDraft = useRef(props.draft?.id);
  const nodeId = props.nodeId;
  const { target, fetcher, root } = props;

  useEffect(() => {
    const abort = new AbortController();
    scope.current = abort;
    return () => abort.abort();
  }, [nodeId, target]);
  useEffect(() => {
    const abort = new AbortController();
    const request = ++revision.current;
    void postQuestion<NodeQuestion[]>(target, { kind: "list-node-questions", nodeId }, fetcher, abort.signal)
      .then((result) => { if (!abort.signal.aborted && revision.current === request) setItems(result); })
      .catch((failure: Error) => {
        if (!abort.signal.aborted && revision.current === request) setError(failure.message);
      });
    return () => abort.abort();
  }, [nodeId, target, fetcher, refresh]);
  useEffect(() => root ? watchQuestions(root, nodeId, () => setRefresh((value) => value + 1)) : undefined, [root, nodeId]);
  useEffect(() => {
    if (props.draft && appliedDraft.current !== props.draft.id) {
      appliedDraft.current = props.draft.id;
      setDraft(props.draft);
    }
  }, [props.draft]);
  useEffect(() => { if (draft) input.current?.focus(); }, [draft?.id]);

  async function run(action: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const signal = scope.current?.signal;
    if (inFlight.current || !signal || signal.aborted) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try { await action(signal); }
    catch (failure) {
      if (!signal.aborted) setError(failure instanceof Error ? failure.message : t("questionUnavailable"));
    }
    finally { inFlight.current = false; if (!signal.aborted) setBusy(false); }
  }

  async function update(request: Parameters<typeof postQuestion>[1], signal: AbortSignal): Promise<void> {
    ++revision.current;
    const result = await postQuestion<NodeQuestion[]>(target, request, fetcher, signal);
    signal.throwIfAborted();
    setItems(result);
  }

  function promote(item: NodeQuestion): Promise<void> {
    return run(async (signal) => {
      const response = await (fetcher ?? fetch)(GRAPH_API_ROUTE, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal,
        body: JSON.stringify({ ...target, kind: "add-prerequisite", fromId: nodeId, title: item.title, create: true }),
      });
      const result = await response.json() as { ok?: boolean; error?: { message?: string } };
      signal.throwIfAborted();
      if (("ok" in response && response.ok === false) || result.ok !== true) throw new Error(result.error?.message ?? t("questionUnavailable"));
      props.onPromoted();
    });
  }

  const prerequisites = new Set(props.graph?.edges.filter((edge) => edge.fromId === nodeId && edge.relationType === "prerequisite").map((edge) => edge.toId));
  const linkedTitles = new Set(props.graph?.nodes.filter((node) => prerequisites.has(node.id))
    .flatMap((node) => [node.title, ...node.aliases]).map(searchKey));
  return <section className="kn-questions" id={props.id} aria-label={t("questions")}>
    <div className="kn-questions-head">
      <strong>{t("questions")}</strong>
      <button type="button" ref={addButton} disabled={busy} onClick={() => setDraft({ id: crypto.randomUUID(), title: "" })}>{t("questionNew")}</button>
      <small>{t("questionHelp")}</small>
    </div>
    {draft ? <form className="kn-question-form" onSubmit={(event) => {
      event.preventDefault();
      if (!draft.title.trim()) return;
      void run(async (signal) => {
        await update({ kind: "add-node-question", nodeId, questionId: draft.id, title: draft.title.trim(), ...(draft.source ? { source: draft.source } : {}) }, signal);
        setDraft((current) => current?.id === draft.id ? null : current);
        addButton.current?.focus();
      });
    }}>
      {draft.source ? <small>{props.nodeTitle} · {t(questionSourceLabel(draft.source))}</small> : null}
      <label>{t("questionTitle")}<input ref={input} value={draft.title} maxLength={120} required disabled={busy}
        onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
      <div>
        <button type="button" disabled={busy} onClick={() => { setDraft(null); addButton.current?.focus(); }}>{t("questionCancel")}</button>
        <button type="submit" disabled={busy || !draft.title.trim()}>{t("questionAdd")}</button>
      </div>
    </form> : null}
    {error ? <div className="kn-question-error" role="alert">{error} {items === null && !draft
      ? <button type="button" onClick={() => { setError(""); setRefresh((value) => value + 1); }}>{t("questionRetry")}</button> : null}</div> : null}
    {items === null ? (!error && <p>{t("questionLoading")}</p>) : items.length === 0 ? <p>{t("questionEmpty")}</p> : (
      <ul aria-label={t("questions")}>{items.map((item) => <QuestionRow key={item.id} item={item} busy={busy}
        linked={linkedTitles.has(searchKey(item.title))} t={t}
        onToggle={(processed) => { void run((signal) => update({ kind: "set-node-question-processed", nodeId, questionId: item.id, processed }, signal)); }}
        onLocate={() => {
          const source = item.source;
          if (source) void run(async (signal) => { await props.onLocate({ ...item, source }, signal); });
        }}
        onPromote={() => { void promote(item); }}
        onDelete={(row) => {
          const neighbor = row.nextElementSibling ?? row.previousElementSibling;
          void run(async (signal) => {
            await update({ kind: "delete-node-question", nodeId, questionId: item.id }, signal);
            requestAnimationFrame(() => (neighbor?.querySelector<HTMLButtonElement>(".kn-question-actions") ?? addButton.current)?.focus());
          });
        }}
      />)}</ul>
    )}
  </section>;
}

function QuestionRow({ item, busy, linked, t, onToggle, onLocate, onPromote, onDelete }: {
  item: NodeQuestion; busy: boolean; linked: boolean; t: ReturnType<typeof makeTranslator>;
  onToggle(processed: boolean): void; onLocate(): void; onPromote(): void; onDelete(row: HTMLElement): void;
}): ReactNode {
  const id = useId();
  const row = useRef<HTMLLIElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const choose = (action: () => void) => { menu.current?.hidePopover(); action(); };
  return <li className="kn-question-row" ref={row}>
    <label><input type="checkbox" aria-label={t("questionProcessed", { title: item.title })} checked={item.processed} disabled={busy}
      onChange={(event) => onToggle(event.target.checked)} /><span>{item.title}</span></label>
    <button type="button" className="kn-question-actions" {...{ popovertarget: id }} aria-label={t("questionActions", { title: item.title })} disabled={busy}>
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeLinecap="round" /></svg>
    </button>
    <div ref={menu} id={id} {...{ popover: "auto" }} className="kn-question-menu" role="group" aria-label={t("questionActions", { title: item.title })}>
      <button type="button" disabled={!item.source || busy} onClick={() => choose(onLocate)}>
        {t("questionLocate")}<small>{item.source?.kind === "file" ? item.source.path : t(questionSourceLabel(item.source))}</small>
      </button>
      <button type="button" disabled={linked || busy} onClick={() => choose(onPromote)}>{t("questionPromote")}</button>
      <hr /><button type="button" className="kn-question-delete" disabled={busy} onClick={() => choose(() => { if (row.current) onDelete(row.current); })}>{t("questionDelete")}</button>
    </div>
  </li>;
}
