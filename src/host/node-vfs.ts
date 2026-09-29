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
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { RepositoryError } from "../vendor/upstream/data/errors.ts";
import type { Vfs, VfsEntry } from "../vendor/upstream/data/v2/fs.ts";
import { escapesLibrary, normalizeRel } from "../vendor/upstream/data/v2/paths.ts";

let atomicSeq = 0;

export class NodeVfs implements Vfs {
  constructor(readonly root: string) {}

  /** 相对路径 → 绝对路径。逃出知识库根的写法一律拒绝，而不是悄悄修正。 */
  absolute(rel: string): string {
    if (escapesLibrary(rel)) {
      throw new RepositoryError("node_outside_library", `路径逃出知识库根目录：${rel}`, {
        relativePath: rel,
      });
    }
    const norm = normalizeRel(rel);
    return norm === "" ? this.root : path.join(this.root, ...norm.split("/"));
  }

  async read(rel: string): Promise<string> {
    const norm = normalizeRel(rel);
    // 关键：绝对路径检查必须发生在 try 之外，否则「逃出库根」会被下面的 catch
    // 吞掉并改写成 not_found，安全边界就形同虚设。
    const abs = this.absolute(norm);
    try {
      return await readFile(abs, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const what = code === "EISDIR" ? "目录不是文件" : "文件不存在";
      throw new RepositoryError("not_found", `${what}：${norm}`, { relativePath: norm });
    }
  }

  async write(rel: string, text: string): Promise<void> {
    const norm = normalizeRel(rel);
    if (norm === "") {
      throw new RepositoryError("invalid_input", "不能写到知识库根目录本身");
    }
    const abs = this.absolute(norm);
    await mkdir(path.dirname(abs), { recursive: true });
    atomicSeq += 1;
    const tmp = `${abs}.${process.pid.toString(36)}.${atomicSeq.toString(36)}.kn-tmp`;
    await writeFile(tmp, text, "utf8");
    // Windows 上 fs.rename 不会覆盖已存在的目标，所以先删目标再改名：
    // 结果要么是完整的新内容，要么（极端情况下）没有目标文件，但绝不会是半个文件。
    await rm(abs, { force: true }).catch(() => undefined);
    await rename(tmp, abs);
  }

  async exists(rel: string): Promise<boolean> {
    const abs = this.absolute(rel); // 同上：检查在 try 之外
    try {
      await stat(abs);
      return true;
    } catch {
      return false;
    }
  }

  async list(rel: string): Promise<VfsEntry[]> {
    const norm = normalizeRel(rel);
    const abs = this.absolute(norm);
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      throw new RepositoryError("not_found", `目录不存在：${norm}`, { relativePath: norm });
    }
    const out: VfsEntry[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        out.push({ name: entry.name, kind: "dir", byteLength: 0, modifiedMs: 0 });
        continue;
      }
      // 符号链接 / junction 一律跳过：上游 NodeVfs 与 Rust 扫描器都是这条纪律
      if (!entry.isFile()) continue;
      const info = await stat(path.join(abs, entry.name)).catch(() => null);
      out.push({
        name: entry.name,
        kind: "file",
        byteLength: info?.size ?? 0,
        modifiedMs: info?.mtimeMs ?? 0,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async remove(rel: string): Promise<void> {
    const norm = normalizeRel(rel);
    if (norm === "") {
      throw new RepositoryError("invalid_input", "拒绝删除知识库根目录本身");
    }
    await rm(this.absolute(norm), { recursive: true, force: true });
  }

  async mkdir(rel: string): Promise<void> {
    const norm = normalizeRel(rel);
    if (norm === "") return;
    await mkdir(this.absolute(norm), { recursive: true });
  }
}
