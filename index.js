import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path, { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
//#region src/vendor/upstream/data/errors.ts
var RepositoryError = class extends Error {
	code;
	detail;
	constructor(code, message, detail) {
		super(message);
		this.name = "RepositoryError";
		this.code = code;
		this.detail = detail;
	}
	/** 修订号过期：需要重新载入知识图再重试 */
	get isRevisionConflict() {
		return this.code === "revision_conflict";
	}
	/** 只读知识库：所有写入口都应当被禁用，而不是等报错 */
	get isReadOnly() {
		return this.code === "read_only";
	}
	/** 磁盘上那份文件已经被别人改过：默认绝不覆盖，让用户先看清差异 */
	get isExternalChangeConflict() {
		return this.code === "external_change_conflict";
	}
};
/**
* 磁盘文件被外部改动（修订号或哈希不符）。
*
* `detail` 必须带上相对路径、期望/实际修订号与哈希，界面才能给出
* 「重新载入 / 查看差异 / 覆盖」三个明确选项，而不是只说一句「保存失败」。
*/
function externalChangeConflict(input) {
	return new RepositoryError("external_change_conflict", input.message ?? `磁盘上的文件已被外部修改：${input.relativePath}`, {
		relativePath: input.relativePath,
		expectedRevision: input.expectedRevision,
		actualRevision: input.actualRevision,
		expectedHash: input.expectedHash ?? null,
		actualHash: input.actualHash
	});
}
//#endregion
//#region src/vendor/upstream/data/types.ts
function normalizeTitle(raw) {
	return raw.trim().replace(/\s+/g, " ");
}
/** 搜索归一化：保留中文、英文、缩写与数学符号，只做大小写与空白折叠，避免过度规范化造成错误匹配 */
function searchKey(raw) {
	return normalizeTitle(raw).toLowerCase();
}
//#endregion
//#region src/vendor/upstream/data/engine.ts
function nodeMap(ws) {
	return new Map(ws.nodes.map((n) => [n.id, n]));
}
function nodesByIds(ws, ids) {
	const m = nodeMap(ws);
	const out = [];
	for (const id of ids) {
		const n = m.get(id);
		if (n) out.push(n);
	}
	return out;
}
/** 某个节点的前置知识（入边），即「要理解它，得先理解谁」 */
function prerequisitesOf(ws, nodeId) {
	return nodesByIds(ws, ws.edges.filter((e) => e.fromId === nodeId).map((e) => e.toId));
}
/** 某个节点被谁依赖（出边），即「理解它之后，可以回去搞懂谁」 */
function dependentsOf(ws, nodeId) {
	return nodesByIds(ws, ws.edges.filter((e) => e.toId === nodeId).map((e) => e.fromId));
}
/**
* 搜索已有知识点。保留中文、英文、缩写与数学符号，不做激进的规范化，
* 避免把「相关性」和「互相关」这类不同概念错误地当成同一个。
*
* 便携知识库的图快照里没有正文，因此搜索只覆盖标题与别名；
* 正文检索属于后续的 FTS5 索引（本轮不做）。
*/
function searchNodes(ws, query, limit = 12) {
	const q = searchKey(query);
	if (!q) return [];
	const scored = [];
	for (const n of ws.nodes) {
		const title = searchKey(n.title);
		if (title === q) {
			scored.push({
				n,
				score: 0
			});
			continue;
		}
		if (n.aliases.some((a) => searchKey(a) === q)) {
			scored.push({
				n,
				score: 1
			});
			continue;
		}
		if (title.startsWith(q)) {
			scored.push({
				n,
				score: 2
			});
			continue;
		}
		if (title.includes(q)) {
			scored.push({
				n,
				score: 3
			});
			continue;
		}
		if (n.aliases.some((a) => searchKey(a).includes(q))) scored.push({
			n,
			score: 4
		});
	}
	scored.sort((a, b) => a.score - b.score || a.n.title.length - b.n.title.length);
	return scored.slice(0, limit).map((s) => s.n);
}
/** 精确命中已有节点（标题或别名完全一致）——这是「复用」而不是「新建」的判据 */
function findExactMatch(ws, title) {
	const q = searchKey(title);
	if (!q) return void 0;
	return ws.nodes.find((n) => searchKey(n.title) === q || n.aliases.some((a) => searchKey(a) === q));
}
/** 输入时的相似候选提示（弱匹配，交由使用者判断是否同一个知识点） */
function findSimilar(ws, title, limit = 5) {
	const q = searchKey(title);
	if (q.length < 2) return [];
	return searchNodes(ws, title, limit * 2).filter((n) => searchKey(n.title) !== q).slice(0, limit);
}
/**
* 判断新增边 from → to 是否会造成循环：沿 to 出发能否走回 from。
* 返回造成循环的路径（不含新增边的起点），无循环返回 null。
*
* 后端会拒绝成环的写入；这里先算一遍是为了让界面在用户点击之前就能提示。
*/
function findCycleIfLinked(ws, fromId, toId) {
	if (fromId === toId) return [fromId, toId];
	const out = /* @__PURE__ */ new Map();
	for (const e of ws.edges) {
		const list = out.get(e.fromId);
		if (list) list.push(e.toId);
		else out.set(e.fromId, [e.toId]);
	}
	const prev = /* @__PURE__ */ new Map();
	const queue = [toId];
	const seen = /* @__PURE__ */ new Set([toId]);
	while (queue.length > 0) {
		const cur = queue.shift();
		if (cur === fromId) {
			const path = [fromId];
			let step = fromId;
			while (step !== toId) {
				step = prev.get(step);
				path.push(step);
			}
			return path.reverse();
		}
		for (const next of out.get(cur) ?? []) if (!seen.has(next)) {
			seen.add(next);
			prev.set(next, cur);
			queue.push(next);
		}
	}
	return null;
}
/** 节点元数据命名空间目录：`.meta/knowledgenet` */
const META_NS_DIR = `.meta/knowledgenet`;
const NODE_FILE = "node.json";
const LIBRARY_FILE = "library.json";
const RELATIONS_FILE = "relations.json";
const RESOURCES_FILE = "resources.json";
/** 笔记冲突副本目录（节点内，跟着节点一起走） */
const CONFLICTS_DIR = "conflicts";
/** 知识库根部（不是节点）的元数据目录 */
const ROOT_META_DIR = ".knowledgenet";
/** 节点标记文件的精确相对路径（相对于节点目录） */
const NODE_MARKER = `${META_NS_DIR}/${NODE_FILE}`;
/** 把任意路径写法归一化成「正斜杠、无首尾斜杠、无 `.` 段」的相对路径 */
function normalizeRel(rel) {
	const parts = [];
	for (const raw of String(rel ?? "").replace(/\\/g, "/").split("/")) {
		if (raw === "" || raw === ".") continue;
		parts.push(raw);
	}
	return parts.join("/");
}
/** 拼接相对路径；全部为空时返回 `""`（知识库根） */
function joinRel(...parts) {
	return normalizeRel(parts.filter((p) => typeof p === "string" && p.length > 0).join("/"));
}
/** 父目录；根目录的父目录仍然是根目录 */
function parentRel(rel) {
	const norm = normalizeRel(rel);
	const index = norm.lastIndexOf("/");
	return index < 0 ? "" : norm.slice(0, index);
}
/** 最后一段名字；根目录返回空串 */
function baseName(rel) {
	const norm = normalizeRel(rel);
	const index = norm.lastIndexOf("/");
	return index < 0 ? norm : norm.slice(index + 1);
}
/** 路径是否可能逃出知识库根目录（绝对路径、盘符、`..` 段） */
function escapesLibrary(rel) {
	const raw = String(rel ?? "").replace(/\\/g, "/");
	if (raw.startsWith("/")) return true;
	if (/^[a-zA-Z]:/.test(raw)) return true;
	return raw.split("/").some((part) => part === "..");
}
function nodeMetaFile(nodeRel) {
	return joinRel(nodeRel, NODE_MARKER);
}
function relationsFile(nodeRel) {
	return joinRel(nodeRel, META_NS_DIR, RELATIONS_FILE);
}
function resourcesFile(nodeRel) {
	return joinRel(nodeRel, META_NS_DIR, RESOURCES_FILE);
}
function conflictsDir(nodeRel) {
	return joinRel(nodeRel, META_NS_DIR, CONFLICTS_DIR);
}
/** 去掉扩展名的文件名（`note.md` -> `note`） */
function stemOf(name) {
	const base = baseName(name);
	const index = base.lastIndexOf(".");
	return index <= 0 ? base : base.slice(0, index);
}
/** 扩展名（含点；没有扩展名时返回空串） */
function extNameOf(name) {
	const base = baseName(name);
	const index = base.lastIndexOf(".");
	return index <= 0 ? "" : base.slice(index);
}
//#endregion
//#region src/vendor/upstream/data/v2/schema.ts
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
const NODE_FORMAT = "knowledgenet-node";
const RELATIONS_FORMAT = "knowledgenet-relations";
const RESOURCES_FORMAT = "knowledgenet-resources";
/**
* 笔记记账文件（与 Rust `docs/v2-deviations.md` D5 同构）。
*
* 文档修订号描述的是**正文文件**的修订，而 `node.json` 的 `revision` 描述的是
* **节点元数据**的修订；用一个数字表示两件事，会出现「改了标题导致笔记保存报冲突」
* 这种莫名其妙的交互。因此正文指纹单独记在
* `.meta/knowledgenet/notes-index.json`，坏了直接重建（它是可推导的缓存）。
*/
const NOTES_INDEX_FORMAT = "knowledgenet-notes-index";
function emptyNotesIndex(nodeId) {
	return {
		format: NOTES_INDEX_FORMAT,
		formatVersion: 1,
		nodeId,
		entries: []
	};
}
function parseNotesIndexFile(text, relativePath = null) {
	const what = "notes-index.json";
	const raw = parseJsonRecord(text, what, relativePath);
	requireFormat(raw, what, NOTES_INDEX_FORMAT, 1, relativePath);
	const { format, formatVersion, nodeId, entries, ...extra } = raw;
	const parsed = [];
	for (const item of requireArray(entries, what, "entries", relativePath)) {
		const { relativePath: docPath, sha256, byteLength, revision, modifiedAt, ...entryExtra } = asRecord(item, `${what} 的 entries 条目`, relativePath);
		parsed.push({
			relativePath: requireString(docPath, what, "entries[].relativePath", relativePath),
			sha256: requireString(sha256 ?? "", what, "entries[].sha256", relativePath),
			byteLength: requireInt(byteLength ?? 0, what, "entries[].byteLength", relativePath),
			revision: requireInt(revision ?? 0, what, "entries[].revision", relativePath),
			modifiedAt: typeof modifiedAt === "number" && Number.isFinite(modifiedAt) ? modifiedAt : 0,
			...entryExtra
		});
	}
	return {
		format: NOTES_INDEX_FORMAT,
		formatVersion: 1,
		nodeId: requireUuid(nodeId, what, "nodeId", relativePath),
		entries: parsed,
		...extra
	};
}
const LEARN_STATUSES = [
	"todo",
	"learning",
	"done"
];
/**
* 元数据错误。
*
* `parsePosition` 只在 JSON 语法错误时有值（来自解析器的位置信息），
* 界面据此可以直接把光标指到出错的那一列；字段类型错误没有位置可言。
*/
var MetadataError = class extends Error {
	code;
	what;
	relativePath;
	parsePosition;
	constructor(code, message, options) {
		super(message);
		this.name = "MetadataError";
		this.code = code;
		this.what = options.what;
		this.relativePath = options.relativePath ?? null;
		this.parsePosition = options.parsePosition ?? null;
	}
};
function invalid(what, detail, relativePath) {
	throw new MetadataError("metadata_invalid", `${what}：${detail}`, {
		what,
		relativePath: relativePath ?? null
	});
}
function unsupported(what, detail, relativePath) {
	throw new MetadataError("metadata_unsupported", `${what}：${detail}`, {
		what,
		relativePath: relativePath ?? null
	});
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** ID 形状检查（UUIDv7 也是 UUID）。只做形状判断，不解释内容。 */
function isUuidLike(value) {
	return typeof value === "string" && UUID_RE.test(value);
}
function asRecord(value, what, rel) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(what, "顶层必须是一个 JSON 对象", rel);
	return value;
}
/** 解析 JSON 文本；语法错误报 `metadata_invalid` 并带上解析位置 */
function parseJsonRecord(text, what, relativePath) {
	let raw;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const position = /position (\d+)/i.exec(message)?.[1] ?? null;
		throw new MetadataError("metadata_invalid", `${what}不是合法的 JSON：${message}`, {
			what,
			relativePath: relativePath ?? null,
			parsePosition: position
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
function requireFormat(raw, what, expectedFormat, expectedVersion, rel) {
	if (raw.format !== expectedFormat) unsupported(what, `format 应为 ${expectedFormat}，实际是 ${JSON.stringify(raw.format ?? null)}`, rel);
	const version = raw.formatVersion;
	if (typeof version !== "number" || !Number.isInteger(version)) invalid(what, "formatVersion 必须是整数", rel);
	if (version !== expectedVersion) unsupported(what, `formatVersion 应为 ${expectedVersion}，实际是 ${version}`, rel);
}
function requireString(value, what, field, rel) {
	if (typeof value !== "string") invalid(what, `${field} 必须是字符串`, rel);
	return value;
}
function requireIsoString(value, what, field, rel) {
	const text = requireString(value, what, field, rel);
	if (text.trim() === "") invalid(what, `${field} 不能为空`, rel);
	return text;
}
function requireInt(value, what, field, rel, min = 0) {
	if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) invalid(what, `${field} 必须是整数`, rel);
	if (value < min) invalid(what, `${field} 不能小于 ${min}`, rel);
	return value;
}
function requireUuid(value, what, field, rel) {
	if (!isUuidLike(value)) invalid(what, `${field} 必须是 UUID`, rel);
	return value;
}
function requireStringArray(value, what, field, rel) {
	if (value === void 0 || value === null) return [];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) invalid(what, `${field} 必须是字符串数组`, rel);
	return value;
}
function requireArray(value, what, field, rel) {
	if (value === void 0 || value === null) return [];
	if (!Array.isArray(value)) invalid(what, `${field} 必须是数组`, rel);
	return value;
}
function optionalString(value, what, field, rel) {
	if (value === void 0 || value === null) return null;
	if (typeof value !== "string") invalid(what, `${field} 必须是字符串或 null`, rel);
	return value;
}
/** 节点主文档必须是节点目录内的规范化相对路径 */
function validatePrimaryDocument(rel) {
	if (typeof rel !== "string" || rel.trim() === "") throw new RepositoryError("invalid_input", "主文档路径不能为空");
	if (escapesLibrary(rel)) throw new RepositoryError("node_outside_library", `主文档路径必须是节点目录内的相对路径：${rel}`, { relativePath: rel });
	return normalizeRel(rel);
}
function newNodeMeta(input) {
	return {
		format: NODE_FORMAT,
		formatVersion: 1,
		id: input.id,
		revision: 1,
		title: input.title,
		aliases: input.aliases ?? [],
		status: input.status ?? "todo",
		primaryDocument: input.primaryDocument === void 0 || input.primaryDocument === null ? null : validatePrimaryDocument(input.primaryDocument),
		createdAt: input.now,
		updatedAt: input.now,
		extensions: input.extensions ?? {}
	};
}
function parseNodeMeta(text, relativePath = null) {
	const what = "node.json";
	const raw = parseJsonRecord(text, what, relativePath);
	requireFormat(raw, what, NODE_FORMAT, 1, relativePath);
	const { format, formatVersion, id, revision, title, aliases, status, primaryDocument, createdAt, updatedAt, extensions, ...extra } = raw;
	let primary = null;
	if (primaryDocument !== void 0 && primaryDocument !== null) {
		if (typeof primaryDocument !== "string") invalid(what, "primaryDocument 必须是字符串或 null", relativePath);
		if (primaryDocument.trim() !== "") {
			if (escapesLibrary(primaryDocument)) invalid(what, `primaryDocument 必须是节点内的相对路径：${primaryDocument}`, relativePath);
			primary = normalizeRel(primaryDocument);
		}
	}
	const rawStatus = status === void 0 || status === null ? "todo" : status;
	if (typeof rawStatus !== "string" || !LEARN_STATUSES.includes(rawStatus)) invalid(what, `status 必须是 ${LEARN_STATUSES.join(" / ")} 之一`, relativePath);
	const extensionsRaw = extensions === void 0 || extensions === null ? {} : asRecord(extensions, what, relativePath);
	return {
		format: NODE_FORMAT,
		formatVersion: 1,
		id: requireUuid(id, what, "id", relativePath),
		revision: requireInt(revision, what, "revision", relativePath),
		title: requireString(title, what, "title", relativePath),
		aliases: requireStringArray(aliases, what, "aliases", relativePath),
		status: rawStatus,
		primaryDocument: primary,
		createdAt: requireIsoString(createdAt, what, "createdAt", relativePath),
		updatedAt: requireIsoString(updatedAt, what, "updatedAt", relativePath),
		extensions: extensionsRaw,
		...extra
	};
}
function emptyRelations(nodeId) {
	return {
		format: RELATIONS_FORMAT,
		formatVersion: 1,
		nodeId,
		revision: 1,
		outgoing: []
	};
}
function parseEvidence(value, what, rel) {
	const { id, threadId, messageId, snippet, question, createdAt, ...extra } = asRecord(value, `${what} 的 evidence 条目`, rel);
	return {
		id: requireUuid(id, what, "evidence.id", rel),
		threadId: optionalString(threadId, what, "evidence.threadId", rel),
		messageId: optionalString(messageId, what, "evidence.messageId", rel),
		snippet: requireString(snippet ?? "", what, "evidence.snippet", rel),
		question: requireString(question ?? "", what, "evidence.question", rel),
		createdAt: requireIsoString(createdAt, what, "evidence.createdAt", rel),
		...extra
	};
}
function parseRelationsFile(text, relativePath = null) {
	const what = "relations.json";
	const raw = parseJsonRecord(text, what, relativePath);
	requireFormat(raw, what, RELATIONS_FORMAT, 1, relativePath);
	const { format, formatVersion, nodeId, revision, outgoing, ...extra } = raw;
	const edges = [];
	for (const item of requireArray(outgoing, what, "outgoing", relativePath)) {
		const { id, toNodeId, type, description, toTitleSnapshot, createdAt, updatedAt, evidence, ...edgeExtra } = asRecord(item, `${what} 的 outgoing 条目`, relativePath);
		edges.push({
			id: requireUuid(id, what, "outgoing[].id", relativePath),
			toNodeId: requireUuid(toNodeId, what, "outgoing[].toNodeId", relativePath),
			type: requireString(type ?? "prerequisite", what, "outgoing[].type", relativePath),
			description: requireString(description ?? "", what, "outgoing[].description", relativePath),
			toTitleSnapshot: requireString(toTitleSnapshot ?? "", what, "outgoing[].toTitleSnapshot", relativePath),
			createdAt: requireIsoString(createdAt, what, "outgoing[].createdAt", relativePath),
			updatedAt: requireIsoString(updatedAt, what, "outgoing[].updatedAt", relativePath),
			evidence: requireArray(evidence, what, "outgoing[].evidence", relativePath).map((e) => parseEvidence(e, what, relativePath)),
			...edgeExtra
		});
	}
	return {
		format: RELATIONS_FORMAT,
		formatVersion: 1,
		nodeId: requireUuid(nodeId, what, "nodeId", relativePath),
		revision: requireInt(revision, what, "revision", relativePath),
		outgoing: edges,
		...extra
	};
}
function emptyResources(nodeId) {
	return {
		format: RESOURCES_FORMAT,
		formatVersion: 1,
		nodeId,
		revision: 1,
		entries: []
	};
}
const RESOURCE_KINDS = [
	"file",
	"url",
	"citation"
];
function parseResourceEntry(value, what, rel) {
	const { id, kind, relativePath, url, originalName, displayName, mimeType, byteLength, sha256, description, sortOrder, createdAt, updatedAt, ...extra } = asRecord(value, `${what} 的 entries 条目`, rel);
	if (typeof kind !== "string" || !RESOURCE_KINDS.includes(kind)) invalid(what, `entries[].kind 必须是 ${RESOURCE_KINDS.join(" / ")} 之一`, rel);
	return {
		id: requireUuid(id, what, "entries[].id", rel),
		kind,
		relativePath: optionalString(relativePath, what, "entries[].relativePath", rel),
		url: optionalString(url, what, "entries[].url", rel),
		originalName: requireString(originalName ?? "", what, "entries[].originalName", rel),
		displayName: requireString(displayName ?? "", what, "entries[].displayName", rel),
		mimeType: requireString(mimeType ?? "", what, "entries[].mimeType", rel),
		byteLength: requireInt(byteLength ?? 0, what, "entries[].byteLength", rel),
		sha256: requireString(sha256 ?? "", what, "entries[].sha256", rel),
		description: requireString(description ?? "", what, "entries[].description", rel),
		sortOrder: requireInt(sortOrder ?? 0, what, "entries[].sortOrder", rel, -1e6),
		createdAt: requireIsoString(createdAt, what, "entries[].createdAt", rel),
		updatedAt: requireIsoString(updatedAt, what, "entries[].updatedAt", rel),
		...extra
	};
}
function parseResourcesFile(text, relativePath = null) {
	const what = "resources.json";
	const raw = parseJsonRecord(text, what, relativePath);
	requireFormat(raw, what, RESOURCES_FORMAT, 1, relativePath);
	const { format, formatVersion, nodeId, revision, entries, ...extra } = raw;
	return {
		format: RESOURCES_FORMAT,
		formatVersion: 1,
		nodeId: requireUuid(nodeId, what, "nodeId", relativePath),
		revision: requireInt(revision, what, "revision", relativePath),
		entries: requireArray(entries, what, "entries", relativePath).map((e) => parseResourceEntry(e, what, relativePath)),
		...extra
	};
}
/** 统一的落盘文本：两空格缩进 + 结尾换行，便于人工阅读与 diff */
function serializeJson(value) {
	return `${JSON.stringify(value, null, 2)}\n`;
}
/** 毫秒时间戳 -> ISO 8601 UTC 字符串（与 Rust `iso_from_ms` 一致） */
function isoFromMs(ms) {
	return new Date(Number.isFinite(ms) ? ms : 0).toISOString();
}
/** ISO 字符串 -> 毫秒；不可解析时报 `metadata_invalid` */
function parseIsoMs(text, relativePath = null) {
	const ms = Date.parse(text);
	if (!Number.isFinite(ms)) invalid("时间", `无法解析的 ISO 时间：${text}`, relativePath);
	return ms;
}
/** 安全化文件夹名：去掉 Windows 非法字符与首尾空白（Rust `sanitize_folder_name` 的对应物） */
function sanitizeFolderName(title, fallback = "未命名") {
	const cleaned = String(title ?? "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").replace(/^[.\s]+/, "").replace(/[.\s]+$/, "").trim();
	if (cleaned === "") return fallback;
	if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) return `${cleaned}_`;
	return cleaned.slice(0, 80);
}
/** 在已有名字集合里找一个不冲突的名字：`名字`、`名字 2`、`名字 3`… */
function uniqueNameIn(base, existing) {
	const taken = new Set(existing);
	if (!taken.has(base)) return base;
	for (let index = 2; index < 1e4; index += 1) {
		const candidate = `${base} ${index}`;
		if (!taken.has(candidate)) return candidate;
	}
	return `${base} ${Date.now()}`;
}
//#endregion
//#region src/vendor/upstream/data/v2/hash.ts
/**
* 纯 TS 的 SHA-256 与字节长度
*
* 为什么不用 `node:crypto` 或 WebCrypto：
* - v2 文件模型要能在浏览器演示模式、Node 测试与 Tauri WebView 里跑同一份代码；
* - WebCrypto 的 `subtle.digest` 是异步的，而指纹校验散布在同步的校验路径里；
* - 这里只需要「内容变了指纹就变」的稳定摘要，自己实现 60 行反而最省依赖。
*
* 与 Rust 端 `atomic::sha256_of` 的十六进制小写输出一致。
*/
const K = new Uint32Array([
	1116352408,
	1899447441,
	3049323471,
	3921009573,
	961987163,
	1508970993,
	2453635748,
	2870763221,
	3624381080,
	310598401,
	607225278,
	1426881987,
	1925078388,
	2162078206,
	2614888103,
	3248222580,
	3835390401,
	4022224774,
	264347078,
	604807628,
	770255983,
	1249150122,
	1555081692,
	1996064986,
	2554220882,
	2821834349,
	2952996808,
	3210313671,
	3336571891,
	3584528711,
	113926993,
	338241895,
	666307205,
	773529912,
	1294757372,
	1396182291,
	1695183700,
	1986661051,
	2177026350,
	2456956037,
	2730485921,
	2820302411,
	3259730800,
	3345764771,
	3516065817,
	3600352804,
	4094571909,
	275423344,
	430227734,
	506948616,
	659060556,
	883997877,
	958139571,
	1322822218,
	1537002063,
	1747873779,
	1955562222,
	2024104815,
	2227730452,
	2361852424,
	2428436474,
	2756734187,
	3204031479,
	3329325298
]);
function rotr(value, bits) {
	return (value >>> bits | value << 32 - bits) >>> 0;
}
/** UTF-8 字节；优先用 TextEncoder（浏览器与 Node 都有），否则手工编码 */
function utf8Bytes$1(text) {
	if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text);
	const out = [];
	for (let i = 0; i < text.length; i += 1) {
		let code = text.charCodeAt(i);
		if (code >= 55296 && code <= 56319 && i + 1 < text.length) {
			const next = text.charCodeAt(i + 1);
			if (next >= 56320 && next <= 57343) {
				code = (code - 55296) * 1024 + (next - 56320) + 65536;
				i += 1;
			}
		}
		if (code < 128) out.push(code);
		else if (code < 2048) out.push(192 | code >> 6, 128 | code & 63);
		else if (code < 65536) out.push(224 | code >> 12, 128 | code >> 6 & 63, 128 | code & 63);
		else out.push(240 | code >> 18, 128 | code >> 12 & 63, 128 | code >> 6 & 63, 128 | code & 63);
	}
	return new Uint8Array(out);
}
/** UTF-8 字节数（不是字符数：中文一个字是 3 个字节） */
function byteLengthOf(text) {
	return utf8Bytes$1(text).byteLength;
}
/** 十六进制小写 SHA-256 */
function sha256Hex(text) {
	const bytes = utf8Bytes$1(text);
	const bitLength = bytes.length * 8;
	const total = Math.ceil((bytes.length + 9) / 64) * 64;
	const buffer = new Uint8Array(total);
	buffer.set(bytes);
	buffer[bytes.length] = 128;
	const view = new DataView(buffer.buffer);
	view.setUint32(total - 8, Math.floor(bitLength / 4294967296));
	view.setUint32(total - 4, bitLength >>> 0);
	let h0 = 1779033703;
	let h1 = 3144134277;
	let h2 = 1013904242;
	let h3 = 2773480762;
	let h4 = 1359893119;
	let h5 = 2600822924;
	let h6 = 528734635;
	let h7 = 1541459225;
	const w = /* @__PURE__ */ new Uint32Array(64);
	for (let offset = 0; offset < total; offset += 64) {
		for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
		for (let i = 16; i < 64; i += 1) {
			const x = w[i - 15];
			const y = w[i - 2];
			const s0 = rotr(x, 7) ^ rotr(x, 18) ^ x >>> 3;
			const s1 = rotr(y, 17) ^ rotr(y, 19) ^ y >>> 10;
			w[i] = w[i - 16] + s0 + w[i - 7] + s1 >>> 0;
		}
		let a = h0;
		let b = h1;
		let c = h2;
		let d = h3;
		let e = h4;
		let f = h5;
		let g = h6;
		let h = h7;
		for (let i = 0; i < 64; i += 1) {
			const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const ch = e & f ^ ~e & g;
			const t1 = h + s1 + ch + K[i] + w[i] >>> 0;
			const t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + (a & b ^ a & c ^ b & c) >>> 0;
			h = g;
			g = f;
			f = e;
			e = d + t1 >>> 0;
			d = c;
			c = b;
			b = a;
			a = t1 + t2 >>> 0;
		}
		h0 = h0 + a >>> 0;
		h1 = h1 + b >>> 0;
		h2 = h2 + c >>> 0;
		h3 = h3 + d >>> 0;
		h4 = h4 + e >>> 0;
		h5 = h5 + f >>> 0;
		h6 = h6 + g >>> 0;
		h7 = h7 + h >>> 0;
	}
	const hex = (value) => value.toString(16).padStart(8, "0");
	return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4) + hex(h5) + hex(h6) + hex(h7);
}
//#endregion
//#region src/vendor/upstream/data/v2/fs.ts
let tempSeq = 0;
/**
* 原子写：先写同目录临时文件，再替换目标，最后清掉临时文件。
*
* 内存实现里「替换」天然是原子的，但真实磁盘上不是——把顺序固定在这里，
* 两个后端就都走同一条写路径，Rust 端只是把 `write` 换成
* 「临时文件 -> flush -> fsync -> rename」。
*/
async function writeTextAtomic(vfs, rel, text) {
	const norm = normalizeRel(rel);
	tempSeq += 1;
	const tmp = joinRel(parentRel(norm), `.${baseName(norm)}.tmp-${tempSeq.toString(36)}`);
	await vfs.write(tmp, text);
	try {
		await vfs.write(norm, text);
	} finally {
		try {
			await vfs.remove(tmp);
		} catch {}
	}
}
/** 取单个文件的目录项（大小/修改时间）；不存在或不是文件时返回 null */
async function fileEntry(vfs, rel) {
	const norm = normalizeRel(rel);
	if (norm === "") return null;
	try {
		const entries = await vfs.list(parentRel(norm));
		const name = baseName(norm);
		return entries.find((entry) => entry.name === name && entry.kind === "file") ?? null;
	} catch {
		return null;
	}
}
//#endregion
//#region src/vendor/upstream/data/v2/nodeMeta.ts
/**
* 节点元数据（`node.json`）的读写与修订/哈希守卫
*
* 所有对 `node.json` 的修改都必须经过这里，原因是设计 §5.3 的外部编辑冲突规则：
* 写之前要同时检查调用方手上的 `revision` 与磁盘文件的 SHA-256，
* 任何一项不符都返回结构化 `external_change_conflict`，**默认绝不覆盖**。
*
* 注意：正文（`note.md`）的修订号**不在** `node.json` 里，而是记在
* `.meta/knowledgenet/notes-index.json`（见 `notes.ts` 与 `docs/v2-deviations.md` D5）：
* 节点元数据修订与文档修订是两件事，混在一个数字里会让「改标题」影响「保存正文」。
*/
/** 读节点元数据；解析失败原样抛 `MetadataError`，由调用方转成扫描问题或错误码 */
async function readNodeMeta(vfs, nodeRel) {
	const rel = nodeMetaFile(nodeRel);
	let text;
	try {
		text = await vfs.read(rel);
	} catch {
		throw new RepositoryError("node_missing", `节点目录里没有 ${rel}`, { relativePath: rel });
	}
	return {
		meta: parseNodeMeta(text, rel),
		relativePath: nodeRel,
		sha256: sha256Hex(text),
		text
	};
}
/** 读节点元数据；不存在时返回 null（只用于「可能还没有元数据」的路径） */
async function readNodeMetaIfExists(vfs, nodeRel) {
	const rel = nodeMetaFile(nodeRel);
	if (!await vfs.exists(rel)) return null;
	return readNodeMeta(vfs, nodeRel);
}
/**
* 写入节点元数据（原子替换），并做修订号 + 哈希守卫。
*
* `expectedRevision` / `expectedHash` 为 null 表示调用方明确要求「不管磁盘上是什么，
* 覆盖它」——只有新建节点与「重新分配 ID」这类不涉及用户内容的场景才允许。
*/
async function writeNodeMeta(vfs, nodeRel, meta, expected = {}) {
	const rel = nodeMetaFile(nodeRel);
	const existing = await readNodeMetaIfExists(vfs, nodeRel);
	if (existing) {
		const expectedRevision = expected.expectedRevision ?? null;
		const expectedHash = expected.expectedHash ?? null;
		if (expectedRevision !== null && expectedRevision !== existing.meta.revision) throw externalChangeConflict({
			relativePath: rel,
			expectedRevision,
			actualRevision: existing.meta.revision,
			expectedHash,
			actualHash: existing.sha256,
			message: "磁盘上的 node.json 已被外部修改（修订号不符），已拒绝覆盖"
		});
		if (expectedHash !== null && expectedHash !== existing.sha256) throw externalChangeConflict({
			relativePath: rel,
			expectedRevision: expectedRevision ?? existing.meta.revision,
			actualRevision: existing.meta.revision,
			expectedHash,
			actualHash: existing.sha256,
			message: "磁盘上的 node.json 已被外部修改（内容哈希不符），已拒绝覆盖"
		});
	} else if ((expected.expectedRevision ?? null) !== null && (expected.expectedRevision ?? 0) > 0) throw new RepositoryError("node_missing", `节点元数据不见了：${rel}`, { relativePath: rel });
	const now = isoFromMs(Date.now());
	const next = {
		...meta,
		revision: (existing?.meta.revision ?? meta.revision ?? 1) + (existing ? 1 : 0),
		updatedAt: expected.touch === false ? meta.updatedAt : now
	};
	if (!existing && next.revision < 1) next.revision = 1;
	const text = serializeJson(next);
	await writeTextAtomic(vfs, rel, text);
	return {
		meta: next,
		relativePath: nodeRel,
		sha256: sha256Hex(text),
		text
	};
}
//#endregion
//#region src/vendor/upstream/data/uuid.ts
/**
* UUID v7 形状的标识生成
*
* **正式知识库的 ID 一律由 Rust 发号**（UUIDv7，时间有序）。
* 前端只在两个不该碰持久层的场景里需要自己造 ID：
* 1. 浏览器演示后端（localStorage，不是便携知识库）；
* 2. 导入图交换格式时给重号/缺失的 ID 重新编号（导入的旧文件里可能是 n1 这类顺序 ID）。
*
* 因此这里刻意不做任何 ID 分配策略，只生成不与已有值冲突的字符串。
*/
function randomBytes$1(length) {
	const bytes = new Uint8Array(length);
	const cryptoApi = globalThis.crypto;
	if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
		cryptoApi.getRandomValues(bytes);
		return bytes;
	}
	for (let i = 0; i < length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
	return bytes;
}
function hex(bytes) {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
/**
* 生成 UUIDv7 形状的字符串：前 48 位是毫秒时间戳，后面是随机位。
* 形状与 Rust 侧一致，便于导入导出后人工辨认（`isUuid` 只检查形状，不解释内容）。
*/
function newUuid(now = Date.now()) {
	const timeHex = (Math.max(0, Math.trunc(now)) % 2 ** 48).toString(16).padStart(12, "0");
	const randHex = hex(randomBytes$1(10));
	return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-${`7${randHex.slice(0, 3)}`}-${`${(Number.parseInt(randHex.slice(3, 4), 16) & 3 | 8).toString(16)}${randHex.slice(4, 7)}`}-${randHex.slice(7, 19)}`;
}
//#endregion
//#region src/vendor/upstream/data/v2/relations.ts
/**
* `relations.json` 的读写（只存出边）
*
* `A → B` 表示 A 依赖 B，这条边只写进 **A 的** `relations.json`（设计 §4.4）。
* 这样新增/删除关系只动一个节点目录，复制节点时「我依赖什么」随节点一起走，
* 也不需要维护双写一致性；代价是入边要在扫描时反向计算。
*
* 写入一律带修订号 + 哈希守卫：文件被外部改过时返回
* `external_change_conflict`，而不是把别人的修改盖掉。
*/
/** 读 `relations.json`；缺失时返回空文件（没有出边是常态，不是错误） */
async function readRelations(vfs, nodeRel, nodeId) {
	const rel = relationsFile(nodeRel);
	let text = null;
	try {
		text = await vfs.read(rel);
	} catch {
		text = null;
	}
	if (text === null) return {
		file: emptyRelations(nodeId),
		sha256: ""
	};
	return {
		file: parseRelationsFile(text, rel),
		sha256: sha256Hex(text)
	};
}
/**
* 写 `relations.json`（原子替换）。
*
* `expectedRevision` / `expectedHash` 为 null 表示调用方刚读过、明确要覆盖
* （本模块内部的所有改边操作都属于这一类）。
*/
async function writeRelations(vfs, nodeRel, file, expected = {}) {
	const rel = relationsFile(nodeRel);
	const current = await readRelations(vfs, nodeRel, file.nodeId);
	const hasFile = current.sha256 !== "";
	const expectedRevision = expected.expectedRevision ?? null;
	const expectedHash = expected.expectedHash ?? null;
	if (hasFile) {
		if (expectedRevision !== null && expectedRevision !== current.file.revision) throw externalChangeConflict({
			relativePath: rel,
			expectedRevision,
			actualRevision: current.file.revision,
			expectedHash,
			actualHash: current.sha256,
			message: "磁盘上的 relations.json 已被外部修改（修订号不符），已拒绝覆盖"
		});
		if (expectedHash !== null && expectedHash !== current.sha256) throw externalChangeConflict({
			relativePath: rel,
			expectedRevision: expectedRevision ?? current.file.revision,
			actualRevision: current.file.revision,
			expectedHash,
			actualHash: current.sha256,
			message: "磁盘上的 relations.json 已被外部修改（内容哈希不符），已拒绝覆盖"
		});
	}
	const next = {
		...file,
		revision: hasFile ? Math.max(file.revision, current.file.revision + 1) : Math.max(1, file.revision)
	};
	const text = serializeJson(next);
	await writeTextAtomic(vfs, rel, text);
	return {
		file: next,
		sha256: sha256Hex(text)
	};
}
/** 内部：读改写一次（revision 自增），`mutate` 里改 `outgoing` */
async function mutateRelations(vfs, nodeRel, nodeId, mutate) {
	const current = await readRelations(vfs, nodeRel, nodeId);
	const file = { ...current.file };
	if (file.nodeId !== nodeId) file.nodeId = nodeId;
	mutate(file);
	return (await writeRelations(vfs, nodeRel, file, {
		expectedRevision: current.sha256 === "" ? null : current.file.revision,
		expectedHash: current.sha256 === "" ? null : current.sha256
	})).file;
}
/** 新增一条出边；同一目标 + 同一类型的重复边直接返回已有的那条 */
async function addEdge$1(vfs, nodeRel, nodeId, input) {
	const relationType = input.relationType?.trim() || "prerequisite";
	let saved = null;
	const file = await mutateRelations(vfs, nodeRel, nodeId, (draft) => {
		const existing = draft.outgoing.find((edge) => edge.toNodeId === input.toNodeId && edge.type === relationType);
		if (existing) {
			saved = existing;
			return;
		}
		const now = isoFromMs(Date.now());
		const edge = {
			id: input.edgeId ?? newUuid(),
			toNodeId: input.toNodeId,
			type: relationType,
			description: input.description ?? "",
			toTitleSnapshot: input.toTitle,
			createdAt: now,
			updatedAt: now,
			evidence: []
		};
		draft.outgoing.push(edge);
		saved = edge;
	});
	const edge = saved ?? file.outgoing.find((item) => item.toNodeId === input.toNodeId);
	if (!edge) throw new RepositoryError("internal", "写入关系失败");
	return edge;
}
async function removeEdge$1(vfs, nodeRel, nodeId, edgeId) {
	let removed = false;
	await mutateRelations(vfs, nodeRel, nodeId, (draft) => {
		const index = draft.outgoing.findIndex((edge) => edge.id === edgeId);
		if (index < 0) return;
		draft.outgoing.splice(index, 1);
		removed = true;
	});
	return removed;
}
function evidenceToFile(evidence) {
	return {
		id: evidence.id,
		threadId: evidence.threadId,
		messageId: evidence.messageId,
		snippet: evidence.snippet,
		question: evidence.question,
		createdAt: isoFromMs(evidence.createdAt)
	};
}
/** 把一段选中文字记到某条关系上（来源记录） */
async function addEvidence(vfs, nodeRel, nodeId, edgeId, input) {
	const now = Date.now();
	const record = {
		id: newUuid(now),
		threadId: input.threadId ?? null,
		messageId: input.messageId ?? null,
		snippet: input.snippet,
		question: input.question ?? "",
		createdAt: now
	};
	let saved = false;
	await mutateRelations(vfs, nodeRel, nodeId, (draft) => {
		const edge = draft.outgoing.find((item) => item.id === edgeId);
		if (!edge) return;
		edge.evidence.push(evidenceToFile(record));
		saved = true;
	});
	if (!saved) throw new RepositoryError("not_found", `关系不存在：${edgeId}`);
	return record;
}
//#endregion
//#region src/vendor/upstream/data/v2/resources.ts
function fileToResource(nodeId, entry) {
	return {
		id: entry.id,
		nodeId,
		resourceType: entry.kind,
		relativePath: entry.relativePath,
		sourceUrl: entry.url,
		originalName: entry.originalName,
		displayName: entry.displayName,
		mimeType: entry.mimeType,
		byteLength: entry.byteLength,
		sha256: entry.sha256,
		description: entry.description,
		sortOrder: entry.sortOrder,
		createdAt: parseIsoMs(entry.createdAt),
		updatedAt: parseIsoMs(entry.updatedAt)
	};
}
/** 读 `resources.json`；缺失时返回空文件（不是错误：没有登记资料是常态） */
async function readResourcesFile(vfs, nodeRel, nodeId) {
	const rel = resourcesFile(nodeRel);
	let text = null;
	try {
		text = await vfs.read(rel);
	} catch {
		text = null;
	}
	if (text === null) {
		const file = emptyResources(nodeId);
		const rendered = serializeJson(file);
		return {
			file,
			sha256: sha256Hex(rendered),
			text: rendered
		};
	}
	return {
		file: parseResourcesFile(text, rel),
		sha256: sha256Hex(text),
		text
	};
}
async function listResources(vfs, nodeRel, nodeId) {
	const { file } = await readResourcesFile(vfs, nodeRel, nodeId);
	return file.entries.map((entry) => fileToResource(nodeId, entry)).sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt);
}
//#endregion
//#region src/host/graph.ts
function summarizeNode(node) {
	return {
		id: node.id,
		title: node.title,
		path: node.relativePath,
		status: node.status,
		aliases: node.aliases,
		health: node.health,
		revision: node.revision
	};
}
function summarizeEdge(edge) {
	return {
		id: edge.id,
		fromId: edge.fromId,
		toId: edge.toId,
		relationType: edge.relationType,
		relation: edge.relation,
		dangling: edge.dangling === true
	};
}
/** 用 id → 相对路径 → 文件夹名 → 标题 的顺序解析一个节点参数 */
function resolveNodeArg(snapshot, args) {
	const byId = typeof args.id === "string" && args.id.trim() !== "" ? snapshot.nodes.find((node) => node.id === args.id.trim()) : void 0;
	if (byId !== void 0) return byId;
	const wanted = typeof args.path === "string" && args.path.trim() !== "" ? normalizeRel(args.path) : "";
	if (wanted !== "") {
		const exact = snapshot.nodes.find((node) => normalizeRel(node.relativePath) === wanted);
		if (exact !== void 0) return exact;
		const byFolder = snapshot.nodes.filter((node) => normalizeRel(node.folderName) === wanted);
		if (byFolder.length === 1) return byFolder[0];
	}
	const title = typeof args.title === "string" ? normalizeTitle(args.title) : "";
	if (title !== "") return findExactMatch(snapshot, title);
}
/** 搜索：命中完全相同 → 直接给结论；否则给相似候选 */
function search(snapshot, query, limit = 8) {
	const exact = findExactMatch(snapshot, query);
	const similar = findSimilar(snapshot, query, limit).map(summarizeNode);
	const fallback = searchNodes(snapshot, query, limit).map(summarizeNode);
	const seen = new Set(similar.map((node) => node.id));
	for (const node of fallback) if (!seen.has(node.id)) {
		similar.push(node);
		seen.add(node.id);
	}
	return {
		exact: exact === void 0 ? null : summarizeNode(exact),
		similar
	};
}
/** 一个节点的一跳邻域：前置 + 后继 + 它们之间的边（供二维聚焦卡片使用） */
function neighborhood(snapshot, nodeId) {
	const center = snapshot.nodes.find((node) => node.id === nodeId);
	const prerequisites = prerequisitesOf(snapshot, nodeId);
	const dependents = dependentsOf(snapshot, nodeId);
	const nodes = [];
	const seen = /* @__PURE__ */ new Set();
	for (const node of [
		center,
		...prerequisites,
		...dependents
	]) {
		if (node === void 0 || seen.has(node.id)) continue;
		seen.add(node.id);
		nodes.push(node);
	}
	const related = new Set(nodes.map((node) => node.id));
	const edges = snapshot.edges.filter((edge) => related.has(edge.fromId) && related.has(edge.toId)).map(summarizeEdge);
	return {
		nodes: nodes.map(summarizeNode),
		edges
	};
}
//#endregion
//#region src/host/v3/frontmatter.ts
/**
* 节点 markdown 的 **front-matter**（v3 存储的核心约定）。
*
* v3 的目标：**一个节点 = 一个 markdown**，且**身份与标题/文件名解耦**。
* 所以每个文件的头部写一小段元数据，其中 `id` 是唯一标识（ULID），永不随标题或文件名变化：
*
* ```md
* ---
* id: 01J9ZQ8F2M7K3N5P6R7S8T9V0W
* title: 注意力机制
* status: learning
* aliases: [Attention, 注意机制]
* createdAt: 2026-09-29T10:00:00.000Z
* updatedAt: 2026-09-29T10:05:00.000Z
* rev: 3
* ---
* 正文（就是笔记本身）
* ```
*
* 为什么自己写解析（不引 yaml 依赖）：插件零运行时依赖 ⇒ 只支持这一小组"键: 标量 / 内联数组"，
* 写出来稳定、可读、可手改（用户拿编辑器直接改这一小段也不会坏）✓。
*/
const FENCE = "---";
/** 生成一个空元数据（新建文件时用） */
function emptyMeta(now, id, title) {
	return {
		id,
		title,
		status: "todo",
		aliases: [],
		createdAt: now,
		updatedAt: now,
		rev: 1,
		extra: {}
	};
}
/** 把一行 `key: value` 拆开；不是这种形状返回 undefined */
function splitLine(line) {
	const at = line.indexOf(":");
	if (at <= 0) return void 0;
	return {
		key: line.slice(0, at).trim(),
		value: line.slice(at + 1).trim()
	};
}
/** 解析内联数组 `[a, b]` / 空 `[]`；不是数组就返回 undefined */
function parseInlineArray(value) {
	if (!value.startsWith("[") || !value.endsWith("]")) return void 0;
	const inner = value.slice(1, -1).trim();
	if (inner === "") return [];
	return inner.split(",").map((piece) => piece.trim().replace(/^["']|["']$/g, "")).filter((piece) => piece !== "");
}
/**
* 解析一个 markdown 文档。
*
* 没有 front-matter 时**不报错**：按"无元数据"返回（调用方决定是否补写 ✓）——
* 这样用户手动新建/粘贴一个 md 进来，也不会让整个库读不出来 ✓。
*
* @param text - 文件全文。
* @returns 解析结果。
*/
function parseDocument(text) {
	const normalized = text.replace(/^\uFEFF/, "");
	const meta = emptyMeta("", "", "");
	if (!normalized.startsWith(`${FENCE}\n`) && !normalized.startsWith(`${FENCE}\r\n`)) return {
		hasFrontMatter: false,
		meta,
		body: normalized
	};
	const lines = normalized.split(/\r?\n/);
	let end = -1;
	for (let i = 1; i < lines.length; i += 1) if (lines[i].trim() === FENCE) {
		end = i;
		break;
	}
	if (end === -1) return {
		hasFrontMatter: false,
		meta,
		body: normalized
	};
	const header = lines.slice(1, end);
	for (const line of header) {
		if (line.trim() === "" || line.trim().startsWith("#")) continue;
		const pair = splitLine(line);
		if (pair === void 0) continue;
		const { key, value } = pair;
		switch (key) {
			case "id":
				meta.id = value;
				break;
			case "title":
				meta.title = value;
				break;
			case "status":
				meta.status = value;
				break;
			case "aliases":
				meta.aliases = parseInlineArray(value) ?? (value === "" ? [] : [value]);
				break;
			case "createdAt":
				meta.createdAt = value;
				break;
			case "updatedAt":
				meta.updatedAt = value;
				break;
			case "rev":
				meta.rev = Number.parseInt(value, 10) || 0;
				break;
			default: meta.extra[key] = value;
		}
	}
	return {
		hasFrontMatter: true,
		meta,
		body: lines.slice(end + 1).join("\n")
	};
}
/** 序列化 front-matter（**键序固定** ⇒ 同样的元数据永远产出同样的头部，便于 diff/比对） */
function serializeFrontMatter(meta) {
	const lines = [FENCE];
	lines.push(`id: ${meta.id}`);
	lines.push(`title: ${meta.title}`);
	lines.push(`status: ${meta.status === "" ? "todo" : meta.status}`);
	lines.push(`aliases: [${meta.aliases.join(", ")}]`);
	if (meta.createdAt !== "") lines.push(`createdAt: ${meta.createdAt}`);
	if (meta.updatedAt !== "") lines.push(`updatedAt: ${meta.updatedAt}`);
	lines.push(`rev: ${meta.rev}`);
	for (const [key, value] of Object.entries(meta.extra)) lines.push(`${key}: ${value}`);
	lines.push(FENCE);
	return lines.join("\n");
}
/** 把元数据 + 正文组装成文件全文（正文前后各留一个空行，读起来舒服） */
function composeDocument(meta, body) {
	const trimmed = body.replace(/^\n+/, "").replace(/\s+$/, "");
	return `${serializeFrontMatter(meta)}\n\n${trimmed}${trimmed === "" ? "" : "\n"}`;
}
/**
* 内容指纹：用来做**冲突守卫**（写之前比对，避免覆盖别人刚改的内容 ✓）。
* @param text - 文件全文。
* @returns 短的十六进制指纹。
*/
function contentHash(text) {
	return createHash("sha1").update(text, "utf8").digest("hex").slice(0, 12);
}
/**
* 给标题找一个可作为文件名的形式（去掉非法字符、压掉多余空格）。
*
* 文件名**不承担身份** ✓（身份在 front-matter 的 id），所以这里只求"可读 + 合法"。
* @param title - 节点标题。
* @returns 文件名主体（不含扩展名）；标题全非法时返回 `node`。
*/
function fileNameFromTitle(title) {
	const cleaned = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().replace(/\.+$/, "").slice(0, 80).trim();
	return cleaned === "" ? "node" : cleaned;
}
//#endregion
//#region src/host/v3/ulid.ts
/**
* ULID：节点 v3 的唯一标识（时间有序 + 随机后缀）。
*
* 为什么用它（用户选定 ✓）：26 个字符、按时间自然有序、无需中央协调、碰撞概率可忽略；
* 而且它**与标题/文件名无关** ✓ —— 改标题、重命名文件、两个节点同名，都不会改变身份 ✓。
*
* 实现说明：零依赖 ⇒ 自己按规范拼：48 位毫秒时间戳 + 80 位随机数，Crockford Base32 编码。
*/
/** Crockford Base32（去掉容易看混的 I L O U） */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
/** 48 位时间戳能表示到 10889 年，ULID 规范限制在这个范围内 */
const MAX_TIME = 0xffffffffffff;
/**
* 生成一个 ULID。
* @param now - 毫秒时间戳（默认当前时间；测试可注入）。
* @returns 26 字符的 ULID。
*/
function ulid(now = Date.now()) {
	let time = Math.floor(Number.isFinite(now) ? now : Date.now());
	if (time < 0) time = 0;
	if (time > MAX_TIME) time = MAX_TIME;
	let timePart = "";
	let remaining = time;
	for (let i = 0; i < TIME_CHARS; i += 1) {
		timePart = ALPHABET[remaining % 32] + timePart;
		remaining = Math.floor(remaining / 32);
	}
	const bytes = randomBytes(10);
	let randomPart = "";
	let bits = 0;
	let value = 0;
	for (const byte of bytes) {
		value = value << 8 | byte;
		bits += 8;
		while (bits >= 5) {
			randomPart += ALPHABET[value >>> bits - 5 & 31];
			bits -= 5;
			value &= (1 << bits) - 1;
		}
	}
	while (randomPart.length < RANDOM_CHARS) randomPart += ALPHABET[0];
	return timePart + randomPart.slice(0, RANDOM_CHARS);
}
/**
* 判断一个字符串像不像 ULID（26 字符、全在字母表内）。
* 用于"id 与文件名/标题无关"的校验，以及数据自检。
* @param value - 待判断的字符串。
* @returns 是否形如 ULID。
*/
function isUlid(value) {
	if (typeof value !== "string" || value.length !== 26) return false;
	for (const char of value) if (!ALPHABET.includes(char)) return false;
	return true;
}
const V3_LIBRARY_FILE = "library.json";
const V3_NODES_DIR = "Nodes";
const V3_GRAPH_FILE = "graph.json";
/** ISO 时间戳（统一一处，测试可注入时钟） */
function stamp(now) {
	return new Date(now).toISOString();
}
/** 原子写：先写临时文件再 rename，避免半截文件 */
async function writeAtomic(target, text) {
	await mkdir(dirname(target), { recursive: true });
	const tmp = `${target}.tmp-${`${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
	await writeFile(tmp, text, "utf8");
	await rename(tmp, target);
}
/**
* **同一库内串行化**的写入队列（按库根 key ✓）。
*
* 为什么需要：`writeAtomic` 只保证"不出现半截文件" ✗，它**不保证**"比较指纹 + 替换"是
* 不可分割的一步 —— 两个请求可以同时读到旧版本、同时通过检查、再各自覆盖 ✗（复查指出的问题）。
* 把插件的正文写入排进同一条队列后，"进队 → 重读 → 比较 → 提交"在**本进程内**互斥 ✓；
* 进程外的编辑器仍然可能插在最后一步之前 ⇒ 只能缩小窗口，不能承诺绝对原子 ✗（如实写在这里 ✓）。
*/
const writeQueues = /* @__PURE__ */ new Map();
/**
* 把一次写入排进该库的串行队列。
* @param root - 库根（队列键 ✓）。
* @param task - 真正执行的写入（内部应重新读取并比较 ✓）。
* @returns 任务结果 ✓。
*/
async function withLibraryWrite(root, task) {
	const key = resolve(root);
	const run = (writeQueues.get(key) ?? Promise.resolve()).then(task, task);
	const guarded = run.catch(() => void 0);
	writeQueues.set(key, guarded);
	try {
		return await run;
	} finally {
		guarded.then(() => {
			if (writeQueues.get(key) === guarded) writeQueues.delete(key);
		});
	}
}
async function readJson(file) {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch {
		return;
	}
}
async function exists(file) {
	try {
		await stat(file);
		return true;
	} catch {
		return false;
	}
}
/** 库根校验：必须是绝对路径，且（可选）已存在 library.json */
function assertRoot(root) {
	const resolved = resolve(root);
	if (resolved === "" || !resolved) throw new Error("invalid_root");
	return resolved;
}
/**
* 读取库清单（v3）。
* @param root - 库根。
* @param options - `withNotes` 时一并读出正文。
* @returns 库对象；不是 v3 库（缺 library.json / 版本不符）返回 undefined。
*/
async function readLibrary(root, options = {}) {
	const base = assertRoot(root);
	const manifest = await readJson(join(base, V3_LIBRARY_FILE));
	if (manifest === void 0 || manifest.formatVersion !== 3) return void 0;
	const nodesDir = join(base, V3_NODES_DIR);
	let names = [];
	try {
		names = (await readdir(nodesDir)).filter((name) => name.toLowerCase().endsWith(".md"));
	} catch {
		names = [];
	}
	const nodes = [];
	const usedIds = /* @__PURE__ */ new Set();
	for (const name of names.sort()) {
		const abs = join(nodesDir, name);
		const text = await readFile(abs, "utf8");
		const parsed = parseDocument(text);
		const relativePath = relative(base, abs).replace(/\\/g, "/");
		let id = parsed.meta.id.trim();
		let adopted = false;
		if (!isUlid(id) || usedIds.has(id)) {
			id = `adopted-${contentHash(relativePath + name)}`;
			adopted = true;
		}
		usedIds.add(id);
		nodes.push({
			id,
			title: parsed.meta.title === "" ? name.replace(/\.md$/i, "") : parsed.meta.title,
			status: parsed.meta.status === "" ? "todo" : parsed.meta.status,
			aliases: parsed.meta.aliases,
			createdAt: parsed.meta.createdAt,
			updatedAt: parsed.meta.updatedAt,
			rev: parsed.meta.rev,
			relativePath,
			hash: contentHash(text),
			...options.withNotes === true ? { note: parsed.body.replace(/^\n+/, "") } : {},
			...adopted ? { adopted: true } : {}
		});
	}
	const graph = await readJson(join(base, V3_GRAPH_FILE));
	return {
		root: base,
		libraryId: typeof manifest.libraryId === "string" ? manifest.libraryId : "",
		title: typeof manifest.title === "string" ? manifest.title : "",
		createdAt: typeof manifest.createdAt === "string" ? manifest.createdAt : "",
		nodes,
		edges: Array.isArray(graph?.edges) ? graph.edges : [],
		graphRevision: typeof graph?.revision === "number" ? graph.revision : 0
	};
}
/**
* 初始化一个 v3 库（空库）。
* @param root - 目标目录（必须存在且为空）。
* @param title - 库标题（默认取目录名）。
* @param now - 时间戳（测试可注入）。
* @returns 结果。
*/
async function createLibrary$1(root, title, now = Date.now()) {
	const base = assertRoot(root);
	if (await exists(join(base, "library.json"))) return {
		ok: false,
		code: "already_library",
		message: `这里已经有 library.json 了：${base}`
	};
	let entries = [];
	try {
		entries = await readdir(base);
	} catch {
		return {
			ok: false,
			code: "invalid_root",
			message: `目录不存在：${base}`
		};
	}
	if (entries.length > 0) {
		const ours = /* @__PURE__ */ new Set([
			V3_NODES_DIR,
			V3_GRAPH_FILE,
			"Backup",
			".knowledgenet"
		]);
		const foreign = entries.filter((entry) => !ours.has(entry));
		if (foreign.length > 0) return {
			ok: false,
			code: "not_empty",
			message: `目录里还有你自己的内容（${foreign.slice(0, 3).join("、")}${foreign.length > 3 ? " 等" : ""}），不能在它里面建库：${base}`
		};
	}
	const libraryId = ulid(now);
	const libraryTitle = typeof title === "string" && title.trim() !== "" ? title.trim() : base.split(/[\\/]/).pop() ?? "知识库";
	await mkdir(join(base, V3_NODES_DIR), { recursive: true });
	await writeAtomic(join(base, V3_LIBRARY_FILE), `${JSON.stringify({
		format: "knowledgenet-library",
		formatVersion: 3,
		libraryId,
		title: libraryTitle,
		createdAt: stamp(now),
		storage: "single-file-markdown"
	}, null, 2)}\n`);
	await writeAtomic(join(base, V3_GRAPH_FILE), `${JSON.stringify({
		formatVersion: 3,
		revision: 1,
		edges: []
	}, null, 2)}\n`);
	return {
		ok: true,
		root: base,
		libraryId,
		title: libraryTitle
	};
}
/** 在 `Nodes/` 下为标题挑一个不冲突的文件名（`标题.md` → `标题-2.md` → …） */
async function pickFileName(base, title) {
	const stem = fileNameFromTitle(title);
	const nodesDir = join(base, V3_NODES_DIR);
	for (let n = 1; n < 1e3; n += 1) {
		const candidate = n === 1 ? `${stem}.md` : `${stem}-${n}.md`;
		if (!await exists(join(nodesDir, candidate))) return candidate;
	}
	return `${stem}-${Date.now()}.md`;
}
/**
* 新建一个节点（= 写一个 markdown）。
* @param root - 库根。
* @param input - 标题 / 状态 / 别名 / 初始正文。
* @param now - 时间戳。
* @returns 结果（含新节点）。
*/
async function createNode$1(root, input, now = Date.now()) {
	const base = assertRoot(root);
	if (await readLibrary(base) === void 0) return {
		ok: false,
		code: "not_library",
		message: `这里还不是 v3 知识库：${base}`
	};
	const title = input.title.trim();
	if (title === "") return {
		ok: false,
		code: "title_required",
		message: "节点标题不能为空"
	};
	if (title.length > 120) return {
		ok: false,
		code: "title_too_long",
		message: "节点标题过长（上限 120 字）"
	};
	const id = ulid(now);
	const fileName = await pickFileName(base, title);
	const meta = {
		...emptyMeta(stamp(now), id, title),
		...input.status !== void 0 && input.status !== "" ? { status: input.status } : {},
		...input.aliases !== void 0 ? { aliases: input.aliases } : {}
	};
	const text = composeDocument(meta, input.note ?? "");
	const relativePath = `${V3_NODES_DIR}/${fileName}`;
	await writeAtomic(join(base, relativePath), text);
	return {
		ok: true,
		node: {
			id,
			title,
			status: meta.status,
			aliases: meta.aliases,
			createdAt: meta.createdAt,
			updatedAt: meta.updatedAt,
			rev: meta.rev,
			relativePath,
			hash: contentHash(text),
			note: input.note ?? ""
		}
	};
}
/** 读一个节点的完整内容（正文 + 关系） */
async function readNode(root, ref) {
	const base = assertRoot(root);
	const library = await readLibrary(base, { withNotes: true });
	if (library === void 0) return {
		ok: false,
		code: "not_library",
		message: `这里还不是 v3 知识库：${base}`
	};
	const node = library.nodes.find((item) => {
		if (typeof ref.id === "string" && ref.id.trim() !== "") return item.id === ref.id.trim();
		if (typeof ref.path === "string" && ref.path.trim() !== "") return item.relativePath === ref.path.trim().replace(/\\/g, "/");
		if (typeof ref.title === "string" && ref.title.trim() !== "") return item.title === ref.title.trim();
		return false;
	});
	if (node === void 0) return {
		ok: false,
		code: "node_missing",
		message: "没有找到这个知识点"
	};
	return {
		ok: true,
		node,
		prerequisites: library.edges.filter((edge) => edge.fromId === node.id),
		dependents: library.edges.filter((edge) => edge.toId === node.id)
	};
}
/**
* 写正文（整体替换），带**冲突守卫**。
* @param root - 库根。
* @param input - 目标节点 + 新正文 + 可选"我手上那版的指纹"。
* @param now - 时间戳。
* @returns 结果；指纹不匹配时返回 `conflict` 与 `actualHash`。
*/
async function writeNote$1(root, input, now = Date.now()) {
	const base = assertRoot(root);
	return await withLibraryWrite(base, () => writeNoteLocked(base, input, now));
}
/** `writeNote` 的串行区实现（由上面的队列保证不并发 ✓） */
async function writeNoteLocked(base, input, now) {
	const library = await readLibrary(base, { withNotes: false });
	if (library === void 0) return {
		ok: false,
		code: "not_library",
		message: `这里还不是 v3 知识库：${base}`
	};
	const node = library.nodes.find((item) => item.id === input.id);
	if (node === void 0) return {
		ok: false,
		code: "node_missing",
		message: "没有找到这个知识点"
	};
	if (typeof input.expectedHash === "string" && input.expectedHash !== "" && input.expectedHash !== node.hash) return {
		ok: false,
		code: "conflict",
		message: "磁盘上的内容在你读取之后被改过，为避免覆盖，本次写入已拒绝",
		actualHash: node.hash
	};
	const abs = join(base, node.relativePath);
	const current = await readFile(abs, "utf8");
	if (typeof input.expectedHash === "string" && input.expectedHash !== "" && contentHash(current) !== input.expectedHash) return {
		ok: false,
		code: "conflict",
		message: "磁盘上的内容在你读取之后被改过，为避免覆盖，本次写入已拒绝",
		actualHash: contentHash(current)
	};
	const parsed = parseDocument(current);
	const id = isUlid(parsed.meta.id) ? parsed.meta.id : node.id.startsWith("adopted-") ? ulid(now) : parsed.meta.id;
	const meta = {
		...parsed.meta,
		id,
		title: parsed.meta.title === "" ? node.title : parsed.meta.title,
		status: parsed.meta.status === "" ? node.status : parsed.meta.status,
		createdAt: parsed.meta.createdAt === "" ? stamp(now) : parsed.meta.createdAt,
		updatedAt: stamp(now),
		rev: (parsed.meta.rev || 0) + 1
	};
	const text = composeDocument(meta, input.text);
	await writeAtomic(abs, text);
	const normalizedBody = parseDocument(text).body;
	return {
		ok: true,
		node: {
			id,
			title: meta.title,
			status: meta.status,
			aliases: meta.aliases,
			createdAt: meta.createdAt,
			updatedAt: meta.updatedAt,
			rev: meta.rev,
			relativePath: node.relativePath,
			hash: contentHash(text),
			note: normalizedBody
		}
	};
}
/** 读 graph.json（缺文件时给一个空图） */
async function readGraph(base) {
	const graph = await readJson(join(base, V3_GRAPH_FILE));
	return {
		revision: typeof graph?.revision === "number" ? graph.revision : 0,
		edges: Array.isArray(graph?.edges) ? graph.edges : []
	};
}
/**
* 加一条前置关系：A → B（B 是 A 的前置）。
* @param root - 库根。
* @param input - 依赖方 id、被依赖方 id、类型/说明/出处。
* @param now - 时间戳。
* @returns 结果；重复边会被幂等返回。
*/
async function addEdge(root, input, now = Date.now()) {
	const base = assertRoot(root);
	const library = await readLibrary(base, { withNotes: false });
	if (library === void 0) return {
		ok: false,
		code: "not_library",
		message: `这里还不是 v3 知识库：${base}`
	};
	const from = library.nodes.find((node) => node.id === input.fromId);
	const to = library.nodes.find((node) => node.id === input.toId);
	if (from === void 0 || to === void 0) return {
		ok: false,
		code: "node_missing",
		message: "关系两端的知识点都必须存在"
	};
	if (from.id === to.id) return {
		ok: false,
		code: "self_edge",
		message: "不能把节点设成自己的前置"
	};
	const graph = await readGraph(base);
	const type = input.type ?? "prerequisite";
	const existing = graph.edges.find((edge) => edge.fromId === from.id && edge.toId === to.id && edge.type === type);
	if (existing !== void 0) return {
		ok: true,
		edge: existing,
		created: false
	};
	const reachable = (start, target) => {
		const seen = /* @__PURE__ */ new Set([start]);
		const queue = [start];
		while (queue.length > 0) {
			const current = queue.shift();
			for (const edge of graph.edges) {
				if (edge.fromId !== current) continue;
				if (edge.toId === target) return true;
				if (!seen.has(edge.toId)) {
					seen.add(edge.toId);
					queue.push(edge.toId);
				}
			}
		}
		return false;
	};
	if (reachable(to.id, from.id)) return {
		ok: false,
		code: "cycle",
		message: "这条关系会形成环，已拒绝"
	};
	const edge = {
		id: ulid(now),
		fromId: from.id,
		toId: to.id,
		type,
		...input.description !== void 0 && input.description !== "" ? { description: input.description } : {},
		...input.source !== void 0 ? { source: input.source } : {}
	};
	await writeAtomic(join(base, V3_GRAPH_FILE), `${JSON.stringify({
		formatVersion: 3,
		revision: graph.revision + 1,
		edges: [...graph.edges, edge]
	}, null, 2)}\n`);
	return {
		ok: true,
		edge,
		created: true
	};
}
/**
* 删一条边。
* @param root - 库根。
* @param edgeId - 边 id。
* @returns 结果。
*/
async function removeEdge(root, edgeId) {
	const base = assertRoot(root);
	const graph = await readGraph(base);
	const edge = graph.edges.find((item) => item.id === edgeId);
	if (edge === void 0) return {
		ok: false,
		code: "edge_missing",
		message: "没有找到这条关系"
	};
	const edges = graph.edges.filter((item) => item.id !== edgeId);
	await writeAtomic(join(base, V3_GRAPH_FILE), `${JSON.stringify({
		formatVersion: 3,
		revision: graph.revision + 1,
		edges
	}, null, 2)}\n`);
	return {
		ok: true,
		removed: edge
	};
}
/**
* 删除一个节点：**直接删掉那个 `.md`**（用户决定：节点就是一个文档，删除即彻底删除 ✓）。
* 同时把它相关的边从 `graph.json` 里摘掉（避免悬挂关系 ✓）。
*
* 不做"回收站/墓碑"：曾经写过身份墓碑，但全仓库没有任何代码读它 ⇒ 只写不读 ⇒ 已删除 ✓。
* 想留底的话，用户自己复制那个 `.md` 即可（它本身就是完整的一份文档 ✓）。
*
* @param root - 库根。
* @param input - 节点 id。
* @returns 结果（含被删节点的 id/title）。
*/
async function removeNode(root, input) {
	const base = assertRoot(root);
	const library = await readLibrary(base, { withNotes: false });
	if (library === void 0) return {
		ok: false,
		code: "not_library",
		message: `这里还不是 v3 知识库：${base}`
	};
	const node = library.nodes.find((item) => item.id === input.id);
	if (node === void 0) return {
		ok: false,
		code: "node_missing",
		message: "没有找到这个知识点"
	};
	const abs = join(base, node.relativePath);
	await unlink(abs).catch(() => void 0);
	const graph = await readGraph(base);
	const edges = graph.edges.filter((edge) => edge.fromId !== node.id && edge.toId !== node.id);
	if (edges.length !== graph.edges.length) await writeAtomic(join(base, V3_GRAPH_FILE), `${JSON.stringify({
		formatVersion: 3,
		revision: graph.revision + 1,
		edges
	}, null, 2)}\n`);
	return {
		ok: true,
		id: node.id,
		title: node.title
	};
}
//#endregion
//#region src/host/node-vfs.ts
/**
* 真实磁盘上的 `Vfs`（v2 开放文件模型只需要「读一个相对路径 / 列一层目录」这几件事）。
*
* 语义与上游 `MemoryVfs`（src/data/v2/fs.ts:60）逐条对齐：
* - `read` 对不存在或不是文件都抛 `not_found`；
* - `list` 只列直接子项、按名字排序、不跟随符号链接；
* - `write` 自动补齐父目录；`remove` 递归且缺失不报错；`mkdir` 递归且已存在不报错。
*
* 写入额外走「同目录临时文件 → rename」，避免中途崩掉留下半个文件
* （上游 `writeTextAtomic` 已经写了一遍临时文件，这里再保证一次替换的完整性）。
*/
let atomicSeq = 0;
var NodeVfs = class {
	root;
	constructor(root) {
		this.root = root;
	}
	/** 相对路径 → 绝对路径。逃出知识库根的写法一律拒绝，而不是悄悄修正。 */
	absolute(rel) {
		if (escapesLibrary(rel)) throw new RepositoryError("node_outside_library", `路径逃出知识库根目录：${rel}`, { relativePath: rel });
		const norm = normalizeRel(rel);
		return norm === "" ? this.root : path.join(this.root, ...norm.split("/"));
	}
	async read(rel) {
		const norm = normalizeRel(rel);
		const abs = this.absolute(norm);
		try {
			return await readFile(abs, "utf8");
		} catch (error) {
			throw new RepositoryError("not_found", `${error.code === "EISDIR" ? "目录不是文件" : "文件不存在"}：${norm}`, { relativePath: norm });
		}
	}
	async write(rel, text) {
		const norm = normalizeRel(rel);
		if (norm === "") throw new RepositoryError("invalid_input", "不能写到知识库根目录本身");
		const abs = this.absolute(norm);
		await mkdir(path.dirname(abs), { recursive: true });
		atomicSeq += 1;
		const tmp = `${abs}.${process.pid.toString(36)}.${atomicSeq.toString(36)}.kn-tmp`;
		await writeFile(tmp, text, "utf8");
		await rm(abs, { force: true }).catch(() => void 0);
		await rename(tmp, abs);
	}
	async exists(rel) {
		const abs = this.absolute(rel);
		try {
			await stat(abs);
			return true;
		} catch {
			return false;
		}
	}
	async list(rel) {
		const norm = normalizeRel(rel);
		const abs = this.absolute(norm);
		let entries;
		try {
			entries = await readdir(abs, { withFileTypes: true });
		} catch {
			throw new RepositoryError("not_found", `目录不存在：${norm}`, { relativePath: norm });
		}
		const out = [];
		for (const entry of entries) {
			if (entry.isDirectory()) {
				out.push({
					name: entry.name,
					kind: "dir",
					byteLength: 0,
					modifiedMs: 0
				});
				continue;
			}
			if (!entry.isFile()) continue;
			const info = await stat(path.join(abs, entry.name)).catch(() => null);
			out.push({
				name: entry.name,
				kind: "file",
				byteLength: info?.size ?? 0,
				modifiedMs: info?.mtimeMs ?? 0
			});
		}
		return out.sort((a, b) => a.name.localeCompare(b.name));
	}
	async remove(rel) {
		const norm = normalizeRel(rel);
		if (norm === "") throw new RepositoryError("invalid_input", "拒绝删除知识库根目录本身");
		await rm(this.absolute(norm), {
			recursive: true,
			force: true
		});
	}
	async mkdir(rel) {
		const norm = normalizeRel(rel);
		if (norm === "") return;
		await mkdir(this.absolute(norm), { recursive: true });
	}
};
//#endregion
//#region src/host/v3/adapter.ts
/**
* v3 存储 → 现有 `GraphSnapshot` 形状的**适配器**。
*
* 为什么要适配：面板、工具、卡片、提案审阅全都吃 `GraphSnapshot` / `KnowledgeNode` / `DependencyEdge`
* 这套形状（来自上游 v2 的类型 ✓）。v3 换了落盘方式，但**没有必要连上层契约一起换**——
* 把它映射成同一形状，界面与工具就一行都不用改 ✓，改动面被限制在存储层 ✓。
*
* 字段映射要点：
* - `id` = front-matter 的 ULID ✓（身份 ✓，与标题/文件名无关）；
* - `relativePath` = `Nodes/<标题>.md` ✓（唯一与 v2 的差别：v2 是节点**文件夹**）；
* - `folderName` = 文件名去扩展名 ✓（面板显示用）；
* - `revision` = front-matter 的 `rev` ✓（写正文的乐观并发依据）；
* - `relation` = 边上的"为什么" ✓，`relationType` = 关系类型 ✓。
*/
/** 合法学习状态（v3 里是自由字符串，落到已知三种，未知的按 todo 处理） */
function learnStatus(value) {
	return value === "learning" || value === "done" || value === "todo" ? value : "todo";
}
/** 时间字符串 → 毫秒（解析失败用当前时间兜底） */
function millis(value) {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : Date.now();
}
function toKnowledgeNode(node) {
	const fileName = node.relativePath.split("/").pop() ?? "";
	return {
		id: node.id,
		title: node.title,
		aliases: node.aliases,
		status: learnStatus(node.status),
		createdAt: millis(node.createdAt),
		updatedAt: millis(node.updatedAt),
		relativePath: node.relativePath,
		folderName: fileName.replace(/\.md$/i, ""),
		health: node.adopted === true ? "needs_adoption" : "ok",
		revision: node.rev,
		localMutation: false,
		prerequisiteIds: [],
		dependentIds: [],
		noteRevision: node.rev,
		noteHash: node.hash
	};
}
function toDependencyEdge(edge, index, nodes) {
	const at = Date.now() + index;
	return {
		id: edge.id,
		fromId: edge.fromId,
		toId: edge.toId,
		relation: edge.description ?? "",
		relationType: edge.type ?? "prerequisite",
		createdAt: at,
		updatedAt: at,
		missing: !nodes.some((node) => node.id === edge.toId),
		...edge.source === void 0 ? {} : { source: edge.source }
	};
}
/** 学习目标 = **没有人依赖它**的节点（没有后继 ⇒ 它是这条线的入口）✓ 与 v2 的口径一致 */
function toGoals(nodes, edges) {
	const dependedOn = new Set(edges.map((edge) => edge.toId));
	return nodes.filter((node) => !dependedOn.has(node.id)).map((node) => ({
		id: `goal-${node.id}`,
		title: node.title,
		rootNodeId: node.id,
		createdAt: millis(node.createdAt)
	}));
}
/** 给 v3 库一个"最小可用"的 Vfs：上层只有 `mutate.ts` 的 v2 分支会用到它 ✓ */
function v3Vfs(root) {
	return {
		absolute: (relativePath) => join(root, relativePath),
		root
	};
}
/** 合成一个 manifest（v3 的 library.json 字段更少，这里补齐上层会读的键） */
function v3Manifest(root, library) {
	return {
		format: "knowledgenet-library",
		formatVersion: 3,
		libraryId: library.libraryId,
		title: library.title,
		createdAt: library.createdAt,
		root,
		scan: {
			exclude: [
				".git",
				"node_modules",
				".knowledgenet",
				"Backup"
			],
			followSymlinks: false
		},
		defaults: { newNodeParent: "Nodes" }
	};
}
/** 合成一份扫描报告（面板的 count/truncated 之类从快照算，这里只求"形状对" ✓） */
function v3Report(nodes, edges) {
	return {
		at: Date.now(),
		ms: 0,
		nodes,
		edges,
		cached: false,
		issues: []
	};
}
/**
* 读一个 v3 库并适配成 `LoadedLibrary`。
* @param root - 库根。
* @param withNotes - 是否连正文一起读（面板不需要 ✓，工具需要时单独读节点 ✓）。
* @returns 适配后的库对象；不是 v3 库时返回 undefined。
*/
async function loadV3Library(root, withNotes = false) {
	const library = await readLibrary(root, { withNotes });
	if (library === void 0) return void 0;
	const nodes = library.nodes.map(toKnowledgeNode);
	const edges = library.edges.map((edge, index) => toDependencyEdge(edge, index, library.nodes));
	const snapshot = {
		revision: library.graphRevision,
		nodes,
		edges,
		goals: toGoals(library.nodes, library.edges),
		session: null
	};
	return {
		root: library.root,
		manifest: v3Manifest(library.root, library),
		vfs: v3Vfs(library.root),
		snapshot,
		report: v3Report(nodes.length, edges.length),
		revision: library.graphRevision,
		storage: "v3"
	};
}
//#endregion
//#region src/host/status.ts
/** 环形缓冲长度：够看清「客户端到底问过没有、问的是什么」 */
const PROBE_LOG_LIMIT = 12;
/** 客户端诊断的环形缓冲长度 */
const CLIENT_DIAG_LIMIT = 32;
/** 扫描指标的环形缓冲长度 */
const SCAN_LOG_LIMIT = 8;
/** 记录一次隔离判定（最新的在前，最多 ISOLATION_LOG_LIMIT 条） */
function recordIsolation(entry) {
	const full = {
		at: Date.now(),
		...entry
	};
	current = {
		api: current?.api ?? {
			path: "",
			registered: false
		},
		prompts: current?.prompts ?? {
			section: false,
			perAgent: false
		},
		startedAt: current?.startedAt ?? Date.now(),
		probes: current?.probes ?? [],
		clientDiag: current?.clientDiag ?? [],
		scans: current?.scans ?? [],
		isolation: [full, ...current?.isolation ?? []].slice(0, ISOLATION_LOG_LIMIT)
	};
}
/** 隔离留痕的环形缓冲长度 */
const ISOLATION_LOG_LIMIT = 8;
let current;
function setRuntimeStatus(status) {
	current = status;
}
function patchRuntimeStatus(patch) {
	current = {
		api: patch.api ?? current?.api ?? {
			path: "",
			registered: false
		},
		prompts: patch.prompts ?? current?.prompts ?? {
			section: false,
			perAgent: false
		},
		startedAt: patch.startedAt ?? current?.startedAt ?? Date.now(),
		probes: patch.probes ?? current?.probes ?? [],
		clientDiag: patch.clientDiag ?? current?.clientDiag ?? [],
		scans: patch.scans ?? current?.scans ?? [],
		isolation: patch.isolation ?? current?.isolation ?? []
	};
}
/** 记录一次路由请求（最新的在前，最多 PROBE_LOG_LIMIT 条） */
function recordProbe(entry) {
	current = {
		api: current?.api ?? {
			path: "",
			registered: false
		},
		prompts: current?.prompts ?? {
			section: false,
			perAgent: false
		},
		startedAt: current?.startedAt ?? Date.now(),
		probes: [entry, ...current?.probes ?? []].slice(0, PROBE_LOG_LIMIT),
		clientDiag: current?.clientDiag ?? [],
		scans: current?.scans ?? [],
		isolation: current?.isolation ?? []
	};
}
/** 记录一次客户端诊断（最新的在前，最多 CLIENT_DIAG_LIMIT 条） */
function recordClientDiag(entry) {
	current = {
		api: current?.api ?? {
			path: "",
			registered: false
		},
		prompts: current?.prompts ?? {
			section: false,
			perAgent: false
		},
		startedAt: current?.startedAt ?? Date.now(),
		probes: current?.probes ?? [],
		clientDiag: [entry, ...current?.clientDiag ?? []].slice(0, CLIENT_DIAG_LIMIT),
		scans: current?.scans ?? [],
		isolation: current?.isolation ?? []
	};
}
/** 记录一次库扫描指标（最新的在前，最多 SCAN_LOG_LIMIT 条） */
function recordScan(entry) {
	current = {
		api: current?.api ?? {
			path: "",
			registered: false
		},
		prompts: current?.prompts ?? {
			section: false,
			perAgent: false
		},
		startedAt: current?.startedAt ?? Date.now(),
		probes: current?.probes ?? [],
		clientDiag: current?.clientDiag ?? [],
		scans: [entry, ...current?.scans ?? []].slice(0, SCAN_LOG_LIMIT)
	};
}
function runtimeStatus() {
	return current;
}
//#endregion
//#region src/host/library.ts
/**
* 知识库定位与装载。
*
* 定位规则（与方案 §「库 ↔ 工作区」一致）：
* 1. 优先用插件 config 的 `libraryRoot`；
* 2. 否则从**当前会话的 cwd**（`exec.agent.session.header.cwd`）向上找最近的 `library.json`
*    —— 最近的那个就是库边界（嵌套库不会把外层库的节点算进来，扫描器本身也会在边界停住）；
* 3. 找不到就抛一个**可操作**的错误，告诉用户该怎么办，而不是返回空图。
*
* 一个 DSH 工作区 = 一个知识库；插件**没有**全局「当前库」单例，一切以调用方会话为准。
*/
const NOT_FOUND_HINT = "没有找到知识库：请把「含 library.json 的知识库根目录」作为当前 DSH 工作区打开，或在本插件的 cordis.patch.yml 配置里写 libraryRoot。";
/** 标记「这是找不到库」而不是「找不到某个节点」，工具的报错码据此区分 */
const LIBRARY_DETAIL = { kind: "library" };
/** 扫描结果缓存时长：一次会话里连续几次工具调用不必反复全量扫描 */
const CACHE_TTL_MS = 1500;
const cache = /* @__PURE__ */ new Map();
/** 在途装载：同一库的并发请求合并成一次扫描 */
const inflightLoads = /* @__PURE__ */ new Map();
let revisionSeq = 0;
/**
* 最近一次装载过的库根。
*
* 用途：**面板没有会话绑定**（`main` 槽的 key 不是 `conversation` 就没有 sessionId），
* 所以面板取数据要有一个默认目标。这个值由任何一次工具调用或面板请求刷新，
* 语义是「你最近在会话里碰过的那个知识库」——比猜一个全局单例诚实得多。
*/
let lastRoot;
/**
* 知识库所在的工作区子目录名（新模型，**唯一**位置）。
*
* 产品语义：**任何工作区都可以有一个知识库**，它就在 `<工作区>/.dsh_knowledge/`。
* "这个工作区有没有知识库"完全由目录自描述 —— 不需要登记表、同步、自动清理那一套。
* 用点开头是为了尽量不污染项目视图。
*/
const KNOWLEDGE_DIR$1 = ".dsh_knowledge";
/**
* 某个目录下的**库根位置**（纯路径计算，不做 IO）。
*
* 按要求**不做兼容**：只有 `<dir>/.dsh_knowledge` 算库根；工作区根目录里就算有 library.json 也不认。
* 于是"一个工作区 = 一个知识库"，边界清晰、没有歧义。
*
* @param dir - 工作区目录（绝对路径）。
* @returns 候选库根（只有子目录这一种）。
*/
function libraryRootCandidates(dir) {
	return [path.join(path.resolve(dir), KNOWLEDGE_DIR$1)];
}
async function resolveLibraryRoot(cwd, configured) {
	const explicit = typeof configured === "string" ? configured.trim() : "";
	if (explicit !== "") {
		const root = path.resolve(explicit);
		if (!await isLibraryRoot(root)) throw new RepositoryError("not_found", `配置的 libraryRoot 下没有 library.json：${root}`, LIBRARY_DETAIL);
		return root;
	}
	if (typeof cwd !== "string" || cwd.trim() === "") throw new RepositoryError("not_found", NOT_FOUND_HINT, LIBRARY_DETAIL);
	let dir = path.resolve(cwd);
	for (let depth = 0; depth < 16; depth += 1) {
		for (const candidate of libraryRootCandidates(dir)) if (await isLibraryRoot(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	const suggestion = path.join(path.resolve(cwd), KNOWLEDGE_DIR$1);
	throw new RepositoryError("not_found", `这个工作区还没有知识库：可以创建在 ${suggestion}`, {
		kind: "library_missing",
		createPath: suggestion
	});
}
/**
* 读一个目录里 `library.json` 的 formatVersion（用来识别"老格式库"）。
*
* 只读这一个字段：undefined = 没有清单文件（普通目录）；数字 = 老格式版本号。
* 为什么不直接忽略老库：那样用户会看到"这个工作区还没有知识库"，然后在非空目录上
* 反复创建失败却不知道为什么 ✗ —— 明确报出来才能一句话解决 ✓。
*
* @param root - 目录。
* @returns 老格式版本号；不是老库时 undefined。
*/
async function readLegacyManifest(root) {
	try {
		const parsed = JSON.parse(await readFile(path.join(root, LIBRARY_FILE), "utf8"));
		if (typeof parsed?.formatVersion === "number" && parsed.formatVersion !== 3) return parsed.formatVersion;
		return;
	} catch {
		return;
	}
}
async function loadLibrary(root, options = {}) {
	const started = Date.now();
	const cached = cache.get(root);
	if (options.refresh !== true && cached !== void 0 && Date.now() - cached.at < CACHE_TTL_MS) {
		recordScan({
			at: started,
			ms: 0,
			nodes: cached.value.snapshot.nodes.length,
			edges: cached.value.snapshot.edges.length,
			cached: true
		});
		return cached.value;
	}
	const inflight = inflightLoads.get(root);
	if (inflight !== void 0) {
		const value = await inflight;
		recordScan({
			at: started,
			ms: Date.now() - started,
			nodes: value.snapshot.nodes.length,
			edges: value.snapshot.edges.length,
			cached: false,
			coalesced: true
		});
		return value;
	}
	const task = (async () => {
		const v3 = await loadV3Library(root);
		if (v3 !== void 0) {
			revisionSeq += 1;
			v3.revision = revisionSeq;
			cache.set(root, {
				at: Date.now(),
				value: v3
			});
			lastRoot = root;
			return v3;
		}
		const legacy = await readLegacyManifest(root);
		if (legacy !== void 0) throw new RepositoryError("unsupported_format", `这个知识库是老格式（formatVersion=${legacy}），当前版本只支持新格式：一节点一个 markdown（library.json 里 formatVersion: 3）。请把 ${root} 整个删掉，然后在面板里点「知识库图谱」重新创建。`, {
			kind: "legacy_library",
			formatVersion: legacy
		});
		throw new RepositoryError("not_found", `这里还不是知识库：${root}`, {
			kind: "library_missing",
			createPath: root
		});
	})();
	inflightLoads.set(root, task);
	try {
		const value = await task;
		recordScan({
			at: started,
			ms: Date.now() - started,
			nodes: value.snapshot.nodes.length,
			edges: value.snapshot.edges.length,
			cached: false
		});
		return value;
	} finally {
		inflightLoads.delete(root);
	}
}
/**
* 从某个目录**向上**找已经装载过的库根（纯内存，无 IO）。
*
* 用途：逐轮注入是同步的，而会话的 `cwd` 可能只是库的**子目录**；直接拿 cwd 查缓存会一直查不到，
* 表现就是明明在库里却一直提示「知识库尚未加载」（审查指出的行为问题）。
*
* @param cwd - 会话工作目录。
* @returns 已装载的库根；没有则 undefined。
*/
function findCachedRoot(cwd) {
	if (typeof cwd !== "string" || cwd.trim() === "") return void 0;
	let dir = path.resolve(cwd);
	for (let depth = 0; depth < 16; depth += 1) {
		if (cache.has(dir)) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
}
/** 最近一次装载过的库根；从未装载过时返回 undefined */
function lastLibraryRoot() {
	return lastRoot;
}
/** 写操作之后必须失效，否则下一次读还是旧图 */
function invalidateLibrary(root) {
	cache.delete(root);
}
/**
* 同步读已经装载过的库（不做 IO）。
*
* 用途：逐轮注入的上下文文本函数必须是**同步**的，而 `loadLibrary` 是异步的。
* 只有本会话已经调用过任意工具之后才有值；没有值时调用方要退化成
* 「先调用 kn_list_graph 加载知识库」的提示，而不是假装知道节点标题。
*/
function peekLibrary(root) {
	if (typeof root !== "string" || root === "") return void 0;
	return cache.get(root)?.value;
}
/** 取调用方会话的 cwd；没有 Agent（例如测试直接调用）时返回 undefined */
function sessionCwdOf(exec) {
	return (exec?.agent)?.session?.header?.cwd;
}
/**
* 目录**本身**是否是一个知识库（只看这一层有没有 `library.json`，不向上找）。
*
* 与 `resolveLibraryRoot` 的区别很关键：
* - 定位一个库（工具/面板取数）时向上找是对的——你在库的某个子目录里也算在库里；
* - 但**「这个工作区是不是知识库」**必须看它本身：否则把库的子目录开成工作区也会被当成知识库，
*   而那按约定只是普通工作区（入口卡片/字形都不该出现）。
*/
async function isLibraryRoot(dir) {
	if (typeof dir !== "string" || dir.trim() === "") return false;
	try {
		return await new NodeVfs(dir).exists(LIBRARY_FILE);
	} catch {
		return false;
	}
}
/**
* 只读地描述一个目录（不装载库、不写盘）。
*
* 用途：客户端在弹"是否在此创建知识库"之前先问一次——只有**空文件夹**才弹创建确认；
* 已有内容的目录直接给出可读原因，不必让人走到写入口再被拒绝。
*
* @param dir - 绝对路径目录。
* @returns 目录状态与条目数。
*/
async function describeFolder(dir) {
	const trimmed = typeof dir === "string" ? dir.trim() : "";
	if (trimmed === "" || !path.isAbsolute(trimmed)) return {
		state: "missing",
		entries: 0
	};
	try {
		if (!(await stat(trimmed)).isDirectory()) return {
			state: "missing",
			entries: 0
		};
		if (await new NodeVfs(trimmed).exists("library.json")) return {
			state: "library",
			entries: 0
		};
		const entries = await readdir(trimmed);
		return {
			state: entries.length === 0 ? "empty" : "non-empty",
			entries: entries.length
		};
	} catch {
		return {
			state: "missing",
			entries: 0
		};
	}
}
/**
* 把一个**空目录**初始化为知识库（写 `library.json` + `Nodes/`）。
*
* 四条安全约束：
* 1. **绝不覆盖**已有 `library.json`（已存在就报 `already_exists`，让用户自己决定）；
* 2. **只接受空文件夹**（目录里有任何内容就报 `not_empty`）——避免把一个正在用的目录
*    误变成知识库；已有内容的目录请用「添加工作区」，或先建一个空目录再来创建；
* 3. 只写 manifest 与一个空目录，不预建任何节点（节点由工具/界面按需创建）；
* 4. 写盘走 `NodeVfs`（临时文件 + rename），manifest 由上游 `newLibraryManifest` 构造，
*    形状与桌面版生成的一致。
*
* @param root - 目标目录（必须已存在且为空）。
* @param title - 库标题；空则取目录名。
* @returns 创建结果。
*/
async function createLibrary(root, title) {
	const trimmed = typeof root === "string" ? root.trim() : "";
	if (trimmed === "" || !path.isAbsolute(trimmed)) return {
		ok: false,
		code: "invalid_root",
		message: "需要一个绝对路径的目录"
	};
	try {
		if (!(await stat(trimmed)).isDirectory()) return {
			ok: false,
			code: "invalid_root",
			message: "这个路径不是目录"
		};
		await readdir(trimmed);
	} catch {
		return {
			ok: false,
			code: "invalid_root",
			message: "这个目录不存在或读不到"
		};
	}
	const created = await createLibrary$1(trimmed, title);
	if (!created.ok) return {
		ok: false,
		code: created.code === "already_library" ? "already_exists" : created.code,
		message: created.message
	};
	lastRoot = created.root;
	return {
		ok: true,
		root: created.root,
		title: created.title,
		libraryId: created.libraryId
	};
}
//#endregion
//#region src/host/plans.ts
/**
* 「提案 → 用户审阅 → 落地」两段式里的**提案存储与校验**（轻量模块：只依赖 fs，便于单测）。
*
* 为什么要有这一层：agent 的「添加前置」在节点不存在时会**真的建目录**，而模型很可能一次建一堆
* （实测：用户只说"搜索相关知识点"，却新建了大量节点）。所以把"建多个"改成一件正经事：
*
* 1. agent 只能**提案**（`kn_propose_prerequisites`）：写出计划，**一个节点都不建**；
* 2. 计划落盘在 `<库>/.knowledgenet/plans/<planId>.json`（库自己的数据目录，不动用户文件）；
* 3. **只有用户在面板里点击**才能落地（客户端走 HTTP 路由，不是 agent 的工具）；
* 4. 落地结果（建了哪些节点）记回计划里，供「撤销」使用。
*
* 关键不变量：**本模块只读写计划文件**，不碰节点、不碰关系——建的入口在别处（见 graph-edit.ts）。
*/
/** 计划文件所在目录（相对库根） */
const PLANS_DIR = `${ROOT_META_DIR}/plans`;
/** 计划文件路径（相对库根） */
function planRelPath(id) {
	return `${PLANS_DIR}/${id}.json`;
}
/**
* 生成计划 id：时间前缀 + 随机后缀（可读、可排序、不撞）。
* @param now - 时间来源（可注入）。
* @param random - 0..1 随机来源（可注入）。
* @returns 形如 `20250101-120000-ab12cd` 的 id。
*/
function newPlanId(now = /* @__PURE__ */ new Date(), random = Math.random) {
	return `${now.toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${Math.floor(random() * 16777215).toString(16).padStart(6, "0")}`;
}
/**
* 规范化一份提案：去空条目、按标题+归属去重、限制条数、补 id。
* @param items - 原始条目（agent 给的）。
* @param idFactory - 条目 id 生成器（可注入，便于测试）。
* @returns 规范化后的条目（可能为空数组）。
*/
function normalizePlanItems(items, idFactory = (index) => `i${index + 1}`) {
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	for (const raw of items) {
		const fromId = typeof raw.fromId === "string" ? raw.fromId.trim() : "";
		const title = typeof raw.title === "string" ? raw.title.trim() : "";
		if (fromId === "" || title === "") continue;
		const key = `${fromId}::${title}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const item = {
			id: idFactory(out.length),
			fromId,
			title
		};
		if (typeof raw.description === "string" && raw.description !== "") item.description = raw.description;
		if (typeof raw.snippet === "string" && raw.snippet !== "") item.snippet = raw.snippet;
		if (typeof raw.existingNodeId === "string" && raw.existingNodeId !== "") item.existingNodeId = raw.existingNodeId;
		out.push(item);
		if (out.length >= 30) break;
	}
	return out;
}
/**
* 校验一份计划是否可落地。
* @param plan - 计划。
* @param selectedIds - 用户勾选的条目 id；不传表示全选。
* @returns 通过时给出要落地的条目；否则给出原因。
*/
function selectPlanItems(plan, selectedIds) {
	if (plan.applied !== void 0 && plan.applied !== null) return {
		ok: false,
		code: "already_applied",
		message: "这份提案已经落地过了"
	};
	if (plan.items.length === 0) return {
		ok: false,
		code: "empty_plan",
		message: "这份提案里没有可落地的条目"
	};
	if (selectedIds === void 0) return {
		ok: true,
		items: [...plan.items]
	};
	const wanted = new Set(selectedIds);
	const items = plan.items.filter((item) => wanted.has(item.id));
	if (items.length === 0) return {
		ok: false,
		code: "nothing_selected",
		message: "没有勾选任何条目"
	};
	return {
		ok: true,
		items
	};
}
/**
* 写入计划（原子替换：先写临时文件再改名）。
* @param root - 库根。
* @param plan - 计划。
*/
async function savePlan(root, plan) {
	const dir = join(root, PLANS_DIR);
	await mkdir(dir, { recursive: true });
	const target = join(root, planRelPath(plan.id));
	const temp = `${target}.tmp`;
	await writeFile(temp, JSON.stringify(plan, null, 2), "utf8");
	await rm(target, { force: true });
	const { rename } = await import("node:fs/promises");
	await rename(temp, target);
}
/**
* 读一份计划。
* @param root - 库根。
* @param id - 计划 id。
* @returns 计划；不存在或坏了则 null。
*/
async function readPlan(root, id) {
	if (typeof id !== "string" || id.trim() === "") return null;
	try {
		const text = await readFile(join(root, planRelPath(id.trim())), "utf8");
		const parsed = JSON.parse(text);
		if (typeof parsed?.id !== "string" || !Array.isArray(parsed.items)) return null;
		return parsed;
	} catch {
		return null;
	}
}
/**
* 列出库里所有提案（新到旧）。
* @param root - 库根。
* @returns 计划列表（读坏的跳过）。
*/
async function listPlans(root) {
	let names = [];
	try {
		names = await readdir(join(root, PLANS_DIR));
	} catch {
		return [];
	}
	const plans = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const plan = await readPlan(root, name.slice(0, -5));
		if (plan !== null) plans.push(plan);
	}
	return plans.sort((a, b) => b.createdAt - a.createdAt);
}
/** 兜底窗口：即使"轮"的边界没被识别到，也不会在短时间里无限新建 */
const CREATION_WINDOW_MS = 6e5;
/** 会话 → 最近新建节点的时间戳 */
const creationLog = /* @__PURE__ */ new Map();
/** 测试可调的上限（默认走 CREATION_QUOTA） */
let quotaOverride = null;
/**
* 新一轮开始：清掉该会话的配额（由逐轮注入在每轮开头调用）。
*
* 为什么按轮而不是按时间窗：时间窗会误伤"用户明确同意了的连续创建"，
* 而"一轮"恰好就是模型自主行动的最小单位——正是要挡的范围。
*
* @param sessionId - 会话 id；不传则清空全部。
*/
function resetCreationQuotaForTurn(sessionId) {
	if (sessionId === void 0 || sessionId === null) {
		creationLog.clear();
		return;
	}
	creationLog.delete(sessionId);
}
/** 仅测试用：临时改上限（null 恢复默认） */
function __setCreationQuotaForTest(limit) {
	quotaOverride = limit;
}
/**
* 取一次新建配额。
* @param sessionId - 会话 id（null 归入匿名桶）。
* @param now - 当前时间（可注入，便于测试）。
* @returns 是否放行 + 本轮已用量。
*/
function takeCreationQuota(sessionId, now = Date.now()) {
	const limit = quotaOverride ?? 3;
	const key = sessionId ?? "(anonymous)";
	const recent = (creationLog.get(key) ?? []).filter((at) => now - at < CREATION_WINDOW_MS);
	if (recent.length >= limit) {
		creationLog.set(key, recent);
		return {
			ok: false,
			used: recent.length
		};
	}
	recent.push(now);
	creationLog.set(key, recent);
	return {
		ok: true,
		used: recent.length
	};
}
//#endregion
//#region src/vendor/upstream/data/v2/notes.ts
/**
* 主文档（通常是 `note.md`）的按需读写与冲突保护
*
* 规则（设计 §5.3、§14.2）：
* - 正文是**磁盘上的普通文件**，只有进入节点时才按需读它，绝不随图快照载入；
* - 保存必须携带手上那份的文档修订号；修订号过期、磁盘哈希不符、文件被删，
*   都返回结构化冲突（`revision_mismatch` / `hash_mismatch` / `disk_missing`），
*   让用户在「重新载入 / 覆盖保存 / 另存冲突副本」之间选择，**默认绝不覆盖**；
* - 「覆盖保存」会先把磁盘上的旧版本另存为冲突副本（放在节点自己的
*   `.meta/knowledgenet/conflicts/` 里，跟着节点文件夹一起走），用户不会丢东西。
*
* 文档修订号**不写进 `node.json`**，而是记在 `.meta/knowledgenet/notes-index.json`
* （与 Rust 端 `docs/v2-deviations.md` D5 同构）：
* `node.json` 的 `revision` 描述节点元数据的修订，文档修订描述正文文件的修订；
* 用一个数字表示两件事，会出现「改了标题导致笔记保存报冲突」这种莫名其妙的交互。
* 记账文件坏了直接重建——它是可推导的缓存，不是权威数据。
*/
/** 没有 `primaryDocument` 时的默认正文文件名 */
const DEFAULT_DOCUMENT = "note.md";
/** 记账文件相对节点目录的路径 */
const NOTES_INDEX_FILE = `${META_NS_DIR}/notes-index.json`;
/** 节点当前的主文档路径：元数据里写了就用它，否则用 `note.md` */
function documentPathOf(primaryDocument) {
	return primaryDocument && primaryDocument.trim() !== "" ? primaryDocument : DEFAULT_DOCUMENT;
}
function makeNoteFingerprint(input) {
	return {
		relativePath: input.relativePath,
		revision: input.revision,
		sha256: sha256Hex(input.content),
		byteLength: byteLengthOf(input.content),
		modifiedAt: input.modifiedAt ?? Date.now()
	};
}
function notesIndexPath(nodeRel) {
	return joinRel(nodeRel, NOTES_INDEX_FILE);
}
/** 读记账文件；缺失或坏掉都返回空索引（重建它不需要用户做任何事） */
async function readNotesIndex(vfs, nodeRel, nodeId) {
	const rel = notesIndexPath(nodeRel);
	try {
		const file = parseNotesIndexFile(await vfs.read(rel), rel);
		return file.nodeId === nodeId ? file : {
			...file,
			nodeId
		};
	} catch {
		return emptyNotesIndex(nodeId);
	}
}
async function writeNotesIndex(vfs, nodeRel, file) {
	await writeTextAtomic(vfs, notesIndexPath(nodeRel), serializeJson(file));
}
/** 取出某个文档的记账项（没有就是 null：说明这份文档还没被本应用登记过） */
async function fingerprintOf(vfs, nodeRel, nodeId, documentRel) {
	const entry = (await readNotesIndex(vfs, nodeRel, nodeId)).entries.find((item) => item.relativePath === documentRel);
	return entry ? { ...entry } : null;
}
/** 写入/更新一条记账项（保留其它文档的记账） */
async function putFingerprint(vfs, nodeRel, nodeId, fingerprint) {
	const file = await readNotesIndex(vfs, nodeRel, nodeId);
	const entry = { ...fingerprint };
	const entries = [...file.entries.filter((item) => item.relativePath !== entry.relativePath), entry];
	await writeNotesIndex(vfs, nodeRel, {
		...file,
		nodeId,
		entries
	});
}
async function diskSnapshot(vfs, nodeRel, nodeId, documentRel, fingerprint) {
	const rel = joinRel(nodeRel, documentRel);
	const entry = await fileEntry(vfs, rel);
	if (!entry) return {
		nodeId,
		relativePath: documentRel,
		content: "",
		sha256: "",
		byteLength: 0,
		modifiedAt: 0,
		documentRevision: fingerprint?.revision ?? 0
	};
	const content = await vfs.read(rel);
	return {
		nodeId,
		relativePath: documentRel,
		content,
		sha256: sha256Hex(content),
		byteLength: byteLengthOf(content),
		modifiedAt: entry.modifiedMs,
		documentRevision: fingerprint?.revision ?? 0
	};
}
/** 读主文档（进入节点时调用）；节点不存在时抛 `node_missing` */
async function readDocument(vfs, nodeRel, nodeId, documentRel) {
	const snapshot = await readNodeMeta(vfs, nodeRel);
	const doc = documentRel ?? documentPathOf(snapshot.meta.primaryDocument);
	return diskSnapshot(vfs, nodeRel, nodeId, doc, await fingerprintOf(vfs, nodeRel, nodeId, doc));
}
/** 检查磁盘上的主文档与记账是否一致（窗口重新获得焦点、进入节点时调用） */
async function checkDocument(vfs, nodeRel, nodeId, documentRel) {
	const snapshot = await readNodeMetaIfExists(vfs, nodeRel);
	if (!snapshot) throw new RepositoryError("node_missing", `节点不存在：${nodeRel}`, { relativePath: nodeRel });
	const doc = documentRel ?? documentPathOf(snapshot.meta.primaryDocument);
	const fingerprint = await fingerprintOf(vfs, nodeRel, nodeId, doc);
	const disk = await diskSnapshot(vfs, nodeRel, nodeId, doc, fingerprint);
	const exists = disk.modifiedAt > 0 || disk.sha256 !== "";
	return {
		nodeId,
		exists,
		sha256: disk.sha256,
		byteLength: disk.byteLength,
		modifiedAt: disk.modifiedAt,
		documentRevision: disk.documentRevision,
		changedOnDisk: !fingerprint || !exists || disk.sha256 !== fingerprint.sha256
	};
}
/**
* 写主文档。
*
* 判定顺序刻意固定：先看修订号（调用方手上的那份是不是最新），再看哈希
* （磁盘内容有没有被外部编辑器改过）。这样界面上给出的冲突原因总是最贴近
* 用户实际做错的那一步，而不是笼统地说「保存失败」。
*/
async function writeDocument(vfs, nodeRel, nodeId, content, expectedRevision, force = false, documentRel) {
	const snapshot = await readNodeMeta(vfs, nodeRel);
	const doc = documentRel ?? documentPathOf(snapshot.meta.primaryDocument);
	const fingerprint = await fingerprintOf(vfs, nodeRel, nodeId, doc);
	const disk = await diskSnapshot(vfs, nodeRel, nodeId, doc, fingerprint);
	const exists = disk.modifiedAt > 0 || disk.sha256 !== "";
	const registered = fingerprint !== null;
	let reason = null;
	let detail = "";
	if (expectedRevision > 0) {
		const actual = fingerprint?.revision ?? 0;
		if (!registered || expectedRevision !== actual) {
			reason = "revision_mismatch";
			detail = `手上这份不是最新版本：期望修订号 ${expectedRevision}，磁盘上是 ${actual}`;
		}
	}
	if (!reason && registered) {
		if (!exists) {
			reason = "disk_missing";
			detail = `磁盘上的 ${doc} 已经不在了（可能被外部删除或移动）`;
		} else if (disk.sha256 !== fingerprint?.sha256) {
			reason = "hash_mismatch";
			detail = `磁盘上的 ${doc} 已被外部修改（内容哈希不一致）`;
		}
	}
	if (reason && !force) return {
		status: "conflict",
		conflict: {
			disk,
			expectedRevision,
			reason,
			detail: `${detail}。可以选择重新载入磁盘版本、另存冲突副本，或明确覆盖。`
		},
		conflictCopy: null
	};
	let conflictCopy = null;
	if (reason && force && exists) {
		const previousRevision = fingerprint?.revision ?? 0;
		const name = `${stemOf(doc)}-${previousRevision}${extNameOf(doc)}`;
		const copyRel = joinRel(conflictsDir(nodeRel), name);
		await writeTextAtomic(vfs, copyRel, disk.content);
		conflictCopy = copyRel;
	}
	const now = Date.now();
	const nextRevision = (fingerprint?.relativePath ?? "") === doc ? (fingerprint?.revision ?? 0) + 1 : 1;
	const nextFingerprint = makeNoteFingerprint({
		relativePath: doc,
		revision: Math.max(1, nextRevision),
		content,
		modifiedAt: now
	});
	await writeTextAtomic(vfs, joinRel(nodeRel, doc), content);
	await putFingerprint(vfs, nodeRel, nodeId, nextFingerprint);
	return {
		status: "saved",
		note: {
			nodeId,
			relativePath: doc,
			content,
			sha256: nextFingerprint.sha256,
			byteLength: nextFingerprint.byteLength,
			modifiedAt: now,
			documentRevision: nextFingerprint.revision
		},
		conflictCopy
	};
}
/**
* 新建节点时写一份初始主文档（桌面端与演示端都这么做）。
*
* 为什么新建节点一定要有 `note.md`：用户点开节点就能直接写，
* 而不是先面对一句「还没有正文，是否创建」。
*/
async function createPrimaryDocument(vfs, nodeRel, nodeId, content = "", documentRel = DEFAULT_DOCUMENT) {
	await writeTextAtomic(vfs, joinRel(nodeRel, documentRel), content);
	const fingerprint = makeNoteFingerprint({
		relativePath: documentRel,
		revision: 1,
		content
	});
	await putFingerprint(vfs, nodeRel, nodeId, fingerprint);
	return {
		snapshot: {
			nodeId,
			relativePath: documentRel,
			content,
			sha256: fingerprint.sha256,
			byteLength: fingerprint.byteLength,
			modifiedAt: fingerprint.modifiedAt,
			documentRevision: 1
		},
		documentRevision: 1
	};
}
//#endregion
//#region src/host/mutate.ts
/**
* 写操作（P1）：建前置知识、写笔记。
*
* 三条纪律，全部照抄上游已有的判断，不另起一套：
* 1. **查重优先**：先 `findExactMatch`，再 `findSimilar`；没有明确要求新建时**不擅自建点**，
*    把候选交回给模型/用户决定——知识库里最贵的不是存储，而是同义节点。
* 2. **成环一律拒绝**：写之前用 `findCycleIfLinked` 算一遍，写之后上游 `addEdge` 还会再挡一次。
* 3. **绝不静默覆盖**：节点元数据与笔记都走修订号/哈希守卫；冲突时返回可读原因和磁盘上的最新修订号，
*    由调用方决定重读还是放弃。
*/
/** 解析归属节点（A）：显式参数 → 会话当前学习节点 → 第一个学习目标 */
function resolveFromNode(context, args) {
	const explicit = resolveNodeArg(context.snapshot, {
		id: args.fromId,
		path: args.fromPath
	});
	if (explicit !== void 0) return explicit;
	if (typeof args.currentId === "string" && args.currentId !== "") {
		const current = context.snapshot.nodes.find((node) => node.id === args.currentId);
		if (current !== void 0) return current;
	}
	const goal = context.snapshot.goals[0];
	if (goal === void 0) return void 0;
	return context.snapshot.nodes.find((node) => node.id === goal.rootNodeId);
}
/** 在「节点归属的父目录」里找一个不冲突的文件夹名 */
async function pickFolderName(context, title) {
	const parent = context.library.manifest.defaults?.newNodeParent ?? "Nodes";
	await context.library.vfs.mkdir(parent).catch(() => void 0);
	const entries = await context.library.vfs.list(parent).catch(() => []);
	return uniqueNameIn(sanitizeFolderName(title), entries.map((entry) => entry.name));
}
/** 新建一个节点：目录 + 主文档 + 元数据（不写任何关系） */
async function createNode(context, title) {
	const folder = await pickFolderName(context, title);
	const nodeRel = joinRel(context.library.manifest.defaults?.newNodeParent ?? "Nodes", folder);
	const nodeId = newUuid();
	const documentRel = documentPathOf(null);
	await context.library.vfs.mkdir(nodeRel);
	await createPrimaryDocument(context.library.vfs, nodeRel, nodeId, "", documentRel);
	await writeNodeMeta(context.library.vfs, nodeRel, newNodeMeta({
		id: nodeId,
		title,
		now: isoFromMs(Date.now()),
		primaryDocument: documentRel
	}), {
		expectedRevision: null,
		expectedHash: null
	});
	return {
		nodeRel,
		nodeId,
		title
	};
}
/**
* 手动新建一个**独立节点**（不属于任何关系）——空库里建第一个节点就靠它。
*
* 复用同一套上游写法（`newNodeMeta` + `createPrimaryDocument`），所以目录、主文档、
* 元数据与库自己的实现完全一致，不会出现"手搓出来的节点扫描不到"。
*
* @param context - 已装载的库上下文。
* @param input - 标题（必填；会按库的规则净化成文件夹名）。
* @returns 新节点的精简信息；标题非法时给出可读错误。
*/
async function createNodeFromUi(context, input) {
	const title = typeof input.title === "string" ? input.title.trim() : "";
	if (title === "") return {
		ok: false,
		error: {
			code: "title_required",
			message: "请填写知识点名称"
		}
	};
	if (title.length > 120) return {
		ok: false,
		error: {
			code: "title_too_long",
			message: "名称太长了（最多 120 字）"
		}
	};
	if (context.library.storage === "v3") {
		const made = await createNode$1(context.library.root, { title });
		if (!made.ok) return {
			ok: false,
			error: {
				code: made.code,
				message: made.message
			}
		};
		invalidateLibrary(context.library.root);
		return {
			ok: true,
			node: {
				id: made.node.id,
				title: made.node.title,
				relativePath: made.node.relativePath
			}
		};
	}
	try {
		const made = await createNode(context, title);
		return {
			ok: true,
			node: {
				id: made.nodeId,
				title: made.title,
				relativePath: made.nodeRel
			}
		};
	} catch (error) {
		return {
			ok: false,
			error: {
				code: "create_node_failed",
				message: error instanceof Error ? error.message : String(error)
			}
		};
	}
}
async function addPrerequisite(context, input, options = {}) {
	const title = normalizeTitle(input.title ?? "");
	if (title === "") return {
		ok: false,
		error: {
			code: "invalid_input",
			message: "title 不能为空"
		}
	};
	const from = resolveFromNode(context, {
		fromId: input.fromId,
		fromPath: input.fromPath,
		currentId: options.currentId
	});
	if (from === void 0) return {
		ok: false,
		error: {
			code: "invalid_input",
			message: "无法确定归属节点：请先 kn_enter_node 进入当前学习节点，或用 fromId/fromPath 指定；知识库里也可以先建一个学习目标（goals）。"
		}
	};
	const exact = findExactMatch(context.snapshot, title);
	if (exact !== void 0 && exact.id === from.id) return {
		ok: false,
		error: {
			code: "invalid_input",
			message: `「${title}」就是当前节点自己，不能设为它自己的前置知识。`
		}
	};
	let target = exact === void 0 ? void 0 : {
		id: exact.id,
		title: exact.title,
		relativePath: exact.relativePath
	};
	let created = false;
	if (target === void 0) {
		const similar = findSimilar(context.snapshot, title, 5);
		if (input.create !== true && similar.length > 0) return {
			ok: true,
			from: summarizeNode(from),
			created: false,
			candidates: similar.map(summarizeNode),
			error: {
				code: "needs_confirmation",
				message: `「${title}」没有精确命中，但有 ${similar.length} 个相近知识点。要么复用其中一个（把它作为前置知识），要么在确认是不同概念后带 create: true 重新调用。`
			}
		};
		const made = context.library.storage === "v3" ? await (async () => {
			const created = await createNode$1(context.library.root, { title });
			if (!created.ok) throw new Error(`v3 建点失败：${created.code} ${created.message}`);
			return {
				nodeId: created.node.id,
				title: created.node.title,
				nodeRel: created.node.relativePath
			};
		})() : await createNode(context, title);
		target = {
			id: made.nodeId,
			title: made.title,
			relativePath: made.nodeRel
		};
		created = true;
	}
	const cycle = findCycleIfLinked(context.snapshot, from.id, target.id);
	if (cycle !== null) return {
		ok: false,
		from: summarizeNode(from),
		cycle,
		error: {
			code: "cycle_rejected",
			message: `这会让依赖成环：${cycle.join(" → ")}。前置关系必须是 DAG。`
		}
	};
	if (context.library.storage === "v3") {
		const added = await addEdge(context.library.root, {
			fromId: from.id,
			toId: target.id,
			type: input.relationType?.trim() || "prerequisite",
			description: input.description ?? "",
			...typeof input.evidence?.snippet === "string" && input.evidence.snippet.trim() !== "" ? { source: {
				snippet: input.evidence.snippet.slice(0, 2e3),
				question: input.evidence?.question ?? "",
				...input.evidence?.messageId === void 0 ? {} : { messageId: input.evidence.messageId },
				at: Date.now()
			} } : {}
		});
		if (!added.ok) return {
			ok: false,
			from: summarizeNode(from),
			error: {
				code: added.code,
				message: added.message
			}
		};
		invalidateLibrary(context.library.root);
		return {
			ok: true,
			from: summarizeNode(from),
			created,
			node: {
				id: target.id,
				title: target.title,
				path: target.relativePath,
				status: "todo",
				aliases: [],
				health: "ok",
				revision: 1
			},
			edge: {
				id: added.edge.id,
				type: added.edge.type,
				description: added.edge.description ?? ""
			},
			evidenceRecorded: added.edge.source !== void 0
		};
	}
	try {
		const edge = await addEdge$1(context.library.vfs, from.relativePath, from.id, {
			toNodeId: target.id,
			toTitle: target.title,
			relationType: input.relationType?.trim() || "prerequisite",
			description: input.description ?? ""
		});
		let evidenceRecorded = false;
		const snippet = input.evidence?.snippet;
		if (typeof snippet === "string" && snippet.trim() !== "") {
			await addEvidence(context.library.vfs, from.relativePath, from.id, edge.id, {
				threadId: input.evidence?.sessionId ?? null,
				messageId: input.evidence?.messageId ?? null,
				snippet: snippet.slice(0, 2e3),
				question: input.evidence?.question ?? ""
			});
			evidenceRecorded = true;
		}
		invalidateLibrary(context.library.root);
		const madeNode = (await readNodeMeta(context.library.vfs, target.relativePath).catch(() => null))?.meta;
		const summary = madeNode === void 0 || madeNode === null ? {
			id: target.id,
			title: target.title,
			path: target.relativePath,
			status: exact?.status ?? "todo",
			aliases: exact?.aliases ?? [],
			health: exact?.health ?? "ok",
			revision: exact?.revision ?? 1
		} : {
			id: madeNode.id,
			title: madeNode.title,
			path: target.relativePath,
			status: madeNode.status,
			aliases: madeNode.aliases,
			health: "ok",
			revision: madeNode.revision
		};
		return {
			ok: true,
			from: summarizeNode(from),
			node: summary,
			created,
			edge: {
				id: edge.id,
				type: edge.type,
				description: edge.description
			},
			evidenceRecorded
		};
	} catch (error) {
		if (error instanceof RepositoryError) return {
			ok: false,
			from: summarizeNode(from),
			error: {
				code: error.code,
				message: error.message
			}
		};
		throw error;
	}
}
/** 写笔记：不带 expectedRevision 时按「刚读过」处理（先校验再写），绝不静默覆盖 */
async function writeNote(context, node, text, expectedRevision) {
	if (context.library.storage === "v3") {
		const current = await readNode(context.library.root, { id: node.id });
		if (!current.ok) return {
			ok: false,
			node: summarizeNode(node),
			error: {
				code: current.code,
				message: current.message
			}
		};
		const guard = current.node.hash;
		const written = await writeNote$1(context.library.root, {
			id: node.id,
			text,
			expectedHash: guard
		});
		if (!written.ok) return {
			ok: false,
			node: summarizeNode(node),
			error: {
				code: written.code,
				message: written.message
			}
		};
		invalidateLibrary(context.library.root);
		return {
			ok: true,
			node: summarizeNode(node),
			revision: written.node.rev
		};
	}
	const nodeRel = node.relativePath;
	const meta = (await readNodeMeta(context.library.vfs, nodeRel)).meta;
	const documentRel = documentPathOf(meta.primaryDocument);
	let revision = expectedRevision;
	if (revision === void 0) revision = (await checkDocument(context.library.vfs, nodeRel, node.id, documentRel)).documentRevision;
	const outcome = await writeDocument(context.library.vfs, nodeRel, node.id, text, revision, false, documentRel);
	if (outcome.status === "conflict") return {
		ok: false,
		node: summarizeNode(node),
		error: {
			code: "external_change_conflict",
			message: `${outcome.conflict.reason}：${outcome.conflict.detail}`,
			actualRevision: outcome.conflict.disk?.documentRevision
		}
	};
	invalidateLibrary(context.library.root);
	return {
		ok: true,
		node: summarizeNode(node),
		note: {
			path: documentRel,
			byteLength: outcome.note.byteLength,
			documentRevision: outcome.note.documentRevision
		}
	};
}
/** 读笔记正文（`kn_read_node` 与注入上下文共用） */
async function readNote(context, node, maxChars = 6e3) {
	const nodeRel = node.relativePath;
	const meta = (await readNodeMeta(context.library.vfs, nodeRel)).meta;
	const documentRel = documentPathOf(meta.primaryDocument);
	try {
		const snapshot = await readDocument(context.library.vfs, nodeRel, node.id, documentRel);
		const content = snapshot.content ?? "";
		return {
			path: documentRel,
			text: content.length > maxChars ? content.slice(0, maxChars) : content,
			truncated: content.length > maxChars,
			byteLength: snapshot.byteLength
		};
	} catch {
		return {
			path: documentRel,
			text: "",
			truncated: false,
			byteLength: 0
		};
	}
}
/**
* 边数上限：节点被裁到 400 时，边仍可能成倍于节点（枢纽节点尤其明显）。
* 超出部分直接截断——图上画不下，模型也不需要。
*/
const MAX_EDGES = 4e3;
/**
* 载荷字节预算（序列化后）。
*
* 为什么放在这里：`maxNodes` 只限制**节点数**，节点很多或说明很长时载荷仍可能到几 MB，
* 面板首载与模型上下文都要为它付费（审查指出）。超预算就从尾部丢节点重算，直到进预算。
*/
const MAX_PAYLOAD_BYTES = 18e5;
function clampMaxNodes(value) {
	return Math.min(Math.max(typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 400, 10), 2e3);
}
/** 说明超长就截断（加省略号），避免单条说明把载荷撑大 */
function clipDescription(value) {
	if (typeof value !== "string" || value.length <= 240) return value;
	return `${value.slice(0, 240)}…`;
}
/** 按上限裁剪节点，并只保留两端都留下的边 */
function clipGraph(snapshot, maxNodes) {
	const nodes = snapshot.nodes.slice(0, maxNodes).map(summarizeNode);
	const kept = new Set(nodes.map((node) => node.id));
	const allEdges = snapshot.edges.filter((edge) => kept.has(edge.fromId) && kept.has(edge.toId)).map((edge) => {
		const summary = summarizeEdge(edge);
		if (typeof summary.description === "string") summary.description = clipDescription(summary.description) ?? "";
		return summary;
	});
	const edges = allEdges.slice(0, MAX_EDGES);
	return {
		truncated: snapshot.nodes.length > nodes.length || allEdges.length > edges.length,
		nodes,
		edges
	};
}
/** 聚焦谁：显式 rootId 优先，否则第一个学习目标；都没有就不聚焦（二维视图会退化成平铺） */
function focusOf(snapshot, rootId) {
	if (typeof rootId === "string" && rootId.trim() !== "") {
		const found = snapshot.nodes.find((node) => node.id === rootId.trim());
		if (found !== void 0) return found.id;
		return null;
	}
	const goal = snapshot.goals[0];
	return goal === void 0 ? null : goal.rootNodeId;
}
function graphPayload(context, options = {}) {
	const snapshot = context.snapshot;
	const clipped = clipGraph(snapshot, clampMaxNodes(options.maxNodes));
	const payload = {
		library: {
			root: context.library.root,
			name: context.library.manifest.title,
			formatVersion: context.library.manifest.formatVersion
		},
		focusId: options.focusId ?? focusOf(snapshot, options.rootId),
		goals: snapshot.goals.map((goal) => ({
			id: goal.id,
			title: goal.title,
			rootNodeId: goal.rootNodeId
		})),
		nodes: clipped.nodes,
		edges: clipped.edges,
		counts: {
			nodes: snapshot.nodes.length,
			edges: snapshot.edges.length,
			issues: context.library.report.issues.length
		},
		issues: context.library.report.issues.slice(0, 5).map((issue) => ({
			code: issue.code,
			relativePath: issue.relativePath,
			detail: issue.detail
		})),
		truncated: clipped.truncated,
		revision: snapshot.revision
	};
	if (JSON.stringify(payload).length > 18e5) {
		let nodes = payload.nodes;
		let edges = payload.edges;
		while (nodes.length > 10 && JSON.stringify({
			...payload,
			nodes,
			edges
		}).length > 18e5) {
			nodes = nodes.slice(0, Math.max(10, Math.floor(nodes.length * .8)));
			const kept = new Set(nodes.map((node) => node.id));
			edges = edges.filter((edge) => kept.has(edge.fromId) && kept.has(edge.toId));
		}
		payload.nodes = nodes;
		payload.edges = edges;
		payload.truncated = true;
	}
	return payload;
}
//#endregion
//#region src/shared/routes.ts
/**
* 宿主与客户端半共用的常量（叶子模块，两个 bundle 都能安全引入）。
*
* 客户端**不能**从 `src/host/api.ts` 取这些值：那会把整条宿主模块图（含 `node:fs`）拖进浏览器包。
*/
/** 宿主注册用的绝对路径 */
const GRAPH_API_PATH = "/api/knowledgenet.graph";
/** 浏览器侧使用的 document-relative 形式（走 Connection 的 HTTP 载体） */
const GRAPH_API_ROUTE = GRAPH_API_PATH.slice(1);
//#endregion
//#region src/host/stack.ts
const ENTER_TOOL = "kn_enter_node";
const BACK_TOOL = "kn_back";
function idFromArguments(raw) {
	if (typeof raw !== "string" || raw.trim() === "") return null;
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		const id = parsed.id;
		return typeof id === "string" && id.trim() !== "" ? id.trim() : null;
	} catch {
		return null;
	}
}
/** 从事件列表折叠出学习栈（栈底在前，栈顶在最后） */
function foldStack(events) {
	const last = events.length > 0 ? events[events.length - 1] : null;
	if (foldCache !== null && foldCache.length === events.length && foldCache.last === last) return foldCache.result;
	const stack = [];
	for (const event of events) {
		if (event === null || typeof event !== "object") continue;
		if (event.type !== "tool/call") continue;
		const name = event.data?.name;
		if (name === ENTER_TOOL) {
			const id = idFromArguments(event.data?.arguments);
			if (id === null) continue;
			const at = stack.indexOf(id);
			if (at >= 0) stack.splice(at, 1);
			stack.push(id);
		} else if (name === BACK_TOOL) stack.pop();
	}
	foldCache = {
		length: events.length,
		last,
		result: stack
	};
	return stack;
}
/** foldStack 的记忆（长度 + 末事件引用 + 结果）：会话日志只追加，所以这样判等是安全的 */
let foldCache = null;
/** 取会话的完整自有事件；拿不到（非 Agent 调用、宿主版本差异）时返回空数组 */
function eventsOf(session) {
	const snapshotEvents = session?.snapshotEvents;
	if (typeof snapshotEvents !== "function") return [];
	try {
		const events = snapshotEvents.call(session);
		return Array.isArray(events) ? events : [];
	} catch {
		return [];
	}
}
/** 会话当前的学习栈 */
function stackOf(session) {
	return foldStack(eventsOf(session));
}
/** 会话当前的知识点 id（栈顶）；空栈返回 null */
function currentIdOf(session) {
	const stack = stackOf(session);
	return stack.length > 0 ? stack[stack.length - 1] : null;
}
/** `kn_enter_node` 之后的新栈（当前这次调用还没落盘，所以要自己算一遍） */
function stackAfterEnter(session, id) {
	const stack = [...stackOf(session)];
	const at = stack.indexOf(id);
	if (at >= 0) stack.splice(at, 1);
	stack.push(id);
	return stack;
}
/** `kn_back` 之后的新栈 */
function stackAfterBack(session) {
	const stack = [...stackOf(session)];
	return {
		previous: stack.length > 0 ? stack.pop() ?? null : null,
		stack
	};
}
//#endregion
//#region src/host/tools.ts
/**
* 工具集：P0 只读（图谱 / 查重 / 读节点）+ P1 写入（建前置 / 进入 / 返回 / 写笔记）。
*
* 工具定义刻意写成**裸对象字面量**，不 import 任何 `@deepseek-ai/*`：
* 这样 Host 半在 profile 里既不需要解析宿主包，也不会因为宿主版本变化而装不上。
*
* 两条踩过的坑，改这里之前先看：
* 1. `parameters` 会被**原样**当作函数 schema 发给模型（`ctx.tools.register` 只校验
*    `output.schema`），所以它必须是标准 JSON Schema（`{ type: "object", properties, required }`）。
*    `defineTool` 才接受「字段表」写法（`{ query: { type: "string", required: true } }`），
*    裸注册用那种写法会被模型 API 拒绝：`schema must be a JSON Schema of 'type: "object"'`。
* 2. `output.schema.type` 必须是 JSON Schema 支持的取值；`{ type: "json" }` 会在注册时被
*    `assertSupportedJsonSchema` 拒掉（`schema.type must be one of object/array/…`）。
*
* 数据一律来自调用方**会话工作区**定位到的知识库；客户端不读库，读图靠工具结果。
*/
function renderJson(value) {
	return [{
		type: "text",
		text: JSON.stringify(value)
	}];
}
function errorPayload(error, code = "unknown") {
	if (error instanceof RepositoryError) {
		const detail = error.detail;
		if (detail?.kind === "library_missing") return {
			ok: false,
			error: {
				code: "library_missing",
				message: error.message,
				...typeof detail.createPath === "string" ? { createPath: detail.createPath } : {}
			}
		};
		return {
			ok: false,
			error: {
				code: detail?.kind === "library" ? "library_unavailable" : error.code,
				message: error.message
			}
		};
	}
	return {
		ok: false,
		error: {
			code,
			message: error instanceof Error ? error.message : String(error)
		}
	};
}
function fail(code, message) {
	return {
		ok: false,
		error: {
			code,
			message
		}
	};
}
/** 解析调用方会话对应的知识库；失败时抛 RepositoryError（由各工具转成可读错误） */
async function openFor(exec, config, options = {}) {
	const library = await loadLibrary(await resolveLibraryRoot(sessionCwdOf(exec), config.libraryRoot), options);
	return {
		library,
		snapshot: library.snapshot
	};
}
function createTools(config = {}) {
	return [
		{
			name: "kn_list_graph",
			description: "列出当前知识库（DSH 工作区）里的知识点与依赖关系。方向约定：A → B 表示「为了理解 A，需要先理解 B」，即 B 是 A 的前置知识。返回每个节点的标题、相对路径、学习状态与前置计数，以及 goals（学习入口）。需要看某个节点周围的一跳关系时优先用它并传 focusId。",
			parameters: {
				type: "object",
				properties: {
					rootId: {
						type: "string",
						description: "可选：要聚焦的节点 id；不传则用第一个学习目标。"
					},
					maxNodes: {
						type: "number",
						description: "可选：返回节点上限，默认 400。"
					},
					refresh: {
						type: "boolean",
						description: "可选：为 true 时跳过缓存重新扫描知识库。"
					}
				}
			},
			output: {
				schema: { type: "object" },
				render: (_args, value) => renderJson(value)
			},
			async execute(args, exec) {
				try {
					return {
						ok: true,
						...graphPayload(await openFor(exec, config, { refresh: args.refresh === true }), {
							rootId: args.rootId,
							maxNodes: args.maxNodes
						})
					};
				} catch (error) {
					return errorPayload(error, "library_unavailable");
				}
			}
		},
		{
			name: "kn_find_node",
			description: "【只读】只查库，**不创建任何节点、不改任何关系**；用户说「搜索 / 找找 / 有哪些」时就用它，不要为了顺手补全而调用任何写入工具。在知识库里按标题/别名查找知识点，用于「这个概念已经有了吗」这类复用判断。返回 exact（标题完全一致）与 similar（相近候选）。",
			parameters: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description: "要查找的标题或别名。"
					},
					limit: {
						type: "number",
						description: "可选：相似候选上限，默认 8。"
					}
				},
				required: ["query"]
			},
			output: {
				schema: { type: "object" },
				render: (_args, value) => renderJson(value)
			},
			async execute(args, exec) {
				const query = typeof args.query === "string" ? normalizeTitle(args.query) : "";
				if (query === "") return fail("invalid_input", "query 不能为空");
				try {
					const context = await openFor(exec, config);
					const limit = typeof args.limit === "number" ? Math.min(Math.max(Math.trunc(args.limit), 1), 50) : 8;
					const found = search(context.snapshot, query, limit);
					return {
						ok: true,
						query,
						exact: found.exact,
						similar: found.similar
					};
				} catch (error) {
					return errorPayload(error, "library_unavailable");
				}
			}
		},
		{
			name: "kn_read_node",
			description: "读取一个知识点的完整信息：元数据、主文档正文（笔记）、它的前置知识与后继节点、以及依赖边（存在库里的 `graph.json`，含「为什么依赖」的说明与来源）。先用它拿到上下文，再决定要不要建新的前置知识。",
			parameters: {
				type: "object",
				properties: {
					id: {
						type: "string",
						description: "节点 id（与 path 二选一）。"
					},
					path: {
						type: "string",
						description: "节点相对知识库根的路径，例如 Nodes/注意力机制（与 id 二选一）。"
					},
					title: {
						type: "string",
						description: "标题（与 id/path 三选一，精确匹配）。"
					},
					noteMaxChars: {
						type: "number",
						description: "可选：正文返回字数上限，默认 6000。"
					}
				}
			},
			output: {
				schema: { type: "object" },
				render: (_args, value) => renderJson(value)
			},
			async execute(args, exec) {
				try {
					const context = await openFor(exec, config);
					const node = resolveNodeArg(context.snapshot, {
						id: args.id,
						path: args.path,
						title: args.title
					});
					if (node === void 0) return fail("not_found", "没有找到该节点：请用 kn_find_node 确认真实标题或路径。");
					const noteMaxCharsV3 = typeof args.noteMaxChars === "number" && args.noteMaxChars > 0 ? Math.trunc(args.noteMaxChars) : 6e3;
					if (context.library.storage === "v3") {
						const read = await readNode(context.library.root, { id: node.id });
						if (!read.ok) return {
							ok: false,
							error: {
								code: read.code,
								message: read.message
							}
						};
						const full = read.node.note ?? "";
						const truncated = full.length > noteMaxCharsV3;
						return {
							ok: true,
							node: {
								...summarizeNode(node),
								primaryDocument: node.relativePath,
								createdAt: node.createdAt,
								updatedAt: node.updatedAt
							},
							note: {
								path: node.relativePath,
								text: truncated ? full.slice(0, noteMaxCharsV3) : full,
								truncated,
								byteLength: Buffer.byteLength(full, "utf8"),
								maxChars: noteMaxCharsV3
							},
							prerequisites: prerequisitesOf(context.snapshot, node.id).map(summarizeNode),
							dependents: dependentsOf(context.snapshot, node.id).map(summarizeNode),
							relations: read.prerequisites.map((edge) => ({
								id: edge.id,
								toNodeId: edge.toId,
								toTitle: context.snapshot.nodes.find((item) => item.id === edge.toId)?.title ?? "",
								relationType: edge.type,
								description: edge.description ?? "",
								evidence: edge.source === void 0 ? [] : [{
									threadId: null,
									messageId: edge.source.messageId ?? null,
									snippet: edge.source.snippet ?? ""
								}]
							})),
							resources: []
						};
					}
					const nodeRel = node.relativePath;
					const meta = (await readNodeMeta(context.library.vfs, nodeRel)).meta;
					const noteMaxChars = typeof args.noteMaxChars === "number" && args.noteMaxChars > 0 ? Math.trunc(args.noteMaxChars) : 6e3;
					const note = await readNote(context, node, noteMaxChars);
					const relations = await readRelations(context.library.vfs, nodeRel, node.id).catch(() => null);
					const resources = await listResources(context.library.vfs, nodeRel).catch(() => []);
					return {
						ok: true,
						node: {
							...summarizeNode(node),
							primaryDocument: meta.primaryDocument,
							createdAt: node.createdAt,
							updatedAt: node.updatedAt
						},
						note: {
							path: note.path,
							text: note.text,
							truncated: note.truncated,
							byteLength: note.byteLength,
							maxChars: noteMaxChars
						},
						prerequisites: prerequisitesOf(context.snapshot, node.id).map(summarizeNode),
						dependents: dependentsOf(context.snapshot, node.id).map(summarizeNode),
						relations: relations === null ? [] : relations.file.outgoing.map((edge) => ({
							id: edge.id,
							toNodeId: edge.toNodeId,
							toTitle: edge.toTitleSnapshot,
							relationType: edge.type,
							description: edge.description,
							evidence: edge.evidence.map((item) => ({
								threadId: item.threadId,
								messageId: item.messageId,
								snippet: item.snippet
							}))
						})),
						resources: resources.map((resource) => ({
							id: resource.id,
							title: resource.title,
							type: resource.type
						}))
					};
				} catch (error) {
					return errorPayload(error, "library_unavailable");
				}
			}
		},
		{
			name: "kn_add_prerequisite",
			description: "把「当前（或指定）知识点还不懂的一个概念」记成它的前置知识：A → B，B 是 A 的前置。先查重：标题完全一致就复用已有节点；只命中相近候选时**不会**擅自建点，而是返回 candidates 让你先问用户「复用哪个 / 还是新建」；确认是不同概念后带 create: true 重试。从回答里划词得到的原文放进 evidence.snippet，这样关系会带上出处（可回溯到哪次回答）。成环会被拒绝；节点元数据与关系文件都有修订号/哈希守卫，冲突时不会覆盖。【写入纪律·必须遵守】这是**写操作**，且节点不存在时会真的新建：① 用户只要求“搜索/看看/有哪些”时**不得调用本工具**（用 kn_find_node / kn_list_graph）；② 调用前要在回复里说明“准备把 B 作为 A 的前置（新建/复用）”，并**等用户同意**；③ 同一轮最多用一次；需要一次处理多个概念时，**必须**改用 kn_propose_prerequisites 提交提案，由用户在面板里审阅后再落地；④ 超过配额会被拒绝并提示你改用提案。",
			parameters: {
				type: "object",
				properties: {
					title: {
						type: "string",
						description: "要设为前置的概念标题（从回答里选中的文字归一化后）。"
					},
					fromId: {
						type: "string",
						description: "可选：归属节点（依赖方）的 id；缺省用会话当前学习节点。"
					},
					fromPath: {
						type: "string",
						description: "可选：归属节点的相对路径（与 fromId 二选一）。"
					},
					create: {
						type: "boolean",
						description: "可选：为 true 时明确要求新建节点（跳过「相近候选先确认」）。"
					},
					relationType: {
						type: "string",
						description: "可选：关系类型，默认 prerequisite。"
					},
					description: {
						type: "string",
						description: "可选：为什么 A 需要 B（回来后恢复上下文用）。"
					},
					snippet: {
						type: "string",
						description: "可选：触发这次建点的原文片段（来源记录）。"
					},
					question: {
						type: "string",
						description: "可选：当时用户的问题（来源记录）。"
					},
					messageId: {
						type: "string",
						description: "可选：来源消息 id（来源记录）。"
					}
				},
				required: ["title"]
			},
			output: {
				schema: { type: "object" },
				render: (_args, value) => renderJson(value)
			},
			async execute(args, exec) {
				try {
					const context = await openFor(exec, config);
					const sessionId = exec?.agent?.id ?? null;
					const fromAgent = exec?.agent !== void 0;
					if (args.create === true && fromAgent) {
						const verdict = takeCreationQuota(sessionId);
						if (verdict.ok !== true) return {
							ok: false,
							error: {
								code: "creation_quota_exceeded",
								message: `本轮已新建 ${verdict.used} 个节点（窗口 ${Math.round(CREATION_WINDOW_MS / 6e4)} 分钟内上限 3 个），已拒绝继续新建。请先向用户说明要建哪些，并用 kn_propose_prerequisites 提交提案，由用户在面板里审阅落地。`
							},
							quota: {
								used: verdict.used,
								limit: 3
							}
						};
					}
					const result = await addPrerequisite(context, {
						title: String(args.title ?? ""),
						fromId: args.fromId,
						fromPath: args.fromPath,
						create: args.create === true,
						relationType: args.relationType,
						description: args.description,
						evidence: {
							sessionId,
							messageId: args.messageId ?? null,
							snippet: args.snippet,
							question: args.question ?? null
						}
					}, { currentId: currentIdOf(sessionOf(exec)) });
					if (result.ok === true) await refreshQuietly(context.library.root);
					return {
						...result,
						currentStack: stackOf(sessionOf(exec))
					};
				} catch (error) {
					return errorPayload(error, "library_unavailable");
				}
			}
		},
		{
			name: "kn_enter_node",
			description: "进入一个知识点（把它压到学习栈顶）：之后「当前知识点」就是它，逐轮注入的上下文与后续建前置都会以它为准。沿依赖往下学（先弄懂前置）时用它；学完用 kn_back 回到上一层。标题/路径/id 都可以，栈从会话事件流折叠得到，因此换会话、恢复、fork 都不会丢。",
			parameters: {
				type: "object",
				properties: {
					id: {
						type: "string",
						description: "节点 id（与 path/title 三选一）。"
					},
					path: {
						type: "string",
						description: "节点相对知识库根的路径。"
					},
					title: {
						type: "string",
						description: "节点标题（精确匹配）。"
					}
				}
			},
			output: {
				schema: { type: "object" },
				render: (_args, value) => renderJson(value)
			},
			async execute(args, exec) {
				try {
					const context = await openFor(exec, config);
					const node = resolveNodeArg(context.snapshot, {
						id: args.id,
						path: args.path,
						title: args.title
					});
					if (node === void 0) return fail("not_found", "没有找到该节点：请用 kn_find_node 确认真实标题或路径。");
					const stack = stackAfterEnter(sessionOf(exec), node.id);
					return {
						ok: true,
						current: summarizeNode(node),
						stackDepth: stack.length,
						prerequisites: prerequisitesOf(context.snapshot, node.id).map((item) => ({
							id: item.id,
							title: item.title,
							status: item.status
						})),
						dependents: dependentsOf(context.snapshot, node.id).map((item) => ({
							id: item.id,
							title: item.title,
							status: item.status
						})),
						note: "已进入该节点；返回上一层用 kn_back。"
					};
				} catch (error) {
					return errorPayload(error, "library_unavailable");
				}
			}
		},
		{
			name: "kn_back",
			description: "弹出学习栈顶，回到上一层知识点（深度优先学习里的「返回」）。返回新的当前节点；栈空时返回 ok: false。",
			parameters: {
				type: "object",
				properties: {}
			},
			output: {
				schema: { type: "object" },
				render: (_args, value) => renderJson(value)
			},
			async execute(_args, exec) {
				try {
					const context = await openFor(exec, config);
					const { previous, stack } = stackAfterBack(sessionOf(exec));
					if (previous === null) return fail("empty_stack", "学习栈是空的：还没有用 kn_enter_node 进入过任何知识点。");
					const current = stack.length === 0 ? null : context.snapshot.nodes.find((node) => node.id === stack[stack.length - 1]);
					return {
						ok: true,
						left: previous,
						current: current === void 0 || current === null ? null : summarizeNode(current),
						stackDepth: stack.length
					};
				} catch (error) {
					return errorPayload(error, "library_unavailable");
				}
			}
		},
		{
			name: "kn_write_note",
			description: "写当前（或指定）知识点的主文档正文。默认按「刚读过」处理：先取磁盘上的修订号再写，期间被外部（编辑器/桌面版）改过就拒绝并返回 actualRevision，绝不静默覆盖；要强制覆盖请显式带上刚读到的 expectedRevision（仍然会被哈希守卫拦一次）。",
			parameters: {
				type: "object",
				properties: {
					text: {
						type: "string",
						description: "新的主文档正文（整体替换）。"
					},
					id: {
						type: "string",
						description: "可选：节点 id；缺省用会话当前学习节点。"
					},
					path: {
						type: "string",
						description: "可选：节点相对路径。"
					},
					title: {
						type: "string",
						description: "可选：节点标题。"
					},
					expectedRevision: {
						type: "number",
						description: "可选：手上那份的文档修订号。"
					}
				},
				required: ["text"]
			},
			output: {
				schema: { type: "object" },
				render: (_args, value) => renderJson(value)
			},
			async execute(args, exec) {
				try {
					const context = await openFor(exec, config);
					const session = sessionOf(exec);
					const explicit = resolveNodeArg(context.snapshot, {
						id: args.id,
						path: args.path,
						title: args.title
					});
					const currentId = currentIdOf(session);
					const node = explicit ?? (currentId === null ? void 0 : context.snapshot.nodes.find((item) => item.id === currentId));
					if (node === void 0) return fail("invalid_input", "没有指定节点，且会话还没有当前学习节点：先用 kn_enter_node 进入一个知识点。");
					const expected = typeof args.expectedRevision === "number" ? Math.trunc(args.expectedRevision) : void 0;
					const result = await writeNote(context, node, String(args.text ?? ""), expected);
					if (result.ok === true) await refreshQuietly(context.library.root);
					return result;
				} catch (error) {
					return errorPayload(error, "library_unavailable");
				}
			}
		},
		{
			name: "kn_status",
			description: "诊断用工具：只在面板打不开、或怀疑本插件没生效时调用。报告运行时状态——面板数据路由是否已注册、逐轮注入是否生效、当前学习栈，以及知识库能否定位。日常学习不需要它。",
			parameters: {
				type: "object",
				properties: {}
			},
			output: {
				schema: { type: "object" },
				render: (_args, value) => renderJson(value)
			},
			async execute(_args, exec) {
				const status = runtimeStatus();
				const stack = stackOf(sessionOf(exec));
				let library = null;
				let libraryError = null;
				try {
					const context = await openFor(exec, config);
					library = {
						root: context.library.root,
						name: context.library.manifest.title,
						nodes: context.snapshot.nodes.length,
						edges: context.snapshot.edges.length,
						goals: context.snapshot.goals.length,
						issues: context.library.report.issues.length
					};
				} catch (error) {
					libraryError = errorPayload(error, "library_unavailable").error ?? null;
				}
				const routeRegistered = status?.api?.registered === true;
				return {
					ok: true,
					status: status ?? null,
					route: GRAPH_API_PATH,
					routeRegistered,
					probes: status?.probes ?? [],
					clientDiag: status?.clientDiag ?? [],
					library,
					libraryError,
					currentStack: stack,
					currentNodeId: stack.length > 0 ? stack[stack.length - 1] : null,
					hint: routeRegistered ? "面板数据路由已注册。" : "面板数据路由**未注册**：宿主模块只有重启 DSH 才会重新加载（刷新页面只更新客户端半，所以面板会显示纯文本 not found）。重启后若仍未注册，请把本结果里的 status 发出来。"
				};
			}
		},
		{
			name: "kn_propose_prerequisites",
			description: "提交一份「新建/挂接前置」的**提案**：只写计划文件，**不建节点、不改关系**。只要需要一次处理多个概念（或用户还没明确同意逐个建），就用它而不是反复调 kn_add_prerequisite。返回 planId 与条目清单；**落地只能由用户在「知识库图谱」面板里点击完成，你不能自行落地**。提交后请把 planId 与清单告诉用户，等用户审阅。",
			parameters: {
				type: "object",
				properties: {
					items: {
						type: "array",
						description: "提案条目：每条的 {fromId, title}，可选 description（为什么 A 需要 B）与 snippet（原文出处）。",
						items: {
							type: "object",
							properties: {
								fromId: {
									type: "string",
									description: "归属节点（A → B 里的 A）的 id。"
								},
								title: {
									type: "string",
									description: "前置概念标题（要新建或复用的那个）。"
								},
								description: {
									type: "string",
									description: "可选：为什么 A 需要 B。"
								},
								snippet: {
									type: "string",
									description: "可选：触发它的原文片段。"
								}
							},
							required: ["fromId", "title"]
						}
					},
					summary: {
						type: "string",
						description: "可选：一句话说明为什么提这些。"
					},
					question: {
						type: "string",
						description: "可选：当时的用户问题（来源记录）。"
					}
				},
				required: ["items"]
			},
			output: {
				schema: { type: "object" },
				render: (_args, value) => renderJson(value)
			},
			async execute(args, exec) {
				try {
					const context = await openFor(exec, config);
					const items = normalizePlanItems((Array.isArray(args.items) ? args.items : []).map((item) => ({
						fromId: String(item.fromId ?? ""),
						title: String(item.title ?? ""),
						description: item.description,
						snippet: item.snippet
					})));
					if (items.length === 0) return {
						ok: false,
						error: {
							code: "empty_plan",
							message: "提案里没有有效条目（每条都要 fromId + title）"
						}
					};
					for (const item of items) {
						const hit = search(context.snapshot, item.title, 3).exact;
						if (hit !== null) item.existingNodeId = hit.id;
					}
					const sessionId = exec?.agent?.id ?? null;
					const plan = {
						id: newPlanId(),
						createdAt: Date.now(),
						items,
						...sessionId === null ? {} : { sessionId },
						...typeof args.summary === "string" && args.summary !== "" ? { summary: args.summary } : {},
						...typeof args.question === "string" && args.question !== "" ? { question: args.question } : {}
					};
					await savePlan(context.library.root, plan);
					return {
						ok: true,
						planId: plan.id,
						items: items.map((item) => ({
							id: item.id,
							fromId: item.fromId,
							title: item.title,
							willReuseExisting: item.existingNodeId !== void 0
						})),
						note: "提案已提交。请在「知识库图谱」面板里审阅后由用户点击落地；提案本身没有创建任何节点。"
					};
				} catch (error) {
					return errorPayload(error, "library_unavailable");
				}
			}
		},
		{
			name: "kn_plan_status",
			description: "查询一份提案的状态（**只读**，不写任何东西）：是否已落地、新建了哪些节点、有没有失败条目。用于向用户汇报「你确认后建了哪几个」。",
			parameters: {
				type: "object",
				properties: { planId: {
					type: "string",
					description: "kn_propose_prerequisites 返回的计划 id。"
				} },
				required: ["planId"]
			},
			output: {
				schema: { type: "object" },
				render: (_args, value) => renderJson(value)
			},
			async execute(args, exec) {
				try {
					const plan = await readPlan((await openFor(exec, config)).library.root, String(args.planId ?? ""));
					if (plan === null) return {
						ok: false,
						error: {
							code: "plan_unknown",
							message: "找不到这份提案"
						}
					};
					return {
						ok: true,
						planId: plan.id,
						itemCount: plan.items.length,
						applied: plan.applied !== void 0 && plan.applied !== null,
						created: plan.applied?.created ?? [],
						reused: plan.applied?.reused ?? [],
						failed: plan.applied?.failed ?? []
					};
				} catch (error) {
					return errorPayload(error, "library_unavailable");
				}
			}
		}
	];
}
/** 取调用方会话对象（`agent.session`）；测试与非 Agent 调用返回 undefined */
function sessionOf(exec) {
	return exec?.agent?.session;
}
/** 写完之后补一次扫描：失败也不影响已经落盘的写入，所以静默 */
async function refreshQuietly(root) {
	await loadLibrary(root, { refresh: true }).catch(() => void 0);
}
//#endregion
//#region src/host/remove-node-meta.ts
/**
* 「移除节点身份」的**纯文件系统实现**（轻量模块：只依赖 node:fs / node:path）。
*
* 为什么单独拆出来：`graph-edit.ts` 会连带导入 `node-vfs.ts`，而后者用了
* TypeScript 参数属性（`constructor(readonly root: string)`），Node 的类型剥离模式不支持，
* 单测里一导入就 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。拆开后这个模块可以直接单测。
*
* 语义（照库自己的实现，`src/data/repository.ts:12`）：
* **只移除节点身份**——把节点的 `.meta/knowledgenet` **移动**到
* `<root>/.knowledgenet/trash/node-metadata/<时间戳>-<节点名>/`；用户的文件夹与文件一个不动。
*/
/**
* 删除节点时"备份"的落点：**库根的 `Backup/`**（建库时就会创建）。
*
* 与库自己的 `.knowledgenet/trash/node-metadata/` 的区别：那是"只留元数据"的回收站，
* 而 `Backup/` 存的是**整个节点文件夹**（笔记、附件、元数据都在里面），用户能直接在文件管理器里
* 找回、读懂、搬回去。
*/
const BACKUP_DIR = "Backup";
/**
* 删除一个节点的**文件夹**，两种语义二选一：
* - `backup`：把整个节点文件夹**移动**到 `<root>/Backup/<时间戳>-<名字>/`（可恢复）；
* - `purge`：连同文件夹**彻底删除**（不可恢复）。
*
* 安全边界：目标必须是库根**内部**的路径，且不能就是库根本身——避免"删库"这类误操作。
*
* @param input.root - 库根（绝对路径）。
* @param input.relativePath - 节点相对库根的路径。
* @param input.mode - 删除方式。
* @param now - 时间来源（可注入，便于测试）。
* @returns 成功/失败；备份模式会回报备份位置。
*/
async function removeNodeFolder(input, now = /* @__PURE__ */ new Date()) {
	const root = typeof input.root === "string" ? input.root : "";
	const relativePath = typeof input.relativePath === "string" ? input.relativePath : "";
	const mode = input.mode === "purge" ? "purge" : "backup";
	if (root === "" || relativePath === "" || !isAbsolute(root)) return {
		ok: false,
		error: {
			code: "node_path_required",
			message: "节点路径不完整，无法删除"
		}
	};
	const rootAbs = resolve(root);
	const targetAbs = resolve(join(rootAbs, relativePath));
	const inside = relative(rootAbs, targetAbs);
	if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return {
		ok: false,
		error: {
			code: "outside_library",
			message: "这个节点不在知识库目录里，已拒绝删除"
		}
	};
	if (!await stat(targetAbs).then((info) => info.isDirectory()).catch(() => false)) return {
		ok: false,
		error: {
			code: "node_missing",
			message: "这个节点的文件夹已经不存在了"
		}
	};
	if (mode === "purge") try {
		await rm(targetAbs, {
			recursive: true,
			force: true
		});
		return {
			ok: true,
			mode
		};
	} catch (error) {
		return {
			ok: false,
			error: {
				code: "purge_failed",
				message: error instanceof Error ? error.message : String(error)
			}
		};
	}
	try {
		const stamp = now.toISOString().replace(/[:.]/g, "-");
		const name = relativePath.split(/[\\/]/).filter((part) => part !== "").pop() ?? "node";
		let backupRel = `${BACKUP_DIR}/${stamp}-${name}`;
		let backupAbs = join(rootAbs, backupRel);
		for (let index = 2; index < 100; index += 1) {
			if (!await stat(backupAbs).then(() => true).catch(() => false)) break;
			backupRel = `${BACKUP_DIR}/${stamp}-${name}-${index}`;
			backupAbs = join(rootAbs, backupRel);
		}
		await mkdir(dirname(backupAbs), { recursive: true });
		await rename(targetAbs, backupAbs);
		const identityFile = join(backupAbs, META_NS_DIR, NODE_FILE);
		if (await stat(identityFile).then(() => true).catch(() => false)) await rename(identityFile, `${identityFile}.backup`).catch(() => void 0);
		return {
			ok: true,
			mode,
			backup: backupRel
		};
	} catch (error) {
		return {
			ok: false,
			error: {
				code: "backup_failed",
				message: error instanceof Error ? error.message : String(error)
			}
		};
	}
}
//#endregion
//#region src/host/graph-edit.ts
/**
* 界面上的**图上编辑**：右键节点加前置、右键连线删依赖。
*
* 两条都复用上游已有的写入口，不自己动关系文件格式：
* - 加前置：`mutate.ts` 的 `addPrerequisite`（标题精确命中就复用已有节点；相近候选会返回 candidates，
*   由界面问用户"复用还是新建"——不擅自建重复节点）；
* - 删依赖：`data/v2/relations.ts` 的 `removeEdge`（走 `relations.json` 的原子替换 + 修订号/内容哈希守卫，
*   磁盘被外部改过就拒绝覆盖，与工具侧写笔记同一套保护）。
*/
/**
* 右键节点 → 在这个节点下加一条前置（A → B，B 是 A 的前置）。
*
* @param context - 已装载的库上下文。
* @param root - 库根（写盘成功后用来失效缓存）。
* @param input - 归属节点与标题。
* @returns 上游结果或可读错误。
*/
async function addPrerequisiteFromUi(context, root, input) {
	const fromId = typeof input.fromId === "string" ? input.fromId.trim() : "";
	const title = typeof input.title === "string" ? input.title.trim() : "";
	if (fromId === "") return {
		ok: false,
		error: {
			code: "bad_body",
			message: "缺少 fromId"
		}
	};
	if (title === "") return {
		ok: false,
		error: {
			code: "bad_body",
			message: "标题不能为空"
		}
	};
	if (context.snapshot.nodes.every((node) => node.id !== fromId)) return {
		ok: false,
		error: {
			code: "node_not_found",
			message: `找不到节点：${fromId}`
		}
	};
	const args = {
		fromId,
		title
	};
	if (input.create === true) args.create = true;
	if (typeof input.description === "string" && input.description.trim() !== "") args.description = input.description.trim();
	args.evidence = {
		snippet: typeof input.snippet === "string" && input.snippet.trim() !== "" ? input.snippet.trim().slice(0, 600) : "（由界面添加）",
		question: typeof input.question === "string" && input.question.trim() !== "" ? input.question.trim().slice(0, 300) : null
	};
	const result = await addPrerequisite(context, args);
	if (result.ok) invalidateLibrary(root);
	return {
		ok: result.ok,
		error: result.error,
		added: result
	};
}
/**
* 右键连线 → 删除这条依赖。
*
* 边只存在**源节点**的 `relations.json` 里（设计 §4.4），所以要拿到源节点；
* 删除本身由上游 `removeEdge` 做，带修订号/哈希守卫。
*
* @param context - 已装载的库上下文。
* @param root - 库根。
* @param input - 源节点 id 与关系 id。
* @returns 是否删掉了一条。
*/
async function removePrerequisiteFromUi(context, root, input) {
	const fromId = typeof input.fromId === "string" ? input.fromId.trim() : "";
	const edgeId = typeof input.edgeId === "string" ? input.edgeId.trim() : "";
	if (fromId === "" || edgeId === "") return {
		ok: false,
		error: {
			code: "bad_body",
			message: "缺少 fromId 或 edgeId"
		}
	};
	const from = context.snapshot.nodes.find((node) => node.id === fromId);
	if (from === void 0) return {
		ok: false,
		error: {
			code: "node_not_found",
			message: `找不到节点：${fromId}`
		}
	};
	if (context.library.storage === "v3") {
		const removedV3 = await removeEdge(context.library.root, edgeId);
		if (!removedV3.ok) return {
			ok: false,
			removed: false,
			error: {
				code: removedV3.code,
				message: removedV3.message
			}
		};
		invalidateLibrary(root);
		return {
			ok: true,
			removed: true
		};
	}
	try {
		const removed = await removeEdge$1(context.library.vfs, from.relativePath, from.id, edgeId);
		if (removed) invalidateLibrary(root);
		return removed ? {
			ok: true,
			removed: true
		} : {
			ok: false,
			removed: false,
			error: {
				code: "edge_not_found",
				message: "这条依赖已经不存在了"
			}
		};
	} catch (error) {
		return {
			ok: false,
			error: {
				code: "write_failed",
				message: error instanceof Error ? error.message : String(error)
			}
		};
	}
}
/**
* 给客户端的**目标节点搜索**：用户要把这段原文挂到哪个知识点下面。
*
* 复用工具侧同一套 `search`（精确命中 + 相近 + 关键词回退），所以"搜索"与模型看到的
* 结果一致，不会出现"界面上搜不到、模型却知道"的分裂。
*
* @param context - 已装载的库上下文。
* @param query - 关键词（空串返回空列表）。
* @param limit - 上限。
* @returns 精简后的候选（id/标题/状态/路径）。
*/
function searchTargets(context, query, limit = 8) {
	const text = typeof query === "string" ? query.trim() : "";
	if (text === "") return [];
	const { exact, similar } = search(context.snapshot, text, Math.max(1, Math.min(20, limit)));
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	for (const node of exact === null ? similar : [exact, ...similar]) {
		if (seen.has(node.id)) continue;
		seen.add(node.id);
		out.push({
			id: node.id,
			title: node.title,
			status: String(node.status ?? "todo"),
			path: String(node.path ?? "")
		});
	}
	return out;
}
/**
* 「删除当前节点」——按**库自己的语义**做：**移除节点身份**，不删用户的文件。
*
* 依据（项目源码）：
* - `src/data/repository.ts:12`：「删除节点」变成「移除节点身份」：只把 `.meta/knowledgenet`
*   移进回收站，用户文件夹原样保留；
* - `src/data/v2/paths.ts:33`：回收站位置就是 `<root>/.knowledgenet/trash/node-metadata/`。
*
* 所以这里**移动**（`rename`）节点的 `.meta/knowledgenet` 到回收站目录，而不是删除：
* 用户的笔记/文件一个不动，想恢复时把那一坨移回节点目录即可。
*
* @param context - 已装载的库上下文。
* @param input - 要移除身份的节点 id。
* @returns 成功/失败（失败带可读原因）。
*/
async function removeNodeFromUi(context, input) {
	const nodeId = typeof input.nodeId === "string" ? input.nodeId : "";
	if (nodeId === "") return {
		ok: false,
		error: {
			code: "node_id_required",
			message: "没有给出要删除的节点 id"
		}
	};
	const node = context.snapshot.nodes.find((item) => item.id === nodeId);
	if (node === void 0) return {
		ok: false,
		error: {
			code: "node_unknown",
			message: "找不到这个节点（可能已经被删除了）"
		}
	};
	const mode = input.mode === "purge" ? "purge" : "backup";
	if (context.library.storage === "v3") {
		const removed = await removeNode(context.library.root, { id: node.id });
		if (!removed.ok) return {
			ok: false,
			error: {
				code: removed.code,
				message: removed.message
			}
		};
		invalidateLibrary(context.library.root);
		return {
			ok: true,
			removed: {
				id: removed.id,
				title: removed.title,
				relativePath: node.relativePath
			}
		};
	}
	const outcome = await removeNodeFolder({
		root: context.library.root,
		relativePath: node.relativePath,
		mode
	});
	if (outcome.ok !== true) return {
		ok: false,
		error: outcome.error
	};
	return {
		ok: true,
		removed: {
			id: node.id,
			title: node.title,
			relativePath: node.relativePath,
			mode,
			...outcome.backup === void 0 ? {} : { backup: outcome.backup }
		}
	};
}
/**
* 落地一份提案（**只能由用户在面板里触发**，见客户端路由 `apply-plan`）。
*
* 逐条走与界面同样的写入口 `addPrerequisiteFromUi`；提案里标了 `existingNodeId` 的条目**复用**已有节点，
* 其余才新建（`create: true`）。落地结果写回计划文件，供「撤销」使用。
*
* @param context - 已装载的库上下文。
* @param root - 库根。
* @param input - 计划 id +（可选）用户勾选的条目 id。
* @returns 成功/失败；成功时带上更新后的计划。
*/
async function applyPlanFromUi(context, root, input) {
	const plan = await readPlan(root, input.planId);
	if (plan === null) return {
		ok: false,
		error: {
			code: "plan_unknown",
			message: "找不到这份提案（可能已被清理或来自别的库）"
		}
	};
	const selection = selectPlanItems(plan, input.itemIds);
	if (selection.ok !== true) return {
		ok: false,
		error: {
			code: selection.code,
			message: selection.message
		}
	};
	const created = [];
	const reused = [];
	const failed = [];
	for (const item of selection.items) {
		const result = await addPrerequisiteFromUi(context, root, {
			fromId: item.fromId,
			title: item.title,
			create: item.existingNodeId === void 0,
			description: item.description,
			snippet: item.snippet,
			question: plan.question
		});
		if (result.ok !== true) {
			failed.push({
				itemId: item.id,
				message: result.error?.message ?? "写入失败"
			});
			continue;
		}
		const entry = {
			itemId: item.id,
			nodeId: result.added?.node?.id,
			title: item.title
		};
		if (result.added?.created === true) created.push(entry);
		else reused.push(entry);
	}
	plan.applied = {
		at: Date.now(),
		created,
		reused,
		failed
	};
	await savePlan(root, plan);
	return {
		ok: true,
		plan
	};
}
/**
* 撤销一次落地：把这次**新建**出来的节点**移除身份**（`.meta/knowledgenet` 进回收站，用户文件保留）。
*
* 复用的节点不动（只解关系这件事这里不做：关系的移除有单独的入口，避免误删用户既有结构）。
*
* @param context - 已装载的库上下文。
* @param root - 库根。
* @param input - 计划 id。
* @returns 成功/失败；成功时带上更新后的计划。
*/
async function undoPlanFromUi(context, root, input) {
	const plan = await readPlan(root, input.planId);
	if (plan === null) return {
		ok: false,
		error: {
			code: "plan_unknown",
			message: "找不到这份提案"
		}
	};
	const applied = plan.applied;
	if (applied === void 0 || applied === null) return {
		ok: false,
		error: {
			code: "not_applied",
			message: "这份提案还没落地，没有可撤销的内容"
		}
	};
	let undone = 0;
	const failed = [];
	for (const entry of applied.created) {
		if (entry.nodeId === void 0) continue;
		const result = await removeNodeFromUi(context, { nodeId: entry.nodeId });
		if (result.ok === true) undone += 1;
		else failed.push({
			itemId: entry.itemId,
			message: result.error?.message ?? "移除失败"
		});
	}
	plan.applied = {
		at: applied.at,
		created: [],
		reused: applied.reused,
		failed: [...applied.failed, ...failed]
	};
	await savePlan(root, plan);
	return {
		ok: true,
		plan,
		undone
	};
}
//#endregion
//#region src/host/isolation.ts
/**
* 「插件内容只在知识库里可见」的**判定逻辑**（轻量模块：只依赖 node:fs/node:path，便于单测）。
*
* 目标（用户要求）：**只有用「添加知识库」按钮登记过的工作区**，其会话才能看到插件的提示词与 `kn_*` 工具；
* 普通工作区（哪怕目录里就有 `library.json`）一律看不到。
*
* 机制（来自 harness `packages/core/tools/lib/types/index.d.ts`）：
* - `tools.register(definition)` 是**全局**注册（所有会话都能看到）；
* - `tools.restrict({ deny: [...] })` 是**按 agent 作用域**过滤全局工具（"Restrict global tools
*   for the calling agent scope"）⇒ 在 agent 作用域调用它，就能只对该会话隐藏。
*
* 所以判定必须**同步**、且在 `agent/created` 时立刻给出（否则首轮会漏出去）：这里用
* `existsSync` 向上找 `library.json`，最多 16 层，不做任何耗时扫描。
*/
/** 知识库所在的工作区子目录名（与 library.ts 的 KNOWLEDGE_DIR 保持一致） */
const KNOWLEDGE_DIR = ".dsh_knowledge";
/**
* 某个目录（或其祖先，最多 `MAX_UPWARD` 层）里的**知识库根**。
*
* 新模型（用户设计，**不做兼容**）：库只可能在 `<工作区>/.dsh_knowledge/`；
* 工作区根目录里就算有 library.json 也不认（"一个工作区 = 一个知识库"，边界清晰）。
* 这几行刻意与 `library.ts` 的 `libraryRootCandidates` 保持一致——本模块必须只依赖
* node:fs/node:path，不能引入 library.ts 的重量级依赖。
*
* @param dir - 起始目录。
* @param probe - 可注入的探测面。
* @returns 找到库根则返回它；否则 undefined。
*/
function findLibraryRootSync(dir, probe = {}) {
	const exists = probe.exists ?? existsSync;
	if (typeof dir !== "string" || dir.trim() === "") return void 0;
	let current = resolve(dir.trim());
	for (let depth = 0; depth < 16; depth += 1) {
		const candidate = join(current, KNOWLEDGE_DIR);
		if (exists(join(candidate, "library.json"))) return candidate;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
}
/**
* **这个会话的工作区有没有知识库**——决定要不要暴露提示词与工具。
*
* 新模型下判据变成"目录自描述"：`<工作区>/.dsh_knowledge/library.json` 存在即启用
* （或工作区根本身就是库，兼容独立知识库工作区）。没有 ⇒ 按普通工作区对待。
* 于是不再需要登记表、客户端同步、自动清理那一整套 ✓。
*
* @param cwd - 会话工作目录。
* @param probe - 可注入的探测面。
* @returns true = 这个工作区有知识库（工具与提示词可见）。
*/
function isLibrarySession(cwd, probe = {}) {
	const exists = probe.exists ?? existsSync;
	if (typeof cwd !== "string" || cwd.trim() === "") return false;
	return findLibraryRootSync(cwd, {
		exists,
		isAbsolute: probe.isAbsolute
	}) !== void 0;
}
//#endregion
//#region src/host/prompts.ts
/**
* 逐轮注入（P2）：让模型**不用被提醒**就知道「现在在学哪个知识点、它的前置是什么」。
*
* 两层，都注册在插件自己的作用域上：
* - 静态「学习协议」**按会话**注册（`agent/created` 时判定工作区是否为知识库）：方向约定、什么时候建前置、机器文件不要手改；普通工作区渲染为空 ⇒ 模型看不到；
* - 动态「当前节点」用 `systemPrompt.context()`，但必须注册在 **agent 作用域**
*   （`agent/created` 里拿到的 `agent.ctx`）——因为 `AssembleContext` 不带 agent，
*   只有作用域本身能确定「这是哪个会话」。
*
* 两条硬约束：
* 1. `text` 是**同步**函数，所以只能读 `peekLibrary`（本会话已装载过的缓存），
*    不能在这里做文件 IO；缓存为空时给「先调用工具加载」的提示，而不是假装知道标题。
* 2. `agent/created` 的监听器**绝不能抛**：它抛了会导致 agent 创建失败、整个会话起不来。
*    所以整个函数体包在 try/catch 里，任何宿主 API 差异都退化成「不注入」。
*/
/** 协议文本刻意写成「行为约定」，不重复工具说明（工具说明在各自的 description 里） */
const PROTOCOL_SECTION = [
	"This session can read and extend a local KnowledgeNet library (知识库) — a folder of knowledge nodes.",
	"Direction convention: A → B means \"to understand A you must first understand B\", so B is a prerequisite of A.",
	"Learning loop to follow:",
	"1. Before explaining a node, call kn_read_node (or kn_list_graph) so the explanation is grounded in the library, not guessed.",
	"2. When the user meets a concept they do not understand — or explicitly asks to add one — call kn_add_prerequisite with the passage in evidence.snippet. It reuses an existing node when the title matches; when it reports candidates, ask the user to reuse or confirm creating a new node instead of creating duplicates.",
	"3. Use kn_enter_node to descend into a prerequisite and kn_back to return; the current node is remembered from the session log.",
	"4. Record what was understood with kn_write_note, and never overwrite a note or node metadata that changed on disk (the tools refuse and report the conflict).",
	"Paths under .knowledgenet/** (inside the library) are machine metadata: read them freely, but do not hand-edit them.",
	"Writing discipline (mandatory — node creation is a real, visible change on the user's disk):",
	"a. Search/read requests are read-only: kn_find_node / kn_list_graph / kn_read_node create nothing. If the user says \"搜索/看看/有哪些\", never call a writing tool.",
	"b. Never create nodes on your own initiative. Before any kn_add_prerequisite that would create a node, state which node you are about to create and for which parent, then WAIT for the user's agreement.",
	"c. kn_add_prerequisite is one node per call and is rate-limited (a few per window). When it reports creation_quota_exceeded, stop and switch to kn_propose_prerequisites.",
	"d. To propose more than one node at once, call kn_propose_prerequisites (writes only a plan file, creates nothing). The landing step belongs to the user: they review the plan in the Knowledge-graph panel and click apply. You cannot apply a plan yourself; use kn_plan_status to report what the user landed.",
	"e. Any node you created can be deleted by the user from the panel; that removes its markdown file for good (nothing is kept). Say so when you report creations."
].join("\n");
const CONTEXT_ORDER = 820;
function titleList(library, ids, limit = 6) {
	return ids.slice(0, limit).map((id) => library.snapshot.nodes.find((node) => node.id === id)?.title ?? id.slice(0, 8)).join(" / ");
}
/** 当前节点上下文文本；返回 undefined 表示「没有可注入的事实」，此时不注入任何内容 */
function currentContextText(agent, config) {
	const session = agent?.session;
	const sessionId = agent?.id ?? session?.id ?? null;
	if (sessionId !== null) resetCreationQuotaForTurn(sessionId);
	const header = session?.header;
	const currentId = currentIdOf(session);
	if (currentId === null) return void 0;
	const library = peekLibrary((typeof config.libraryRoot === "string" && config.libraryRoot.trim() !== "" ? path.resolve(config.libraryRoot.trim()) : void 0) ?? findCachedRoot(header?.cwd));
	if (library === void 0) return `Current knowledge node: id=${currentId}（知识库尚未加载：先调用 kn_list_graph 或 kn_read_node 取上下文）`;
	const node = library.snapshot.nodes.find((item) => item.id === currentId);
	if (node === void 0) return `Current knowledge node: id=${currentId}（不在当前知识库里，可能已被删除）`;
	const prerequisites = prerequisitesOf(library.snapshot, node.id).map((item) => item.id);
	const dependents = dependentsOf(library.snapshot, node.id).map((item) => item.id);
	return [
		`Current knowledge node: ${node.title}（${node.relativePath}，状态 ${node.status}）`,
		prerequisites.length > 0 ? `Its prerequisites: ${titleList(library, prerequisites)}` : "It has no recorded prerequisites yet.",
		dependents.length > 0 ? `Nodes that depend on it: ${titleList(library, dependents)}` : "",
		"Read its note with kn_read_node before answering; add missing prerequisites with kn_add_prerequisite."
	].filter((line) => line !== "").join("\n");
}
/** 注册静态协议 + 每 agent 的动态上下文；任何一步失败都只跳过注入，不影响会话 */
function registerPrompts(ctx, config) {
	const context = ctx;
	let section = false;
	let perAgent = false;
	try {
		section = true;
	} catch {}
	try {
		context?.on?.("agent/created", (payload) => {
			try {
				const agent = payload?.agent;
				const agentCtx = agent?.ctx;
				if (typeof agentCtx?.systemPrompt?.context !== "function") return;
				const cwd = sessionCwdOf({ agent }) ?? "";
				agentCtx.systemPrompt.context({
					name: "knowledgenet-current",
					order: CONTEXT_ORDER,
					text: () => {
						if (!isLibrarySession(cwd)) return "";
						const dynamic = currentContextText(agent, config) ?? "";
						return dynamic === "" ? PROTOCOL_SECTION : `${PROTOCOL_SECTION}\n${dynamic}`;
					}
				});
			} catch {}
		});
		perAgent = true;
	} catch {}
	return {
		section,
		perAgent
	};
}
//#endregion
//#region src/host/create-dir.ts
/**
* 在指定位置下新建一个文件夹（「创建知识库」的第一步）。
*
* 为什么不让客户端直接调 `uiWorkspace.createDirectory`：那条路失败时异常信息拿不回来，
* 界面上只能显示"新建文件夹失败"，用户和排查都得不到原因（实测）。这里自己做，理由有两条：
* 1. 宿主侧本来就有 fs 权限，逻辑最简单可控（`mkdir` 不带 recursive：**已存在就报错**，语义清楚）；
* 2. 能把**具体原因**（名字非法 / 已存在 / 父目录不存在 / 权限）原样带回界面。
*
* 安全边界：只新建一层目录；名字里不允许路径分隔符与 Windows 保留字符；父目录必须已存在。
*/
/** Windows 保留字符 + 路径分隔符都不允许出现在新目录名里 */
const INVALID_NAME = /[\\/:*?"<>|]/;
/**
* 新建子目录。
* @param input.parent - 父目录（必须已存在）。
* @param input.name - 新目录名。
* @returns 成功时给出新路径；失败给出可读原因。
*/
async function createSubdirectory(input) {
	const parent = typeof input.parent === "string" ? input.parent.trim() : "";
	const name = typeof input.name === "string" ? input.name.trim() : "";
	if (parent === "") return {
		ok: false,
		error: {
			code: "parent_required",
			message: "请先选择位置"
		}
	};
	if (name === "") return {
		ok: false,
		error: {
			code: "name_required",
			message: "请填写知识库名称"
		}
	};
	if (INVALID_NAME.test(name)) return {
		ok: false,
		error: {
			code: "name_invalid",
			message: "名字里不能包含 \\ / : * ? \" < > |"
		}
	};
	if (!await stat(parent).then((info) => info.isDirectory()).catch(() => false)) return {
		ok: false,
		error: {
			code: "parent_missing",
			message: `位置不存在或不是文件夹：${parent}`
		}
	};
	const target = join(parent, name);
	if (await stat(target).then(() => true).catch(() => false)) return {
		ok: false,
		error: {
			code: "exists",
			message: `已经有同名文件夹了：${target}`
		}
	};
	try {
		await mkdir(target);
		return {
			ok: true,
			path: target
		};
	} catch (error) {
		return {
			ok: false,
			error: {
				code: "mkdir_failed",
				message: error instanceof Error ? error.message : String(error)
			}
		};
	}
}
//#endregion
//#region src/host/node-document.ts
/**
* 面板用的**节点正文读写**（对应 `design/node-note-editor-plan.md` 的「API 与文件安全」）。
*
* 设计要点（逐条落地 ✓）：
* - 只读写**正文**：front-matter 的身份 / 标题 / 状态 / 修订号全部由存储层维护，
*   客户端拿不到、也改不了 ✗（避免用户误改节点身份）；
* - 读返回**实际相对路径**（节点被重命名后是新的那个 ✓）与**整文件指纹**
*   （`contentHash(整个文件)` ⇒ 外部改了正文或 front-matter 都会被发现 ✓）；
* - 保存是**比较交换**：带上读取时的指纹，磁盘对不上就拒绝并回带**最新正文**，
*   让界面能比较 / 手动合并，绝不默认覆盖 ✗；
* - 大文档有明确上限：超过就**拒绝**（读与写都拒），绝不静默截断后允许保存 ✗；
* - 只认库内相对路径 ⇒ 由存储层按 `nodeId` 自己解析路径 ✗（不接受客户端给的绝对路径 ✓）。
*/
/**
* 正文大小上限（UTF-8 字节）。
*
* 512KB 远超正常笔记（几万字），但足以挡住"误把大文件塞进来"的情形 ✓。
*/
const MAX_DOCUMENT_BYTES = 524288;
/**
* **正文口径**：读、写、返回三处必须完全一致 ✓。
*
* 磁盘上的正文与 front-matter 之间有一个分隔换行，`composeDocument` 也会去掉正文的
* 前导空行与尾部空白 ⇒ 读回来的 `note` 若原样带着那个换行，
* 编辑器打开时顶部就多一个空行、而且**保存后基线与草稿不相等**（会被判成"还有未保存修改" ✗）。
*/
function normalizeBody(text) {
	return text.replace(/^\n+/, "").replace(/\s+$/, "");
}
function docOf(node) {
	return {
		nodeId: node.id,
		title: node.title,
		path: node.relativePath,
		text: normalizeBody(typeof node.note === "string" ? node.note : ""),
		hash: node.hash,
		revision: node.rev
	};
}
function utf8Bytes(text) {
	let bytes = 0;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
	}
	return bytes;
}
/**
* 读一个节点的正文文档。
* @param root - 库根（**由宿主解析**，不接受客户端绝对路径 ✓）。
* @param nodeId - 稳定节点 id。
* @returns 文档，或带 code 的失败 ✓。
*/
async function readNodeDocument(root, nodeId) {
	const id = typeof nodeId === "string" ? nodeId.trim() : "";
	if (id === "") return {
		ok: false,
		code: "node_missing",
		message: "缺少 nodeId"
	};
	const library = await readLibrary(root, { withNotes: true });
	if (library === void 0) return {
		ok: false,
		code: "not_library",
		message: `这里还不是 v3 知识库：${root}`
	};
	const node = library.nodes.find((item) => item.id === id);
	if (node === void 0) return {
		ok: false,
		code: "node_missing",
		message: "没有找到这个知识点"
	};
	const document = docOf(node);
	if (utf8Bytes(document.text) > 524288) return {
		ok: false,
		code: "too_large",
		message: `正文超过 ${Math.round(MAX_DOCUMENT_BYTES / 1024)}KB，面板编辑器不处理这么大的文档`
	};
	return {
		ok: true,
		document
	};
}
/**
* 保存正文（整体替换），带**比较交换**守卫。
*
* **指纹是必填的** ✗（复查 P1-4）：面板这条保存接口的存在意义就是"不覆盖外部修改" ✓，
* 缺指纹/空白/类型不对一律 `bad_body` 且**不写文件** ✗ ——
* 其它工具若需要"无指纹写入"，那是它们自己的语义（在 store 层 ✓），面板不继承 ✓。
*
* @param root - 库根（宿主解析 ✓）。
* @param input - `nodeId`、完整正文、读取时的**整文件指纹**（必填 ✓）。
* @param now - 时间戳（测试注入 ✓）。
* @returns 新文档（含新指纹与**规范化后的正文** ✓）；指纹对不上 ⇒ `conflict` 并回带最新正文 ✓。
*/
async function saveNodeDocument(root, input, now = Date.now()) {
	const id = typeof input.nodeId === "string" ? input.nodeId.trim() : "";
	if (id === "") return {
		ok: false,
		code: "node_missing",
		message: "缺少 nodeId"
	};
	const hash = typeof input.hash === "string" ? input.hash.trim() : "";
	if (hash === "") return {
		ok: false,
		code: "bad_body",
		message: "保存必须带上读取时的整文件指纹（否则无法保证不覆盖外部修改）"
	};
	const text = typeof input.text === "string" ? input.text : "";
	if (utf8Bytes(text) > 524288) return {
		ok: false,
		code: "too_large",
		message: `正文超过 ${Math.round(MAX_DOCUMENT_BYTES / 1024)}KB，已拒绝保存（不截断 ✓）`
	};
	const result = await writeNote$1(root, {
		id,
		text,
		expectedHash: hash
	}, now);
	if (result.ok === true) return {
		ok: true,
		document: docOf(result.node)
	};
	if (result.code === "conflict") {
		const latest = await readNodeDocument(root, id);
		return {
			ok: false,
			code: "conflict",
			message: result.message,
			...latest.ok === true ? { latest: latest.document } : {}
		};
	}
	if (result.code === "not_library") return {
		ok: false,
		code: "not_library",
		message: result.message
	};
	if (result.code === "node_missing") return {
		ok: false,
		code: "node_missing",
		message: result.message
	};
	return {
		ok: false,
		code: "write_failed",
		message: result.message
	};
}
//#endregion
//#region src/host/isolation-state.ts
const states = /* @__PURE__ */ new Set();
/**
* 登记一个会话，并**立即**按当前判定裁决一次。
* @param cwd - 会话工作目录。
* @param applyDeny - 施加隐藏并返回 disposer（拿不到工具面时返回 null）。
* @param shouldReveal - 是否应当"可见"（true = 不隐藏）。
* @returns 是否已隐藏。
*/
function registerAgentIsolation(cwd, applyDeny, shouldReveal) {
	const state = {
		cwd,
		applyDeny,
		active: null
	};
	states.add(state);
	return applyIfNeeded(state, shouldReveal);
}
function applyIfNeeded(state, shouldReveal) {
	if (shouldReveal) {
		if (state.active !== null) {
			try {
				state.active();
			} catch {}
			state.active = null;
		}
		return false;
	}
	if (state.active !== null) return true;
	const dispose = state.applyDeny();
	state.active = dispose;
	return dispose !== null;
}
/**
* 重新裁决所有已登记的会话（登记表更新后调用）。
* @param shouldReveal - 判定函数：给会话工作目录，返回它是否应当可见。
* @returns 统计：可见/隐藏的会话数。
*/
function reevaluateIsolation(shouldReveal) {
	let visible = 0;
	let hidden = 0;
	for (const state of states) if (applyIfNeeded(state, shouldReveal(state.cwd))) hidden += 1;
	else visible += 1;
	return {
		visible,
		hidden
	};
}
/** 仅测试用：清空会话登记 */
function __resetIsolationStatesForTest() {
	for (const state of states) try {
		state.active?.();
	} catch {}
	states.clear();
}
//#endregion
//#region src/host/api.ts
/**
* 宿主侧 HTTP（Fetch）路由：给**常驻面板**取数据用。
*
* 为什么需要它：编译型插件的客户端半没有 `host.call`，也用不了仓内生成的 `ctx.remote.*`；
* 但 DSH 提供了官方通道 —— `ctx.connection.fetch.register(...)` 注册精确 Fetch 路由，
* 客户端半用 document-relative 的 `fetch('api/...')` 读（浏览器走同源路由、Electron 走 IPC 桥）。
* shipped 的 `/export`（session-log-export）就是这么做的，这里照同一套写。
*
* 载荷与 `kn_list_graph` **共用** `graphPayload`：卡片、面板、模型看到的永远同形同源。
*/
const PANEL_HINT = "还没有可用的知识库：请把「含 library.json 的知识库根目录」作为当前会话的工作区，或者在上方输入框里填一个库根路径。";
function jsonResponse(body, status = 200, head = false) {
	const text = JSON.stringify(body);
	const headers = {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	};
	if (head) return new Response(null, {
		status,
		headers
	});
	return new Response(text, {
		status,
		headers
	});
}
function errorBody(error) {
	if (error instanceof RepositoryError) {
		const detail = error.detail;
		if (detail?.kind === "library_missing") return {
			code: "library_missing",
			message: error.message,
			...typeof detail.createPath === "string" ? { createPath: detail.createPath } : {}
		};
		return {
			code: detail?.kind === "library" ? "library_unavailable" : error.code,
			message: error.message
		};
	}
	return {
		code: "unknown",
		message: error instanceof Error ? error.message : String(error)
	};
}
/**
* 会话 id → 该会话工作区的 cwd。
*
* 两条来源，缺一不可：
* - `ctx.agents.get(id).session.header.cwd`：与工具侧 `sessionCwdOf` 一致的活会话路径；
* - `ctx.sessions.get(id).header.cwd`：**刚建、还没 agent 的会话只在这里**——
*   只有第一条时，"新会话"会被判成"问不到 cwd"，进而被误判成"工作区不是知识库"。
*/
function cwdOfSession(ctx, sessionId) {
	const pick = (value) => {
		const shaped = value;
		const cwd = shaped?.session?.header?.cwd ?? shaped?.header?.cwd;
		return typeof cwd === "string" && cwd !== "" ? cwd : void 0;
	};
	try {
		const fromAgent = pick(ctx.agents?.get?.(sessionId));
		if (fromAgent !== void 0) return fromAgent;
	} catch {}
	try {
		return pick(ctx.sessions?.get?.(sessionId));
	} catch {
		return;
	}
}
/** 从一个错误里读出"该在哪儿建库"（不是这种错就返回 undefined） */
function missingFrom(error) {
	const detail = error?.detail;
	if (detail?.kind !== "library_missing") return void 0;
	return typeof detail.createPath === "string" && detail.createPath !== "" ? { createPath: detail.createPath } : void 0;
}
/**
* 库根解析顺序：显式 root → 会话 cwd → 插件配置 → 「最近装载过的库」。
*
* 但**显式给 `sessionId` 是个强声明**：它表示「问的是这个会话的作用域」。这种情况下
* 找不到库就如实返回 null，绝不拿别的会话用过的库顶上——否则「这个工作区是不是知识库」
* 这类判断会被一个无关的库污染（右侧栏要不要显示入口卡片就靠它）。
*/
async function resolveRequestedRoot(ctx, config, options = {}) {
	const explicit = typeof options.root === "string" ? options.root.trim() : "";
	if (explicit !== "") {
		if (options.exact === true) return {
			root: await isLibraryRoot(explicit) ? explicit : null,
			sessionUnknown: false,
			cwd: explicit
		};
		if (await isLibraryRoot(explicit)) return {
			root: explicit,
			sessionUnknown: false,
			cwd: explicit
		};
		try {
			return {
				root: await resolveLibraryRoot(explicit, null),
				sessionUnknown: false,
				cwd: explicit
			};
		} catch (error) {
			return {
				root: null,
				sessionUnknown: false,
				cwd: explicit,
				missing: missingFrom(error)
			};
		}
	}
	if (typeof options.sessionId === "string" && options.sessionId !== "") {
		const cwd = cwdOfSession(ctx, options.sessionId);
		if (cwd !== void 0) try {
			return {
				root: await resolveLibraryRoot(cwd, config.libraryRoot),
				sessionUnknown: false,
				cwd
			};
		} catch (error) {
			return {
				root: null,
				sessionUnknown: false,
				cwd,
				missing: missingFrom(error)
			};
		}
		return {
			root: null,
			sessionUnknown: true,
			cwd: null
		};
	}
	if (typeof config.libraryRoot === "string" && config.libraryRoot.trim() !== "") {
		const configured = await resolveLibraryRoot(void 0, config.libraryRoot).catch(() => null);
		if (configured !== null) return {
			root: configured,
			sessionUnknown: false,
			cwd: null
		};
	}
	return {
		root: lastLibraryRoot() ?? null,
		sessionUnknown: false,
		cwd: null
	};
}
/** 处理一次面板数据请求（导出以便单测直接调用，不必起 HTTP） */
async function graphApiPayload(ctx, config, request) {
	let url;
	try {
		url = new URL(request.url, "http://dsh.local/");
	} catch {
		return {
			status: 200,
			body: {
				ok: false,
				error: {
					code: "invalid_url",
					message: String(request.url)
				}
			}
		};
	}
	const askedSession = url.searchParams.get("sessionId");
	const askedRoot = url.searchParams.get("root");
	if (url.searchParams.get("probe") === "1" && askedRoot !== null && askedRoot.trim() !== "") {
		const folder = await describeFolder(askedRoot);
		recordProbe({
			at: Date.now(),
			sessionId: askedSession,
			root: askedRoot,
			cwd: folder.state,
			code: `folder_${folder.state}`
		});
		return {
			status: 200,
			body: {
				ok: true,
				folder
			}
		};
	}
	/** 每次回答都留痕：入口卡片没出现时，`kn_status` 能直接说出客户端问了什么、宿主答了什么 */
	const answer = (body) => {
		const error = body.error;
		const code = body.ok === true ? "library" : error?.code ?? "unknown";
		recordProbe({
			at: Date.now(),
			sessionId: askedSession,
			root: askedRoot,
			cwd: lastResolutionCwd,
			code
		});
		return {
			status: 200,
			body
		};
	};
	let lastResolutionCwd = null;
	try {
		const resolution = await resolveRequestedRoot(ctx, config, {
			root: askedRoot,
			sessionId: askedSession,
			exact: url.searchParams.get("exact") === "1"
		});
		lastResolutionCwd = resolution.cwd ?? null;
		if (resolution.root === null) {
			const missing = resolution.missing;
			if (!resolution.sessionUnknown && missing !== void 0) return answer({
				ok: false,
				error: {
					code: "library_missing",
					message: `这个工作区还没有知识库：可以创建在 ${missing.createPath}`,
					createPath: missing.createPath
				}
			});
			return answer(resolution.sessionUnknown ? {
				ok: false,
				error: {
					code: "session_unknown",
					message: "宿主还没拿到这个会话的工作区路径（会话刚建或尚未开始），稍后重问即可。"
				}
			} : {
				ok: false,
				error: {
					code: "library_unavailable",
					message: PANEL_HINT
				}
			});
		}
		const root = resolution.root;
		const library = await loadLibrary(root, { refresh: url.searchParams.get("refresh") === "1" });
		const focusId = url.searchParams.get("focusId");
		const maxNodesRaw = url.searchParams.get("maxNodes");
		const maxNodes = maxNodesRaw === null || maxNodesRaw.trim() === "" ? void 0 : Number(maxNodesRaw);
		return answer({
			ok: true,
			...graphPayload({
				library,
				snapshot: library.snapshot
			}, {
				focusId: focusId === null || focusId.trim() === "" ? void 0 : focusId.trim(),
				maxNodes: Number.isFinite(maxNodes) ? maxNodes : void 0
			})
		});
	} catch (error) {
		return answer({
			ok: false,
			error: errorBody(error)
		});
	}
}
/**
* 处理路由请求：
* - GET/HEAD 取图数据（`exact=1` 时只认目录本身是不是知识库）；
* - POST `{kind:'diag'}` 收客户端结构指纹；
* - POST `{kind:'create-library', root, title?}` 把一个目录初始化为知识库（**绝不覆盖**已有清单）。
*
* 抽成独立函数是为了能直接单测——不必真的起 HTTP。
*/
async function handleApiRequest(ctx, config, request) {
	const method = (request.method ?? "GET").toUpperCase();
	if (method !== "POST") return await graphApiPayload(ctx, config, {
		url: request.url,
		method
	});
	let payload;
	try {
		payload = await request.json?.();
	} catch (error) {
		return {
			status: 200,
			body: {
				ok: false,
				error: {
					code: "bad_body",
					message: String(error)
				}
			}
		};
	}
	const record = payload;
	if (record === null || typeof record !== "object") return {
		status: 200,
		body: {
			ok: false,
			error: {
				code: "bad_body",
				message: "请求体必须是对象"
			}
		}
	};
	if (record.kind === "create-library") {
		const root = typeof record.root === "string" ? record.root : "";
		const title = typeof record.title === "string" ? record.title : void 0;
		if (root !== "") try {
			await mkdir(root, { recursive: true });
		} catch (error) {
			return {
				status: 200,
				body: {
					ok: false,
					error: {
						code: "mkdir_failed",
						message: error instanceof Error ? error.message : String(error)
					}
				}
			};
		}
		const result = await createLibrary(root, title);
		if (result.ok) {
			invalidateLibrary(result.root);
			const cwd = root.replace(/[\\/][^\\/]*$/, "");
			reevaluateIsolation((candidate) => isLibrarySession(candidate || cwd));
			return {
				status: 200,
				body: {
					ok: true,
					library: {
						root: result.root,
						title: result.title,
						libraryId: result.libraryId
					}
				}
			};
		}
		return {
			status: 200,
			body: {
				ok: false,
				error: {
					code: result.code,
					message: result.message
				}
			}
		};
	}
	if (record.kind === "create-directory") {
		const result = await createSubdirectory({
			parent: typeof record.parent === "string" ? record.parent : "",
			name: typeof record.name === "string" ? record.name : ""
		});
		return {
			status: 200,
			body: result.ok === true ? {
				ok: true,
				path: result.path
			} : {
				ok: false,
				error: result.error
			}
		};
	}
	if (record.kind === "create-node") {
		const resolved = await resolveRequestedRoot(ctx, config, {
			root: typeof record.root === "string" ? record.root : void 0,
			sessionId: typeof record.sessionId === "string" ? record.sessionId : void 0
		});
		if (resolved.root === void 0) return {
			status: 200,
			body: {
				ok: false,
				error: {
					code: "library_unavailable",
					message: "找不到知识库"
				}
			}
		};
		try {
			const library = await loadLibrary(resolved.root, { refresh: true });
			const created = await createNodeFromUi({
				library,
				snapshot: library.snapshot
			}, { title: typeof record.title === "string" ? record.title : "" });
			if (created.ok === true) invalidateLibrary(resolved.root);
			return {
				status: 200,
				body: created.ok === true ? {
					ok: true,
					node: created.node
				} : {
					ok: false,
					error: created.error
				}
			};
		} catch (error) {
			return {
				status: 200,
				body: {
					ok: false,
					error: {
						code: "create_node_failed",
						message: error instanceof Error ? error.message : String(error)
					}
				}
			};
		}
	}
	if (record.kind === "list-plans" || record.kind === "apply-plan" || record.kind === "undo-plan") {
		const resolved = await resolveRequestedRoot(ctx, config, {
			root: typeof record.root === "string" ? record.root : void 0,
			sessionId: typeof record.sessionId === "string" ? record.sessionId : void 0
		});
		if (resolved.root === void 0) return {
			status: 200,
			body: {
				ok: false,
				error: {
					code: "library_unavailable",
					message: "找不到知识库"
				}
			}
		};
		try {
			const library = await loadLibrary(resolved.root, { refresh: record.kind !== "list-plans" });
			const context = {
				library,
				snapshot: library.snapshot
			};
			if (record.kind === "list-plans") return {
				status: 200,
				body: {
					ok: true,
					plans: (await listPlans(resolved.root)).map((plan) => ({
						id: plan.id,
						createdAt: plan.createdAt,
						summary: plan.summary ?? "",
						itemCount: plan.items.length,
						applied: plan.applied !== void 0 && plan.applied !== null,
						createdCount: plan.applied?.created.length ?? 0,
						items: plan.items.map((item) => ({
							id: item.id,
							fromId: item.fromId,
							title: item.title,
							reuse: item.existingNodeId !== void 0
						}))
					}))
				}
			};
			const planId = typeof record.planId === "string" ? record.planId : "";
			if (record.kind === "apply-plan") {
				const itemIds = Array.isArray(record.itemIds) ? record.itemIds.filter((id) => typeof id === "string") : void 0;
				const result = await applyPlanFromUi(context, resolved.root, {
					planId,
					itemIds
				});
				if (result.ok === true) invalidateLibrary(resolved.root);
				return {
					status: 200,
					body: result.ok === true ? {
						ok: true,
						planId,
						created: result.plan?.applied?.created ?? [],
						reused: result.plan?.applied?.reused ?? [],
						failed: result.plan?.applied?.failed ?? []
					} : {
						ok: false,
						error: result.error
					}
				};
			}
			const undone = await undoPlanFromUi(context, resolved.root, { planId });
			if (undone.ok === true) invalidateLibrary(resolved.root);
			return {
				status: 200,
				body: undone.ok === true ? {
					ok: true,
					planId,
					undone: undone.undone ?? 0
				} : {
					ok: false,
					error: undone.error
				}
			};
		} catch (error) {
			return {
				status: 200,
				body: {
					ok: false,
					error: {
						code: "plan_failed",
						message: error instanceof Error ? error.message : String(error)
					}
				}
			};
		}
	}
	if (record.kind === "search-nodes") {
		const resolved = await resolveRequestedRoot(ctx, config, {
			root: typeof record.root === "string" ? record.root : void 0,
			sessionId: typeof record.sessionId === "string" ? record.sessionId : void 0
		});
		if (resolved.root === void 0) return {
			status: 200,
			body: {
				ok: false,
				error: {
					code: "library_unavailable",
					message: "找不到知识库"
				}
			}
		};
		try {
			const library = await loadLibrary(resolved.root, {});
			return {
				status: 200,
				body: {
					ok: true,
					nodes: searchTargets({
						library,
						snapshot: library.snapshot
					}, typeof record.query === "string" ? record.query : "", 10)
				}
			};
		} catch (error) {
			return {
				status: 200,
				body: {
					ok: false,
					error: {
						code: "library_unavailable",
						message: error instanceof Error ? error.message : String(error)
					}
				}
			};
		}
	}
	if (record.kind === "read-node-document" || record.kind === "save-node-document") {
		const resolved = await resolveRequestedRoot(ctx, config, {
			root: typeof record.root === "string" ? record.root : void 0,
			sessionId: typeof record.sessionId === "string" ? record.sessionId : void 0
		});
		if (resolved.root === void 0) return {
			status: 200,
			body: {
				ok: false,
				error: {
					code: "library_unavailable",
					message: "找不到知识库"
				}
			}
		};
		try {
			if ((await loadLibrary(resolved.root, {})).storage === "v2") return {
				status: 200,
				body: {
					ok: false,
					error: {
						code: "unsupported_format",
						message: "这个知识库还是旧格式（v2，只读兼容）⇒ 面板里不能编辑正文"
					}
				}
			};
		} catch (error) {
			return {
				status: 200,
				body: {
					ok: false,
					error: {
						code: "unsupported_format",
						message: error instanceof Error ? error.message : String(error)
					}
				}
			};
		}
		const nodeId = typeof record.nodeId === "string" ? record.nodeId : "";
		if (record.kind === "read-node-document") {
			const result = await readNodeDocument(resolved.root, nodeId);
			return result.ok === true ? {
				status: 200,
				body: {
					ok: true,
					document: result.document
				}
			} : {
				status: 200,
				body: {
					ok: false,
					error: {
						code: result.code,
						message: result.message
					}
				}
			};
		}
		if (typeof record.text !== "string") return {
			status: 200,
			body: {
				ok: false,
				error: {
					code: "bad_body",
					message: "缺少 text"
				}
			}
		};
		const result = await saveNodeDocument(resolved.root, {
			nodeId,
			text: record.text,
			hash: record.hash
		});
		if (result.ok === true) {
			invalidateLibrary(resolved.root);
			return {
				status: 200,
				body: {
					ok: true,
					document: result.document
				}
			};
		}
		return {
			status: 200,
			body: {
				ok: false,
				error: {
					code: result.code,
					message: result.message,
					...result.latest === void 0 ? {} : { latest: result.latest }
				}
			}
		};
	}
	if (record.kind === "remove-node") {
		const resolved = await resolveRequestedRoot(ctx, config, {
			root: typeof record.root === "string" ? record.root : void 0,
			sessionId: typeof record.sessionId === "string" ? record.sessionId : void 0
		});
		if (resolved.root === void 0) return {
			status: 200,
			body: {
				ok: false,
				error: {
					code: "library_unavailable",
					message: "找不到知识库"
				}
			}
		};
		try {
			const library = await loadLibrary(resolved.root, { refresh: true });
			const result = await removeNodeFromUi({
				library,
				snapshot: library.snapshot
			}, { nodeId: typeof record.nodeId === "string" ? record.nodeId : "" });
			if (result.ok === true) invalidateLibrary(resolved.root);
			return {
				status: 200,
				body: result.ok === true ? {
					ok: true,
					removed: result.removed
				} : {
					ok: false,
					error: result.error
				}
			};
		} catch (error) {
			return {
				status: 200,
				body: {
					ok: false,
					error: {
						code: "remove_failed",
						message: error instanceof Error ? error.message : String(error)
					}
				}
			};
		}
	}
	if (record.kind === "add-prerequisite" || record.kind === "remove-prerequisite") {
		const resolved = await resolveRequestedRoot(ctx, config, {
			root: typeof record.root === "string" ? record.root : void 0,
			sessionId: typeof record.sessionId === "string" ? record.sessionId : void 0
		});
		if (resolved.root === void 0) return {
			status: 200,
			body: {
				ok: false,
				error: {
					code: resolved.sessionUnknown ? "session_unknown" : "library_unavailable",
					message: "找不到知识库"
				}
			}
		};
		let library;
		try {
			library = await loadLibrary(resolved.root, { refresh: true });
		} catch (error) {
			return {
				status: 200,
				body: {
					ok: false,
					error: {
						code: "library_unavailable",
						message: error instanceof Error ? error.message : String(error)
					}
				}
			};
		}
		const context = {
			library,
			snapshot: library.snapshot
		};
		const edit = record.kind === "add-prerequisite" ? await addPrerequisiteFromUi(context, resolved.root, {
			fromId: typeof record.fromId === "string" ? record.fromId : "",
			title: typeof record.title === "string" ? record.title : "",
			create: record.create === true,
			description: typeof record.description === "string" ? record.description : void 0,
			snippet: typeof record.snippet === "string" ? record.snippet : void 0,
			question: typeof record.question === "string" ? record.question : void 0
		}) : await removePrerequisiteFromUi(context, resolved.root, {
			fromId: typeof record.fromId === "string" ? record.fromId : "",
			edgeId: typeof record.edgeId === "string" ? record.edgeId : ""
		});
		if (edit.ok) return {
			status: 200,
			body: {
				ok: true,
				added: edit.added,
				removed: edit.removed
			}
		};
		return {
			status: 200,
			body: {
				ok: false,
				error: edit.error ?? {
					code: "write_failed",
					message: "写入失败"
				}
			}
		};
	}
	if (record.kind !== void 0 && record.kind !== "diag") return {
		status: 200,
		body: {
			ok: false,
			error: {
				code: "unknown_kind",
				message: `宿主不认识这个操作：${String(record.kind)}（宿主可能还没重启，请重启 DSH 后再试）`
			}
		}
	};
	if (record.area === void 0) return {
		status: 200,
		body: {
			ok: false,
			error: {
				code: "bad_body",
				message: "缺少 area"
			}
		}
	};
	const entry = {
		at: Date.now(),
		area: String(record.area),
		outcome: String(record.outcome ?? "unknown")
	};
	for (const [key, value] of Object.entries(record)) {
		if (key === "kind" || key === "area" || key === "outcome") continue;
		if (value === null || [
			"string",
			"number",
			"boolean"
		].includes(typeof value) || Array.isArray(value)) entry[key] = value;
	}
	recordClientDiag(entry);
	return {
		status: 200,
		body: { ok: true }
	};
}
/** 注册路由；没有 connection 服务（例如 headless 组合）时返回未注册与原因，不抛错 */
function registerApi(ctx, config) {
	const registrar = ctx;
	const connection = registrar.get?.("connection") ?? registrar.connection;
	if (connection === void 0) return {
		path: GRAPH_API_PATH,
		registered: false,
		reason: "看不到 connection 服务（宿主组合里没有它？）"
	};
	const register = connection.fetch?.register;
	if (typeof register !== "function") return {
		path: GRAPH_API_PATH,
		registered: false,
		reason: "connection 服务没有 fetch.register"
	};
	const handler = async (request) => {
		const head = request.method === "HEAD";
		const { status, body } = await handleApiRequest(registrar, config, {
			url: request.url,
			method: request.method,
			json: () => request.json()
		});
		return jsonResponse(body, status, head);
	};
	try {
		register({
			path: GRAPH_API_PATH,
			methods: [
				"GET",
				"HEAD",
				"POST"
			],
			requestBody: "buffered",
			fetch: handler
		});
		return {
			path: GRAPH_API_PATH,
			registered: true
		};
	} catch (error) {
		return {
			path: GRAPH_API_PATH,
			registered: false,
			reason: error instanceof Error ? error.message : String(error)
		};
	}
}
//#endregion
//#region src/host/index.ts
/**
* KnowledgeNet × DSH —— 插件 Host 半入口。
*
* 形态：Cordis 函数式插件（`export function apply`），`inject: ['tools']` 等待工具注册表。
* 职责边界：
* - 把**本地知识库**（v2 开放文件格式）读进来并允许受控写入，作为一组工具暴露给模型；
* - 逐轮把「当前学习节点 + 它的前置」注入上下文，让模型不必被提醒；
* - 注册一条精确 Fetch 路由（`/api/knowledgenet.graph`）给**常驻面板**取数据；
* - 不持有全局「当前库」单例：库由调用方会话的 cwd 决定（见 library.ts），
*   面板没有会话绑定时用「最近装载过的库」兜底（见 lastLibraryRoot）；
* - 学习栈从会话事件流折叠（见 stack.ts），因此 resume/fork/重启都不丢；
* - 不 import 任何 `@deepseek-ai/*`，一切都通过 `ctx` 服务使用。
*/
const name = "knowledgenet";
/** `ctx.tools` 就绪之前不激活（prompts 与路由走可选 `ctx.get`，不加入 inject，避免缺少服务时永久 pending） */
const inject = ["tools"];
function apply(ctx, config = {}) {
	const tools = ctx.tools;
	/** 本插件注册的全部工具名（隔离时整批 deny 用；直接从注册内容取，避免漏掉将来新增的工具） */
	const toolNames = [];
	if (tools !== void 0 && typeof tools.register === "function") for (const tool of createTools(config)) {
		tools.register(tool);
		const name = tool.name;
		if (typeof name === "string" && name !== "") toolNames.push(name);
	}
	if (typeof ctx.on === "function") try {
		ctx.on("agent/created", (payload) => {
			try {
				const agent = payload?.agent;
				const cwd = sessionCwdOf({ agent }) ?? "";
				const reveal = () => isLibrarySession(cwd);
				const scoped = (agent?.ctx)?.tools;
				const hidden = registerAgentIsolation(cwd, () => {
					if (typeof scoped?.restrict !== "function") return null;
					try {
						return scoped.restrict({ deny: toolNames });
					} catch {
						return null;
					}
				}, reveal());
				recordIsolation({
					sessionCwd: cwd === "" ? null : cwd,
					isLibrary: reveal(),
					restricted: hidden,
					...typeof scoped?.restrict === "function" ? {} : { reason: "no-agent-tools" }
				});
			} catch (error) {
				recordIsolation({
					sessionCwd: null,
					isLibrary: false,
					restricted: false,
					reason: error instanceof Error ? error.message : String(error)
				});
			}
		});
	} catch {}
	const prompts = registerPrompts(ctx, config);
	setRuntimeStatus({
		api: {
			path: GRAPH_API_PATH,
			registered: false,
			reason: "等待 connection 服务"
		},
		prompts,
		startedAt: Date.now()
	});
	if (typeof ctx.inject === "function") try {
		ctx.inject(["connection"], (scoped) => {
			patchRuntimeStatus({ api: registerApi(scoped ?? ctx, config) });
		});
	} catch (error) {
		patchRuntimeStatus({ api: {
			path: GRAPH_API_PATH,
			registered: false,
			reason: `ctx.inject('connection') 失败：${error instanceof Error ? error.message : String(error)}`
		} });
	}
	else patchRuntimeStatus({ api: registerApi(ctx, config) });
}
/**
* 供插件自带测试直接调用（`Loader.unwrapExports` 取的是 `apply`/default，
* 多出的具名导出不影响插件装载）。
*/
const __internal = {
	NodeVfs,
	loadLibrary,
	peekLibrary,
	resolveLibraryRoot,
	isLibraryRoot,
	createLibrary,
	createNodeFromUi,
	addPrerequisiteFromUi,
	removePrerequisiteFromUi,
	applyPlanFromUi,
	undoPlanFromUi,
	listPlans,
	/** 测试用：放开/改回"本轮最多新建几个节点"的配额（生产按轮重置，见 creation-quota.ts） */
	setCreationQuotaForTest: __setCreationQuotaForTest,
	resetCreationQuotaForTurn,
	findCachedRoot,
	reevaluateIsolation,
	isLibrarySession,
	__resetIsolationStatesForTest,
	clipGraph,
	DEFAULT_MAX_NODES: 400,
	MAX_EDGES,
	MAX_EDGE_DESCRIPTION: 240,
	MAX_PAYLOAD_BYTES,
	runtimeStatus,
	foldStack,
	lastLibraryRoot,
	summarizeNode,
	search,
	neighborhood,
	resolveNodeArg,
	createTools,
	addPrerequisite,
	readNote,
	writeNote,
	currentContextText,
	registerPrompts,
	PROTOCOL_SECTION,
	foldStack,
	stackOf,
	stackAfterEnter,
	stackAfterBack,
	currentIdOf,
	graphPayload,
	graphApiPayload,
	handleApiRequest,
	registerApi,
	resolveRequestedRoot,
	clipGraph,
	clampMaxNodes,
	focusOf,
	GRAPH_API_PATH,
	GRAPH_API_ROUTE,
	runtimeStatus,
	patchRuntimeStatus
};
//#endregion
export { __internal, apply, inject, name };
