/**
 * 工具卡片的**纯数据模型**（无 JSX、无 React）。
 *
 * 单独抽出来的理由：客户端半没法在 DSH 里跑单测，但「把工具结果解析成界面模型」这件事
 * 是纯函数，可以在 `node --test` 里直接验证——客户端最容易坏的就是它与宿主结果之间的契约。
 * 组件只负责把模型画出来。
 */

export interface ToolResultBlock {
  isError?: boolean;
  content?: ReadonlyArray<{ type?: string; text?: string }>;
}

export interface ErrorInfo {
  code: string;
  message: string;
}

export interface NodeRef {
  id: string;
  title: string;
  path: string;
  status?: string;
}

export interface ParsedToolResult {
  ok: boolean;
  error?: ErrorInfo;
  data: Record<string, unknown>;
}

/** 同一个结果卡片要同时容纳「成功」「需要确认」两种形态 */
const asString = (value: unknown): string => (typeof value === "string" ? value : "");
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** 把工具结果解析成 `{ok, error?, data}`；不可解析时 ok=false 且 error 说明原因 */
export function parseToolResult(block: ToolResultBlock | undefined): ParsedToolResult {
  const content = block?.content;
  if (!Array.isArray(content) || content.length === 0) {
    return { ok: false, error: { code: "unreadable", message: "no content" }, data: {} };
  }
  const first = content[0];
  if (first === undefined || first.type !== "text" || typeof first.text !== "string") {
    return { ok: false, error: { code: "unreadable", message: "not a text block" }, data: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(first.text);
  } catch {
    return { ok: false, error: { code: "unreadable", message: "invalid json" }, data: {} };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, error: { code: "unreadable", message: "not an object" }, data: {} };
  }
  const data = parsed as Record<string, unknown>;
  const error = data.error as { code?: unknown; message?: unknown } | undefined;
  return {
    ok: data.ok === true,
    ...(error === undefined
      ? {}
      : { error: { code: asString(error.code), message: asString(error.message) } }),
    data,
  };
}

function nodeRef(raw: unknown): NodeRef | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const id = asString(value.id) || asString(value.toNodeId);
  const title = asString(value.title) || asString(value.toTitle);
  if (id === "" && title === "") return null;
  return { id, title, path: asString(value.path) || asString(value.relativePath), status: asString(value.status) || undefined };
}

export interface NodeCardModel {
  title: string;
  path: string;
  status: string;
  primaryDocument: string;
  noteText: string;
  noteTruncated: boolean;
  noteChars: number;
  prerequisites: NodeRef[];
  dependents: NodeRef[];
  relations: Array<{ title: string; type: string; description: string; hasEvidence: boolean }>;
  resources: Array<{ title: string; type: string }>;
}

/** `kn_read_node` 的卡片模型 */
export function nodeCardModel(data: Record<string, unknown>): NodeCardModel {
  const node = (data.node ?? {}) as Record<string, unknown>;
  const note = (data.note ?? {}) as Record<string, unknown>;
  const noteText = asString(note.text);
  const relations = asArray(data.relations).flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const edge = item as Record<string, unknown>;
    return [{
      title: asString(edge.toTitle) || asString(edge.toNodeId).slice(0, 8),
      type: asString(edge.relationType) || "prerequisite",
      description: asString(edge.description),
      hasEvidence: asArray(edge.evidence).length > 0,
    }];
  });
  return {
    title: asString(node.title),
    path: asString(node.path),
    status: asString(node.status) || "todo",
    primaryDocument: asString(node.primaryDocument),
    noteText,
    noteTruncated: note.truncated === true,
    noteChars: noteText.length,
    prerequisites: asArray(data.prerequisites).flatMap((item) => nodeRef(item) ?? []),
    dependents: asArray(data.dependents).flatMap((item) => nodeRef(item) ?? []),
    relations,
    resources: asArray(data.resources).flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const resource = item as Record<string, unknown>;
      return [{ title: asString(resource.title), type: asString(resource.type) }];
    }),
  };
}

export interface PrereqCardModel {
  from: NodeRef | null;
  node: NodeRef | null;
  created: boolean;
  edgeType: string;
  relationDescription: string;
  evidenceRecorded: boolean;
  candidates: NodeRef[];
  cycle: string[];
  needsConfirmation: boolean;
  emptyStack: boolean;
}

/** `kn_add_prerequisite`（以及 `kn_enter_node` / `kn_back` / `kn_write_note` 的错误态）的卡片模型 */
export function prereqCardModel(data: Record<string, unknown>): PrereqCardModel {
  const edge = (data.edge ?? {}) as Record<string, unknown>;
  return {
    from: nodeRef(data.from),
    node: nodeRef(data.node),
    created: data.created === true,
    edgeType: asString(edge.type),
    relationDescription: asString(edge.description),
    evidenceRecorded: data.evidenceRecorded === true,
    candidates: asArray(data.candidates).flatMap((item) => nodeRef(item) ?? []),
    cycle: asArray(data.cycle).map((item) => asString(item)),
    needsConfirmation: (data.error as { code?: unknown } | undefined)?.code === "needs_confirmation",
    emptyStack: (data.error as { code?: unknown } | undefined)?.code === "empty_stack",
  };
}

/** 节点条/前台显示用的一行摘要 */
export function nodeLine(ref: NodeRef | null | undefined): string {
  if (ref === null || ref === undefined) return "";
  const status = ref.status === undefined ? "" : ` · ${ref.status}`;
  return `${ref.title}${status}`;
}

/**
 * 取文案：宿主给了 `t`（locale 注册成功）就用它，否则回落到组件内字面文案。
 * 这样 locale 服务缺席时界面不会空，也不会因为一个命名空间没注册就崩。
 */
export function makeTranslator(
  t: unknown,
  dict: Record<string, string>,
): (key: string, values?: Record<string, string | number>) => string {
  const bind = typeof t === "function" ? (t as (key: string) => unknown) : null;
  return (key, values) => {
    let template = dict[key] ?? key;
    if (bind !== null) {
      try {
        const text = bind(key);
        if (typeof text === "string" && text !== "" && text !== key) template = text;
      } catch {
        // 宿主 locale 服务行为变化时静默回落
      }
    }
    if (values === undefined) return template;
    return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(values[name] ?? ""));
  };
}
