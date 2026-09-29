/**
 * v2 递归扫描器（纯函数，跑在 `Vfs` 上）
 *
 * 与 Rust `src-tauri/src/v2/scanner.rs` 同规则，两个实现必须能对同一份夹具
 * 跑出相同的节点/边/线程/问题集合（`fixtures/v2/expected/scan.json`）。
 *
 * 扫描纪律（契约 §3.4）：
 * 1. 只认**精确路径** `.meta/knowledgenet/node.json`——光有 `.meta` 不算节点；
 * 2. 不跟随符号链接 / junction / reparse point（`Vfs` 的 `list` 不报告它们）；
 * 3. 遇到嵌套的另一个 `library.json` 停止向下，并产出一条 `nested_library_boundary`；
 * 4. 排除目录固定含 `.git`、`node_modules`、`.knowledgenet`，外加 `library.json.scan.exclude`；
 * 5. 关系只从源节点的 `relations.json` 读出边；目标不存在时保留这条边并产出一条
 *    `dangling_relation` warning（绝不自动删除用户建立的关系）；
 * 6. 线程只读 `thread.json` 并数消息文件个数，**不读正文**；
 * 7. 重复 node id 两份都标 `duplicate_id` 并产出一条 `duplicate_node_id` error；
 * 8. `node.json` 解析失败产出一条 `metadata_invalid` / `metadata_unsupported`，
 *    该文件夹**不算节点**（但继续向下扫描，里面可能还有合法节点）。
 */
import type { ChatThread } from "../chatTypes.ts";
import type {
  DependencyEdge,
  DuplicateIdGroup,
  Goal,
  KnowledgeNode,
  LearnStatus,
  NodeHealth,
  ScanIssue,
  ScanReport,
} from "../types.ts";
import { isMetadataError } from "./schema.ts";
import {
  MetadataError,
  excludedDirNames,
  parseGoalsFile,
  parseIsoMs,
  parseNodeMeta,
  parseRelationsFile,
  parseThreadFile,
  type V2LibraryManifest,
  type V2RelationsFile,
} from "./schema.ts";
import type { Vfs, VfsEntry } from "./fs.ts";
import {
  GOALS_FILE,
  LIBRARY_FILE,
  chatsDir,
  joinRel,
  messagesDir,
  nodeMetaFile,
  parseMessageFileName,
  relationsFile,
  threadDir,
  threadFile,
} from "./paths.ts";

export interface ScanOptions {
  /** 全量扫描（真正的冷扫描）；增量扫描同样复用本函数，只是调用方决定何时调用 */
  full: boolean;
}

/** 扫描期收集到的一个节点（含目录位置与元数据指纹） */
interface NodeHit {
  node: KnowledgeNode;
  metaText: string;
}

export async function scanLibrary(
  vfs: Vfs,
  manifest: V2LibraryManifest,
  options: ScanOptions = { full: true },
): Promise<ScanReport> {
  const startedAt = Date.now();
  const excluded = new Set(excludedDirNames(manifest));
  const issues: ScanIssue[] = [];
  const hits: NodeHit[] = [];
  const edges: DependencyEdge[] = [];
  const threads: ChatThread[] = [];
  let scannedDirs = 0;
  let truncated = false;

  const pushIssue = (issue: ScanIssue): void => {
    issues.push(issue);
  };

  const describeMetadataError = (error: unknown, what: string, rel: string): ScanIssue => {
    if (isMetadataError(error)) {
      return {
        code: error.code,
        severity: "error",
        relativePath: rel,
        nodeId: null,
        detail: error.message,
        parsePosition: error.parsePosition,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      code: "metadata_invalid",
      severity: "error",
      relativePath: rel,
      nodeId: null,
      detail: `${what} 读写失败：${message}`,
      parsePosition: null,
    };
  };

  /** 读一个节点目录的 `node.json`；失败时产出 issue 并返回 null（该目录不算节点） */
  const readNodeAt = async (dir: string): Promise<NodeHit | null> => {
    const marker = nodeMetaFile(dir);
    let text: string;
    try {
      text = await vfs.read(marker);
    } catch (error) {
      pushIssue(describeMetadataError(error, "node.json", marker));
      return null;
    }
    try {
      const meta = parseNodeMeta(text, marker);
      return {
        metaText: text,
        node: {
          id: meta.id,
          title: meta.title,
          aliases: meta.aliases,
          status: meta.status as LearnStatus,
          createdAt: parseIsoMs(meta.createdAt, marker),
          updatedAt: parseIsoMs(meta.updatedAt, marker),
          relativePath: dir,
          folderName: dir === "" ? "" : (dir.split("/").pop() as string),
          health: "ok" as NodeHealth,
          revision: meta.revision,
          localMutation: false,
        },
      };
    } catch (error) {
      pushIssue(describeMetadataError(error, "node.json", marker));
      return null;
    }
  };

  const readRelationsAt = async (dir: string, nodeId: string): Promise<void> => {
    const rel = relationsFile(dir);
    let raw: string;
    try {
      raw = await vfs.read(rel);
    } catch {
      // 没有 relations.json 是最常见的情况：没有出边，不是问题
      return;
    }
    let file: V2RelationsFile;
    try {
      file = parseRelationsFile(raw, rel);
    } catch (error) {
      pushIssue(describeMetadataError(error, "relations.json", rel));
      return;
    }
    if (file.nodeId !== nodeId) {
      pushIssue({
        code: "metadata_invalid",
        severity: "warning",
        relativePath: rel,
        nodeId,
        detail: `relations.json 里的 nodeId（${file.nodeId}）与 node.json 的 id（${nodeId}）不一致，已按所在节点归属这些出边`,
        parsePosition: null,
      });
    }
    for (const edge of file.outgoing) {
      edges.push({
        id: edge.id,
        fromId: nodeId,
        toId: edge.toNodeId,
        relation: edge.description,
        relationType: edge.type || "prerequisite",
        createdAt: parseIsoMs(edge.createdAt, rel),
        updatedAt: parseIsoMs(edge.updatedAt, rel),
        dangling: true, // 稍后统一按节点集合判定
      });
    }
  };

  const readThreadsAt = async (dir: string, nodeId: string): Promise<void> => {
    const chats = chatsDir(dir);
    let threadDirs: VfsEntry[];
    try {
      threadDirs = (await vfs.list(chats)).filter((entry) => entry.kind === "dir");
    } catch {
      return;
    }
    for (const entry of threadDirs) {
      const threadRel = threadDir(dir, entry.name);
      const fileRel = threadFile(dir, entry.name);
      let raw: string;
      try {
        raw = await vfs.read(fileRel);
      } catch {
        pushIssue({
          code: "metadata_invalid",
          severity: "warning",
          relativePath: threadRel,
          nodeId,
          detail: "对话目录里没有 thread.json，已跳过",
          parsePosition: null,
        });
        continue;
      }
      let thread;
      try {
        thread = parseThreadFile(raw, fileRel);
      } catch (error) {
        pushIssue(describeMetadataError(error, "thread.json", fileRel));
        continue;
      }
      const messageCount = await countMessageFiles(vfs, dir, entry.name);
      threads.push({
        id: thread.id,
        nodeId,
        title: thread.title,
        summary: thread.summary,
        createdAt: parseIsoMs(thread.createdAt, fileRel),
        updatedAt: parseIsoMs(thread.updatedAt, fileRel),
        messageCount,
        nodeRelativePath: dir,
      });
    }
  };

  /* --------------------------------- 递归 --------------------------------- */

  const stack: string[] = [""];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    scannedDirs += 1;
    let entries: VfsEntry[];
    try {
      entries = await vfs.list(dir);
    } catch (error) {
      // 某一层目录读不动时不能假装扫描成功：如实报告「报告不完整」
      truncated = true;
      const message = error instanceof Error ? error.message : String(error);
      pushIssue({
        code: "scan_incomplete",
        severity: "error",
        relativePath: dir,
        nodeId: null,
        detail: `目录读不动，扫描提前跳过：${message}`,
        parsePosition: null,
      });
      continue;
    }

    // 自己是不是节点：只认精确的 `.meta/knowledgenet/node.json`
    if (await vfs.exists(nodeMetaFile(dir))) {
      const hit = await readNodeAt(dir);
      if (hit) hits.push(hit);
    }

    for (const entry of entries) {
      if (entry.kind !== "dir") continue;
      if (excluded.has(entry.name)) continue;
      const child = joinRel(dir, entry.name);
      // 嵌套的另一个知识库：停止向下，避免一个节点同时属于两个库
      if (await vfs.exists(joinRel(child, LIBRARY_FILE))) {
        pushIssue({
          code: "nested_library_boundary",
          severity: "info",
          relativePath: child,
          nodeId: null,
          detail: "这里还有一个 library.json：停止向下扫描，其中的文件夹不属于当前知识库",
          parsePosition: null,
        });
        continue;
      }
      stack.push(child);
    }
  }

  /* -------------------------- 重复 ID / 出边 / 线程 -------------------------- */

  const byId = new Map<string, NodeHit[]>();
  for (const hit of hits) {
    const list = byId.get(hit.node.id);
    if (list) list.push(hit);
    else byId.set(hit.node.id, [hit]);
  }

  const duplicateIds: DuplicateIdGroup[] = [];
  for (const [nodeId, group] of byId) {
    if (group.length < 2) continue;
    const relativePaths = group.map((hit) => hit.node.relativePath).sort();
    duplicateIds.push({ nodeId, relativePaths });
    for (const hit of group) {
      hit.node.health = "duplicate_id";
      pushIssue({
        code: "duplicate_node_id",
        severity: "error",
        relativePath: nodeMetaFile(hit.node.relativePath),
        nodeId,
        detail: `同一个 node id 出现在 ${group.length} 个目录：${relativePaths.join("、")}。请选择保留其中一个，或给副本分配新 ID`,
        parsePosition: null,
      });
    }
  }
  duplicateIds.sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));

  const nodeIds = new Set(byId.keys());
  const nodes: KnowledgeNode[] = hits
    .map((hit) => hit.node)
    .sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));

  for (const hit of hits) {
    await readRelationsAt(hit.node.relativePath, hit.node.id);
  }
  for (const edge of edges) {
    edge.dangling = !nodeIds.has(edge.toId);
    if (edge.dangling) {
      const source = byId.get(edge.fromId)?.[0]?.node;
      pushIssue({
        code: "dangling_relation",
        severity: "warning",
        relativePath: source ? relationsFile(source.relativePath) : null,
        nodeId: edge.fromId,
        detail: `关系目标 ${edge.toId} 当前不在知识库里：关系与标题快照都已保留，可稍后修复`,
        parsePosition: null,
      });
    }
  }

  for (const hit of hits) {
    await readThreadsAt(hit.node.relativePath, hit.node.id);
  }

  const goals = await readGoals(vfs);

  return {
    full: options.full,
    durationMs: Math.max(0, Date.now() - startedAt),
    scannedDirs,
    nodes,
    edges,
    goals,
    threads,
    issues,
    duplicateIds,
    rootIsNode: hits.some((hit) => hit.node.relativePath === ""),
    truncated,
  };
}

/** 数一个对话目录里的消息文件个数（只读文件名，不读正文） */
async function countMessageFiles(vfs: Vfs, nodeRel: string, threadId: string): Promise<number> {
  try {
    const entries = await vfs.list(messagesDir(nodeRel, threadId));
    return entries.filter((entry) => entry.kind === "file" && parseMessageFileName(entry.name) !== null)
      .length;
  } catch {
    return 0;
  }
}

/**
 * 读根目录 `.knowledgenet/goals.json`。
 *
 * 目标属于整个知识库（不属于某个节点），缺失时返回空列表而不是报错：
 * 一个刚建好的知识库本来就没有目标。
 */
export async function readGoals(vfs: Vfs): Promise<Goal[]> {
  let raw: string | null = null;
  try {
    raw = await vfs.read(GOALS_FILE);
  } catch {
    return [];
  }
  try {
    const file = parseGoalsFile(raw, GOALS_FILE);
    return file.goals.map((goal) => ({
      id: goal.id,
      title: goal.title,
      rootNodeId: goal.rootNodeId,
      createdAt: parseIsoMs(goal.createdAt, GOALS_FILE),
    }));
  } catch {
    // 目标文件坏了不该让整次扫描失败：图仍然可用，问题由完整性检查报告
    return [];
  }
}

/** 供调用方构造 issue 用（例如写盘前发现版本不支持） */
export function metadataIssue(
  error: unknown,
  fallback: { relativePath?: string | null; nodeId?: string | null } = {},
): ScanIssue {
  if (error instanceof MetadataError) {
    return {
      code: error.code,
      severity: "error",
      relativePath: error.relativePath ?? fallback.relativePath ?? null,
      nodeId: fallback.nodeId ?? null,
      detail: error.message,
      parsePosition: error.parsePosition,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "metadata_invalid",
    severity: "error",
    relativePath: fallback.relativePath ?? null,
    nodeId: fallback.nodeId ?? null,
    detail: message,
    parsePosition: null,
  };
}

/** 扫描报告里用于「嵌套节点边界」判断的小工具（resources.ts 复用） */
export async function hasNodeMarkerAt(vfs: Vfs, dir: string): Promise<boolean> {
  return vfs.exists(nodeMetaFile(dir));
}
