/**
 * v2 开放文件模型：解析、校验与构造（纯函数）
 *
 * 对应契约 §1 的六个 JSON 文件与 §2 的错误码，与 Rust `src-tauri/src/v2/schema.rs` 同构。
 *
 * 三条纪律：
 * 1. **未知字段原样保留**：解析时把已知字段摘出来，其余字段用 `...extra` 放回对象，
 *    重新序列化后用户/别的工具写进去的扩展字段一个都不会丢；
 * 2. **错误码固定**：`format` / `formatVersion` 不对是 `metadata_unsupported`，
 *    解析失败与必填字段类型错是 `metadata_invalid`（契约 §2）；
 * 3. **不做善意修正**：字段类型不对就报错，绝不「顺手」把数字当字符串用。
 *    坏文件要如实显示为坏文件，而不是被静默改写。
 */
import { RepositoryError } from "../errors.ts";
import type { ProcessStep } from "../chatTypes.ts";
import { escapesLibrary, normalizeRel, requireSafeRelative } from "./paths.ts";

/* --------------------------------- 常量 --------------------------------- */

export const LIBRARY_FORMAT = "knowledgenet-library";
export const LIBRARY_FORMAT_VERSION = 2;

export const NODE_FORMAT = "knowledgenet-node";
export const NODE_FORMAT_VERSION = 1;

export const RELATIONS_FORMAT = "knowledgenet-relations";
export const RELATIONS_FORMAT_VERSION = 1;

export const RESOURCES_FORMAT = "knowledgenet-resources";
export const RESOURCES_FORMAT_VERSION = 1;

export const BOOKMARKS_FORMAT = "knowledgenet-bookmarks";
export const BOOKMARKS_FORMAT_VERSION = 1;

export const GOALS_FORMAT = "knowledgenet-goals";
export const GOALS_FORMAT_VERSION = 1;

export const THREAD_FORMAT = "knowledgenet-chat-thread";
export const THREAD_FORMAT_VERSION = 1;

/**
 * 笔记记账文件（与 Rust `docs/v2-deviations.md` D5 同构）。
 *
 * 文档修订号描述的是**正文文件**的修订，而 `node.json` 的 `revision` 描述的是
 * **节点元数据**的修订；用一个数字表示两件事，会出现「改了标题导致笔记保存报冲突」
 * 这种莫名其妙的交互。因此正文指纹单独记在
 * `.meta/knowledgenet/notes-index.json`，坏了直接重建（它是可推导的缓存）。
 */
export const NOTES_INDEX_FORMAT = "knowledgenet-notes-index";
export const NOTES_INDEX_FORMAT_VERSION = 1;

export interface V2NoteEntry extends Extensible {
  /** 文档相对节点目录的路径，例如 `note.md` */
  relativePath: string;
  sha256: string;
  byteLength: number;
  revision: number;
  modifiedAt: number;
}

export interface V2NotesIndexFile extends Extensible {
  format: string;
  formatVersion: number;
  nodeId: string;
  entries: V2NoteEntry[];
}

export function emptyNotesIndex(nodeId: string): V2NotesIndexFile {
  return {
    format: NOTES_INDEX_FORMAT,
    formatVersion: NOTES_INDEX_FORMAT_VERSION,
    nodeId,
    entries: [],
  };
}

export function parseNotesIndexFile(
  text: string,
  relativePath: string | null = null,
): V2NotesIndexFile {
  const what = "notes-index.json";
  const raw = parseJsonRecord(text, what, relativePath);
  requireFormat(raw, what, NOTES_INDEX_FORMAT, NOTES_INDEX_FORMAT_VERSION, relativePath);
  const { format, formatVersion, nodeId, entries, ...extra } = raw;
  const parsed: V2NoteEntry[] = [];
  for (const item of requireArray(entries, what, "entries", relativePath)) {
    const entry = asRecord(item, `${what} 的 entries 条目`, relativePath);
    const { relativePath: docPath, sha256, byteLength, revision, modifiedAt, ...entryExtra } = entry;
    parsed.push({
      relativePath: requireString(docPath, what, "entries[].relativePath", relativePath),
      sha256: requireString(sha256 ?? "", what, "entries[].sha256", relativePath),
      byteLength: requireInt(byteLength ?? 0, what, "entries[].byteLength", relativePath),
      revision: requireInt(revision ?? 0, what, "entries[].revision", relativePath),
      modifiedAt:
        typeof modifiedAt === "number" && Number.isFinite(modifiedAt) ? modifiedAt : 0,
      ...entryExtra,
    });
  }
  return {
    format: NOTES_INDEX_FORMAT,
    formatVersion: NOTES_INDEX_FORMAT_VERSION,
    nodeId: requireUuid(nodeId, what, "nodeId", relativePath),
    entries: parsed,
    ...extra,
  };
}

export const MESSAGE_FORMAT = "knowledgenet-chat-message";
export const MESSAGE_FORMAT_VERSION = 1;

/** 消息文件里的状态集合（与前端 `MessageStatus` 的对应关系见 `chats.ts`） */
export const MESSAGE_FILE_STATUSES = [
  "streaming",
  "complete",
  "stopped",
  "error",
  "incomplete",
] as const;
export type MessageFileStatus = (typeof MESSAGE_FILE_STATUSES)[number];

export const MESSAGE_ROLES = ["system", "user", "assistant"] as const;
export type MessageFileRole = (typeof MESSAGE_ROLES)[number];

export const LEARN_STATUSES = ["todo", "learning", "done"] as const;
export type FileLearnStatus = (typeof LEARN_STATUSES)[number];

/** 未知字段的容器：所有 v2 文件模型都允许扩展字段 */
export interface Extensible {
  [key: string]: unknown;
}

/* --------------------------------- 错误 --------------------------------- */

export type MetadataErrorCode = "metadata_invalid" | "metadata_unsupported";

/**
 * 元数据错误。
 *
 * `parsePosition` 只在 JSON 语法错误时有值（来自解析器的位置信息），
 * 界面据此可以直接把光标指到出错的那一列；字段类型错误没有位置可言。
 */
export class MetadataError extends Error {
  readonly code: MetadataErrorCode;
  readonly what: string;
  readonly relativePath: string | null;
  readonly parsePosition: string | null;

  constructor(
    code: MetadataErrorCode,
    message: string,
    options: { what: string; relativePath?: string | null; parsePosition?: string | null },
  ) {
    super(message);
    this.name = "MetadataError";
    this.code = code;
    this.what = options.what;
    this.relativePath = options.relativePath ?? null;
    this.parsePosition = options.parsePosition ?? null;
  }
}

export function isMetadataError(error: unknown): error is MetadataError {
  return error instanceof MetadataError;
}

function invalid(what: string, detail: string, relativePath?: string | null): never {
  throw new MetadataError("metadata_invalid", `${what}：${detail}`, {
    what,
    relativePath: relativePath ?? null,
  });
}

function unsupported(what: string, detail: string, relativePath?: string | null): never {
  throw new MetadataError("metadata_unsupported", `${what}：${detail}`, {
    what,
    relativePath: relativePath ?? null,
  });
}

/* -------------------------------- 基础校验 -------------------------------- */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ID 形状检查（UUIDv7 也是 UUID）。只做形状判断，不解释内容。 */
export function isUuidLike(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function asRecord(value: unknown, what: string, rel?: string | null): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(what, "顶层必须是一个 JSON 对象", rel);
  }
  return value as Record<string, unknown>;
}

/** 解析 JSON 文本；语法错误报 `metadata_invalid` 并带上解析位置 */
export function parseJsonRecord(
  text: string,
  what: string,
  relativePath?: string | null,
): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const position = /position (\d+)/i.exec(message)?.[1] ?? null;
    throw new MetadataError("metadata_invalid", `${what}不是合法的 JSON：${message}`, {
      what,
      relativePath: relativePath ?? null,
      parsePosition: position,
    });
  }
  return asRecord(raw, what, relativePath);
}

/**
 * 校验 `format` 与 `formatVersion`。
 *
 * 两者任一不匹配都是 `metadata_unsupported`：这通常意味着文件属于别的工具，
 * 或属于更新版本的 KnowledgeNet——用户需要的是「升级应用 / 换个工具」，
 * 而不是一句「文件坏了」。
 */
function requireFormat(
  raw: Record<string, unknown>,
  what: string,
  expectedFormat: string,
  expectedVersion: number,
  rel?: string | null,
): void {
  if (raw.format !== expectedFormat) {
    unsupported(
      what,
      `format 应为 ${expectedFormat}，实际是 ${JSON.stringify(raw.format ?? null)}`,
      rel,
    );
  }
  const version = raw.formatVersion;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    invalid(what, "formatVersion 必须是整数", rel);
  }
  if (version !== expectedVersion) {
    unsupported(what, `formatVersion 应为 ${expectedVersion}，实际是 ${version}`, rel);
  }
}

function requireString(value: unknown, what: string, field: string, rel?: string | null): string {
  if (typeof value !== "string") invalid(what, `${field} 必须是字符串`, rel);
  return value;
}

function requireIsoString(value: unknown, what: string, field: string, rel?: string | null): string {
  const text = requireString(value, what, field, rel);
  if (text.trim() === "") invalid(what, `${field} 不能为空`, rel);
  return text;
}

function requireInt(
  value: unknown,
  what: string,
  field: string,
  rel?: string | null,
  min = 0,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    invalid(what, `${field} 必须是整数`, rel);
  }
  if (value < min) invalid(what, `${field} 不能小于 ${min}`, rel);
  return value;
}

function requireUuid(value: unknown, what: string, field: string, rel?: string | null): string {
  if (!isUuidLike(value)) invalid(what, `${field} 必须是 UUID`, rel);
  return value;
}

function requireStringArray(value: unknown, what: string, field: string, rel?: string | null): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    invalid(what, `${field} 必须是字符串数组`, rel);
  }
  return value as string[];
}

function requireArray(value: unknown, what: string, field: string, rel?: string | null): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalid(what, `${field} 必须是数组`, rel);
  return value;
}

function optionalString(value: unknown, what: string, field: string, rel?: string | null): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") invalid(what, `${field} 必须是字符串或 null`, rel);
  return value;
}

/** 节点主文档必须是节点目录内的规范化相对路径 */
export function validatePrimaryDocument(rel: string): string {
  if (typeof rel !== "string" || rel.trim() === "") {
    throw new RepositoryError("invalid_input", "主文档路径不能为空");
  }
  if (escapesLibrary(rel)) {
    throw new RepositoryError(
      "node_outside_library",
      `主文档路径必须是节点目录内的相对路径：${rel}`,
      { relativePath: rel },
    );
  }
  return normalizeRel(rel);
}

/* ------------------------------- library.json ------------------------------- */

export interface V2ScanConfig extends Extensible {
  exclude: string[];
  followSymlinks: boolean;
}

export interface V2LibraryDefaults extends Extensible {
  newNodeParent: string;
}

export interface V2LibraryManifest extends Extensible {
  format: string;
  formatVersion: number;
  libraryId: string;
  title: string;
  createdAt: string;
  scan: V2ScanConfig;
  defaults: V2LibraryDefaults;
}

/** 扫描时永远排除的目录名 + `scan.exclude` 里「单纯是目录名」的那些 */
export function excludedDirNames(manifest: V2LibraryManifest): string[] {
  const names = new Set<string>([".git", "node_modules", ".knowledgenet"]);
  for (const entry of manifest.scan?.exclude ?? []) {
    const name = String(entry ?? "").trim();
    // 只认单纯的目录名；`**/.meta/knowledgenet` 这类 glob 由「只认精确 marker 路径」兜住
    if (name !== "" && !name.includes("/") && !name.includes("*")) names.add(name);
  }
  return [...names];
}

export function newLibraryManifest(input: {
  libraryId: string;
  title: string;
  now: string;
  newNodeParent?: string;
}): V2LibraryManifest {
  return {
    format: LIBRARY_FORMAT,
    formatVersion: LIBRARY_FORMAT_VERSION,
    libraryId: input.libraryId,
    title: input.title,
    createdAt: input.now,
    scan: {
      exclude: [".git", "node_modules", ".knowledgenet", "**/.meta/knowledgenet"],
      followSymlinks: false,
    },
    defaults: { newNodeParent: input.newNodeParent ?? "Nodes" },
  };
}

export function parseLibraryManifest(
  text: string,
  relativePath: string | null = null,
): V2LibraryManifest {
  const what = "library.json";
  const raw = parseJsonRecord(text, what, relativePath);
  requireFormat(raw, what, LIBRARY_FORMAT, LIBRARY_FORMAT_VERSION, relativePath);

  const {
    format,
    formatVersion,
    libraryId,
    title,
    createdAt,
    scan,
    defaults,
    ...extra
  } = raw;

  const scanRaw = scan === undefined || scan === null ? {} : asRecord(scan, what, relativePath);
  const { exclude, followSymlinks, ...scanExtra } = scanRaw;
  const scanConfig: V2ScanConfig = {
    exclude: requireStringArray(exclude, what, "scan.exclude", relativePath),
    followSymlinks: followSymlinks === true,
    ...scanExtra,
  };

  const defaultsRaw =
    defaults === undefined || defaults === null ? {} : asRecord(defaults, what, relativePath);
  const { newNodeParent, ...defaultsExtra } = defaultsRaw;
  const defaultsConfig: V2LibraryDefaults = {
    newNodeParent:
      typeof newNodeParent === "string" && newNodeParent.trim() !== ""
        ? normalizeRel(newNodeParent)
        : "Nodes",
    ...defaultsExtra,
  };

  return {
    format: LIBRARY_FORMAT,
    formatVersion: LIBRARY_FORMAT_VERSION,
    libraryId: requireUuid(libraryId, what, "libraryId", relativePath),
    title: requireString(title, what, "title", relativePath),
    createdAt: requireIsoString(createdAt, what, "createdAt", relativePath),
    scan: scanConfig,
    defaults: defaultsConfig,
    ...extra,
  };
}

/* -------------------------------- node.json -------------------------------- */

export interface V2NodeMeta extends Extensible {
  format: string;
  formatVersion: number;
  id: string;
  revision: number;
  title: string;
  aliases: string[];
  status: FileLearnStatus;
  primaryDocument: string | null;
  createdAt: string;
  updatedAt: string;
  extensions: Record<string, unknown>;
}

export function newNodeMeta(input: {
  id: string;
  title: string;
  now: string;
  aliases?: string[];
  status?: FileLearnStatus;
  primaryDocument?: string | null;
  extensions?: Record<string, unknown>;
}): V2NodeMeta {
  return {
    format: NODE_FORMAT,
    formatVersion: NODE_FORMAT_VERSION,
    id: input.id,
    revision: 1,
    title: input.title,
    aliases: input.aliases ?? [],
    status: input.status ?? "todo",
    primaryDocument:
      input.primaryDocument === undefined || input.primaryDocument === null
        ? null
        : validatePrimaryDocument(input.primaryDocument),
    createdAt: input.now,
    updatedAt: input.now,
    extensions: input.extensions ?? {},
  };
}

export function parseNodeMeta(text: string, relativePath: string | null = null): V2NodeMeta {
  const what = "node.json";
  const raw = parseJsonRecord(text, what, relativePath);
  requireFormat(raw, what, NODE_FORMAT, NODE_FORMAT_VERSION, relativePath);

  const {
    format,
    formatVersion,
    id,
    revision,
    title,
    aliases,
    status,
    primaryDocument,
    createdAt,
    updatedAt,
    extensions,
    ...extra
  } = raw;

  let primary: string | null = null;
  if (primaryDocument !== undefined && primaryDocument !== null) {
    if (typeof primaryDocument !== "string") {
      invalid(what, "primaryDocument 必须是字符串或 null", relativePath);
    }
    if (primaryDocument.trim() !== "") {
      if (escapesLibrary(primaryDocument)) {
        invalid(what, `primaryDocument 必须是节点内的相对路径：${primaryDocument}`, relativePath);
      }
      primary = normalizeRel(primaryDocument);
    }
  }

  const rawStatus = status === undefined || status === null ? "todo" : status;
  if (typeof rawStatus !== "string" || !LEARN_STATUSES.includes(rawStatus as FileLearnStatus)) {
    invalid(what, `status 必须是 ${LEARN_STATUSES.join(" / ")} 之一`, relativePath);
  }

  const extensionsRaw =
    extensions === undefined || extensions === null
      ? {}
      : asRecord(extensions, what, relativePath);

  return {
    format: NODE_FORMAT,
    formatVersion: NODE_FORMAT_VERSION,
    id: requireUuid(id, what, "id", relativePath),
    revision: requireInt(revision, what, "revision", relativePath),
    title: requireString(title, what, "title", relativePath),
    aliases: requireStringArray(aliases, what, "aliases", relativePath),
    status: rawStatus as FileLearnStatus,
    primaryDocument: primary,
    createdAt: requireIsoString(createdAt, what, "createdAt", relativePath),
    updatedAt: requireIsoString(updatedAt, what, "updatedAt", relativePath),
    extensions: extensionsRaw,
    ...extra,
  };
}

/* ------------------------------ relations.json ------------------------------ */

export interface V2Evidence extends Extensible {
  id: string;
  threadId: string | null;
  messageId: string | null;
  snippet: string;
  question: string;
  createdAt: string;
}

export interface V2RelationEdge extends Extensible {
  id: string;
  toNodeId: string;
  /** 线上字段名就是 `type`（TS 里用 `type` 是合法属性名） */
  type: string;
  description: string;
  toTitleSnapshot: string;
  createdAt: string;
  updatedAt: string;
  evidence: V2Evidence[];
}

export interface V2RelationsFile extends Extensible {
  format: string;
  formatVersion: number;
  nodeId: string;
  revision: number;
  outgoing: V2RelationEdge[];
}

export function emptyRelations(nodeId: string): V2RelationsFile {
  return {
    format: RELATIONS_FORMAT,
    formatVersion: RELATIONS_FORMAT_VERSION,
    nodeId,
    revision: 1,
    outgoing: [],
  };
}

function parseEvidence(value: unknown, what: string, rel?: string | null): V2Evidence {
  const raw = asRecord(value, `${what} 的 evidence 条目`, rel);
  const { id, threadId, messageId, snippet, question, createdAt, ...extra } = raw;
  return {
    id: requireUuid(id, what, "evidence.id", rel),
    threadId: optionalString(threadId, what, "evidence.threadId", rel),
    messageId: optionalString(messageId, what, "evidence.messageId", rel),
    snippet: requireString(snippet ?? "", what, "evidence.snippet", rel),
    question: requireString(question ?? "", what, "evidence.question", rel),
    createdAt: requireIsoString(createdAt, what, "evidence.createdAt", rel),
    ...extra,
  };
}

export function parseRelationsFile(text: string, relativePath: string | null = null): V2RelationsFile {
  const what = "relations.json";
  const raw = parseJsonRecord(text, what, relativePath);
  requireFormat(raw, what, RELATIONS_FORMAT, RELATIONS_FORMAT_VERSION, relativePath);

  const { format, formatVersion, nodeId, revision, outgoing, ...extra } = raw;
  const edges: V2RelationEdge[] = [];
  for (const item of requireArray(outgoing, what, "outgoing", relativePath)) {
    const edge = asRecord(item, `${what} 的 outgoing 条目`, relativePath);
    const {
      id,
      toNodeId,
      type,
      description,
      toTitleSnapshot,
      createdAt,
      updatedAt,
      evidence,
      ...edgeExtra
    } = edge;
    edges.push({
      id: requireUuid(id, what, "outgoing[].id", relativePath),
      toNodeId: requireUuid(toNodeId, what, "outgoing[].toNodeId", relativePath),
      type: requireString(type ?? "prerequisite", what, "outgoing[].type", relativePath),
      description: requireString(description ?? "", what, "outgoing[].description", relativePath),
      toTitleSnapshot: requireString(
        toTitleSnapshot ?? "",
        what,
        "outgoing[].toTitleSnapshot",
        relativePath,
      ),
      createdAt: requireIsoString(createdAt, what, "outgoing[].createdAt", relativePath),
      updatedAt: requireIsoString(updatedAt, what, "outgoing[].updatedAt", relativePath),
      evidence: requireArray(evidence, what, "outgoing[].evidence", relativePath).map((e) =>
        parseEvidence(e, what, relativePath),
      ),
      ...edgeExtra,
    });
  }

  return {
    format: RELATIONS_FORMAT,
    formatVersion: RELATIONS_FORMAT_VERSION,
    nodeId: requireUuid(nodeId, what, "nodeId", relativePath),
    revision: requireInt(revision, what, "revision", relativePath),
    outgoing: edges,
    ...extra,
  };
}

/* ------------------------------ resources.json ------------------------------ */

export interface V2ResourceEntry extends Extensible {
  id: string;
  kind: "file" | "url" | "citation";
  relativePath: string | null;
  url: string | null;
  originalName: string;
  displayName: string;
  mimeType: string;
  byteLength: number;
  sha256: string;
  description: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface V2ResourcesFile extends Extensible {
  format: string;
  formatVersion: number;
  nodeId: string;
  revision: number;
  entries: V2ResourceEntry[];
}

export function emptyResources(nodeId: string): V2ResourcesFile {
  return {
    format: RESOURCES_FORMAT,
    formatVersion: RESOURCES_FORMAT_VERSION,
    nodeId,
    revision: 1,
    entries: [],
  };
}

const RESOURCE_KINDS = ["file", "url", "citation"] as const;

function parseResourceEntry(value: unknown, what: string, rel?: string | null): V2ResourceEntry {
  const raw = asRecord(value, `${what} 的 entries 条目`, rel);
  const {
    id,
    kind,
    relativePath,
    url,
    originalName,
    displayName,
    mimeType,
    byteLength,
    sha256,
    description,
    sortOrder,
    createdAt,
    updatedAt,
    ...extra
  } = raw;
  if (typeof kind !== "string" || !RESOURCE_KINDS.includes(kind as V2ResourceEntry["kind"])) {
    invalid(what, `entries[].kind 必须是 ${RESOURCE_KINDS.join(" / ")} 之一`, rel);
  }
  return {
    id: requireUuid(id, what, "entries[].id", rel),
    kind: kind as V2ResourceEntry["kind"],
    relativePath: optionalString(relativePath, what, "entries[].relativePath", rel),
    url: optionalString(url, what, "entries[].url", rel),
    originalName: requireString(originalName ?? "", what, "entries[].originalName", rel),
    displayName: requireString(displayName ?? "", what, "entries[].displayName", rel),
    mimeType: requireString(mimeType ?? "", what, "entries[].mimeType", rel),
    byteLength: requireInt(byteLength ?? 0, what, "entries[].byteLength", rel),
    sha256: requireString(sha256 ?? "", what, "entries[].sha256", rel),
    description: requireString(description ?? "", what, "entries[].description", rel),
    sortOrder: requireInt(sortOrder ?? 0, what, "entries[].sortOrder", rel, -1000000),
    createdAt: requireIsoString(createdAt, what, "entries[].createdAt", rel),
    updatedAt: requireIsoString(updatedAt, what, "entries[].updatedAt", rel),
    ...extra,
  };
}

export function parseResourcesFile(text: string, relativePath: string | null = null): V2ResourcesFile {
  const what = "resources.json";
  const raw = parseJsonRecord(text, what, relativePath);
  requireFormat(raw, what, RESOURCES_FORMAT, RESOURCES_FORMAT_VERSION, relativePath);
  const { format, formatVersion, nodeId, revision, entries, ...extra } = raw;
  return {
    format: RESOURCES_FORMAT,
    formatVersion: RESOURCES_FORMAT_VERSION,
    nodeId: requireUuid(nodeId, what, "nodeId", relativePath),
    revision: requireInt(revision, what, "revision", relativePath),
    entries: requireArray(entries, what, "entries", relativePath).map((e) =>
      parseResourceEntry(e, what, relativePath),
    ),
    ...extra,
  };
}

/* ------------------------------ bookmarks.json ------------------------------ */

export interface V2BookmarkEntry extends Extensible {
  id: string;
  threadId: string | null;
  messageId: string | null;
  scrollOffset: number;
  question: string;
  returnNodeId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface V2BookmarksFile extends Extensible {
  format: string;
  formatVersion: number;
  nodeId: string;
  revision: number;
  bookmarks: V2BookmarkEntry[];
}

export function emptyBookmarks(nodeId: string): V2BookmarksFile {
  return {
    format: BOOKMARKS_FORMAT,
    formatVersion: BOOKMARKS_FORMAT_VERSION,
    nodeId,
    revision: 1,
    bookmarks: [],
  };
}

function parseBookmarkEntry(value: unknown, what: string, rel?: string | null): V2BookmarkEntry {
  const raw = asRecord(value, `${what} 的 bookmarks 条目`, rel);
  const {
    id,
    threadId,
    messageId,
    scrollOffset,
    question,
    returnNodeId,
    createdAt,
    updatedAt,
    ...extra
  } = raw;
  const offset = scrollOffset === undefined || scrollOffset === null ? 0 : scrollOffset;
  if (typeof offset !== "number" || !Number.isFinite(offset)) {
    invalid(what, "bookmarks[].scrollOffset 必须是数字", rel);
  }
  return {
    id: requireUuid(id, what, "bookmarks[].id", rel),
    threadId: optionalString(threadId, what, "bookmarks[].threadId", rel),
    messageId: optionalString(messageId, what, "bookmarks[].messageId", rel),
    scrollOffset: offset,
    question: requireString(question ?? "", what, "bookmarks[].question", rel),
    returnNodeId: optionalString(returnNodeId, what, "bookmarks[].returnNodeId", rel),
    createdAt: requireIsoString(createdAt, what, "bookmarks[].createdAt", rel),
    updatedAt: requireIsoString(updatedAt, what, "bookmarks[].updatedAt", rel),
    ...extra,
  };
}

export function parseBookmarksFile(text: string, relativePath: string | null = null): V2BookmarksFile {
  const what = "bookmarks.json";
  const raw = parseJsonRecord(text, what, relativePath);
  requireFormat(raw, what, BOOKMARKS_FORMAT, BOOKMARKS_FORMAT_VERSION, relativePath);
  const { format, formatVersion, nodeId, revision, bookmarks, ...extra } = raw;
  return {
    format: BOOKMARKS_FORMAT,
    formatVersion: BOOKMARKS_FORMAT_VERSION,
    nodeId: requireUuid(nodeId, what, "nodeId", relativePath),
    revision: requireInt(revision, what, "revision", relativePath),
    bookmarks: requireArray(bookmarks, what, "bookmarks", relativePath).map((b) =>
      parseBookmarkEntry(b, what, relativePath),
    ),
    ...extra,
  };
}

/* -------------------------------- goals.json -------------------------------- */

export interface V2GoalEntry extends Extensible {
  id: string;
  title: string;
  rootNodeId: string;
  createdAt: string;
}

export interface V2GoalsFile extends Extensible {
  format: string;
  formatVersion: number;
  libraryId: string;
  revision: number;
  goals: V2GoalEntry[];
}

export function emptyGoals(libraryId: string): V2GoalsFile {
  return {
    format: GOALS_FORMAT,
    formatVersion: GOALS_FORMAT_VERSION,
    libraryId,
    revision: 1,
    goals: [],
  };
}

export function parseGoalsFile(text: string, relativePath: string | null = null): V2GoalsFile {
  const what = "goals.json";
  const raw = parseJsonRecord(text, what, relativePath);
  requireFormat(raw, what, GOALS_FORMAT, GOALS_FORMAT_VERSION, relativePath);
  const { format, formatVersion, libraryId, revision, goals, ...extra } = raw;
  const entries: V2GoalEntry[] = [];
  for (const item of requireArray(goals, what, "goals", relativePath)) {
    const goal = asRecord(item, `${what} 的 goals 条目`, relativePath);
    const { id, title, rootNodeId, createdAt, ...goalExtra } = goal;
    entries.push({
      id: requireUuid(id, what, "goals[].id", relativePath),
      title: requireString(title ?? "", what, "goals[].title", relativePath),
      rootNodeId: requireUuid(rootNodeId, what, "goals[].rootNodeId", relativePath),
      createdAt: requireIsoString(createdAt, what, "goals[].createdAt", relativePath),
      ...goalExtra,
    });
  }
  return {
    format: GOALS_FORMAT,
    formatVersion: GOALS_FORMAT_VERSION,
    libraryId: requireUuid(libraryId, what, "libraryId", relativePath),
    revision: requireInt(revision, what, "revision", relativePath),
    goals: entries,
    ...extra,
  };
}

/* -------------------------------- thread.json -------------------------------- */

export interface V2ThreadFile extends Extensible {
  format: string;
  formatVersion: number;
  id: string;
  nodeId: string;
  revision: number;
  title: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
}

export function newThreadFile(input: {
  id: string;
  nodeId: string;
  title: string;
  now: string;
  summary?: string;
}): V2ThreadFile {
  return {
    format: THREAD_FORMAT,
    formatVersion: THREAD_FORMAT_VERSION,
    id: input.id,
    nodeId: input.nodeId,
    revision: 1,
    title: input.title,
    summary: input.summary ?? "",
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function parseThreadFile(text: string, relativePath: string | null = null): V2ThreadFile {
  const what = "thread.json";
  const raw = parseJsonRecord(text, what, relativePath);
  requireFormat(raw, what, THREAD_FORMAT, THREAD_FORMAT_VERSION, relativePath);
  const { format, formatVersion, id, nodeId, revision, title, summary, createdAt, updatedAt, ...extra } =
    raw;
  return {
    format: THREAD_FORMAT,
    formatVersion: THREAD_FORMAT_VERSION,
    id: requireUuid(id, what, "id", relativePath),
    nodeId: requireUuid(nodeId, what, "nodeId", relativePath),
    revision: requireInt(revision, what, "revision", relativePath),
    title: requireString(title ?? "", what, "title", relativePath),
    summary: requireString(summary ?? "", what, "summary", relativePath),
    createdAt: requireIsoString(createdAt, what, "createdAt", relativePath),
    updatedAt: requireIsoString(updatedAt, what, "updatedAt", relativePath),
    ...extra,
  };
}

/* ------------------------------- message 文件 ------------------------------- */

export interface V2MessageFile extends Extensible {
  format: string;
  formatVersion: number;
  id: string;
  threadId: string;
  sequence: number;
  role: MessageFileRole;
  content: string;
  status: MessageFileStatus;
  finishReason: string | null;
  requestId: string | null;
  usage: unknown;
  model: string | null;
  /** 过程记录：思考与工具调用，按发生顺序；空数组表示没有 */
  steps: ProcessStep[];
  /** 上一版留下的纯文本思考过程，只用于读旧消息 */
  reasoning: string | null;
  createdAt: string;
  updatedAt: string;
}

export function newMessageFile(input: {
  id: string;
  threadId: string;
  sequence: number;
  role: MessageFileRole;
  content: string;
  status?: MessageFileStatus;
  now: string;
  finishReason?: string | null;
  requestId?: string | null;
  usage?: unknown;
  model?: string | null;
  steps?: ProcessStep[];
  reasoning?: string | null;
}): V2MessageFile {
  return {
    format: MESSAGE_FORMAT,
    formatVersion: MESSAGE_FORMAT_VERSION,
    id: input.id,
    threadId: input.threadId,
    sequence: input.sequence,
    role: input.role,
    content: input.content,
    status: input.status ?? "complete",
    finishReason: input.finishReason ?? null,
    requestId: input.requestId ?? null,
    usage: input.usage ?? null,
    model: input.model ?? null,
    steps: input.steps ?? [],
    reasoning: input.reasoning ?? null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function parseMessageFile(text: string, relativePath: string | null = null): V2MessageFile {
  const what = "消息文件";
  const raw = parseJsonRecord(text, what, relativePath);
  requireFormat(raw, what, MESSAGE_FORMAT, MESSAGE_FORMAT_VERSION, relativePath);
  const {
    format,
    formatVersion,
    id,
    threadId,
    sequence,
    role,
    content,
    status,
    finishReason,
    requestId,
    usage,
    model,
    steps,
    reasoning,
    createdAt,
    updatedAt,
    ...extra
  } = raw;

  if (typeof role !== "string" || !MESSAGE_ROLES.includes(role as MessageFileRole)) {
    invalid(what, `role 必须是 ${MESSAGE_ROLES.join(" / ")} 之一`, relativePath);
  }
  if (
    typeof status !== "string" ||
    !MESSAGE_FILE_STATUSES.includes(status as MessageFileStatus)
  ) {
    invalid(what, `status 必须是 ${MESSAGE_FILE_STATUSES.join(" / ")} 之一`, relativePath);
  }

  return {
    format: MESSAGE_FORMAT,
    formatVersion: MESSAGE_FORMAT_VERSION,
    id: requireUuid(id, what, "id", relativePath),
    threadId: requireUuid(threadId, what, "threadId", relativePath),
    sequence: requireInt(sequence, what, "sequence", relativePath, 1),
    role: role as MessageFileRole,
    content: requireString(content ?? "", what, "content", relativePath),
    status: status as MessageFileStatus,
    finishReason: optionalString(finishReason, what, "finishReason", relativePath),
    requestId: optionalString(requestId, what, "requestId", relativePath),
    // `usage` 是自由 JSON（用量原文），null 表示没有
    usage: usage === undefined ? null : usage,
    model: optionalString(model, what, "model", relativePath),
    /*
     * `steps` 是结构化的过程记录。这里只做「必须是数组」的检查，不逐字段校验：
     * 它的形状由 aiProvider 的事件契约决定，而演示后端的职责是原样存取——
     * 在这里再校验一遍等于把同一份契约维护两遍，加一个步骤类型就要改三处。
     */
    steps: Array.isArray(steps) ? (steps as ProcessStep[]) : [],
    // 老消息文件没有这个键：缺失即「没有思考过程」，不是错误
    reasoning: optionalString(reasoning, what, "reasoning", relativePath),
    createdAt: requireIsoString(createdAt, what, "createdAt", relativePath),
    updatedAt: requireIsoString(updatedAt, what, "updatedAt", relativePath),
    ...extra,
  };
}

/* --------------------------------- 序列化 --------------------------------- */

/** 统一的落盘文本：两空格缩进 + 结尾换行，便于人工阅读与 diff */
export function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** 毫秒时间戳 -> ISO 8601 UTC 字符串（与 Rust `iso_from_ms` 一致） */
export function isoFromMs(ms: number): string {
  const value = Number.isFinite(ms) ? ms : 0;
  return new Date(value).toISOString();
}

/** ISO 字符串 -> 毫秒；不可解析时报 `metadata_invalid` */
export function parseIsoMs(text: string, relativePath: string | null = null): number {
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) invalid("时间", `无法解析的 ISO 时间：${text}`, relativePath);
  return ms;
}

/** 空 extensions（Rust `empty_extensions()` 的对应物） */
export function emptyExtensions(): Record<string, unknown> {
  return {};
}

/** 安全化文件夹名：去掉 Windows 非法字符与首尾空白（Rust `sanitize_folder_name` 的对应物） */
export function sanitizeFolderName(title: string, fallback = "未命名"): string {
  const cleaned = String(title ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    .trim();
  if (cleaned === "") return fallback;
  // Windows 保留名：直接加后缀，避免创建出打不开的目录
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) return `${cleaned}_`;
  return cleaned.slice(0, 80);
}

/** 在已有名字集合里找一个不冲突的名字：`名字`、`名字 2`、`名字 3`… */
export function uniqueNameIn(base: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  for (let index = 2; index < 10000; index += 1) {
    const candidate = `${base} ${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
}

/** 把 RepositoryError 形式的主文档校验错误转成元数据错误（解析路径上使用） */
export function guardPrimaryDocument(rel: string, relativePath?: string | null): string {
  try {
    return requireSafeRelative(rel, "主文档路径");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    invalid("node.json", message, relativePath);
  }
}
