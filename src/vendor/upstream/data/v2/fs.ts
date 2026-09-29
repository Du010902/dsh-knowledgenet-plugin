/**
 * 极小的文件系统抽象（Vfs）
 *
 * 为什么需要它：v2 的知识资产全是**开放文件**（node.json、relations.json、chats/**），
 * 扫描、读写、冲突校验与对话落盘都只依赖「读一个相对路径 / 列一层目录」这几件事。
 * 把这一层抽出来以后：
 *
 * - Rust 端在真实磁盘上做同一件事（`src-tauri/src/v2/*`）；
 * - 浏览器演示模式用 `MemoryVfs`（可序列化到 localStorage）；
 * - 测试用 Node `fs` 或 `MemoryVfs` 直接跑同一份扫描器。
 *
 * 路径约定与 `paths.ts` 一致：相对知识库根的正斜杠字符串，根目录是 `""`。
 * 所有写入都走「先写临时键，再替换」的原子路径（`writeTextAtomic`）。
 */
import { RepositoryError } from "../errors.ts";
import { baseName, joinRel, normalizeRel, parentRel } from "./paths.ts";

export type VfsEntryKind = "file" | "dir";

export interface VfsEntry {
  name: string;
  kind: VfsEntryKind;
  /** 文件字节数；目录为 0 */
  byteLength: number;
  /** 最后修改时间（毫秒）；未知时为 0 */
  modifiedMs: number;
}

export interface Vfs {
  /** 读文本文件；不存在或不是文件时抛 `not_found` */
  read(rel: string): Promise<string>;
  /** 覆盖写文本文件；父目录不存在时自动创建 */
  write(rel: string, text: string): Promise<void>;
  exists(rel: string): Promise<boolean>;
  /** 列出直接子项（不递归）；路径不存在时抛 `not_found` */
  list(rel: string): Promise<VfsEntry[]>;
  /** 删除文件或整棵目录；不存在时不报错 */
  remove(rel: string): Promise<void>;
  /** 创建目录（含父目录）；已存在时不报错 */
  mkdir(rel: string): Promise<void>;
}

interface MemoryFile {
  text: string;
  modifiedMs: number;
}

interface MemoryVfsSnapshot {
  version: 1;
  clock: number;
  files: Record<string, MemoryFile>;
}

/**
 * 内存文件系统（浏览器演示模式与测试用）。
 *
 * 目录是隐式的：写一个文件会把它的全部祖先目录补上，
 * 因此不需要调用方记得 `mkdir`，也不会出现「文件在、目录不在」的中间态。
 */
export class MemoryVfs implements Vfs {
  #files = new Map<string, MemoryFile>();
  #dirs = new Set<string>();
  #clock = 0;

  constructor(files: Record<string, string> = {}) {
    for (const [rel, text] of Object.entries(files)) {
      this.writeSync(rel, text);
    }
  }

  static fromJSON(raw: string | null | undefined): MemoryVfs {
    const vfs = new MemoryVfs();
    if (!raw) return vfs;
    try {
      const parsed = JSON.parse(raw) as MemoryVfsSnapshot;
      for (const [rel, file] of Object.entries(parsed.files ?? {})) {
        const norm = normalizeRel(rel);
        if (!norm) continue;
        vfs.#files.set(norm, {
          text: String(file?.text ?? ""),
          modifiedMs: Number(file?.modifiedMs ?? 0),
        });
        vfs.#ensureDir(parentRel(norm));
      }
      vfs.#clock = Number(parsed.clock ?? 0) || 0;
    } catch {
      // 演示数据坏了不值得中断界面：当作空库，用户还可以重新创建
      return new MemoryVfs();
    }
    return vfs;
  }

  toJSON(): string {
    const files: Record<string, MemoryFile> = {};
    for (const [rel, file] of this.#files) files[rel] = { ...file };
    const snapshot: MemoryVfsSnapshot = { version: 1, clock: this.#clock, files };
    return JSON.stringify(snapshot);
  }

  /** 直接写入（构造与测试用，同步） */
  writeSync(rel: string, text: string): void {
    const norm = normalizeRel(rel);
    if (!norm) throw new RepositoryError("invalid_input", "不能写到知识库根目录本身");
    this.#clock += 1;
    this.#files.set(norm, { text, modifiedMs: this.#clock });
    this.#ensureDir(parentRel(norm));
  }

  readSync(rel: string): string {
    const norm = normalizeRel(rel);
    const file = this.#files.get(norm);
    if (!file) throw new RepositoryError("not_found", `文件不存在：${norm}`, { relativePath: norm });
    return file.text;
  }

  /** 全部文件路径（快照/断言用） */
  filePaths(): string[] {
    return [...this.#files.keys()].sort();
  }

  #ensureDir(rel: string): void {
    let current = normalizeRel(rel);
    while (current !== "") {
      if (this.#dirs.has(current)) return;
      this.#dirs.add(current);
      current = parentRel(current);
    }
  }

  #isFile(rel: string): boolean {
    return this.#files.has(rel);
  }

  #isDir(rel: string): boolean {
    return rel === "" || this.#dirs.has(rel);
  }

  async read(rel: string): Promise<string> {
    const norm = normalizeRel(rel);
    const file = this.#files.get(norm);
    if (!file) {
      const what = this.#isDir(norm) ? "目录不是文件" : "文件不存在";
      throw new RepositoryError("not_found", `${what}：${norm}`, { relativePath: norm });
    }
    return file.text;
  }

  async write(rel: string, text: string): Promise<void> {
    this.writeSync(rel, text);
  }

  async exists(rel: string): Promise<boolean> {
    const norm = normalizeRel(rel);
    return this.#isFile(norm) || this.#isDir(norm);
  }

  async list(rel: string): Promise<VfsEntry[]> {
    const norm = normalizeRel(rel);
    if (!this.#isDir(norm)) {
      throw new RepositoryError("not_found", `目录不存在：${norm}`, { relativePath: norm });
    }
    const prefix = norm === "" ? "" : `${norm}/`;
    const seen = new Map<string, VfsEntry>();
    const push = (name: string, kind: VfsEntryKind, byteLength: number, modifiedMs: number) => {
      if (name === "" || seen.has(name)) return;
      seen.set(name, { name, kind, byteLength, modifiedMs });
    };
    for (const [path, file] of this.#files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (rest === "" || rest.includes("/")) continue;
      push(rest, "file", utf8Length(file.text), file.modifiedMs);
    }
    for (const dir of this.#dirs) {
      if (!dir.startsWith(prefix)) continue;
      const rest = dir.slice(prefix.length);
      if (rest === "" || rest.includes("/")) continue;
      push(rest, "dir", 0, 0);
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async remove(rel: string): Promise<void> {
    const norm = normalizeRel(rel);
    if (norm === "") {
      this.#files.clear();
      this.#dirs.clear();
      return;
    }
    this.#files.delete(norm);
    const prefix = `${norm}/`;
    for (const path of [...this.#files.keys()]) {
      if (path.startsWith(prefix)) this.#files.delete(path);
    }
    for (const dir of [...this.#dirs]) {
      if (dir === norm || dir.startsWith(prefix)) this.#dirs.delete(dir);
    }
  }

  async mkdir(rel: string): Promise<void> {
    this.#ensureDir(normalizeRel(rel));
  }
}

function utf8Length(text: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).byteLength;
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/* --------------------------------- 读写工具 --------------------------------- */

let tempSeq = 0;

/**
 * 原子写：先写同目录临时文件，再替换目标，最后清掉临时文件。
 *
 * 内存实现里「替换」天然是原子的，但真实磁盘上不是——把顺序固定在这里，
 * 两个后端就都走同一条写路径，Rust 端只是把 `write` 换成
 * 「临时文件 -> flush -> fsync -> rename」。
 */
export async function writeTextAtomic(vfs: Vfs, rel: string, text: string): Promise<void> {
  const norm = normalizeRel(rel);
  tempSeq += 1;
  const tmp = joinRel(parentRel(norm), `.${baseName(norm)}.tmp-${tempSeq.toString(36)}`);
  await vfs.write(tmp, text);
  try {
    await vfs.write(norm, text);
  } finally {
    try {
      await vfs.remove(tmp);
    } catch {
      // 临时文件清理失败不该让整次写入失败：正式文件已经就位
    }
  }
}

/** 读 JSON；不存在返回 null；解析失败原样抛出（调用方按 `metadata_invalid` 处理） */
export async function readJsonIfExists<T>(vfs: Vfs, rel: string): Promise<T | null> {
  if (!(await vfs.exists(rel))) return null;
  return JSON.parse(await vfs.read(rel)) as T;
}

export async function writeJsonAtomic(vfs: Vfs, rel: string, value: unknown): Promise<string> {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeTextAtomic(vfs, rel, text);
  return text;
}

/** 递归删除一棵子树（`remove` 已经处理子树，这里只是语义化别名） */
export async function removeTree(vfs: Vfs, rel: string): Promise<void> {
  await vfs.remove(rel);
}

/** 取单个文件的目录项（大小/修改时间）；不存在或不是文件时返回 null */
export async function fileEntry(vfs: Vfs, rel: string): Promise<VfsEntry | null> {
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

/** 目录项是否存在且是目录 */
export async function isDirectory(vfs: Vfs, rel: string): Promise<boolean> {
  const norm = normalizeRel(rel);
  if (norm === "") return true;
  try {
    const entries = await vfs.list(parentRel(norm));
    return entries.some((entry) => entry.name === baseName(norm) && entry.kind === "dir");
  } catch {
    return false;
  }
}

/**
 * 递归复制一棵子树，返回复制的文件数。
 *
 * 用于「恢复节点身份」（把回收站里的元数据放回文件夹）与合并时的线程转移。
 * 已存在的目标文件不会在这里被静默覆盖：调用方负责先检查冲突。
 */
export async function copyTree(vfs: Vfs, from: string, to: string): Promise<number> {
  const source = normalizeRel(from);
  const target = normalizeRel(to);
  let copied = 0;
  const entries = await vfs.list(source);
  await vfs.mkdir(target);
  for (const entry of entries) {
    const fromRel = joinRel(source, entry.name);
    const toRel = joinRel(target, entry.name);
    if (entry.kind === "dir") {
      copied += await copyTree(vfs, fromRel, toRel);
      continue;
    }
    await vfs.write(toRel, await vfs.read(fromRel));
    copied += 1;
  }
  return copied;
}

/** 复制后删源（`Vfs` 没有 rename，跨实现最稳的等价写法） */
export async function moveTree(vfs: Vfs, from: string, to: string): Promise<number> {
  const copied = await copyTree(vfs, from, to);
  await vfs.remove(from);
  return copied;
}

/** 确保某个相对路径的父目录存在 */
export async function ensureParentDir(vfs: Vfs, rel: string): Promise<void> {
  const parent = parentRel(rel);
  if (parent !== "") await vfs.mkdir(parent);
}
