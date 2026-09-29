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
import { RepositoryError } from "../errors.ts";
import type { NodeNote, NoteConflict, NoteDiskState } from "../types.ts";
import { fileEntry, writeTextAtomic, type Vfs } from "./fs.ts";
import { byteLengthOf, sha256Hex } from "./hash.ts";
import { readNodeMeta, readNodeMetaIfExists } from "./nodeMeta.ts";
import {
  emptyNotesIndex,
  parseNotesIndexFile,
  serializeJson,
  type V2NoteEntry,
  type V2NotesIndexFile,
} from "./schema.ts";
import { META_NS_DIR, conflictsDir, extNameOf, joinRel, stemOf } from "./paths.ts";

/** 没有 `primaryDocument` 时的默认正文文件名 */
export const DEFAULT_DOCUMENT = "note.md";

/** 记账文件相对节点目录的路径 */
export const NOTES_INDEX_FILE = `${META_NS_DIR}/notes-index.json`;

export interface NoteFingerprint {
  /** 文档相对节点目录的路径 */
  relativePath: string;
  revision: number;
  sha256: string;
  byteLength: number;
  modifiedAt: number;
}

export interface DocumentSnapshot {
  nodeId: string;
  /** 文档相对节点目录的路径 */
  relativePath: string;
  content: string;
  sha256: string;
  byteLength: number;
  modifiedAt: number;
  documentRevision: number;
}

export type DocumentWriteOutcome =
  | { status: "saved"; note: DocumentSnapshot; conflictCopy: string | null }
  | { status: "conflict"; conflict: NoteConflict; conflictCopy: string | null };

/** 节点当前的主文档路径：元数据里写了就用它，否则用 `note.md` */
export function documentPathOf(primaryDocument: string | null | undefined): string {
  return primaryDocument && primaryDocument.trim() !== "" ? primaryDocument : DEFAULT_DOCUMENT;
}

export function makeNoteFingerprint(input: {
  relativePath: string;
  revision: number;
  content: string;
  modifiedAt?: number;
}): NoteFingerprint {
  return {
    relativePath: input.relativePath,
    revision: input.revision,
    sha256: sha256Hex(input.content),
    byteLength: byteLengthOf(input.content),
    modifiedAt: input.modifiedAt ?? Date.now(),
  };
}

/* ------------------------------ 记账文件读写 ------------------------------ */

function notesIndexPath(nodeRel: string): string {
  return joinRel(nodeRel, NOTES_INDEX_FILE);
}

/** 读记账文件；缺失或坏掉都返回空索引（重建它不需要用户做任何事） */
export async function readNotesIndex(
  vfs: Vfs,
  nodeRel: string,
  nodeId: string,
): Promise<V2NotesIndexFile> {
  const rel = notesIndexPath(nodeRel);
  try {
    const file = parseNotesIndexFile(await vfs.read(rel), rel);
    return file.nodeId === nodeId ? file : { ...file, nodeId };
  } catch {
    return emptyNotesIndex(nodeId);
  }
}

async function writeNotesIndex(
  vfs: Vfs,
  nodeRel: string,
  file: V2NotesIndexFile,
): Promise<void> {
  await writeTextAtomic(vfs, notesIndexPath(nodeRel), serializeJson(file));
}

/** 取出某个文档的记账项（没有就是 null：说明这份文档还没被本应用登记过） */
export async function fingerprintOf(
  vfs: Vfs,
  nodeRel: string,
  nodeId: string,
  documentRel: string,
): Promise<NoteFingerprint | null> {
  const file = await readNotesIndex(vfs, nodeRel, nodeId);
  const entry = file.entries.find((item) => item.relativePath === documentRel);
  return entry ? { ...entry } : null;
}

/** 写入/更新一条记账项（保留其它文档的记账） */
async function putFingerprint(
  vfs: Vfs,
  nodeRel: string,
  nodeId: string,
  fingerprint: NoteFingerprint,
): Promise<void> {
  const file = await readNotesIndex(vfs, nodeRel, nodeId);
  const entry: V2NoteEntry = { ...fingerprint };
  const entries = [...file.entries.filter((item) => item.relativePath !== entry.relativePath), entry];
  await writeNotesIndex(vfs, nodeRel, { ...file, nodeId, entries });
}

/* -------------------------------- 读与检查 -------------------------------- */

async function diskSnapshot(
  vfs: Vfs,
  nodeRel: string,
  nodeId: string,
  documentRel: string,
  fingerprint: NoteFingerprint | null,
): Promise<DocumentSnapshot> {
  const rel = joinRel(nodeRel, documentRel);
  const entry = await fileEntry(vfs, rel);
  if (!entry) {
    return {
      nodeId,
      relativePath: documentRel,
      content: "",
      sha256: "",
      byteLength: 0,
      modifiedAt: 0,
      documentRevision: fingerprint?.revision ?? 0,
    };
  }
  const content = await vfs.read(rel);
  return {
    nodeId,
    relativePath: documentRel,
    content,
    sha256: sha256Hex(content),
    byteLength: byteLengthOf(content),
    modifiedAt: entry.modifiedMs,
    documentRevision: fingerprint?.revision ?? 0,
  };
}

/** 读主文档（进入节点时调用）；节点不存在时抛 `node_missing` */
export async function readDocument(
  vfs: Vfs,
  nodeRel: string,
  nodeId: string,
  documentRel?: string,
): Promise<DocumentSnapshot> {
  const snapshot = await readNodeMeta(vfs, nodeRel);
  const doc = documentRel ?? documentPathOf(snapshot.meta.primaryDocument);
  const fingerprint = await fingerprintOf(vfs, nodeRel, nodeId, doc);
  return diskSnapshot(vfs, nodeRel, nodeId, doc, fingerprint);
}

/** 检查磁盘上的主文档与记账是否一致（窗口重新获得焦点、进入节点时调用） */
export async function checkDocument(
  vfs: Vfs,
  nodeRel: string,
  nodeId: string,
  documentRel?: string,
): Promise<NoteDiskState> {
  const snapshot = await readNodeMetaIfExists(vfs, nodeRel);
  if (!snapshot) {
    throw new RepositoryError("node_missing", `节点不存在：${nodeRel}`, { relativePath: nodeRel });
  }
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
    changedOnDisk: !fingerprint || !exists || disk.sha256 !== fingerprint.sha256,
  };
}

/* --------------------------------- 写入 --------------------------------- */

/**
 * 写主文档。
 *
 * 判定顺序刻意固定：先看修订号（调用方手上的那份是不是最新），再看哈希
 * （磁盘内容有没有被外部编辑器改过）。这样界面上给出的冲突原因总是最贴近
 * 用户实际做错的那一步，而不是笼统地说「保存失败」。
 */
export async function writeDocument(
  vfs: Vfs,
  nodeRel: string,
  nodeId: string,
  content: string,
  expectedRevision: number,
  force = false,
  documentRel?: string,
): Promise<DocumentWriteOutcome> {
  const snapshot = await readNodeMeta(vfs, nodeRel);
  const doc = documentRel ?? documentPathOf(snapshot.meta.primaryDocument);
  const fingerprint = await fingerprintOf(vfs, nodeRel, nodeId, doc);
  const disk = await diskSnapshot(vfs, nodeRel, nodeId, doc, fingerprint);
  const exists = disk.modifiedAt > 0 || disk.sha256 !== "";
  const registered = fingerprint !== null;

  let reason: NoteConflict["reason"] | null = null;
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

  if (reason && !force) {
    return {
      status: "conflict",
      conflict: {
        disk,
        expectedRevision,
        reason,
        detail: `${detail}。可以选择重新载入磁盘版本、另存冲突副本，或明确覆盖。`,
      },
      conflictCopy: null,
    };
  }

  // 覆盖保存：先把磁盘上的旧版本留一份副本，用户不会丢东西
  let conflictCopy: string | null = null;
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
    modifiedAt: now,
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
      documentRevision: nextFingerprint.revision,
    },
    conflictCopy,
  };
}

/**
 * 新建节点时写一份初始主文档（桌面端与演示端都这么做）。
 *
 * 为什么新建节点一定要有 `note.md`：用户点开节点就能直接写，
 * 而不是先面对一句「还没有正文，是否创建」。
 */
export async function createPrimaryDocument(
  vfs: Vfs,
  nodeRel: string,
  nodeId: string,
  content = "",
  documentRel: string = DEFAULT_DOCUMENT,
): Promise<{ snapshot: DocumentSnapshot; documentRevision: number }> {
  await writeTextAtomic(vfs, joinRel(nodeRel, documentRel), content);
  const fingerprint = makeNoteFingerprint({ relativePath: documentRel, revision: 1, content });
  await putFingerprint(vfs, nodeRel, nodeId, fingerprint);
  return {
    snapshot: {
      nodeId,
      relativePath: documentRel,
      content,
      sha256: fingerprint.sha256,
      byteLength: fingerprint.byteLength,
      modifiedAt: fingerprint.modifiedAt,
      documentRevision: 1,
    },
    documentRevision: 1,
  };
}

/** 列出节点里的冲突副本（界面「查看被覆盖的旧版本」用） */
export async function listConflictCopies(
  vfs: Vfs,
  nodeRel: string,
): Promise<Array<{ relativePath: string; name: string; content: string }>> {
  const dir = conflictsDir(nodeRel);
  let entries;
  try {
    entries = await vfs.list(dir);
  } catch {
    return [];
  }
  const out: Array<{ relativePath: string; name: string; content: string }> = [];
  for (const entry of entries) {
    if (entry.kind !== "file") continue;
    const rel = joinRel(dir, entry.name);
    out.push({ relativePath: rel, name: entry.name, content: await vfs.read(rel) });
  }
  return out;
}

/** 把文档快照转成仓储层返回的形状（领域模型与快照字段一致，这里只是集中一处） */
export function toNodeNote(snapshot: DocumentSnapshot): NodeNote {
  return {
    nodeId: snapshot.nodeId,
    relativePath: snapshot.relativePath,
    content: snapshot.content,
    documentRevision: snapshot.documentRevision,
    sha256: snapshot.sha256,
    byteLength: snapshot.byteLength,
    modifiedAt: snapshot.modifiedAt,
  };
}
