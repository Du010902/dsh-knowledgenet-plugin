/**
 * v3 存储 → 现有 `GraphSnapshot` 形状的**适配器**。
 *
 * 为什么要适配：面板、工具、卡片、提案审阅全都吃 `GraphSnapshot` / `KnowledgeNode` / `DependencyEdge`
 * 这套形状（来自上游 v2 的类型 ✓）。v3 换了落盘方式，但**没有必要连上层契约一起换**——
 * 把它映射成同一形状，界面与工具就一行都不用改 ✓，改动面被限制在存储层 ✓。
 *
 * 字段映射要点：
 * - `id` = front-matter 的 ULID ✓（身份 ✓，与标题/文件名无关）；
 * - `relativePath` = `Nodes/<标题>.md` ✓（唯一与 v2 的差别：v2 是节点**文件夹**）；
 * - `folderName` = 文件名去扩展名 ✓（面板显示用）；
 * - `revision` = front-matter 的 `rev` ✓（写正文的乐观并发依据）；
 * - `relation` = 边上的"为什么" ✓，`relationType` = 关系类型 ✓。
 */
import { join } from "node:path";

import type { DependencyEdge, Goal, GraphSnapshot, KnowledgeNode, LearnStatus, ScanReport } from "../vendor/upstream/data/types.ts";
import type { LoadedLibrary } from "./library.ts";
import { V3_LIBRARY_FILE, readLibrary as readV3Library, type V3Edge, type V3Node } from "./store.ts";

/** 合法学习状态（v3 里是自由字符串，落到已知三种，未知的按 todo 处理） */
function learnStatus(value: string): LearnStatus {
  return value === "learning" || value === "done" || value === "todo" ? value : "todo";
}

/** 时间字符串 → 毫秒（解析失败用当前时间兜底） */
function millis(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function toKnowledgeNode(node: V3Node): KnowledgeNode {
  const fileName = node.relativePath.split("/").pop() ?? "";
  return {
    id: node.id,
    title: node.title,
    aliases: node.aliases,
    status: learnStatus(node.status),
    createdAt: millis(node.createdAt),
    updatedAt: millis(node.updatedAt),
    relativePath: node.relativePath,
    folderName: fileName.replace(/\.md$/i, ""),
    health: node.adopted === true ? "needs_adoption" : "ok",
    revision: node.rev,
    localMutation: false,
    // 下面这些字段 v3 里没有独立概念，给安全默认值（上层只在少数分支读它们）
    prerequisiteIds: [],
    dependentIds: [],
    noteRevision: node.rev,
    noteHash: node.hash,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as unknown as KnowledgeNode;
}

function toDependencyEdge(edge: V3Edge, index: number, nodes: V3Node[]): DependencyEdge {
  const at = Date.now() + index;
  return {
    id: edge.id,
    fromId: edge.fromId,
    toId: edge.toId,
    relation: edge.description ?? "",
    relationType: edge.type ?? "prerequisite",
    createdAt: at,
    updatedAt: at,
    missing: !nodes.some((node) => node.id === edge.toId),
    ...(edge.source === undefined ? {} : { source: edge.source }),
  } as unknown as DependencyEdge;
}

/** 学习目标 = **没有人依赖它**的节点（没有后继 ⇒ 它是这条线的入口）✓ 与 v2 的口径一致 */
function toGoals(nodes: V3Node[], edges: V3Edge[]): Goal[] {
  const dependedOn = new Set(edges.map((edge) => edge.toId));
  return nodes
    .filter((node) => !dependedOn.has(node.id))
    .map((node) => ({
      id: `goal-${node.id}`,
      title: node.title,
      rootNodeId: node.id,
      createdAt: millis(node.createdAt),
    }));
}

/** 给 v3 库一个"最小可用"的 Vfs：上层只有 `mutate.ts` 的 v2 分支会用到它 ✓ */
function v3Vfs(root: string): LoadedLibrary["vfs"] {
  return {
    absolute: (relativePath: string) => join(root, relativePath),
    root,
  } as unknown as LoadedLibrary["vfs"];
}

/** 合成一个 manifest（v3 的 library.json 字段更少，这里补齐上层会读的键） */
function v3Manifest(root: string, library: { libraryId: string; title: string; createdAt: string }): LoadedLibrary["manifest"] {
  return {
    format: "knowledgenet-library",
    formatVersion: 3,
    libraryId: library.libraryId,
    title: library.title,
    createdAt: library.createdAt,
    root,
    scan: { exclude: [".git", "node_modules", ".knowledgenet", "Backup"], followSymlinks: false },
    defaults: { newNodeParent: "Nodes" },
  } as unknown as LoadedLibrary["manifest"];
}

/** 合成一份扫描报告（面板的 count/truncated 之类从快照算，这里只求"形状对" ✓） */
function v3Report(nodes: number, edges: number): ScanReport {
  return {
    at: Date.now(),
    ms: 0,
    nodes,
    edges,
    cached: false,
    issues: [],
  } as unknown as ScanReport;
}

/**
 * 读一个 v3 库并适配成 `LoadedLibrary`。
 * @param root - 库根。
 * @param withNotes - 是否连正文一起读（面板不需要 ✓，工具需要时单独读节点 ✓）。
 * @returns 适配后的库对象；不是 v3 库时返回 undefined。
 */
export async function loadV3Library(root: string, withNotes = false): Promise<LoadedLibrary | undefined> {
  const library = await readV3Library(root, { withNotes });
  if (library === undefined) return undefined;

  const nodes = library.nodes.map(toKnowledgeNode);
  const edges = library.edges.map((edge, index) => toDependencyEdge(edge, index, library.nodes));
  const snapshot: GraphSnapshot = {
    revision: library.graphRevision,
    nodes,
    edges,
    goals: toGoals(library.nodes, library.edges),
    session: null,
  };

  return {
    root: library.root,
    manifest: v3Manifest(library.root, library),
    vfs: v3Vfs(library.root),
    snapshot,
    report: v3Report(nodes.length, edges.length),
    revision: library.graphRevision,
    // 上层据此判断"这是新存储"，从而走 v3 的写入口
    storage: "v3",
  } as LoadedLibrary;
}

/** v3 库的清单文件名（library.ts 分派时用，避免两处写字符串） */
export const V3_MANIFEST_FILE = V3_LIBRARY_FILE;
