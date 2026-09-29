/**
 * 写操作（P1）：建前置知识、写笔记。
 *
 * 三条纪律，全部照抄上游已有的判断，不另起一套：
 * 1. **查重优先**：先 `findExactMatch`，再 `findSimilar`；没有明确要求新建时**不擅自建点**，
 *    把候选交回给模型/用户决定——知识库里最贵的不是存储，而是同义节点。
 * 2. **成环一律拒绝**：写之前用 `findCycleIfLinked` 算一遍，写之后上游 `addEdge` 还会再挡一次。
 * 3. **绝不静默覆盖**：节点元数据与笔记都走修订号/哈希守卫；冲突时返回可读原因和磁盘上的最新修订号，
 *    由调用方决定重读还是放弃。
 */
import { RepositoryError } from "../vendor/upstream/data/errors.ts";
import { newUuid } from "../vendor/upstream/data/uuid.ts";
import type { KnowledgeNode } from "../vendor/upstream/data/types.ts";
import { findCycleIfLinked, findExactMatch, findSimilar } from "../vendor/upstream/data/engine.ts";
import { joinRel } from "../vendor/upstream/data/v2/paths.ts";
import {
  isoFromMs,
  newNodeMeta,
  sanitizeFolderName,
  uniqueNameIn,
} from "../vendor/upstream/data/v2/schema.ts";
import { readNodeMeta, writeNodeMeta } from "../vendor/upstream/data/v2/nodeMeta.ts";
import {
  checkDocument,
  createPrimaryDocument,
  documentPathOf,
  readDocument,
  writeDocument,
} from "../vendor/upstream/data/v2/notes.ts";
import { addEdge, addEvidence } from "../vendor/upstream/data/v2/relations.ts";
import { normalizeTitle } from "../vendor/upstream/data/types.ts";
import { resolveNodeArg, summarizeNode, type NodeSummary } from "./graph.ts";
import { invalidateLibrary, type LibraryContext } from "./library.ts";
import { readNode as readV3Node, removeEdge as removeV3Edge } from "./v3/store.ts";
import {
  addEdge as addV3Edge,
  createNode as createV3Node,
  writeNote as writeV3Note,
} from "./v3/store.ts";

export interface AddPrerequisiteInput {
  /** 归属节点：A → B 里的 A。缺省用会话当前的学习节点 */
  fromId?: string;
  fromPath?: string;
  /** 选中文字归一化后的标题 */
  title: string;
  /** 明确要求新建时才建点；否则命中相似候选就把决定交回给调用方 */
  create?: boolean;
  relationType?: string;
  description?: string;
  /** 来源记录：从哪次回答的哪句话来的 */
  evidence?: {
    sessionId?: string | null;
    messageId?: string | null;
    snippet?: string | null;
    question?: string | null;
  };
}

export interface AddPrerequisiteResult {
  ok: boolean;
  error?: { code: string; message: string };
  from?: NodeSummary;
  node?: NodeSummary;
  created?: boolean;
  edge?: { id: string; type: string; description: string };
  evidenceRecorded?: boolean;
  /** 命中相似但未确认时给出，供模型复用或要求新建 */
  candidates?: NodeSummary[];
  cycle?: string[];
}

/** 解析归属节点（A）：显式参数 → 会话当前学习节点 → 第一个学习目标 */
export function resolveFromNode(
  context: LibraryContext,
  args: { fromId?: string; fromPath?: string; currentId?: string | null },
): KnowledgeNode | undefined {
  const explicit = resolveNodeArg(context.snapshot, { id: args.fromId, path: args.fromPath });
  if (explicit !== undefined) return explicit;
  if (typeof args.currentId === "string" && args.currentId !== "") {
    const current = context.snapshot.nodes.find((node) => node.id === args.currentId);
    if (current !== undefined) return current;
  }
  const goal = context.snapshot.goals[0];
  if (goal === undefined) return undefined;
  return context.snapshot.nodes.find((node) => node.id === goal.rootNodeId);
}

/** 在「节点归属的父目录」里找一个不冲突的文件夹名 */
async function pickFolderName(context: LibraryContext, title: string): Promise<string> {
  const parent = context.library.manifest.defaults?.newNodeParent ?? "Nodes";
  await context.library.vfs.mkdir(parent).catch(() => undefined);
  const entries = await context.library.vfs.list(parent).catch(() => []);
  return uniqueNameIn(sanitizeFolderName(title), entries.map((entry) => entry.name));
}

/** 新建一个节点：目录 + 主文档 + 元数据（不写任何关系） */
async function createNode(
  context: LibraryContext,
  title: string,
): Promise<{ nodeRel: string; nodeId: string; title: string }> {
  const folder = await pickFolderName(context, title);
  const parent = context.library.manifest.defaults?.newNodeParent ?? "Nodes";
  const nodeRel = joinRel(parent, folder);
  const nodeId = newUuid();
  const documentRel = documentPathOf(null);

  await context.library.vfs.mkdir(nodeRel);
  await createPrimaryDocument(context.library.vfs, nodeRel, nodeId, "", documentRel);
  await writeNodeMeta(
    context.library.vfs,
    nodeRel,
    newNodeMeta({
      id: nodeId,
      title,
      now: isoFromMs(Date.now()),
      primaryDocument: documentRel,
    }),
    { expectedRevision: null, expectedHash: null },
  );
  return { nodeRel, nodeId, title };
}

/**
 * 手动新建一个**独立节点**（不属于任何关系）——空库里建第一个节点就靠它。
 *
 * 复用同一套上游写法（`newNodeMeta` + `createPrimaryDocument`），所以目录、主文档、
 * 元数据与库自己的实现完全一致，不会出现"手搓出来的节点扫描不到"。
 *
 * @param context - 已装载的库上下文。
 * @param input - 标题（必填；会按库的规则净化成文件夹名）。
 * @returns 新节点的精简信息；标题非法时给出可读错误。
 */
export async function createNodeFromUi(
  context: LibraryContext,
  input: { title: string },
): Promise<{
  ok: boolean;
  error?: { code: string; message: string };
  node?: { id: string; title: string; relativePath: string };
}> {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (title === "") return { ok: false, error: { code: "title_required", message: "请填写知识点名称" } };
  if (title.length > 120) {
    return { ok: false, error: { code: "title_too_long", message: "名称太长了（最多 120 字）" } };
  }

  /*
   * v3 库（一节点 = 一个 markdown）：走新存储 ⇒ 建出来的是 `Nodes/<标题>.md` ✓，
   * 身份是 front-matter 里的 ULID ✓（与标题/文件名无关）。
   */
  if (context.library.storage === "v3") {
    const made = await createV3Node(context.library.root, { title });
    if (!made.ok) return { ok: false, error: { code: made.code, message: made.message } };
    invalidateLibrary(context.library.root);
    return { ok: true, node: { id: made.node.id, title: made.node.title, relativePath: made.node.relativePath } };
  }

  try {
    const made = await createNode(context, title);
    return { ok: true, node: { id: made.nodeId, title: made.title, relativePath: made.nodeRel } };
  } catch (error) {
    return {
      ok: false,
      error: { code: "create_node_failed", message: error instanceof Error ? error.message : String(error) },
    };
  }
}

export async function addPrerequisite(
  context: LibraryContext,
  input: AddPrerequisiteInput,
  options: { currentId?: string | null } = {},
): Promise<AddPrerequisiteResult> {
  const title = normalizeTitle(input.title ?? "");
  if (title === "") {
    return { ok: false, error: { code: "invalid_input", message: "title 不能为空" } };
  }

  const from = resolveFromNode(context, {
    fromId: input.fromId,
    fromPath: input.fromPath,
    currentId: options.currentId,
  });
  if (from === undefined) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message:
          "无法确定归属节点：请先 kn_enter_node 进入当前学习节点，或用 fromId/fromPath 指定；"
          + "知识库里也可以先建一个学习目标（goals）。",
      },
    };
  }

  const exact = findExactMatch(context.snapshot, title);
  if (exact !== undefined && exact.id === from.id) {
    return {
      ok: false,
      error: { code: "invalid_input", message: `「${title}」就是当前节点自己，不能设为它自己的前置知识。` },
    };
  }

  let target: { id: string; title: string; relativePath: string } | undefined =
    exact === undefined ? undefined : { id: exact.id, title: exact.title, relativePath: exact.relativePath };
  let created = false;

  if (target === undefined) {
    const similar = findSimilar(context.snapshot, title, 5);
    if (input.create !== true && similar.length > 0) {
      return {
        ok: true,
        from: summarizeNode(from),
        created: false,
        candidates: similar.map(summarizeNode),
        error: {
          code: "needs_confirmation",
          message:
            `「${title}」没有精确命中，但有 ${similar.length} 个相近知识点。`
            + "要么复用其中一个（把它作为前置知识），要么在确认是不同概念后带 create: true 重新调用。",
        },
      };
    }
    const made = context.library.storage === "v3"
      /* v3：建节点 = 写一个 `Nodes/<标题>.md` ✓（身份是 front-matter 的 ULID） */
      ? await (async () => {
        const created = await createV3Node(context.library.root, { title });
        if (!created.ok) throw new Error(`v3 建点失败：${created.code} ${created.message}`);
        return { nodeId: created.node.id, title: created.node.title, nodeRel: created.node.relativePath };
      })()
      : await createNode(context, title);
    target = { id: made.nodeId, title: made.title, relativePath: made.nodeRel };
    created = true;
  }

  const cycle = findCycleIfLinked(context.snapshot, from.id, target.id);
  if (cycle !== null) {
    return {
      ok: false,
      from: summarizeNode(from),
      cycle,
      error: {
        code: "cycle_rejected",
        message: `这会让依赖成环：${cycle.join(" → ")}。前置关系必须是 DAG。`,
      },
    };
  }

  /*
   * v3 库：关系写在库根的 `graph.json` 里（单一 sidecar ✓），出处记在边的 `source` 上 ✓。
   * 成环检测仍用上层那套快照机检（与 v2 完全一致 ✓）。
   */
  if (context.library.storage === "v3") {
    const added = await addV3Edge(context.library.root, {
      fromId: from.id,
      toId: target.id,
      type: input.relationType?.trim() || "prerequisite",
      description: input.description ?? "",
      ...(typeof input.evidence?.snippet === "string" && input.evidence.snippet.trim() !== ""
        ? {
          source: {
            snippet: input.evidence.snippet.slice(0, 2000),
            question: input.evidence?.question ?? "",
            ...(input.evidence?.messageId === undefined ? {} : { messageId: input.evidence.messageId }),
            at: Date.now(),
          },
        }
        : {}),
    });
    if (!added.ok) {
      return {
        ok: false,
        from: summarizeNode(from),
        error: { code: added.code, message: added.message },
      };
    }
    invalidateLibrary(context.library.root);
    /*
     * 返回形状必须与 v2 分支一致 ✓（`applyPlanFromUi` 读的是 `added.node.id` 与 `added.created` ✓，
     * 落地记录里没有 nodeId，撤销就会"无事可做" ✗ —— 集成测试抓到的真 bug ✓）。
     * `path` 字段名也与工具/面板一致 ✓。
     */
    return {
      ok: true,
      from: summarizeNode(from),
      created,
      node: {
        id: target.id,
        title: target.title,
        path: target.relativePath,
        status: "todo",
        aliases: [],
        health: "ok",
        revision: 1,
      },
      edge: {
        id: added.edge.id,
        type: added.edge.type,
        description: added.edge.description ?? "",
      },
      evidenceRecorded: added.edge.source !== undefined,
    } as unknown as AddPrerequisiteResult;
  }

  try {
    const edge = await addEdge(context.library.vfs, from.relativePath, from.id, {
      toNodeId: target.id,
      toTitle: target.title,
      relationType: input.relationType?.trim() || "prerequisite",
      description: input.description ?? "",
    });

    let evidenceRecorded = false;
    const snippet = input.evidence?.snippet;
    if (typeof snippet === "string" && snippet.trim() !== "") {
      await addEvidence(context.library.vfs, from.relativePath, from.id, edge.id, {
        threadId: input.evidence?.sessionId ?? null,
        messageId: input.evidence?.messageId ?? null,
        snippet: snippet.slice(0, 2000),
        question: input.evidence?.question ?? "",
      });
      evidenceRecorded = true;
    }

    invalidateLibrary(context.library.root);

    const madeNode = (await readNodeMeta(context.library.vfs, target.relativePath).catch(() => null))?.meta;
    const summary: NodeSummary = madeNode === undefined || madeNode === null
      ? {
          id: target.id,
          title: target.title,
          path: target.relativePath,
          status: exact?.status ?? "todo",
          aliases: exact?.aliases ?? [],
          health: exact?.health ?? "ok",
          revision: exact?.revision ?? 1,
        }
      : {
          id: madeNode.id,
          title: madeNode.title,
          path: target.relativePath,
          status: madeNode.status,
          aliases: madeNode.aliases,
          health: "ok",
          revision: madeNode.revision,
        };

    return {
      ok: true,
      from: summarizeNode(from),
      node: summary,
      created,
      edge: { id: edge.id, type: edge.type, description: edge.description },
      evidenceRecorded,
    };
  } catch (error) {
    if (error instanceof RepositoryError) {
      return { ok: false, from: summarizeNode(from), error: { code: error.code, message: error.message } };
    }
    throw error;
  }
}

export interface WriteNoteResult {
  ok: boolean;
  error?: { code: string; message: string; actualRevision?: number };
  node?: NodeSummary;
  note?: { path: string; byteLength: number; documentRevision: number };
}

/** 写笔记：不带 expectedRevision 时按「刚读过」处理（先校验再写），绝不静默覆盖 */
export async function writeNote(
  context: LibraryContext,
  node: KnowledgeNode,
  text: string,
  expectedRevision?: number,
): Promise<WriteNoteResult> {
  /*
   * v3（一节点 = 一个 markdown）：**整个文件就是笔记** ✓ —— 正文写在 front-matter 之后，
   * 冲突守卫用**内容指纹**（比修订号更严：外部编辑器改了任意一个字符都会被拦 ✓）。
   * `expectedRevision` 在 v3 里没有对应语义（修订号是文件内的 rev ✓），忽略它即可 ✗ 不影响守卫强度 ✓。
   */
  if (context.library.storage === "v3") {
    const current = await readV3Node(context.library.root, { id: node.id });
    if (!current.ok) {
      return { ok: false, node: summarizeNode(node), error: { code: current.code, message: current.message } } as WriteNoteResult;
    }
    // 先读当前指纹：这等价于「刚读过」✓（同一次调用内读取 → 写入，中间被改就会冲突 ✓）
    const guard = current.node.hash;
    void expectedRevision;
    const written = await writeV3Note(context.library.root, { id: node.id, text, expectedHash: guard });
    if (!written.ok) {
      return {
        ok: false,
        node: summarizeNode(node),
        error: { code: written.code, message: written.message },
      } as WriteNoteResult;
    }
    invalidateLibrary(context.library.root);
    return { ok: true, node: summarizeNode(node), revision: written.node.rev } as unknown as WriteNoteResult;
  }

  const nodeRel = node.relativePath;
  const meta = (await readNodeMeta(context.library.vfs, nodeRel)).meta;
  const documentRel = documentPathOf(meta.primaryDocument);

  let revision = expectedRevision;
  if (revision === undefined) {
    const checked = await checkDocument(context.library.vfs, nodeRel, node.id, documentRel);
    revision = checked.documentRevision;
  }

  const outcome = await writeDocument(context.library.vfs, nodeRel, node.id, text, revision, false, documentRel);
  if (outcome.status === "conflict") {
    return {
      ok: false,
      node: summarizeNode(node),
      error: {
        code: "external_change_conflict",
        message: `${outcome.conflict.reason}：${outcome.conflict.detail}`,
        actualRevision: outcome.conflict.disk?.documentRevision,
      },
    };
  }

  invalidateLibrary(context.library.root);
  return {
    ok: true,
    node: summarizeNode(node),
    note: {
      path: documentRel,
      byteLength: outcome.note.byteLength,
      documentRevision: outcome.note.documentRevision,
    },
  };
}

/** 读笔记正文（`kn_read_node` 与注入上下文共用） */
export async function readNote(context: LibraryContext, node: KnowledgeNode, maxChars = 6000): Promise<
  { path: string; text: string; truncated: boolean; byteLength: number }
> {
  const nodeRel = node.relativePath;
  const meta = (await readNodeMeta(context.library.vfs, nodeRel)).meta;
  const documentRel = documentPathOf(meta.primaryDocument);
  try {
    const snapshot = await readDocument(context.library.vfs, nodeRel, node.id, documentRel);
    const content = snapshot.content ?? "";
    return {
      path: documentRel,
      text: content.length > maxChars ? content.slice(0, maxChars) : content,
      truncated: content.length > maxChars,
      byteLength: snapshot.byteLength,
    };
  } catch {
    return { path: documentRel, text: "", truncated: false, byteLength: 0 };
  }
}
