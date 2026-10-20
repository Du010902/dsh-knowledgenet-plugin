/**
 * 节点删除的**纯文件系统实现**（轻量模块：只依赖 node:fs / node:path）。
 *
 * 为什么单独拆出来：`graph-edit.ts` 会连带导入 `node-vfs.ts`（真实磁盘 VFS），
 * 而这里只关心"删文件夹 / 搬备份"这几条文件系统语义 ✓ —— 拆开后可以单独单测 ✓。
 *
 * 语义：**删除整个节点文件夹**（`Backup/` 备份或彻底删除 ✓）。
 *
 * 历史：v2 时代的「只移除节点身份（`.meta/knowledgenet` → 回收站）」已经不再被任何代码使用
 * （v3 一节点一个 .md，没有独立元数据目录 ✓），那个函数已整体删除 ✓。
 */
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { META_NS_DIR, NODE_FILE } from "../vendor/upstream/data/v2/paths.ts";

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
