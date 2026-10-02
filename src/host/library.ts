/**
 * 知识库定位与装载。
 *
 * 定位规则（与方案 §「库 ↔ 工作区」一致）：
 * 1. 优先用插件 config 的 `libraryRoot`；
 * 2. 否则从**当前会话的 cwd**（`exec.agent.session.header.cwd`）向上找最近的 `library.json`
 *    —— 最近的那个就是库边界（嵌套库不会把外层库的节点算进来，扫描器本身也会在边界停住）；
 * 3. 找不到就抛一个**可操作**的错误，告诉用户该怎么办，而不是返回空图。
 *
 * 一个 DSH 工作区 = 一个知识库；插件**没有**全局「当前库」单例，一切以调用方会话为准。
 */
import path from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";

import { RepositoryError } from "../vendor/upstream/data/errors.ts";
import type { GraphSnapshot, ScanReport } from "../vendor/upstream/data/types.ts";
import { newUuid } from "../vendor/upstream/data/uuid.ts";
import { LIBRARY_FILE } from "../vendor/upstream/data/v2/paths.ts";
import {
  newLibraryManifest,
  parseLibraryManifest,
  serializeJson,
  type V2LibraryManifest,
} from "../vendor/upstream/data/v2/schema.ts";
import { scanLibrary } from "../vendor/upstream/data/v2/scanner.ts";
import { NodeVfs } from "./node-vfs.ts";
import { loadV3Library } from "./v3/adapter.ts";
import { createLibrary as createV3Library, seedNodeIndex } from "./v3/store.ts";
import { recordScan } from "./status.ts";

export interface LoadedLibrary {
  root: string;
  manifest: V2LibraryManifest;
  vfs: NodeVfs;
  snapshot: GraphSnapshot;
  report: ScanReport;
  revision: number;
  /** 落盘格式：v3 = 一节点一 markdown（新）；v2 = 上游文件夹格式（只读兼容） */
  storage?: "v2" | "v3";
}

const NOT_FOUND_HINT =
  "没有找到知识库：请把「含 library.json 的知识库根目录」作为当前 DSH 工作区打开，"
  + "或在本插件的 cordis.patch.yml 配置里写 libraryRoot。";

/** 标记「这是找不到库」而不是「找不到某个节点」，工具的报错码据此区分 */
const LIBRARY_DETAIL = { kind: "library" } as const;

/** 扫描结果缓存时长：一次会话里连续几次工具调用不必反复全量扫描 */
const CACHE_TTL_MS = 1500;
const cache = new Map<string, { at: number; value: LoadedLibrary }>();
/** 在途装载：同一库的并发请求合并成一次扫描 */
const inflightLoads = new Map<string, Promise<LoadedLibrary>>();
let revisionSeq = 0;
/**
 * 最近一次装载过的库根。
 *
 * 用途：**面板没有会话绑定**（`main` 槽的 key 不是 `conversation` 就没有 sessionId），
 * 所以面板取数据要有一个默认目标。这个值由任何一次工具调用或面板请求刷新，
 * 语义是「你最近在会话里碰过的那个知识库」——比猜一个全局单例诚实得多。
 */
let lastRoot: string | undefined;

/**
 * 知识库所在的工作区子目录名（新模型，**唯一**位置）。
 *
 * 产品语义：**任何工作区都可以有一个知识库**，它就在 `<工作区>/.dsh_knowledge/`。
 * "这个工作区有没有知识库"完全由目录自描述 —— 不需要登记表、同步、自动清理那一套。
 * 用点开头是为了尽量不污染项目视图。
 */
export const KNOWLEDGE_DIR = ".dsh_knowledge";

/**
 * 某个目录下的**库根位置**（纯路径计算，不做 IO）。
 *
 * 按要求**不做兼容**：只有 `<dir>/.dsh_knowledge` 算库根；工作区根目录里就算有 library.json 也不认。
 * 于是"一个工作区 = 一个知识库"，边界清晰、没有歧义。
 *
 * @param dir - 工作区目录（绝对路径）。
 * @returns 候选库根（只有子目录这一种）。
 */
export function libraryRootCandidates(dir: string): string[] {
  return [path.join(path.resolve(dir), KNOWLEDGE_DIR)];
}

export async function resolveLibraryRoot(
  cwd: string | undefined,
  configured?: string | null,
): Promise<string> {
  const explicit = typeof configured === "string" ? configured.trim() : "";
  if (explicit !== "") {
    const root = path.resolve(explicit);
    if (!(await isLibraryRoot(root))) {
      throw new RepositoryError("not_found", `配置的 libraryRoot 下没有 library.json：${root}`, LIBRARY_DETAIL);
    }
    return root;
  }

  if (typeof cwd !== "string" || cwd.trim() === "") {
    throw new RepositoryError("not_found", NOT_FOUND_HINT, LIBRARY_DETAIL);
  }
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < 16; depth += 1) {
    for (const candidate of libraryRootCandidates(dir)) {
      if (await isLibraryRoot(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  /*
   * 没找到：这是**正常状态**（这个工作区还没建知识库），不是错误。
   *
   * 给专属 detail + 建议创建位置，让界面能"首次打开时静默创建"（用户要求）：
   * 面板拿到 library_missing 就去建 `<cwd>/.dsh_knowledge/`，而不是甩一个错误弹窗。
   */
  const suggestion = path.join(path.resolve(cwd), KNOWLEDGE_DIR);
  throw new RepositoryError("not_found", `这个工作区还没有知识库：可以创建在 ${suggestion}`, {
    kind: "library_missing",
    createPath: suggestion,
  });
}

/**
 * 读一个目录里 `library.json` 的 formatVersion（用来识别"老格式库"）。
 *
 * 只读这一个字段：undefined = 没有清单文件（普通目录）；数字 = 老格式版本号。
 * 为什么不直接忽略老库：那样用户会看到"这个工作区还没有知识库"，然后在非空目录上
 * 反复创建失败却不知道为什么 ✗ —— 明确报出来才能一句话解决 ✓。
 *
 * @param root - 目录。
 * @returns 老格式版本号；不是老库时 undefined。
 */
async function readLegacyManifest(root: string): Promise<number | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path.join(root, LIBRARY_FILE), "utf8")) as { formatVersion?: unknown };
    if (typeof parsed?.formatVersion === "number" && parsed.formatVersion !== 3) return parsed.formatVersion;
    return undefined;
  } catch {
    return undefined;
  }
}

export async function loadLibrary(
  root: string,
  options: { refresh?: boolean } = {},
): Promise<LoadedLibrary> {  const started = Date.now();
  const cached = cache.get(root);
  if (options.refresh !== true && cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) {
    // 命中：记一条 ms=0 的指标，这样"缓存到底有没有起作用"能从 kn_status 直接读出来
    recordScan({
      at: started,
      ms: 0,
      nodes: cached.value.snapshot.nodes.length,
      edges: cached.value.snapshot.edges.length,
      cached: true,
    });
    return cached.value;
  }

  /*
   * **并发合并**：同一个库同时来了多个请求时只扫一次，其余等同一份结果。
   * 否则面板取数 + 工具调用 + 逐轮注入可能各扫一遍（大库上就是成倍的磁盘遍历）。
   */
  const inflight = inflightLoads.get(root);
  if (inflight !== undefined) {
    const value = await inflight;
    recordScan({
      at: started,
      ms: Date.now() - started,
      nodes: value.snapshot.nodes.length,
      edges: value.snapshot.edges.length,
      cached: false,
      coalesced: true,
    });
    return value;
  }

  const task = (async (): Promise<LoadedLibrary> => {
    /*
     * **只认 v3**（用户决定：不兼容老格式）。
     *
     * v3 = 一节点一个 markdown、身份是 front-matter 的 ULID ✓；由适配器映射成上层吃的那套
     * `GraphSnapshot` 形状 ⇒ 面板与工具一行都不用改 ✓。
     *
     * 如果这里放着一个**旧格式（v2）**的库，不静默当普通目录，而是给一条明确错误：
     * 否则用户会看到"这个工作区还没有知识库"，然后在非空目录上反复创建失败，不知为什么 ✗。
     */
    const v3 = await loadV3Library(root);
    if (v3 !== undefined) {
      revisionSeq += 1;
      v3.revision = revisionSeq;
      cache.set(root, { at: Date.now(), value: v3 });
      lastRoot = root;
      /*
       * **把这次扫描结果喂给单节点索引** ✓（`design/plugin-note-editor-loading-optimization.md` 优先优化一 ✓）：
       * 图谱/工具本来就会扫全库 ✓ ⇒ 之后"点节点编辑读正文"就只读目标文件 ✓，不必再扫一遍 ✗。
       */
      seedNodeIndex(
        root,
        v3.snapshot.nodes.map((node: { id?: unknown; relativePath?: unknown }) => ({
          id: String(node.id),
          relativePath: String(node.relativePath),
        })),
        v3.manifest.libraryId,
      );
      return v3;
    }

    const legacy = await readLegacyManifest(root);
    if (legacy !== undefined) {
      throw new RepositoryError(
        "unsupported_format",
        `这个知识库是老格式（formatVersion=${legacy}），当前版本只支持新格式：`
        + `一节点一个 markdown（library.json 里 formatVersion: 3）。`
        + `请把 ${root} 整个删掉，然后在面板里点「知识库图谱」重新创建。`,
        { kind: "legacy_library", formatVersion: legacy },
      );
    }
    throw new RepositoryError("not_found", `这里还不是知识库：${root}`, { kind: "library_missing", createPath: root });
  })();
  inflightLoads.set(root, task);
  try {
    const value = await task;
    recordScan({
      at: started,
      ms: Date.now() - started,
      nodes: value.snapshot.nodes.length,
      edges: value.snapshot.edges.length,
      cached: false,
    });
    return value;
  } finally {
    inflightLoads.delete(root);
  }
}

/**
 * 从某个目录**向上**找已经装载过的库根（纯内存，无 IO）。
 *
 * 用途：逐轮注入是同步的，而会话的 `cwd` 可能只是库的**子目录**；直接拿 cwd 查缓存会一直查不到，
 * 表现就是明明在库里却一直提示「知识库尚未加载」（审查指出的行为问题）。
 *
 * @param cwd - 会话工作目录。
 * @returns 已装载的库根；没有则 undefined。
 */
export function findCachedRoot(cwd: string | undefined): string | undefined {
  if (typeof cwd !== "string" || cwd.trim() === "") return undefined;
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < 16; depth += 1) {
    if (cache.has(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** 最近一次装载过的库根；从未装载过时返回 undefined */
export function lastLibraryRoot(): string | undefined {
  return lastRoot;
}

/** 写操作之后必须失效，否则下一次读还是旧图 */
export function invalidateLibrary(root: string): void {
  cache.delete(root);
}

/**
 * 同步读已经装载过的库（不做 IO）。
 *
 * 用途：逐轮注入的上下文文本函数必须是**同步**的，而 `loadLibrary` 是异步的。
 * 只有本会话已经调用过任意工具之后才有值；没有值时调用方要退化成
 * 「先调用 kn_list_graph 加载知识库」的提示，而不是假装知道节点标题。
 */
export function peekLibrary(root: string | undefined): LoadedLibrary | undefined {
  if (typeof root !== "string" || root === "") return undefined;
  return cache.get(root)?.value;
}

/** 一次工具调用里要用的库上下文 */
export interface LibraryContext {
  library: LoadedLibrary;
  snapshot: GraphSnapshot;
}

/** 取调用方会话的 cwd；没有 Agent（例如测试直接调用）时返回 undefined */
export function sessionCwdOf(exec: unknown): string | undefined {
  const agent = (exec as { agent?: { session?: { header?: { cwd?: string } } } } | undefined)?.agent;
  return agent?.session?.header?.cwd;
}

/**
 * 目录**本身**是否是一个知识库（只看这一层有没有 `library.json`，不向上找）。
 *
 * 与 `resolveLibraryRoot` 的区别很关键：
 * - 定位一个库（工具/面板取数）时向上找是对的——你在库的某个子目录里也算在库里；
 * - 但**「这个工作区是不是知识库」**必须看它本身：否则把库的子目录开成工作区也会被当成知识库，
 *   而那按约定只是普通工作区（入口卡片/字形都不该出现）。
 */
export async function isLibraryRoot(dir: string): Promise<boolean> {
  if (typeof dir !== "string" || dir.trim() === "") return false;
  try {
    return await new NodeVfs(dir).exists(LIBRARY_FILE);
  } catch {
    return false;
  }
}

/** 目录状态：用来在**创建之前**就知道该弹什么提示（只有空文件夹才允许创建） */
export type FolderState = "library" | "empty" | "non-empty" | "missing";

export interface FolderDescription {
  state: FolderState;
  /** 目录里的条目数（`non-empty` 时用于提示"已经有 N 项内容"） */
  entries: number;
}

/**
 * 只读地描述一个目录（不装载库、不写盘）。
 *
 * 用途：客户端在弹"是否在此创建知识库"之前先问一次——只有**空文件夹**才弹创建确认；
 * 已有内容的目录直接给出可读原因，不必让人走到写入口再被拒绝。
 *
 * @param dir - 绝对路径目录。
 * @returns 目录状态与条目数。
 */
export async function describeFolder(dir: string): Promise<FolderDescription> {
  const trimmed = typeof dir === "string" ? dir.trim() : "";
  if (trimmed === "" || !path.isAbsolute(trimmed)) return { state: "missing", entries: 0 };
  try {
    const info = await stat(trimmed);
    if (!info.isDirectory()) return { state: "missing", entries: 0 };
    if (await new NodeVfs(trimmed).exists(LIBRARY_FILE)) return { state: "library", entries: 0 };
    const entries = await readdir(trimmed);
    return { state: entries.length === 0 ? "empty" : "non-empty", entries: entries.length };
  } catch {
    return { state: "missing", entries: 0 };
  }
}

/** 创建知识库的结果：成功给出库信息，失败给出可读原因（不抛，便于路由直接回给客户端） */
export type CreateLibraryResult =
  | { ok: true; root: string; title: string; libraryId: string }
  | { ok: false; code: "already_exists" | "invalid_root" | "not_empty" | "write_failed"; message: string };

/**
 * 把一个**空目录**初始化为知识库（写 `library.json` + `Nodes/`）。
 *
 * 四条安全约束：
 * 1. **绝不覆盖**已有 `library.json`（已存在就报 `already_exists`，让用户自己决定）；
 * 2. **只接受空文件夹**（目录里有任何内容就报 `not_empty`）——避免把一个正在用的目录
 *    误变成知识库；已有内容的目录请用「添加工作区」，或先建一个空目录再来创建；
 * 3. 只写 manifest 与一个空目录，不预建任何节点（节点由工具/界面按需创建）；
 * 4. 写盘走 `NodeVfs`（临时文件 + rename），manifest 由上游 `newLibraryManifest` 构造，
 *    形状与桌面版生成的一致。
 *
 * @param root - 目标目录（必须已存在且为空）。
 * @param title - 库标题；空则取目录名。
 * @returns 创建结果。
 */
export async function createLibrary(root: string, title?: string): Promise<CreateLibraryResult> {
  const trimmed = typeof root === "string" ? root.trim() : "";
  if (trimmed === "" || !path.isAbsolute(trimmed)) {
    return { ok: false, code: "invalid_root", message: "需要一个绝对路径的目录" };
  }
  let entries: string[];
  try {
    const info = await stat(trimmed);
    if (!info.isDirectory()) {
      return { ok: false, code: "invalid_root", message: "这个路径不是目录" };
    }
    entries = await readdir(trimmed);
  } catch {
    return { ok: false, code: "invalid_root", message: "这个目录不存在或读不到" };
  }

  /*
   * **新建库一律产出 v3**（一节点 = 一个 markdown，身份 = front-matter 的 ULID）✓。
   *
   * v3 的 `createLibrary` 已经负责：`Nodes/`、`graph.json` ✓（没有 Backup/、也没有回收站 ✓），
   * 所以这里不再自己拼 manifest（v2 的写法保留在上面的兼容分支里，只用于**读**旧库 ✓）。
   */
  const created = await createV3Library(trimmed, title);
  if (!created.ok) {
    return {
      ok: false,
      code: created.code === "already_library" ? "already_exists" : created.code,
      message: created.message,
    };
  }
  lastRoot = created.root;
  return { ok: true, root: created.root, title: created.title, libraryId: created.libraryId };
}
