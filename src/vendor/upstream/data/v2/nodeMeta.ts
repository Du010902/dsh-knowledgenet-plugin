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
import { RepositoryError, externalChangeConflict } from "../errors.ts";
import { isoFromMs, parseNodeMeta, serializeJson, type V2NodeMeta } from "./schema.ts";
import { sha256Hex } from "./hash.ts";
import { writeTextAtomic, type Vfs } from "./fs.ts";
import { nodeMetaFile } from "./paths.ts";

export interface NodeMetaSnapshot {
  meta: V2NodeMeta;
  /** 相对知识库根的正斜杠路径 */
  relativePath: string;
  sha256: string;
  text: string;
}

/** 读节点元数据；解析失败原样抛 `MetadataError`，由调用方转成扫描问题或错误码 */
export async function readNodeMeta(vfs: Vfs, nodeRel: string): Promise<NodeMetaSnapshot> {
  const rel = nodeMetaFile(nodeRel);
  let text: string;
  try {
    text = await vfs.read(rel);
  } catch {
    throw new RepositoryError("node_missing", `节点目录里没有 ${rel}`, { relativePath: rel });
  }
  const meta = parseNodeMeta(text, rel);
  return { meta, relativePath: nodeRel, sha256: sha256Hex(text), text };
}

/** 读节点元数据；不存在时返回 null（只用于「可能还没有元数据」的路径） */
export async function readNodeMetaIfExists(
  vfs: Vfs,
  nodeRel: string,
): Promise<NodeMetaSnapshot | null> {
  const rel = nodeMetaFile(nodeRel);
  if (!(await vfs.exists(rel))) return null;
  return readNodeMeta(vfs, nodeRel);
}

/**
 * 写入节点元数据（原子替换），并做修订号 + 哈希守卫。
 *
 * `expectedRevision` / `expectedHash` 为 null 表示调用方明确要求「不管磁盘上是什么，
 * 覆盖它」——只有新建节点与「重新分配 ID」这类不涉及用户内容的场景才允许。
 */
export async function writeNodeMeta(
  vfs: Vfs,
  nodeRel: string,
  meta: V2NodeMeta,
  expected: { expectedRevision?: number | null; expectedHash?: string | null; touch?: boolean } = {},
): Promise<NodeMetaSnapshot> {
  const rel = nodeMetaFile(nodeRel);
  const existing = await readNodeMetaIfExists(vfs, nodeRel);
  if (existing) {
    const expectedRevision = expected.expectedRevision ?? null;
    const expectedHash = expected.expectedHash ?? null;
    if (expectedRevision !== null && expectedRevision !== existing.meta.revision) {
      throw externalChangeConflict({
        relativePath: rel,
        expectedRevision,
        actualRevision: existing.meta.revision,
        expectedHash,
        actualHash: existing.sha256,
        message: "磁盘上的 node.json 已被外部修改（修订号不符），已拒绝覆盖",
      });
    }
    if (expectedHash !== null && expectedHash !== existing.sha256) {
      throw externalChangeConflict({
        relativePath: rel,
        expectedRevision: expectedRevision ?? existing.meta.revision,
        actualRevision: existing.meta.revision,
        expectedHash,
        actualHash: existing.sha256,
        message: "磁盘上的 node.json 已被外部修改（内容哈希不符），已拒绝覆盖",
      });
    }
  } else if ((expected.expectedRevision ?? null) !== null && (expected.expectedRevision ?? 0) > 0) {
    throw new RepositoryError("node_missing", `节点元数据不见了：${rel}`, { relativePath: rel });
  }

  const now = isoFromMs(Date.now());
  const next: V2NodeMeta = {
    ...meta,
    revision: (existing?.meta.revision ?? meta.revision ?? 1) + (existing ? 1 : 0),
    updatedAt: expected.touch === false ? meta.updatedAt : now,
  };
  if (!existing && next.revision < 1) next.revision = 1;
  const text = serializeJson(next);
  await writeTextAtomic(vfs, rel, text);
  return { meta: next, relativePath: nodeRel, sha256: sha256Hex(text), text };
}
