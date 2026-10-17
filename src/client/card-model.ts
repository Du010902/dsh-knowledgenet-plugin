import { pluginTranslate } from "./plugin-locale.ts";

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
  /**
   * 关系**总数**（宿主 `relationCounts`），可能大于上面两个列表的长度：
   * `kn_read_node` 默认 `relations: "none"` 只返回计数 ⇒ 列表为空**不代表没有关系**。
   * 卡片必须用计数区分「真的没有」与「本次没展开」，否则会显示成误导性的「暂无」。
   */
  prerequisiteCount: number;
  dependentCount: number;
  relations: Array<{ title: string; type: string; description: string; hasEvidence: boolean }>;
  resources: Array<{ title: string; type: string }>;
}

/** 非负整数；缺字段/坏值时用调用方给的回落值（旧结果没有 relationCounts ⇒ 用列表长度） */
function countValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/**
 * 前置 / 被依赖列表的**展示决策**（纯函数，便于单测）。
 *
 * 空列表有两种完全不同的含义：
 * - `hidden === 0` ⇒ 真的没有关系（界面显示「（暂无）」）；
 * - `hidden > 0` ⇒ 有关系、但本次 `relations` 没展开（界面显示「共 N 个（未展开）」）。
 * 列表非空时 `hidden` 表示被 `relationLimit` 截断掉的数量（界面提示「另有 N 个未展开」）。
 *
 * @param refs - 工具结果里已展开的引用（可能为空）。
 * @param total - `relationCounts` 里的总数；缺字段时传列表长度。
 * @returns 原样的 refs + 未展示的数量（永远非负）。
 */
export function relationChipState(refs: NodeRef[], total: number): { refs: NodeRef[]; hidden: number } {
  /* 计数比列表短说明结果自相矛盾 ⇒ 以列表为准，避免算出负的「未展开」 */
  return { refs, hidden: Math.max(0, Math.max(refs.length, total) - refs.length) };
}

/** `kn_read_node` 的卡片模型 */
export function nodeCardModel(data: Record<string, unknown>): NodeCardModel {
  const node = (data.node ?? {}) as Record<string, unknown>;
  const note = (data.note ?? {}) as Record<string, unknown>;
  const noteText = asString(note.text);
  const prerequisites = asArray(data.prerequisites).flatMap((item) => nodeRef(item) ?? []);
  const dependents = asArray(data.dependents).flatMap((item) => nodeRef(item) ?? []);
  const counts = (data.relationCounts ?? {}) as Record<string, unknown>;
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
    prerequisites,
    dependents,
    /* 计数比列表短说明结果自相矛盾 ⇒ 以列表为准，避免卡片算出负的「未展开」 */
    prerequisiteCount: Math.max(prerequisites.length, countValue(counts.prerequisites, 0)),
    dependentCount: Math.max(dependents.length, countValue(counts.dependents, 0)),
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
    /*
     * **三级取词** ✓（用户实测：英文界面下插件满屏中文 ✗）：
     * ① 宿主注入的 `t` ✓；② **插件自己 bind 的翻译函数** ✓（`plugin-locale.ts` ✓）；
     * ③ 组件内字面文案 ✓。实测英文界面里 ① 没能解析出我们的命名空间 ✗ ⇒ 只靠 ① 会一直中文 ✓。
     */
    const fromHost = (): string | null => {
      if (bind === null) return null;
      try {
        const text = bind(key);
        return typeof text === "string" && text !== "" && text !== key ? text : null;
      } catch {
        // 宿主 locale 服务行为变化时静默回落
        return null;
      }
    };
    const fromPlugin = (): string | null => {
      try {
        const text = pluginTranslate()?.(key);
        return typeof text === "string" && text !== "" && text !== key ? text : null;
      } catch {
        return null;
      }
    };
    const text = fromHost() ?? fromPlugin();
    if (text !== null) template = text;
    if (values === undefined) return template;
    return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(values[name] ?? ""));
  };
}
