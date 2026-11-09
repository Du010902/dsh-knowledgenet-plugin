export type NoteQuestionSource = { kind: "note"; nodeId: string; excerpt: string; block: number };
export type ChatQuestionSource = { kind: "chat"; sessionId: string; messageKey: string; seq?: number; excerpt?: string; offset?: number };
export type FileQuestionSource = { kind: "file"; sessionId: string; path: string; line?: number };
export type QuestionSource = NoteQuestionSource | ChatQuestionSource | FileQuestionSource;
export type QuestionSourceInput = NoteQuestionSource | ChatQuestionSource
  | { kind: "file"; sessionId: string; absolutePath: string; line?: number };

export interface NodeQuestion {
  id: string;
  title: string;
  processed: boolean;
  source?: QuestionSource;
}

export function readQuestionSource(input: unknown): QuestionSource | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  const nonempty = (text: unknown, max: number): text is string =>
    typeof text === "string" && text.trim() !== "" && text.length <= max && !text.includes("\0");
  const index = (n: unknown, min: number): n is number =>
    typeof n === "number" && Number.isSafeInteger(n) && n >= min;
  if (value.kind === "note" && nonempty(value.nodeId, 300) && nonempty(value.excerpt, 500) && index(value.block, 0)) {
    return { kind: "note", nodeId: value.nodeId, excerpt: value.excerpt, block: value.block };
  }
  if (!nonempty(value.sessionId, 300)) return undefined;
  if (value.kind === "chat" && nonempty(value.messageKey, 500) && (value.seq === undefined || index(value.seq, 0))
    && (value.excerpt === undefined || nonempty(value.excerpt, 500))
    && (value.offset === undefined || (value.excerpt !== undefined && index(value.offset, 0)))) {
    return {
      kind: "chat", sessionId: value.sessionId, messageKey: value.messageKey,
      ...(value.seq === undefined ? {} : { seq: value.seq }),
      ...(value.excerpt === undefined ? {} : { excerpt: value.excerpt }),
      ...(value.offset === undefined ? {} : { offset: value.offset }),
    };
  }
  if (value.kind === "file" && nonempty(value.path, 4096) && !/[\\:]/.test(value.path)
    && value.path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
    && (value.line === undefined || index(value.line, 1))) {
    return { kind: "file", sessionId: value.sessionId, path: value.path, ...(value.line === undefined ? {} : { line: value.line }) };
  }
  return undefined;
}
