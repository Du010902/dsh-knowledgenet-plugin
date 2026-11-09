import type { ChatQuestionSource, FileQuestionSource } from "../shared/node-questions.ts";

interface SessionBinding { session: { loadThrough?(seq: number): Promise<void> } }
interface SessionReference {
  ready?: Promise<SessionBinding>;
  binding: SessionBinding;
  release(): void;
}
interface QuestionNavigation {
  sessions?: {
    binding?(id: string): SessionBinding | undefined;
    retain?(id: string, options: { source: "controllerOperation" }): SessionReference;
  };
  uiConversation?: { binding(binding: SessionBinding): {
    target(target: "chat"): { getSnapshot(): { nodes: { get(key: string): {
      anchorSeq?: number;
      location?: { turn?: { start?: { seq?: number } } };
    } | undefined } } | undefined };
  } };
  sidebarRight?: { openResource?(address: string, options?: { params?: { line: number } }): void };
}

let services: () => QuestionNavigation = () => ({});
let jump = 0;
let notice: HTMLElement | undefined;
const CHAT_HIGHLIGHT = "knowledgenet-question-source";
let highlightTimer: number | undefined;

function clearChatHighlight(): void {
  if (typeof window === "undefined") return;
  window.clearTimeout(highlightTimer);
  CSS.highlights?.delete(CHAT_HIGHLIGHT);
}

export function attachQuestionNavigation(read: () => QuestionNavigation): () => void {
  services = read;
  return () => { if (services === read) { services = () => ({}); ++jump; clearChatHighlight(); } };
}

function elementOf(node: Node | null | undefined): Element | null {
  return node instanceof Element ? node : node?.parentElement ?? null;
}

export function chatQuestionSource(selection: Selection | null): ChatQuestionSource | undefined {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  const row = elementOf(range.startContainer)?.closest("[data-chat-node-key]");
  const messageKey = row?.getAttribute("data-chat-node-key");
  const sessionId = row?.closest("[data-conversation-session]")?.getAttribute("data-conversation-session");
  if (!row || !messageKey || !sessionId || row !== elementOf(range.endContainer)?.closest("[data-chat-node-key]")) return undefined;
  const selected = range.toString();
  const excerpt = selected.trim().slice(0, 500);
  if (!excerpt) return undefined;
  const before = document.createRange();
  before.selectNodeContents(row);
  before.setEnd(range.startContainer, range.startOffset);
  const offset = before.toString().length + selected.length - selected.trimStart().length;
  let seq: number | undefined;
  try {
    const { sessions, uiConversation } = services();
    const binding = sessions?.binding?.(sessionId);
    const node = binding && uiConversation?.binding(binding).target("chat").getSnapshot()?.nodes.get(messageKey);
    seq = node?.location?.turn?.start?.seq ?? node?.anchorSeq;
  } catch { /* The message key still locates rows already in the loaded window. */ }
  return { kind: "chat", sessionId, messageKey, excerpt, offset, ...(seq === undefined ? {} : { seq }) };
}

export function questionNotice(message: string): void {
  notice?.remove();
  const item = document.createElement("div");
  notice = item;
  item.setAttribute("role", "status");
  item.textContent = message;
  Object.assign(item.style, {
    position: "fixed", zIndex: "10004", insetInlineStart: "50%", bottom: "24px", translate: "-50% 0",
    maxWidth: "min(90vw, 420px)", padding: "8px 14px", borderRadius: "8px",
    background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-primary)",
    border: "1px solid var(--dsw-alias-border-l2)", boxShadow: "var(--dsw-elevation-panel)",
  });
  document.body.append(item);
  window.setTimeout(() => { item.remove(); if (notice === item) notice = undefined; }, 3800);
}

export function markQuestionSource(row: HTMLElement): void {
  row.scrollIntoView({ block: "center", inline: "nearest" });
  if (typeof row.animate !== "function") return;
  row.animate([
    { outline: "2px solid var(--dsw-alias-brand-primary)", outlineOffset: "2px" },
    { outline: "2px solid transparent", outlineOffset: "2px" },
  ], { duration: 2400, easing: "cubic-bezier(0.7, 0, 1, 1)" });
}

function chatExcerptRange(row: HTMLElement, excerpt: string, offset: number | undefined): Range | undefined {
  const text = row.textContent ?? "";
  let start: number;
  let length = excerpt.length;
  if (offset !== undefined && text.startsWith(excerpt, offset)) {
    start = offset;
  } else {
    // Older titles may have collapsed whitespace from the rendered answer.
    const escaped = excerpt.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const pattern = new RegExp(escaped.join("\\s+"), "g");
    const match = pattern.exec(text);
    if (!match) return undefined;
    pattern.lastIndex = match.index + 1;
    if (pattern.exec(text)) return undefined;
    start = match.index;
    length = match[0].length;
  }

  const end = start + length;
  const range = document.createRange();
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let position = 0;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const next = position + node.length;
    if (position <= start && start < next) range.setStart(node, start - position);
    if (position < end && end <= next) {
      range.setEnd(node, end - position);
      return range;
    }
    position = next;
  }
  return undefined;
}

function revealChatExcerpt(row: HTMLElement, source: ChatQuestionSource): boolean {
  const excerpt = source.excerpt?.trim();
  if (!excerpt) return false;
  const range = chatExcerptRange(row, excerpt, source.offset);
  const rect = range && Array.from(range.getClientRects()).find((line) => line.width && line.height);
  if (!range || !rect) return false;

  const scroller = row.closest<HTMLElement>("[data-conversation-scroll]");
  if (scroller) {
    const top = scroller.getBoundingClientRect().top + scroller.clientTop;
    scroller.scrollTop += rect.top + rect.height / 2 - top - scroller.clientHeight / 2;
  } else {
    window.scrollBy(0, rect.top + rect.height / 2 - window.innerHeight / 2);
  }
  if (CSS.highlights && typeof Highlight === "function") {
    if (!document.getElementById(CHAT_HIGHLIGHT)) {
      const style = document.createElement("style");
      style.id = CHAT_HIGHLIGHT;
      style.textContent = `::highlight(${CHAT_HIGHLIGHT}) { background-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, transparent); }`;
      document.head.append(style);
    }
    CSS.highlights.set(CHAT_HIGHLIGHT, new Highlight(range));
    highlightTimer = window.setTimeout(clearChatHighlight, 4000);
  }
  return true;
}

/** Called after the normal node-conversation navigation has been requested. */
export async function locateChatQuestion(source: ChatQuestionSource, missing: string, unavailable = missing, missingExcerpt = missing): Promise<void> {
  const request = ++jump;
  clearChatHighlight();
  notice?.remove();
  notice = undefined;
  const selector = `[data-conversation-session="${CSS.escape(source.sessionId)}"]`;
  const rowSelector = `[data-chat-node-key="${CSS.escape(source.messageKey)}"]`;
  const find = (): HTMLElement | undefined => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(`${selector} ${rowSelector}`));
    const row = rows.find((item) => item.getClientRects().length && !item.closest("[hidden]"));
    if (row) return row;
    const folded = rows[0]?.closest('[hidden="until-found"]');
    folded?.dispatchEvent(new Event("beforematch", { bubbles: true }));
    return undefined;
  };
  const immediate = find();
  if (immediate && revealChatExcerpt(immediate, source)) return;
  if (!immediate && source.seq !== undefined) {
    let reference: SessionReference | undefined;
    try {
      reference = services().sessions?.retain?.(source.sessionId, { source: "controllerOperation" });
      const binding = reference ? await (reference.ready ?? reference.binding) : services().sessions?.binding?.(source.sessionId);
      if (request !== jump) return;
      await binding?.session.loadThrough?.(source.seq);
    } catch { /* Still try locating the row in the mounted view. */ }
    finally { reference?.release(); }
  }
  const end = Date.now() + 1600;
  let row = immediate;
  while (request === jump && Date.now() < end) {
    row = find();
    if (row && (!source.excerpt || revealChatExcerpt(row, source))) {
      if (source.excerpt) return;
      break;
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
  }
  if (request !== jump) return;
  if (row) {
    row.scrollIntoView({ block: "start", inline: "nearest" });
    questionNotice(missingExcerpt);
  } else questionNotice(document.querySelector(selector) ? missing : unavailable);
}

export function openFileQuestion(source: FileQuestionSource): void {
  const sidebar = services().sidebarRight;
  if (!sidebar?.openResource) throw new Error("Document preview is unavailable");
  const path = source.path.split("/").map((part) => encodeURIComponent(part)).join("/");
  const address = `dsh-resource://file/session/${encodeURIComponent(source.sessionId)}/${path}`;
  sidebar.openResource(address, source.line === undefined ? undefined : { params: { line: source.line } });
}

export function fileQuestionSelection(button: HTMLElement, selection: Selection | null): { text: string; line?: number } {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return { text: "" };
  const range = selection.getRangeAt(0);
  const start = elementOf(range.startContainer);
  const end = elementOf(range.endContainer);
  const preview = button.closest("[data-textpreview-url]");
  if (!preview || !start || !end || !preview.contains(start) || !preview.contains(end)) return { text: "" };
  const text = selection.toString();
  const line = Number(start.closest("[data-textpreview-line]")?.getAttribute("data-textpreview-line"));
  if (Number.isSafeInteger(line) && line > 0) return { text, line };
  const codeLine = start.closest("pre .line");
  const pre = codeLine?.closest("pre");
  return codeLine && pre?.closest("[data-code-preview]")
    ? { text, line: Array.from(pre.querySelectorAll(".line")).indexOf(codeLine) + 1 }
    : { text };
}
