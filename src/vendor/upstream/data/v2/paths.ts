/**
 * v2 磁盘路径规则（纯函数，与 Rust `src-tauri/src/v2/vpaths.rs` 一一对应）
 *
 * 全部路径都是**相对知识库根目录**的正斜杠字符串，根目录用空串 `""` 表示。
 * 这里不碰真实文件系统，因此可以在浏览器、测试与 Node 里共用同一套规则。
 *
 * 硬规则：
 * - 节点只能由**精确路径** `.meta/knowledgenet/node.json` 标记，`.meta` 本身不是节点；
 * - 消息文件名固定 `<6 位零填充序号>_<messageId>.json`；
 * - 任何拼出来的相对路径都必须留在知识库内（禁止绝对路径、盘符与 `..`）。
 */
import { RepositoryError } from "../errors.ts";

export const META_DIR = ".meta";
export const NS_DIR = "knowledgenet";
/** 节点元数据命名空间目录：`.meta/knowledgenet` */
export const META_NS_DIR = `${META_DIR}/${NS_DIR}`;
export const NODE_FILE = "node.json";
export const LIBRARY_FILE = "library.json";
export const RELATIONS_FILE = "relations.json";
export const RESOURCES_FILE = "resources.json";
export const BOOKMARKS_FILE = "bookmarks.json";
export const CHATS_DIR = "chats";
export const THREAD_FILE = "thread.json";
export const MESSAGES_DIR = "messages";
/** 笔记冲突副本目录（节点内，跟着节点一起走） */
export const CONFLICTS_DIR = "conflicts";

/** 知识库根部（不是节点）的元数据目录 */
export const ROOT_META_DIR = ".knowledgenet";
export const GOALS_FILE = `${ROOT_META_DIR}/goals.json`;
export const LOCK_FILE = `${ROOT_META_DIR}/lock`;
export const TRASH_NODE_METADATA_DIR = `${ROOT_META_DIR}/trash/node-metadata`;
/** 删除节点文件夹之前的整份备份：`<root>/.knowledgenet/backups/<时间戳>-<名字>/` */
export const BACKUPS_DIR = `${ROOT_META_DIR}/backups`;

/** 扫描永远排除的目录名（另加 `library.json.scan.exclude`） */
export const ALWAYS_EXCLUDED_DIRS: readonly string[] = [".git", "node_modules", ROOT_META_DIR];

/** 节点标记文件的精确相对路径（相对于节点目录） */
export const NODE_MARKER = `${META_NS_DIR}/${NODE_FILE}`;

/** 把任意路径写法归一化成「正斜杠、无首尾斜杠、无 `.` 段」的相对路径 */
export function normalizeRel(rel: string): string {
  const parts: string[] = [];
  for (const raw of String(rel ?? "").replace(/\\/g, "/").split("/")) {
    if (raw === "" || raw === ".") continue;
    parts.push(raw);
  }
  return parts.join("/");
}

/** 拼接相对路径；全部为空时返回 `""`（知识库根） */
export function joinRel(...parts: Array<string | null | undefined>): string {
  return normalizeRel(parts.filter((p): p is string => typeof p === "string" && p.length > 0).join("/"));
}

/** 父目录；根目录的父目录仍然是根目录 */
export function parentRel(rel: string): string {
  const norm = normalizeRel(rel);
  const index = norm.lastIndexOf("/");
  return index < 0 ? "" : norm.slice(0, index);
}

/** 最后一段名字；根目录返回空串 */
export function baseName(rel: string): string {
  const norm = normalizeRel(rel);
  const index = norm.lastIndexOf("/");
  return index < 0 ? norm : norm.slice(index + 1);
}

/** 相对根的层级：根为 0，`Nodes` 为 1，`Nodes/Attention` 为 2 */
export function depthOf(rel: string): number {
  const norm = normalizeRel(rel);
  return norm === "" ? 0 : norm.split("/").length;
}

/** 该路径是否位于 `.meta` 之内（`.meta` 自身也算） */
export function isMetaRelative(rel: string): boolean {
  const norm = normalizeRel(rel);
  return norm === META_DIR || norm.startsWith(`${META_DIR}/`);
}

/** 路径是否可能逃出知识库根目录（绝对路径、盘符、`..` 段） */
export function escapesLibrary(rel: string): boolean {
  const raw = String(rel ?? "").replace(/\\/g, "/");
  if (raw.startsWith("/")) return true;
  if (/^[a-zA-Z]:/.test(raw)) return true;
  return raw.split("/").some((part) => part === "..");
}

/**
 * 校验并归一化节点内的相对路径（`primaryDocument`、资料文件路径）。
 * 逃出节点/知识库一律按 `node_outside_library` 拒绝，而不是悄悄修正。
 */
export function requireSafeRelative(rel: string, what = "相对路径"): string {
  const raw = String(rel ?? "");
  if (raw.trim() === "") {
    throw new RepositoryError("invalid_input", `${what}不能为空`);
  }
  if (escapesLibrary(raw)) {
    throw new RepositoryError("node_outside_library", `${what}逃出了知识库根目录：${raw}`, {
      relativePath: raw,
    });
  }
  return normalizeRel(raw);
}

/* ------------------------------ 节点元数据路径 ------------------------------ */

export function nsDir(nodeRel: string): string {
  return joinRel(nodeRel, META_NS_DIR);
}

export function nodeMetaFile(nodeRel: string): string {
  return joinRel(nodeRel, NODE_MARKER);
}

export function hasNodeMarker(rel: string): boolean {
  return normalizeRel(rel).endsWith(`/${NODE_MARKER}`) || normalizeRel(rel) === NODE_MARKER;
}

export function relationsFile(nodeRel: string): string {
  return joinRel(nodeRel, META_NS_DIR, RELATIONS_FILE);
}

export function resourcesFile(nodeRel: string): string {
  return joinRel(nodeRel, META_NS_DIR, RESOURCES_FILE);
}

export function bookmarksFile(nodeRel: string): string {
  return joinRel(nodeRel, META_NS_DIR, BOOKMARKS_FILE);
}

export function chatsDir(nodeRel: string): string {
  return joinRel(nodeRel, META_NS_DIR, CHATS_DIR);
}

export function threadDir(nodeRel: string, threadId: string): string {
  return joinRel(chatsDir(nodeRel), threadId);
}

export function threadFile(nodeRel: string, threadId: string): string {
  return joinRel(threadDir(nodeRel, threadId), THREAD_FILE);
}

export function messagesDir(nodeRel: string, threadId: string): string {
  return joinRel(threadDir(nodeRel, threadId), MESSAGES_DIR);
}

export function conflictsDir(nodeRel: string): string {
  return joinRel(nodeRel, META_NS_DIR, CONFLICTS_DIR);
}

/* -------------------------------- 消息文件名 -------------------------------- */

/** `<6 位零填充序号>_<messageId>.json` */
export function messageFileName(sequence: number, messageId: string): string {
  const seq = Math.max(0, Math.trunc(sequence));
  return `${String(seq).padStart(6, "0")}_${messageId}.json`;
}

/** 反向解析消息文件名；不符合命名规则时返回 null（仍然计入消息数，但不参与排序） */
export function parseMessageFileName(name: string): { sequence: number; messageId: string } | null {
  const match = /^(\d{6})_(.+)\.json$/.exec(name);
  if (!match) return null;
  const sequence = Number.parseInt(match[1] as string, 10);
  const messageId = match[2] as string;
  if (!Number.isFinite(sequence) || messageId.length === 0) return null;
  return { sequence, messageId };
}

/** 去掉扩展名的文件名（`note.md` -> `note`） */
export function stemOf(name: string): string {
  const base = baseName(name);
  const index = base.lastIndexOf(".");
  return index <= 0 ? base : base.slice(0, index);
}

/** 扩展名（含点；没有扩展名时返回空串） */
export function extNameOf(name: string): string {
  const base = baseName(name);
  const index = base.lastIndexOf(".");
  return index <= 0 ? "" : base.slice(index);
}
