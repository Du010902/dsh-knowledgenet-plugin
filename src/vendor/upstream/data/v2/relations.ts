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
import { RepositoryError, externalChangeConflict } from "../errors.ts";
import type { Evidence, EvidenceInput } from "../types.ts";
import { newUuid } from "../uuid.ts";
import {
  emptyRelations,
  isoFromMs,
  parseIsoMs,
  parseRelationsFile,
  serializeJson,
  type V2Evidence,
  type V2RelationEdge,
  type V2RelationsFile,
} from "./schema.ts";
import { sha256Hex } from "./hash.ts";
import { writeTextAtomic, type Vfs } from "./fs.ts";
import { relationsFile } from "./paths.ts";

export interface RelationsSnapshot {
  file: V2RelationsFile;
  sha256: string;
}

/** 读 `relations.json`；缺失时返回空文件（没有出边是常态，不是错误） */
export async function readRelations(
  vfs: Vfs,
  nodeRel: string,
  nodeId: string,
): Promise<RelationsSnapshot> {
  const rel = relationsFile(nodeRel);
  let text: string | null = null;
  try {
    text = await vfs.read(rel);
  } catch {
    text = null;
  }
  if (text === null) return { file: emptyRelations(nodeId), sha256: "" };
  const file = parseRelationsFile(text, rel);
  return { file, sha256: sha256Hex(text) };
}

/**
 * 写 `relations.json`（原子替换）。
 *
 * `expectedRevision` / `expectedHash` 为 null 表示调用方刚读过、明确要覆盖
 * （本模块内部的所有改边操作都属于这一类）。
 */
export async function writeRelations(
  vfs: Vfs,
  nodeRel: string,
  file: V2RelationsFile,
  expected: { expectedRevision?: number | null; expectedHash?: string | null } = {},
): Promise<RelationsSnapshot> {
  const rel = relationsFile(nodeRel);
  const current = await readRelations(vfs, nodeRel, file.nodeId);
  const hasFile = current.sha256 !== "";
  const expectedRevision = expected.expectedRevision ?? null;
  const expectedHash = expected.expectedHash ?? null;

  if (hasFile) {
    if (expectedRevision !== null && expectedRevision !== current.file.revision) {
      throw externalChangeConflict({
        relativePath: rel,
        expectedRevision,
        actualRevision: current.file.revision,
        expectedHash,
        actualHash: current.sha256,
        message: "磁盘上的 relations.json 已被外部修改（修订号不符），已拒绝覆盖",
      });
    }
    if (expectedHash !== null && expectedHash !== current.sha256) {
      throw externalChangeConflict({
        relativePath: rel,
        expectedRevision: expectedRevision ?? current.file.revision,
        actualRevision: current.file.revision,
        expectedHash,
        actualHash: current.sha256,
        message: "磁盘上的 relations.json 已被外部修改（内容哈希不符），已拒绝覆盖",
      });
    }
  }

  const next: V2RelationsFile = {
    ...file,
    revision: hasFile ? Math.max(file.revision, current.file.revision + 1) : Math.max(1, file.revision),
  };
  const text = serializeJson(next);
  await writeTextAtomic(vfs, rel, text);
  return { file: next, sha256: sha256Hex(text) };
}

/** 内部：读改写一次（revision 自增），`mutate` 里改 `outgoing` */
async function mutateRelations(
  vfs: Vfs,
  nodeRel: string,
  nodeId: string,
  mutate: (file: V2RelationsFile) => void,
): Promise<V2RelationsFile> {
  const current = await readRelations(vfs, nodeRel, nodeId);
  const file: V2RelationsFile = { ...current.file };
  if (file.nodeId !== nodeId) file.nodeId = nodeId;
  mutate(file);
  const written = await writeRelations(vfs, nodeRel, file, {
    expectedRevision: current.sha256 === "" ? null : current.file.revision,
    expectedHash: current.sha256 === "" ? null : current.sha256,
  });
  return written.file;
}

/** 新增一条出边；同一目标 + 同一类型的重复边直接返回已有的那条 */
export async function addEdge(
  vfs: Vfs,
  nodeRel: string,
  nodeId: string,
  input: {
    toNodeId: string;
    toTitle: string;
    relationType?: string;
    description?: string;
    edgeId?: string;
  },
): Promise<V2RelationEdge> {
  const relationType = input.relationType?.trim() || "prerequisite";
  let saved: V2RelationEdge | null = null;
  const file = await mutateRelations(vfs, nodeRel, nodeId, (draft) => {
    const existing = draft.outgoing.find(
      (edge) => edge.toNodeId === input.toNodeId && edge.type === relationType,
    );
    if (existing) {
      saved = existing;
      return;
    }
    const now = isoFromMs(Date.now());
    const edge: V2RelationEdge = {
      id: input.edgeId ?? newUuid(),
      toNodeId: input.toNodeId,
      type: relationType,
      description: input.description ?? "",
      toTitleSnapshot: input.toTitle,
      createdAt: now,
      updatedAt: now,
      evidence: [],
    };
    draft.outgoing.push(edge);
    saved = edge;
  });
  const edge = saved ?? file.outgoing.find((item) => item.toNodeId === input.toNodeId);
  if (!edge) throw new RepositoryError("internal", "写入关系失败");
  return edge;
}

export async function removeEdge(
  vfs: Vfs,
  nodeRel: string,
  nodeId: string,
  edgeId: string,
): Promise<boolean> {
  let removed = false;
  await mutateRelations(vfs, nodeRel, nodeId, (draft) => {
    const index = draft.outgoing.findIndex((edge) => edge.id === edgeId);
    if (index < 0) return;
    draft.outgoing.splice(index, 1);
    removed = true;
  });
  return removed;
}

export async function updateEdgeDescription(
  vfs: Vfs,
  nodeRel: string,
  nodeId: string,
  edgeId: string,
  description: string,
): Promise<V2RelationEdge> {
  let saved: V2RelationEdge | null = null;
  await mutateRelations(vfs, nodeRel, nodeId, (draft) => {
    const edge = draft.outgoing.find((item) => item.id === edgeId);
    if (!edge) return;
    edge.description = description;
    edge.updatedAt = isoFromMs(Date.now());
    saved = edge;
  });
  if (!saved) throw new RepositoryError("not_found", `关系不存在：${edgeId}`);
  return saved;
}

export async function updateEdgeRelation(
  vfs: Vfs,
  nodeRel: string,
  nodeId: string,
  edgeId: string,
  patch: { relationType?: string; description?: string; toTitleSnapshot?: string },
): Promise<V2RelationEdge> {
  let saved: V2RelationEdge | null = null;
  await mutateRelations(vfs, nodeRel, nodeId, (draft) => {
    const edge = draft.outgoing.find((item) => item.id === edgeId);
    if (!edge) return;
    if (patch.relationType !== undefined) edge.type = patch.relationType;
    if (patch.description !== undefined) edge.description = patch.description;
    if (patch.toTitleSnapshot !== undefined) edge.toTitleSnapshot = patch.toTitleSnapshot;
    edge.updatedAt = isoFromMs(Date.now());
    saved = edge;
  });
  if (!saved) throw new RepositoryError("not_found", `关系不存在：${edgeId}`);
  return saved;
}

function evidenceToDomain(record: V2Evidence): Evidence {
  return {
    id: record.id,
    threadId: record.threadId,
    messageId: record.messageId,
    snippet: record.snippet,
    question: record.question,
    createdAt: parseIsoMs(record.createdAt),
  };
}

export function evidenceToFile(evidence: Evidence): V2Evidence {
  return {
    id: evidence.id,
    threadId: evidence.threadId,
    messageId: evidence.messageId,
    snippet: evidence.snippet,
    question: evidence.question,
    createdAt: isoFromMs(evidence.createdAt),
  };
}

/** 把一段选中文字记到某条关系上（来源记录） */
export async function addEvidence(
  vfs: Vfs,
  nodeRel: string,
  nodeId: string,
  edgeId: string,
  input: EvidenceInput,
): Promise<Evidence> {
  const now = Date.now();
  const record: Evidence = {
    id: newUuid(now),
    threadId: input.threadId ?? null,
    messageId: input.messageId ?? null,
    snippet: input.snippet,
    question: input.question ?? "",
    createdAt: now,
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

export async function deleteEvidence(
  vfs: Vfs,
  nodeRel: string,
  nodeId: string,
  edgeId: string,
  evidenceId: string,
): Promise<void> {
  await mutateRelations(vfs, nodeRel, nodeId, (draft) => {
    const edge = draft.outgoing.find((item) => item.id === edgeId);
    if (!edge) return;
    edge.evidence = edge.evidence.filter((item) => item.id !== evidenceId);
  });
}

/** 读出某个节点全部出边的来源记录（按边 ID 分组） */
export async function evidenceByEdge(
  vfs: Vfs,
  nodeRel: string,
  nodeId: string,
): Promise<Record<string, Evidence[]>> {
  const { file } = await readRelations(vfs, nodeRel, nodeId);
  const out: Record<string, Evidence[]> = {};
  for (const edge of file.outgoing) {
    out[edge.id] = edge.evidence.map(evidenceToDomain);
  }
  return out;
}

/**
 * 合并节点用：把一批源节点里指向 `oldToId` 的出边改接到 `newToId`。
 *
 * 同时做去重与去自环——合并之后 `A → A` 这种边没有意义，
 * 但**不能**直接删掉了事：来源记录要保留（内容留着，边断开）。
 */
export async function repointTarget(
  vfs: Vfs,
  sourceRels: Array<{ relativePath: string; nodeId: string }>,
  oldToId: string,
  newToId: string,
  newTitle: string,
): Promise<{ moved: number; dropped: Array<{ droppedEdgeId: string; replacementEdgeId: string | null }> }> {
  let moved = 0;
  const dropped: Array<{ droppedEdgeId: string; replacementEdgeId: string | null }> = [];

  for (const source of sourceRels) {
    const current = await readRelations(vfs, source.relativePath, source.nodeId);
    const target = current.file.outgoing.find((edge) => edge.toNodeId === oldToId);
    if (!target) continue;
    const selfLoop = source.nodeId === newToId;
    const duplicate = current.file.outgoing.find(
      (edge) =>
        edge.id !== target.id && edge.toNodeId === newToId && edge.type === target.type && !selfLoop,
    );
    if (selfLoop) {
      dropped.push({ droppedEdgeId: target.id, replacementEdgeId: null });
    } else if (duplicate) {
      dropped.push({ droppedEdgeId: target.id, replacementEdgeId: duplicate.id });
    } else {
      moved += 1;
    }
    await mutateRelations(vfs, source.relativePath, source.nodeId, (draft) => {
      const index = draft.outgoing.findIndex((edge) => edge.id === target.id);
      if (index < 0) return;
      if (selfLoop || duplicate) {
        draft.outgoing.splice(index, 1);
        return;
      }
      const edge = draft.outgoing[index] as V2RelationEdge;
      edge.toNodeId = newToId;
      edge.toTitleSnapshot = newTitle;
      edge.updatedAt = isoFromMs(Date.now());
    });
  }

  return { moved, dropped };
}

/** 合并节点用：把源节点目录里的全部出边迁移到目标节点目录（去重） */
export async function moveEdges(
  vfs: Vfs,
  source: { relativePath: string; nodeId: string },
  target: { relativePath: string; nodeId: string },
): Promise<number> {
  const from = await readRelations(vfs, source.relativePath, source.nodeId);
  if (from.file.outgoing.length === 0) return 0;
  const to = await readRelations(vfs, target.relativePath, target.nodeId);
  const existing = new Set(to.file.outgoing.map((edge) => `${edge.toNodeId}|${edge.type}`));
  let moved = 0;
  for (const edge of from.file.outgoing) {
    const key = `${edge.toNodeId}|${edge.type}`;
    if (edge.toNodeId === target.nodeId) continue; // 自环不迁移
    if (existing.has(key)) continue; // 去重
    existing.add(key);
    moved += 1;
    await mutateRelations(vfs, target.relativePath, target.nodeId, (draft) => {
      draft.outgoing.push({ ...edge });
    });
  }
  await mutateRelations(vfs, source.relativePath, source.nodeId, (draft) => {
    draft.outgoing = [];
  });
  return moved;
}
