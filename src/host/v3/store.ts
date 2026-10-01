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
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
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
    names = (await readdir(nodesDir)).filter((name) => name.toLowerCase().endsWith(".md"));
  } catch {
    names = [];
  }

  const nodes: V3Node[] = [];
  const usedIds = new Set<string>();
  for (const name of names.sort()) {
    const abs = join(nodesDir, name);
    const text = await readFile(abs, "utf8");
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
  const library = await readLibrary(base, { withNotes: false });
  if (library === undefined) return { ok: false, code: "not_library", message: `这里还不是 v3 知识库：${base}` };
  const node = library.nodes.find((item) => item.id === input.id);
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
