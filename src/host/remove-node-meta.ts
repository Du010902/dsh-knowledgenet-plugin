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
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { META_NS_DIR, NODE_FILE, TRASH_NODE_METADATA_DIR } from "../vendor/upstream/data/v2/paths.ts";

/**
 * 删除节点时"备份"的落点：**库根的 `Backup/`**（建库时就会创建）。
 *
 * 与库自己的 `.knowledgenet/trash/node-metadata/` 的区别：那是"只留元数据"的回收站，
 * 而 `Backup/` 存的是**整个节点文件夹**（笔记、附件、元数据都在里面），用户能直接在文件管理器里
 * 找回、读懂、搬回去。
 */
export const BACKUP_DIR = "Backup";

/** 删除节点时用户的选择 */
export type NodeDeleteMode = "backup" | "purge";

/** 一次删除的结果 */
export interface RemoveNodeFolderResult {
  ok: boolean;
  /** 实际执行的方式 */
  mode?: NodeDeleteMode;
  /** 备份模式：备份目录的相对路径（库根为基准） */
  backup?: string;
  error?: { code: string; message: string };
}

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
export async function removeNodeFolder(
  input: { root: string; relativePath: string; mode: NodeDeleteMode },
  now: Date = new Date(),
): Promise<RemoveNodeFolderResult> {
  const root = typeof input.root === "string" ? input.root : "";
  const relativePath = typeof input.relativePath === "string" ? input.relativePath : "";
  const mode: NodeDeleteMode = input.mode === "purge" ? "purge" : "backup";
  if (root === "" || relativePath === "" || !isAbsolute(root)) {
    return { ok: false, error: { code: "node_path_required", message: "节点路径不完整，无法删除" } };
  }

  const rootAbs = resolve(root);
  const targetAbs = resolve(join(rootAbs, relativePath));
  const inside = relative(rootAbs, targetAbs);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    // 目标不在库内（或就是库根本身）：拒绝，绝不动库根
    return { ok: false, error: { code: "outside_library", message: "这个节点不在知识库目录里，已拒绝删除" } };
  }

  const exists = await stat(targetAbs).then((info) => info.isDirectory()).catch(() => false);
  if (!exists) {
    return { ok: false, error: { code: "node_missing", message: "这个节点的文件夹已经不存在了" } };
  }

  if (mode === "purge") {
    try {
      await rm(targetAbs, { recursive: true, force: true });
      return { ok: true, mode };
    } catch (error) {
      return {
        ok: false,
        error: { code: "purge_failed", message: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  try {
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    const name = relativePath.split(/[\\/]/).filter((part) => part !== "").pop() ?? "node";
    let backupRel = `${BACKUP_DIR}/${stamp}-${name}`;
    let backupAbs = join(rootAbs, backupRel);
    // 同一秒内删两个同名节点时避免撞车
    for (let index = 2; index < 100; index += 1) {
      const taken = await stat(backupAbs).then(() => true).catch(() => false);
      if (!taken) break;
      backupRel = `${BACKUP_DIR}/${stamp}-${name}-${index}`;
      backupAbs = join(rootAbs, backupRel);
    }
    await mkdir(dirname(backupAbs), { recursive: true });
    await rename(targetAbs, backupAbs);
    /*
     * 搬完还要把**节点身份文件改名**。
     *
     * 库的扫描器判定节点的规则是"某目录下存在 `.meta/knowledgenet/node.json`"，**不看目录位置**——
     * 所以备份目录里的 node.json 会让刚删掉的节点立刻从 Backup/ 里"复活"（实测：撤销后重扫仍在库里）。
     * 改名 `.backup` 后扫描不到；想还原时把它改回 `node.json`、再把文件夹搬回 Nodes/ 即可。
     */
    const identityFile = join(backupAbs, META_NS_DIR, NODE_FILE);
    const hasIdentity = await stat(identityFile).then(() => true).catch(() => false);
    if (hasIdentity) {
      await rename(identityFile, `${identityFile}.backup`).catch(() => undefined);
    }
    return { ok: true, mode, backup: backupRel };
  } catch (error) {
    return {
      ok: false,
      error: { code: "backup_failed", message: error instanceof Error ? error.message : String(error) },
    };
  }
}

/** 结果 */
export interface RemoveNodeMetadataResult {
  ok: boolean;
  /** 回收站里的相对路径（可恢复位置的凭据） */
  trash?: string;
  error?: { code: string; message: string };
}

/**
 * 移除某个节点的身份（元数据进回收站，用户文件保留）。
 *
 * @param input.root - 库根目录（绝对路径）。
 * @param input.relativePath - 节点相对库根的目录。
 * @param input.title - 节点标题（仅用于日志/回报，可空）。
 * @param now - 时间戳来源（可注入，便于测试）。
 * @returns 成功/失败（失败带可读原因）。
 */
export async function removeNodeMetadata(
  input: { root: string; relativePath: string; title?: string },
  now: Date = new Date(),
): Promise<RemoveNodeMetadataResult> {
  const root = typeof input.root === "string" ? input.root : "";
  const relativePath = typeof input.relativePath === "string" ? input.relativePath : "";
  if (root === "" || relativePath === "") {
    return { ok: false, error: { code: "node_path_required", message: "节点路径不完整，无法移除身份" } };
  }
  const metaAbs = join(root, relativePath, META_NS_DIR);
  try {
    const present = await stat(metaAbs).then(() => true).catch(() => false);
    if (!present) {
      return {
        ok: false,
        error: {
          code: "node_metadata_missing",
          message: "这个节点没有 .meta/knowledgenet 元数据，无法移除它的身份（文件不会被改动）",
        },
      };
    }
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    const name = relativePath.split(/[\\/]/).filter((part) => part !== "").pop() ?? "node";
    const trashRel = `${TRASH_NODE_METADATA_DIR}/${stamp}-${name}`;
    const trashAbs = join(root, trashRel);
    await mkdir(dirname(trashAbs), { recursive: true });
    await rename(metaAbs, trashAbs);
    return { ok: true, trash: trashRel };
  } catch (error) {
    return {
      ok: false,
      error: { code: "remove_failed", message: error instanceof Error ? error.message : String(error) },
    };
  }
}
