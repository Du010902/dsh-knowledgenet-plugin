import { GRAPH_API_ROUTE } from "../shared/routes.ts";
import type { NodeQuestion, NoteQuestionSource, QuestionSourceInput } from "../shared/node-questions.ts";
import type { DocumentTarget, FetchLike } from "./node-document-client.ts";

export const QUESTION_ZH = {
  questions: "学习疑问",
  questionHelp: "记下需要理解的知识点，弄懂后勾选。",
  questionEmpty: "还没有记录的知识点。",
  questionNew: "记一条",
  questionCapture: "记为疑问",
  questionTitle: "知识点名称",
  questionProcessed: "已处理 · {title}",
  questionActions: "知识点操作 · {title}",
  questionLocate: "定位来源",
  questionPromote: "创建为前置节点",
  questionDelete: "删除",
  questionNoSource: "未关联来源",
  questionNote: "节点笔记",
  questionChat: "聊天消息",
  questionFile: "工作区文档",
  questionOwner: "归属节点",
  questionChooseNode: "选择一个节点",
  questionSearchNodes: "搜索节点",
  questionAdd: "添加",
  questionCancel: "取消",
  questionLoading: "正在读取…",
  questionRetry: "重试",
  questionMissingNote: "已打开笔记，原段落已修改或无法唯一定位。",
  questionMissingChat: "已打开对话，未找到原消息。",
  questionMissingChatExcerpt: "已定位到原消息，无法唯一匹配其中的原文。",
  questionUnavailable: "无法打开来源，请确认它仍可访问。",
  questionRecorded: "已记录学习疑问",
};

export const QUESTION_EN: Record<keyof typeof QUESTION_ZH, string> = {
  questions: "Learning questions",
  questionHelp: "List what you want to understand and check it off when you do.",
  questionEmpty: "No questions recorded yet.",
  questionNew: "Add one",
  questionCapture: "Record as a question",
  questionTitle: "Topic name",
  questionProcessed: "Processed · {title}",
  questionActions: "Question actions · {title}",
  questionLocate: "Go to source",
  questionPromote: "Create as prerequisite",
  questionDelete: "Delete",
  questionNoSource: "No source linked",
  questionNote: "Node note",
  questionChat: "Chat message",
  questionFile: "Workspace document",
  questionOwner: "Learning node",
  questionChooseNode: "Choose a node",
  questionSearchNodes: "Search nodes",
  questionAdd: "Add",
  questionCancel: "Cancel",
  questionLoading: "Loading…",
  questionRetry: "Retry",
  questionMissingNote: "The note is open. The original passage changed or could not be matched uniquely.",
  questionMissingChat: "The chat is open. The original message could not be found.",
  questionMissingChatExcerpt: "The original message is open. The passage could not be matched uniquely.",
  questionUnavailable: "The source could not be opened. Check that it is still accessible.",
  questionRecorded: "Learning question recorded",
};

export interface QuestionContext {
  root: string;
  libraryId?: string;
  nodes: { id: string; title: string }[];
  ownerNodeId?: string;
}

type Request = { kind: "list-node-questions"; nodeId?: string; questionId?: string }
  | { kind: "add-node-question"; nodeId: string; questionId: string; title: string; source?: QuestionSourceInput }
  | { kind: "set-node-question-processed"; nodeId: string; questionId: string; processed: boolean }
  | { kind: "delete-node-question"; nodeId: string; questionId: string };

export async function postQuestion<T extends NodeQuestion[] | QuestionContext>(
  target: DocumentTarget | undefined, request: Request, fetcher: FetchLike = fetch, signal?: AbortSignal,
): Promise<T> {
  const response = await fetcher(GRAPH_API_ROUTE, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...target, ...request }), ...(signal ? { signal } : {}),
  });
  const body = await response.json() as { ok?: boolean; questions?: unknown; error?: { message?: string } };
  if (("ok" in response && response.ok === false) || body.ok !== true) throw new Error(body.error?.message ?? "Unable to load learning questions");
  return (request.nodeId ? body.questions : body) as T;
}

const changes = new EventTarget();

function rootKey(root: string): string {
  const path = root.replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-z]:\/|^\/\//i.test(path) ? path.toLowerCase() : path;
}

export function notifyQuestionsChanged(root: string, nodeId: string): void {
  changes.dispatchEvent(new CustomEvent(rootKey(root), { detail: nodeId }));
}

export function watchQuestions(root: string, nodeId: string, refresh: () => void): () => void {
  const key = rootKey(root);
  const onChange = (event: Event) => { if ((event as CustomEvent).detail === nodeId) refresh(); };
  changes.addEventListener(key, onChange);
  return () => changes.removeEventListener(key, onChange);
}

export function questionSourceLabel(source: Pick<QuestionSourceInput, "kind"> | undefined): keyof typeof QUESTION_ZH {
  return source?.kind === "note" ? "questionNote" : source?.kind === "chat" ? "questionChat"
    : source?.kind === "file" ? "questionFile" : "questionNoSource";
}

export function normalizedQuestionText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function findQuestionBlock(blocks: string[], source: Pick<NoteQuestionSource, "block" | "excerpt">): number {
  const matches = blocks.flatMap((text, index) => normalizedQuestionText(text).includes(source.excerpt) ? [index] : []);
  if (matches.includes(source.block)) return source.block;
  return matches.length === 1 ? matches[0]! : -1;
}
