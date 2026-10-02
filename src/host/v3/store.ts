/**
 * **v3 存储层**：一节点 = 一个 markdown，身份 = front-matter 里的 ULID（与标题/文件名无关）。
 *
 * 目录形态：
 * ```
 * <库根>/
 *   library.json      { formatVersion: 3, libraryId, title, createdAt, … }
 *   Nodes/<标题>.md    ← 一个节点一个文件；重名自动 -2/-3；身份在 front-matter
 *   graph.json        ← 关系（A→B、类型、为什么、出处）+ revision
 * ```
 *
 * 刻意**没有**备份/回收站/墓碑：节点就是一个文档 ✓，删除就是删掉那个文件 ✓。
 * （曾经写过"身份墓碑"，但全仓库没有任何代码读它 ⇒ 只写不读的垃圾，已删除 ✓。）
 *
 * 为什么另起一层而不是改 vendor：上游 v2（文件夹 + `node.json` + `relations.json`）是逐字节冻结的
 * 开放格式 ✓ —— 新存储写在我自己的模块里，vendor 保持原样，v2 库继续能**只读**打开（并提示迁移）。
 *
 * 本模块刻意保持"轻"：只依赖 node:fs/node:path/node:crypto 与同层的 frontmatter/ulid ✓，
 * 这样测试可以直接 import，不受打包产物影响 ✓。
 */
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { composeDocument, contentHash, emptyMeta, fileNameFromTitle, parseDocument, type FrontMatter } from "./frontmatter.ts";
import { isUlid, ulid } from "./ulid.ts";

export const V3_FORMAT_VERSION = 3;
export const V3_LIBRARY_FILE = "library.json";
export const V3_NODES_DIR = "Nodes";
export const V3_GRAPH_FILE = "graph.json";

export interface V3Node {
  id: string;
  title: string;
  status: string;
  aliases: string[];
  createdAt: string;
  updatedAt: string;
  rev: number;
  /** 相对库根的路径（`Nodes/xxx.md`） */
  relativePath: string;
  /** 内容指纹（并发写守卫用） */
  hash: string;
  /** 正文（`readLibrary({withNotes:true})` 时才有） */
  note?: string;
  /** true = 这个文件原本没有 front-matter，身份是临时的（下次写入时才固化一个 ULID） */
  adopted?: boolean;
}

export interface V3Edge {
  id: string;
  fromId: string;
  toId: string;
  type: string;
  description?: string;
  source?: { snippet?: string; question?: string; messageId?: string; at?: number };
}

export interface V3Library {
  root: string;
  libraryId: string;
  title: string;
  createdAt: string;
  nodes: V3Node[];
  edges: V3Edge[];
  /** graph.json 的修订号（每次改边 +1） */
  graphRevision: number;
}

export type V3Result<T> = ({ ok: true } & T) | { ok: false; code: string; message: string };

/** ISO 时间戳（统一一处，测试可注入时钟） */
function stamp(now: number): string {
  return new Date(now).toISOString();
}

/** 原子写：先写临时文件再 rename，避免半截文件 */
async function writeAtomic(target: string, text: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  /*
   * 临时名必须**唯一** ✓：原来只用 `pid + Date.now()`，同一进程同一毫秒写同一个目标
   * 就会共享临时文件 ⇒ 互相串写或 rename 失败 ✗（复查指出的问题）。
   * 加一段随机后缀即可（原子性仍由 rename 保证 ✓）。
   */
  const unique = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const tmp = `${target}.tmp-${unique}`;
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
const writeQueues = new Map<string, Promise<unknown>>();

/**
 * 把一次写入排进该库的串行队列。
 * @param root - 库根（队列键 ✓）。
 * @param task - 真正执行的写入（内部应重新读取并比较 ✓）。
 * @returns 任务结果 ✓。
 */
export async function withLibraryWrite<T>(root: string, task: () => Promise<T>): Promise<T> {
  const key = resolve(root);
  const previous = writeQueues.get(key) ?? Promise.resolve();
  /* 前一个任务失败也不能卡住后面的 ✓ */
  const run = previous.then(task, task);
  const guarded = run.catch(() => undefined);
  writeQueues.set(key, guarded);
  try {
    return await run;
  } finally {
    /* 队尾还是自己 ⇒ 排空后把键清掉（不能立刻删：后面可能已经排了新任务 ✓） */
    void guarded.then(() => {
      if (writeQueues.get(key) === guarded) writeQueues.delete(key);
    });
  }
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** 库根校验：必须是绝对路径，且（可选）已存在 library.json */
function assertRoot(root: string): string {
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
export async function readLibrary(root: string, options: { withNotes?: boolean } = {}): Promise<V3Library | undefined> {
  const base = assertRoot(root);
  const manifest = await readJson<{ formatVersion?: number; libraryId?: string; title?: string; createdAt?: string }>(
    join(base, V3_LIBRARY_FILE),
  );
  if (manifest === undefined || manifest.formatVersion !== V3_FORMAT_VERSION) return undefined;

  const nodesDir = join(base, V3_NODES_DIR);
  let names: string[] = [];
  try {
    names = (await readdir(nodesDir)).filter((name: string) => name.toLowerCase().endsWith(".md"));
  } catch {
    names = [];
  }

  /*
   * **有界并发读** ✓（`mapLimit` ✓）：这里必须读**整份**文件（要正文与整文件指纹 ✗），
   * 但没必要一个文件一次串行往返 ✓ —— 冷盘 / 被别的进程抢 IO 时串行会被线性放大 ✓
   * （实测见过 16 个节点扫 8 秒 ✓）。身份仍然按排序**串行**分配 ✓ ⇒ 语义一字不变 ✓。
   *
   * ⚠️ 读不出来的文件**照旧让它抛** ✓（不吞异常 ✗）：静默跳过等于让节点在图谱里凭空消失 ✓，
   * 比"明确报错"更糟 ✓。索引那条路（`buildNodeIndex`）才允许跳过 ✓ —— 它只是"提示"✓，
   * 而且会把"有文件读不到"记进 `readFailed` ✓，让读取走权威的全库兜底 ✓。
   */
  const files = await mapLimit([...names].sort(), LIBRARY_READ_CONCURRENCY, async (name: string) => {
    const abs = join(nodesDir, name);
    return { name, abs, text: await readFile(abs, "utf8") };
  });

  const nodes: V3Node[] = [];
  const usedIds = new Set<string>();
  for (const file of files) {
    const { abs, name, text } = file;
    const parsed = parseDocument(text);
    const relativePath = relative(base, abs).replace(/\\/g, "/");
    let id = parsed.meta.id.trim();
    let adopted = false;
    if (!isUlid(id) || usedIds.has(id)) {
      // 没有（或非法/重复）front-matter id：先给一个**确定性**的临时身份，
      // 保证同一个文件每次读到同样的 id（重命名前稳定 ✓），真正写入时才固化成 ULID ✓。
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
      ...(options.withNotes === true ? { note: parsed.body.replace(/^\n+/, "") } : {}),
      ...(adopted ? { adopted: true } : {}),
    });
  }

  const graph = await readJson<{ revision?: number; edges?: V3Edge[] }>(join(base, V3_GRAPH_FILE));
  return {
    root: base,
    libraryId: typeof manifest.libraryId === "string" ? manifest.libraryId : "",
    title: typeof manifest.title === "string" ? manifest.title : "",
    createdAt: typeof manifest.createdAt === "string" ? manifest.createdAt : "",
    nodes,
    edges: Array.isArray(graph?.edges) ? graph.edges : [],
    graphRevision: typeof graph?.revision === "number" ? graph.revision : 0,
  };
}

/**
 * **单节点索引**：nodeId → 相对路径 ✓
 * （`design/plugin-note-editor-loading-optimization.md` 优先优化一 ✓）。
 *
 * 复查确认的问题：读**一篇**正文却 `readLibrary({withNotes:true})` **扫全库** ✗ ——
 * 遍历所有节点文件、逐个读取解析，最后才找到目标节点 ✓。
 * 现在改成"索引定位 + 只读那一个文件" ✓：
 *
 * - 索引只按**库身份 + 节点身份**解析路径 ✗（绝不接受客户端给的路径 ✓）；
 * - 图谱扫描的结果可以直接**喂进来**（`seedNodeIndex` ✓）⇒ 面板已经扫过的话，读取正文一个文件都不用多扫 ✓；
 * - 索引过期（TTL ✓）或文件被删 / 身份对不上 ⇒ **受控重扫一次**并更新索引 ✓；
 * - 写入 / 新建 / 删除之后立刻失效或更新相关记录 ✓；
 * - **保存路径不受影响** ✗：`writeNote` 仍然现场读磁盘文件再比指纹 ✓（缓存正文/缓存指纹都不能替代外部修改检测 ✗）。
 */
interface NodePathIndex {
  at: number;
  libraryId: string;
  paths: Map<string, string>;
  /** 建索引时 `Nodes/` 的文件名集合（排序后拼一起 ✓）—— 见下面的"目录变动检测" ✓ */
  namesKey: string;
  /**
   * 建索引时**读不到**的文件数 ✓。
   * `> 0` ⇒ "索引里没有这个 id"**不能当权威结论** ✗（也许正好是那个读不到的文件 ✓）
   * ⇒ `readNodeFast` 报告 `unverified` ✓，调用方走权威的全库兜底 ✓（那里读不到会**抛错** ✓）。
   */
  readFailed: number;
}

const nodeIndexes = new Map<string, NodePathIndex>();

/**
 * 索引存活时间 ✓。
 *
 * 复查（`design/plugin-note-editor-loading-recheck.md` 问题二 ✓）指出：
 * 原来定 1.5s、和图谱缓存一致 ✗ ⇒ 隔一会儿点开笔记就**又全量读一遍所有文件** ✓；
 * 修掉 API 前置全库扫描之后，它就会变成下一处主要等待 ✓。
 *
 * 现在**和"图谱快照的新鲜度"彻底分开** ✓ —— 路径只是**提示** ✗，权威性靠这四条保证 ✓：
 * ① 每次读都**现场读目标文件**、校验身份、现算指纹 ✓（`readIndexedNode` ✓）；
 * ② 每次读都做一次**极廉价的目录变动检测** ✓（一次 `readdir` 比对名字集合 ✓，
 *    新增 / 删除 / 改名 / 采用身份都会让它变 ✓ ⇒ 立刻重建 ✓；这也堵住了
 *    "别的文件新增了相同 ULID、排序规则可能换掉归属"那个洞 ✓）；
 * ③ 插件自己写盘之后**立刻更新或摘掉**记录 ✓（`writeNote` / `createNode` / `removeNode` ✓）；
 * ④ `libraryId` 变了 ⇒ 整个索引作废 ✓。
 */
export const NODE_INDEX_TTL_MS = 10 * 60 * 1000;

/** 把文件名集合变成可比较的字符串 ✓（排序 ⇒ 与顺序无关 ✓） */
function namesKeyOf(names: readonly string[]): string {
  return [...names].sort().join("\n");
}

/** 用**已有扫描结果**喂索引 ✓（图谱/工具刚扫过 ⇒ 读正文不必再扫一遍 ✓） */
export function seedNodeIndex(
  root: string,
  nodes: readonly { id: string; relativePath: string }[],
  libraryId = "",
): void {
  const paths = new Map<string, string>();
  const names: string[] = [];
  for (const node of nodes) {
    paths.set(node.id, node.relativePath);
    const name = node.relativePath.split("/").pop() ?? "";
    if (name !== "") names.push(name);
  }
  nodeIndexes.set(assertRoot(root), { at: Date.now(), libraryId, paths, namesKey: namesKeyOf(names), readFailed: 0 });
}

/** 让索引里的一条记录失效 / 失效整个库 ✓（写入、新建、删除之后必须调用 ✓） */
export function invalidateNodeIndex(root: string, nodeId?: string): void {
  const base = assertRoot(root);
  if (nodeId === undefined) {
    nodeIndexes.delete(base);
    return;
  }
  nodeIndexes.get(base)?.paths.delete(nodeId);
}

/**
 * 更新索引里的一条记录 ✓（**只在索引已经存在时**动它 ✗ ——
 * 没有索引就现建一个"只有这一条"的，会让别的节点看起来不存在 ✓）。
 */
export function updateNodeIndexEntry(root: string, node: { id: string; relativePath: string }): void {
  const index = nodeIndexes.get(assertRoot(root));
  if (index === undefined) return;
  index.paths.set(node.id, node.relativePath);
  index.at = Date.now();
  /*
   * 写入可能**改名**（标题变了 ⇒ 文件名变了 ✓）⇒ 名字集合要跟着更新 ✓，
   * 否则下一次读会误判"目录变了"、白重建一次索引 ✗。
   */
  const name = node.relativePath.split("/").pop() ?? "";
  const names = index.namesKey === "" ? [] : index.namesKey.split("\n");
  if (name !== "" && !names.includes(name)) names.push(name);
  index.namesKey = namesKeyOf(names);
}

/** 索引里记的**文件名集合**（目录变动检测用 ✓；没索引返回 `undefined` ✓） */
function indexedNamesKey(root: string): string | undefined {
  return nodeIndexes.get(assertRoot(root))?.namesKey;
}

/** 一次 `readdir` 比名字集合 ✓（**不读任何文件**✗）—— 目录变了就返回 `false` ✓ */
async function namesUnchanged(base: string, expected: string): Promise<boolean> {
  const nodesDir = join(base, V3_NODES_DIR);
  let names: string[] = [];
  try {
    names = (await readdir(nodesDir)).filter((name: string) => name.toLowerCase().endsWith(".md"));
  } catch {
    return false;
  }
  return namesKeyOf(names) === expected;
}

/** 索引现状（只给诊断与测试看 ✓：条数与时间，**不含路径/文本** ✗） */
export function peekNodeIndex(root: string): { size: number; at: number; libraryId: string } | undefined {
  const index = nodeIndexes.get(assertRoot(root));
  if (index === undefined) return undefined;
  return { size: index.paths.size, at: index.at, libraryId: index.libraryId };
}

/**
 * 建/重建索引时**每个文件只读头部多少字节** ✓
 * （复查指出：注释写着"只读 front-matter 需要的部分"，实际却 `readFile` 读了整份 markdown ✗）。
 * 4KB 足够覆盖正常 front-matter（十几个字段 ✓）；万一不够 ⇒ 退回读整份 ✓（正确性优先 ✓）。
 */
export const INDEX_HEAD_BYTES = 4096;

/** 建立索引时的**有界并发** ✓（顺序交给下面的串行身份分配 ✓，语义与 `readLibrary` 完全一致 ✓） */
export const INDEX_READ_CONCURRENCY = 8;

/** 库扫描（图谱那条路 ✓）读文件时的有界并发 ✓ */
export const LIBRARY_READ_CONCURRENCY = 8;

/**
 * **有界并发**跑异步任务，结果顺序与输入一致 ✓（limit 至少 1 ✓）。
 *
 * 为什么需要：原来索引与库扫描都是 `for (const name of names) await readFile(...)` ✗ ——
 * 一个文件一次往返、完全串行 ✓；冷盘 / 被别的进程抢 IO 时（实测见过 8 秒的扫描 ✓）
 * 串行往返会被线性放大 ✓。这里只并发**读**，**不并发决定身份** ✗：
 * 重复 ULID 的归属依赖排序规则 ✓，所以身份仍然按排序**串行**分配 ✓。
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;
  const size = Math.max(1, Math.min(Math.floor(limit), items.length));
  let next = 0;
  const workers = Array.from({ length: size }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await run(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 只读文件**头部**（最多 `maxBytes` ✓）；读不到返回 `undefined` ✓ */
async function readTextHead(abs: string, maxBytes: number): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(abs, "r");
    const buffer = new Uint8Array(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return new TextDecoder("utf-8").decode(buffer.subarray(0, bytesRead));
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * 从**文件头部**取出 front-matter 里的 `id` ✓（建立索引不该把整篇正文读进来 ✗）。
 * 内部直接复用 `parseDocument` ✓ ⇒ 与整文件解析的结果**逐字一致** ✓。
 * @param head - 文件头部文本 ✓。
 * @returns 去掉空白的 id ✓；头部里 front-matter 还没结束（或压根没有）⇒ `undefined` ✓（调用方退回读整份 ✓）。
 */
export function idFromHead(head: string): string | undefined {
  const parsed = parseDocument(head);
  if (!parsed.hasFrontMatter) return undefined;
  return parsed.meta.id.trim();
}

/**
 * 建/重建索引：**每个文件只读头部** ✓（id 在 front-matter 里、文件名不含 id ✗，
 * 所以首次建立仍要过一遍文件 ✓ —— 但不再读整份正文 ✓，而且是**有界并发** ✓）。
 */
async function buildNodeIndex(base: string, libraryId: string): Promise<NodePathIndex> {
  const nodesDir = join(base, V3_NODES_DIR);
  let names: string[] = [];
  try {
    names = (await readdir(nodesDir)).filter((name: string) => name.toLowerCase().endsWith(".md"));
  } catch {
    names = [];
  }
  const sorted = [...names].sort();
  /* ① **并发**只取"身份线索"（头部 ✓；不够就退回整份 ✓） */
  let readFailed = 0;
  const clues = await mapLimit(sorted, INDEX_READ_CONCURRENCY, async (name: string) => {
    const abs = join(nodesDir, name);
    const head = await readTextHead(abs, INDEX_HEAD_BYTES);
    if (head === undefined) return { name, id: undefined as string | undefined, present: false }; /* 读不到 ⇒ 计入 readFailed ✓ */
    const fromHead = idFromHead(head);
    if (fromHead !== undefined) return { name, id: fromHead, present: true };
    /* 头部里 front-matter 没结束（超长 front-matter ✓）或压根没有 ⇒ 老老实实读整份 ✓ */
    try {
      const text = await readFile(abs, "utf8");
      return { name, id: parseDocument(text).meta.id.trim(), present: true };
    } catch {
      return { name, id: undefined, present: false };
    }
  });
  /* ② 身份**按排序串行**分配 ✓ ⇒ 与 `readLibrary` 同一套规则（合法 ULID / adopted / 重复 ULID ✓） */
  const paths = new Map<string, string>();
  const usedIds = new Set<string>();
  for (const clue of clues) {
    if (!clue.present) { readFailed += 1; continue; }
    const relativePath = relative(base, join(nodesDir, clue.name)).replace(/\\/g, "/");
    let id = clue.id ?? "";
    if (!isUlid(id) || usedIds.has(id)) id = `adopted-${contentHash(relativePath + clue.name)}`;
    usedIds.add(id);
    paths.set(id, relativePath);
  }
  const index: NodePathIndex = { at: Date.now(), libraryId, paths, namesKey: namesKeyOf(sorted), readFailed };
  nodeIndexes.set(base, index);
  return index;
}

/** 读索引指向的那**一个**文件 ✓；身份对不上返回 `undefined` ✓（调用方据此重扫 ✓） */
async function readIndexedNode(base: string, relativePath: string, expectedId: string): Promise<V3Node | undefined> {
  let text = "";
  try {
    text = await readFile(join(base, relativePath), "utf8");
  } catch {
    return undefined; /* 文件没了 ⇒ 索引过期 ✓ */
  }
  const parsed = parseDocument(text);
  const name = relativePath.split("/").pop() ?? "";
  const raw = parsed.meta.id.trim();
  const id = isUlid(raw) ? raw : `adopted-${contentHash(relativePath + name)}`;
  if (id !== expectedId) return undefined; /* 重命名 / 身份被改 / 重复 ULID ⇒ 重扫 ✓ */
  return {
    id,
    title: parsed.meta.title === "" ? name.replace(/\.md$/i, "") : parsed.meta.title,
    status: parsed.meta.status === "" ? "todo" : parsed.meta.status,
    aliases: parsed.meta.aliases,
    createdAt: parsed.meta.createdAt,
    updatedAt: parsed.meta.updatedAt,
    rev: parsed.meta.rev,
    relativePath,
    hash: contentHash(text),
    note: parsed.body.replace(/^\n+/, ""),
  };
}

/** `readNodeFast` 的结果：找不到时区分"索引已重建确认没有"与"身份没验证通过" ✓ */
export type FastNodeResult =
  | { ok: true; node: V3Node }
  | { ok: false; code: "not_library" }
  | { ok: false; code: "node_missing"; rescan: boolean; unverified: boolean };

/**
 * **按索引读一个节点** ✓：正常情况只读一个文件 ✓，绝不为了读一篇正文扫全库 ✗。
 *
 * @param root - 库根 ✓。
 * @param id - 节点身份（由宿主解析，**不接受客户端给的路径** ✗）。
 * @returns 节点；找不到时带 `unverified` ⇒ 调用方可以受控地做一次全库兜底 ✓。
 */
export async function readNodeFast(root: string, id: string): Promise<FastNodeResult> {
  const base = assertRoot(root);
  const manifest = await readJson<{ formatVersion?: number; libraryId?: string }>(join(base, V3_LIBRARY_FILE));
  if (manifest === undefined || manifest.formatVersion !== V3_FORMAT_VERSION) {
    return { ok: false, code: "not_library" };
  }
  const libraryId = typeof manifest.libraryId === "string" ? manifest.libraryId : "";
  let index = nodeIndexes.get(base);
  let fresh = false;
  if (index === undefined || index.libraryId !== libraryId || Date.now() - index.at >= NODE_INDEX_TTL_MS) {
    index = await buildNodeIndex(base, libraryId);
    fresh = true;
  } else if (!(await namesUnchanged(base, index.namesKey))) {
    /*
     * **目录变动检测** ✓（复查问题二 ✓）：一次 `readdir` 就能发现新增 / 删除 / 改名 ✓
     * ⇒ 立刻重建 ✓（不读任何文件 ✗）。这样索引可以活得很久 ✓，
     * 又不会出现"别的文件新增了相同 ULID、归属被换掉却没人知道"✗。
     */
    index = await buildNodeIndex(base, libraryId);
    fresh = true;
  }
  let rescanned = fresh;
  let unverified = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const relativePath = index.paths.get(id);
    if (relativePath !== undefined) {
      const node = await readIndexedNode(base, relativePath, id);
      if (node !== undefined) return { ok: true, node };
      unverified = true; /* 索引过期（重命名 / 删除 / 身份被改 ✓）⇒ 重扫一次 ✓ */
    }
    /* 索引是刚建的 ⇒ 它就是权威结果 ✓（不再重复扫 ✗）；否则受控重扫**一次** ✓ */
    if (fresh) break;
    index = await buildNodeIndex(base, libraryId);
    fresh = true;
    rescanned = true;
  }
  /* 索引里"有文件读不到" ⇒ 未命中不可信 ✗ ⇒ 让调用方走权威的全库兜底 ✓ */
  return { ok: false, code: "node_missing", rescan: rescanned, unverified: unverified || index.readFailed > 0 };
}

/**
 * **只做格式判定**的轻量检查 ✓
 * （`design/plugin-note-editor-loading-recheck.md` 问题一 ✓）。
 *
 * 正文读/写接口原来先 `loadLibrary(root)` ✗ —— 目的只是"确认这是 v3 库"✓，
 * 却顺手把**整个图谱**加载了一遍 ✓：缓存（1.5s ✓）过期就全库扫一遍 ✓，
 * 有扫描在飞还得等它跑完 ✓ ⇒ "只读一篇笔记"也可能等上全库扫描的时间 ✓（实测见过 8 秒的扫描 ✓）。
 *
 * 现在只读 **`library.json` 一个小文件** ✓，**不加载图谱快照** ✗ —— 读/写正文与图谱快照本来就无关 ✓。
 *
 * 错误分类要分清 ✗（原来把任何异常都报成 `unsupported_format` ✗，
 * 磁盘/权限问题会伪装成格式问题 ✓）：
 * - `ok: true`：是 v3 库 ✓；
 * - `unsupported_format`：旧格式（v2 ✓）或 `formatVersion` 不认识 / 不是合法 JSON ✓；
 * - `library_unavailable`：目录里没有 `library.json` ✓；
 * - `read_failed`：读不了（权限 / IO ✓）—— 不是格式问题 ✗。
 */
export type LibraryFormatCheck =
  | { ok: true }
  | { ok: false; code: "unsupported_format" | "library_unavailable" | "read_failed"; message: string };

/**
 * 轻量格式检查（**只读 library.json** ✓）。
 * @param root - 库根。
 * @returns 判定结果（见上面的错误分类 ✓）。
 */
export async function checkLibraryFormat(root: string): Promise<LibraryFormatCheck> {
  const base = assertRoot(root);
  const manifestPath = join(base, V3_LIBRARY_FILE);
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") {
      return { ok: false, code: "library_unavailable", message: `这里还不是知识库：${base}` };
    }
    /*
     * 其余都算**读不了** ✗：权限（EACCES ✓）、同名目录（EISDIR ✓）、路径中间不是目录（ENOTDIR ✓）、
     * IO 错误 ✓……它们与"这里不是知识库"是两件事 ✓（原来一律报成格式问题 ✗）。
     */
    return {
      ok: false,
      code: "read_failed",
      message: `读不了 ${V3_LIBRARY_FILE}（${code ?? "未知错误"}）：${base}`,
    };
  }
  let formatVersion: unknown;
  try {
    formatVersion = (JSON.parse(raw) as { formatVersion?: unknown }).formatVersion;
  } catch {
    return { ok: false, code: "unsupported_format", message: `${V3_LIBRARY_FILE} 不是合法的 JSON：${base}` };
  }
  if (formatVersion === V3_FORMAT_VERSION) return { ok: true };
  if (typeof formatVersion === "number") {
    return {
      ok: false,
      code: "unsupported_format",
      message: `这个知识库是老格式（formatVersion=${formatVersion}），当前版本只支持新格式：`
        + `一节点一个 markdown（library.json 里 formatVersion: ${V3_FORMAT_VERSION}）。`
        + `请把 ${base} 整个删掉，然后在面板里点「知识库图谱」重新创建。`,
    };
  }
  return { ok: false, code: "unsupported_format", message: `${V3_LIBRARY_FILE} 里没有 formatVersion：${base}` };
}

/**
 * 初始化一个 v3 库（空库）。
 * @param root - 目标目录（必须存在且为空）。
 * @param title - 库标题（默认取目录名）。
 * @param now - 时间戳（测试可注入）。
 * @returns 结果。
 */
export async function createLibrary(
  root: string,
  title?: string,
  now: number = Date.now(),
): Promise<V3Result<{ root: string; libraryId: string; title: string }>> {
  const base = assertRoot(root);
  if (await exists(join(base, V3_LIBRARY_FILE))) {
    return { ok: false, code: "already_library", message: `这里已经有 library.json 了：${base}` };
  }
  let entries: string[] = [];
  try {
    entries = await readdir(base);
  } catch {
    return { ok: false, code: "invalid_root", message: `目录不存在：${base}` };
  }
  if (entries.length > 0) {
    /*
     * 目录非空时**不一律拒绝**：如果里面只有"我们自己会造的东西"
     * （`Nodes/`、`graph.json`、`Backup/`、`.knowledgenet/`），说明是上一次创建中断留下的残留
     * ⇒ 允许就地初始化 ✓。
     *
     * 为什么必须这样：实测踩到过 —— 工作区里留下一个只有 `Backup/`、`Nodes/`、却没有 `library.json`
     * 的 `.dsh_knowledge` ⇒ 旧逻辑一律回 `not_empty` ⇒ 面板的"首次静默创建"静默失败，用户只看到
     * "还没有知识库"，怎么点都建不出来 ✗。用户自己的文件仍然一律拒绝 ✓（不许把有内容的目录变成库）。
     */
    const ours = new Set([V3_NODES_DIR, V3_GRAPH_FILE, "Backup", ".knowledgenet"]);
    const foreign = entries.filter((entry) => !ours.has(entry));
    if (foreign.length > 0) {
      return {
        ok: false,
        code: "not_empty",
        message: `目录里还有你自己的内容（${foreign.slice(0, 3).join("、")}${foreign.length > 3 ? " 等" : ""}），不能在它里面建库：${base}`,
      };
    }
  }

  const libraryId = ulid(now);
  const libraryTitle = typeof title === "string" && title.trim() !== "" ? title.trim() : base.split(/[\\/]/).pop() ?? "知识库";
  await mkdir(join(base, V3_NODES_DIR), { recursive: true });
  await writeAtomic(
    join(base, V3_LIBRARY_FILE),
    `${JSON.stringify(
      {
        format: "knowledgenet-library",
        formatVersion: V3_FORMAT_VERSION,
        libraryId,
        title: libraryTitle,
        createdAt: stamp(now),
        storage: "single-file-markdown",
      },
      null,
      2,
    )}\n`,
  );
  await writeAtomic(join(base, V3_GRAPH_FILE), `${JSON.stringify({ formatVersion: V3_FORMAT_VERSION, revision: 1, edges: [] }, null, 2)}\n`);
  return { ok: true, root: base, libraryId, title: libraryTitle };
}

/** 在 `Nodes/` 下为标题挑一个不冲突的文件名（`标题.md` → `标题-2.md` → …） */
async function pickFileName(base: string, title: string): Promise<string> {
  const stem = fileNameFromTitle(title);
  const nodesDir = join(base, V3_NODES_DIR);
  for (let n = 1; n < 1000; n += 1) {
    const candidate = n === 1 ? `${stem}.md` : `${stem}-${n}.md`;
    if (!(await exists(join(nodesDir, candidate)))) return candidate;
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
export async function createNode(
  root: string,
  input: { title: string; status?: string; aliases?: string[]; note?: string },
  now: number = Date.now(),
): Promise<V3Result<{ node: V3Node }>> {
  const base = assertRoot(root);
  if ((await readLibrary(base)) === undefined) {
    return { ok: false, code: "not_library", message: `这里还不是 v3 知识库：${base}` };
  }
  const title = input.title.trim();
  if (title === "") return { ok: false, code: "title_required", message: "节点标题不能为空" };
  if (title.length > 120) return { ok: false, code: "title_too_long", message: "节点标题过长（上限 120 字）" };

  const id = ulid(now);
  const fileName = await pickFileName(base, title);
  const meta: FrontMatter = {
    ...emptyMeta(stamp(now), id, title),
    ...(input.status !== undefined && input.status !== "" ? { status: input.status } : {}),
    ...(input.aliases !== undefined ? { aliases: input.aliases } : {}),
  };
  const text = composeDocument(meta, input.note ?? "");
  const relativePath = `${V3_NODES_DIR}/${fileName}`;
  await writeAtomic(join(base, relativePath), text);
  /* 新节点立刻进索引 ✓（不然下一次读它要先扫全库 ✗） */
  updateNodeIndexEntry(base, { id, relativePath });

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
      note: input.note ?? "",
    },
  };
}

/** 按 id / 标题 / 相对路径找节点（标题允许重名 ⇒ 返回第一个匹配） */
export async function resolveNode(
  root: string,
  ref: { id?: string; title?: string; path?: string },
): Promise<V3Node | undefined> {
  const library = await readLibrary(root, { withNotes: false });
  if (library === undefined) return undefined;
  const id = typeof ref.id === "string" ? ref.id.trim() : "";
  if (id !== "") return library.nodes.find((node) => node.id === id);
  const path = typeof ref.path === "string" ? ref.path.trim().replace(/\\/g, "/") : "";
  if (path !== "") {
    return library.nodes.find((node) => node.relativePath === path || node.relativePath.endsWith(`/${path}`));
  }
  const title = typeof ref.title === "string" ? ref.title.trim() : "";
  if (title !== "") {
    const exact = library.nodes.filter((node) => node.title === title);
    if (exact.length > 0) return exact[0];
    const lower = title.toLowerCase();
    return library.nodes.find((node) => node.title.toLowerCase() === lower);
  }
  return undefined;
}

/** 读一个节点的完整内容（正文 + 关系） */
export async function readNode(
  root: string,
  ref: { id?: string; title?: string; path?: string },
): Promise<V3Result<{ node: V3Node; prerequisites: V3Edge[]; dependents: V3Edge[] }>> {
  const base = assertRoot(root);
  const library = await readLibrary(base, { withNotes: true });
  if (library === undefined) return { ok: false, code: "not_library", message: `这里还不是 v3 知识库：${base}` };
  const node = library.nodes.find((item) => {
    if (typeof ref.id === "string" && ref.id.trim() !== "") return item.id === ref.id.trim();
    if (typeof ref.path === "string" && ref.path.trim() !== "") return item.relativePath === ref.path.trim().replace(/\\/g, "/");
    if (typeof ref.title === "string" && ref.title.trim() !== "") return item.title === ref.title.trim();
    return false;
  });
  if (node === undefined) return { ok: false, code: "node_missing", message: "没有找到这个知识点" };
  return {
    ok: true,
    node,
    prerequisites: library.edges.filter((edge) => edge.fromId === node.id),
    dependents: library.edges.filter((edge) => edge.toId === node.id),
  };
}

/**
 * 写正文（整体替换），带**冲突守卫**。
 * @param root - 库根。
 * @param input - 目标节点 + 新正文 + 可选"我手上那版的指纹"。
 * @param now - 时间戳。
 * @returns 结果；指纹不匹配时返回 `conflict` 与 `actualHash`。
 */
export async function writeNote(
  root: string,
  input: { id: string; text: string; expectedHash?: string },
  now: number = Date.now(),
): Promise<V3Result<{ node: V3Node }> | { ok: false; code: "conflict"; message: string; actualHash: string }> {
  const base = assertRoot(root);
  /*
   * **整段进串行队列**（复查 P1-5）：重读 → 比较 → 提交必须在同一段互斥区间里，
   * 否则两个请求可以同时通过检查再各自覆盖 ✗（rename 的原子性救不了这个 ✓）。
   */
  return await withLibraryWrite(base, () => writeNoteLocked(base, input, now));
}

/** `writeNote` 的串行区实现（由上面的队列保证不并发 ✓） */
async function writeNoteLocked(
  base: string,
  input: { id: string; text: string; expectedHash?: string },
  now: number,
): Promise<V3Result<{ node: V3Node }> | { ok: false; code: "conflict"; message: string; actualHash: string }> {
  /*
   * 定位目标节点：**索引 + 只读那一个文件** ✓（加载优化文档优先优化一 ✓）。
   * 这一步给的 `node.hash` 是**刚读到的文件**算出来的 ✓，而下面还会再读一次文件、再比一次 ✓ ——
   * "检查到提交"这段窗口的守卫**一点没放松** ✗（缓存正文/缓存指纹都没有参与判定 ✓）。
   */
  const located = await readNodeFast(base, input.id);
  if (located.ok === false && located.code === "not_library") {
    return { ok: false, code: "not_library", message: `这里还不是 v3 知识库：${base}` };
  }
  let node = located.ok === true ? located.node : undefined;
  if (node === undefined && located.ok === false && located.unverified) {
    /* 索引里那个 id 指向的文件身份对不上（极少数 ✓）⇒ 受控全库确认一次 ✓ */
    const library = await readLibrary(base, { withNotes: false });
    if (library === undefined) return { ok: false, code: "not_library", message: `这里还不是 v3 知识库：${base}` };
    node = library.nodes.find((item) => item.id === input.id);
  }
  if (node === undefined) return { ok: false, code: "node_missing", message: "没有找到这个知识点" };

  if (typeof input.expectedHash === "string" && input.expectedHash !== "" && input.expectedHash !== node.hash) {
    return {
      ok: false,
      code: "conflict",
      message: "磁盘上的内容在你读取之后被改过，为避免覆盖，本次写入已拒绝",
      actualHash: node.hash,
    };
  }

  const abs = join(base, node.relativePath);
  const current = await readFile(abs, "utf8");
  /*
   * **收紧比较交换的窗口**（`design/node-note-editor-plan.md` 要求守卫覆盖"检查到提交"✓）：
   * 上面那次指纹比较用的是**扫描时**的 hash，而文件是在这之后才读的 ⇒
   * 两者之间被外部改过就会漏判 ✗。这里用刚读到内容再比一次：
   * 不一致 ⇒ 同样按冲突拒绝，绝不覆盖 ✗（只在真的被并发改过时才会命中 ✓）。
   */
  if (typeof input.expectedHash === "string" && input.expectedHash !== "" && contentHash(current) !== input.expectedHash) {
    return {
      ok: false,
      code: "conflict",
      message: "磁盘上的内容在你读取之后被改过，为避免覆盖，本次写入已拒绝",
      actualHash: contentHash(current),
    };
  }
  const parsed = parseDocument(current);
  // 原本没有 front-matter（用户手工新建的 md）⇒ 这里顺手固化一个正式 ULID 身份
  const id = isUlid(parsed.meta.id) ? parsed.meta.id : node.id.startsWith("adopted-") ? ulid(now) : parsed.meta.id;
  const meta: FrontMatter = {
    ...parsed.meta,
    id,
    title: parsed.meta.title === "" ? node.title : parsed.meta.title,
    status: parsed.meta.status === "" ? node.status : parsed.meta.status,
    createdAt: parsed.meta.createdAt === "" ? stamp(now) : parsed.meta.createdAt,
    updatedAt: stamp(now),
    rev: (parsed.meta.rev || 0) + 1,
  };
  const text = composeDocument(meta, input.text);
  await writeAtomic(abs, text);
  /*
   * 返回的正文用**磁盘上那份**（= 规范化后的正文 ✓），不是原始 `input.text` ✗：
   * `composeDocument` 会去掉正文前导空行与尾部空白，若回带原文，
   * 界面"已保存"的基线就与磁盘不一致（复查指出的问题 ✓）。
   */
  const normalizedBody = parseDocument(text).body;
  /* 写完立刻更新索引 ✓（标题被改 ⇒ 文件名也可能变 ✓；免得下一次读正文又全库重扫 ✗） */
  updateNodeIndexEntry(base, { id, relativePath: node.relativePath });
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
      note: normalizedBody,
    },
  };
}

/** 读 graph.json（缺文件时给一个空图） */
async function readGraph(base: string): Promise<{ revision: number; edges: V3Edge[] }> {
  const graph = await readJson<{ revision?: number; edges?: V3Edge[] }>(join(base, V3_GRAPH_FILE));
  return {
    revision: typeof graph?.revision === "number" ? graph.revision : 0,
    edges: Array.isArray(graph?.edges) ? graph.edges : [],
  };
}

/**
 * 加一条前置关系：A → B（B 是 A 的前置）。
 * @param root - 库根。
 * @param input - 依赖方 id、被依赖方 id、类型/说明/出处。
 * @param now - 时间戳。
 * @returns 结果；重复边会被幂等返回。
 */
export async function addEdge(
  root: string,
  input: { fromId: string; toId: string; type?: string; description?: string; source?: V3Edge["source"] },
  now: number = Date.now(),
): Promise<V3Result<{ edge: V3Edge; created: boolean }>> {
  const base = assertRoot(root);
  const library = await readLibrary(base, { withNotes: false });
  if (library === undefined) return { ok: false, code: "not_library", message: `这里还不是 v3 知识库：${base}` };
  const from = library.nodes.find((node) => node.id === input.fromId);
  const to = library.nodes.find((node) => node.id === input.toId);
  if (from === undefined || to === undefined) return { ok: false, code: "node_missing", message: "关系两端的知识点都必须存在" };
  if (from.id === to.id) return { ok: false, code: "self_edge", message: "不能把节点设成自己的前置" };

  const graph = await readGraph(base);
  const type = input.type ?? "prerequisite";
  const existing = graph.edges.find((edge) => edge.fromId === from.id && edge.toId === to.id && edge.type === type);
  if (existing !== undefined) return { ok: true, edge: existing, created: false };

  // 成环检测：若 to 已经（可达地）依赖 from，就拒绝
  const reachable = (start: string, target: string): boolean => {
    const seen = new Set<string>([start]);
    const queue = [start];
    while (queue.length > 0) {
      const current = queue.shift() as string;
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
  if (reachable(to.id, from.id)) return { ok: false, code: "cycle", message: "这条关系会形成环，已拒绝" };

  const edge: V3Edge = {
    id: ulid(now),
    fromId: from.id,
    toId: to.id,
    type,
    ...(input.description !== undefined && input.description !== "" ? { description: input.description } : {}),
    ...(input.source !== undefined ? { source: input.source } : {}),
  };
  await writeAtomic(
    join(base, V3_GRAPH_FILE),
    `${JSON.stringify({ formatVersion: V3_FORMAT_VERSION, revision: graph.revision + 1, edges: [...graph.edges, edge] }, null, 2)}\n`,
  );
  return { ok: true, edge, created: true };
}

/**
 * 删一条边。
 * @param root - 库根。
 * @param edgeId - 边 id。
 * @returns 结果。
 */
export async function removeEdge(root: string, edgeId: string): Promise<V3Result<{ removed: V3Edge }>> {
  const base = assertRoot(root);
  const graph = await readGraph(base);
  const edge = graph.edges.find((item) => item.id === edgeId);
  if (edge === undefined) return { ok: false, code: "edge_missing", message: "没有找到这条关系" };
  const edges = graph.edges.filter((item) => item.id !== edgeId);
  await writeAtomic(
    join(base, V3_GRAPH_FILE),
    `${JSON.stringify({ formatVersion: V3_FORMAT_VERSION, revision: graph.revision + 1, edges }, null, 2)}\n`,
  );
  return { ok: true, removed: edge };
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
export async function removeNode(
  root: string,
  input: { id: string },
): Promise<V3Result<{ id: string; title: string }>> {
  const base = assertRoot(root);
  const library = await readLibrary(base, { withNotes: false });
  if (library === undefined) return { ok: false, code: "not_library", message: `这里还不是 v3 知识库：${base}` };
  const node = library.nodes.find((item) => item.id === input.id);
  if (node === undefined) return { ok: false, code: "node_missing", message: "没有找到这个知识点" };

  const abs = join(base, node.relativePath);
  await unlink(abs).catch(() => undefined);
  /* 删掉后把这条记录从索引里摘掉 ✓（不然下次读它要等重扫 ✗） */
  invalidateNodeIndex(base, node.id);

  const graph = await readGraph(base);
  const edges = graph.edges.filter((edge) => edge.fromId !== node.id && edge.toId !== node.id);
  if (edges.length !== graph.edges.length) {
    await writeAtomic(
      join(base, V3_GRAPH_FILE),
      `${JSON.stringify({ formatVersion: V3_FORMAT_VERSION, revision: graph.revision + 1, edges }, null, 2)}\n`,
    );
  }

  return { ok: true, id: node.id, title: node.title };
}
