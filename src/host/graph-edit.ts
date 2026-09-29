/**
 * 界面上的**图上编辑**：右键节点加前置、右键连线删依赖。
 *
 * 两条都复用上游已有的写入口，不自己动关系文件格式：
 * - 加前置：`mutate.ts` 的 `addPrerequisite`（标题精确命中就复用已有节点；相近候选会返回 candidates，
 *   由界面问用户"复用还是新建"——不擅自建重复节点）；
 * - 删依赖：`data/v2/relations.ts` 的 `removeEdge`（走 `relations.json` 的原子替换 + 修订号/内容哈希守卫，
 *   磁盘被外部改过就拒绝覆盖，与工具侧写笔记同一套保护）。
 */
import { removeEdge } from "../vendor/upstream/data/v2/relations.ts";
import { invalidateLibrary, type LibraryContext } from "./library.ts";
import { addPrerequisite, type AddPrerequisiteInput, type AddPrerequisiteResult } from "./mutate.ts";
import { removeEdge as removeV3Edge, removeNode as removeV3Node } from "./v3/store.ts";
import { removeNodeFolder, type NodeDeleteMode } from "./remove-node-meta.ts";
import { search } from "./graph.ts";
import { readPlan, savePlan, selectPlanItems, type Plan } from "./plans.ts";

/** 右键节点 → 加前置的输入 */
export interface AddPrerequisiteUiInput {
  /** 被右键的那个节点（A → B 里的 A） */
  fromId: string;
  /** 用户输入的标题 */
  title: string;
  /** true = 明确新建（跳过"相近候选先确认"） */
  create?: boolean;
  description?: string;
  /** 触发这次添加的原文片段（从对话里划词得到），写进 evidence 便于回溯 */
  snippet?: string;
  /** 当时用户的问题（来源记录，可选） */
  question?: string;
}

export interface UiEditResult {
  ok: boolean;
  error?: { code: string; message: string };
  /** 加前置时回传上游结果（含 candidates / created / edge） */
  added?: AddPrerequisiteResult;
  /** 删依赖时是否真的删掉了一条 */
  removed?: boolean;
}

/**
 * 右键节点 → 在这个节点下加一条前置（A → B，B 是 A 的前置）。
 *
 * @param context - 已装载的库上下文。
 * @param root - 库根（写盘成功后用来失效缓存）。
 * @param input - 归属节点与标题。
 * @returns 上游结果或可读错误。
 */
export async function addPrerequisiteFromUi(
  context: LibraryContext,
  root: string,
  input: AddPrerequisiteUiInput,
): Promise<UiEditResult> {
  const fromId = typeof input.fromId === "string" ? input.fromId.trim() : "";
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (fromId === "") return { ok: false, error: { code: "bad_body", message: "缺少 fromId" } };
  if (title === "") return { ok: false, error: { code: "bad_body", message: "标题不能为空" } };
  if (context.snapshot.nodes.every((node) => node.id !== fromId)) {
    return { ok: false, error: { code: "node_not_found", message: `找不到节点：${fromId}` } };
  }

  const args: AddPrerequisiteInput = { fromId, title };
  if (input.create === true) args.create = true;
  if (typeof input.description === "string" && input.description.trim() !== "") {
    args.description = input.description.trim();
  }
  args.evidence = {
    snippet: typeof input.snippet === "string" && input.snippet.trim() !== ""
      ? input.snippet.trim().slice(0, 600)
      : "（由界面添加）",
    question: typeof input.question === "string" && input.question.trim() !== "" ? input.question.trim().slice(0, 300) : null,
  };

  const result = await addPrerequisite(context, args);
  if (result.ok) invalidateLibrary(root);
  return { ok: result.ok, error: result.error, added: result };
}

/**
 * 右键连线 → 删除这条依赖。
 *
 * 边只存在**源节点**的 `relations.json` 里（设计 §4.4），所以要拿到源节点；
 * 删除本身由上游 `removeEdge` 做，带修订号/哈希守卫。
 *
 * @param context - 已装载的库上下文。
 * @param root - 库根。
 * @param input - 源节点 id 与关系 id。
 * @returns 是否删掉了一条。
 */
export async function removePrerequisiteFromUi(
  context: LibraryContext,
  root: string,
  input: { fromId: string; edgeId: string },
): Promise<UiEditResult> {
  const fromId = typeof input.fromId === "string" ? input.fromId.trim() : "";
  const edgeId = typeof input.edgeId === "string" ? input.edgeId.trim() : "";
  if (fromId === "" || edgeId === "") {
    return { ok: false, error: { code: "bad_body", message: "缺少 fromId 或 edgeId" } };
  }
  const from = context.snapshot.nodes.find((node) => node.id === fromId);
  if (from === undefined) {
    return { ok: false, error: { code: "node_not_found", message: `找不到节点：${fromId}` } };
  }

  /* v3：关系都在库根的 `graph.json` 里 ✓（单一 sidecar），删除只动那一个文件 ✓ */
  if (context.library.storage === "v3") {
    const removedV3 = await removeV3Edge(context.library.root, edgeId);
    if (!removedV3.ok) {
      return { ok: false, removed: false, error: { code: removedV3.code, message: removedV3.message } };
    }
    invalidateLibrary(root);
    return { ok: true, removed: true };
  }

  try {
    const removed = await removeEdge(context.library.vfs, from.relativePath, from.id, edgeId);
    if (removed) invalidateLibrary(root);
    return removed
      ? { ok: true, removed: true }
      : { ok: false, removed: false, error: { code: "edge_not_found", message: "这条依赖已经不存在了" } };
  } catch (error) {
    // 守卫拒绝（外部改过文件）或磁盘错误：原话回给界面
    return {
      ok: false,
      error: { code: "write_failed", message: error instanceof Error ? error.message : String(error) },
    };
  }
}

/**
 * 给客户端的**目标节点搜索**：用户要把这段原文挂到哪个知识点下面。
 *
 * 复用工具侧同一套 `search`（精确命中 + 相近 + 关键词回退），所以"搜索"与模型看到的
 * 结果一致，不会出现"界面上搜不到、模型却知道"的分裂。
 *
 * @param context - 已装载的库上下文。
 * @param query - 关键词（空串返回空列表）。
 * @param limit - 上限。
 * @returns 精简后的候选（id/标题/状态/路径）。
 */
export function searchTargets(
  context: LibraryContext,
  query: string,
  limit = 8,
): Array<{ id: string; title: string; status: string; path: string }> {
  const text = typeof query === "string" ? query.trim() : "";
  if (text === "") return [];
  const { exact, similar } = search(context.snapshot, text, Math.max(1, Math.min(20, limit)));
  const out: Array<{ id: string; title: string; status: string; path: string }> = [];
  const seen = new Set<string>();
  for (const node of exact === null ? similar : [exact, ...similar]) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push({ id: node.id, title: node.title, status: String(node.status ?? "todo"), path: String(node.path ?? "") });
  }
  return out;
}

/**
 * 「删除当前节点」——按**库自己的语义**做：**移除节点身份**，不删用户的文件。
 *
 * 依据（项目源码）：
 * - `src/data/repository.ts:12`：「删除节点」变成「移除节点身份」：只把 `.meta/knowledgenet`
 *   移进回收站，用户文件夹原样保留；
 * - `src/data/v2/paths.ts:33`：回收站位置就是 `<root>/.knowledgenet/trash/node-metadata/`。
 *
 * 所以这里**移动**（`rename`）节点的 `.meta/knowledgenet` 到回收站目录，而不是删除：
 * 用户的笔记/文件一个不动，想恢复时把那一坨移回节点目录即可。
 *
 * @param context - 已装载的库上下文。
 * @param input - 要移除身份的节点 id。
 * @returns 成功/失败（失败带可读原因）。
 */
export async function removeNodeFromUi(
  context: LibraryContext,
  input: { nodeId: string; mode?: NodeDeleteMode },
): Promise<
  UiEditResult & {
    removed?: { id: string; title: string; relativePath: string; mode: NodeDeleteMode; backup?: string };
  }
> {
  const nodeId = typeof input.nodeId === "string" ? input.nodeId : "";
  if (nodeId === "") {
    return { ok: false, error: { code: "node_id_required", message: "没有给出要删除的节点 id" } };
  }
  const node = context.snapshot.nodes.find((item) => item.id === nodeId);
  if (node === undefined) {
    return { ok: false, error: { code: "node_unknown", message: "找不到这个节点（可能已经被删除了）" } };
  }
  /*
   * 删除节点的两种语义（用户在确认框里选）：
   * - backup：**整个节点**移进 `<库>/Backup/`（可恢复，默认）；
   * - purge：彻底删除（不可恢复）。
   *
   * v3（一节点 = 一个 markdown）：直接删掉那个 `.md`（没有回收站/墓碑）；
   * v2（上游文件夹格式）：移动/删除整个节点文件夹 ✓。
   */
  const mode: NodeDeleteMode = input.mode === "purge" ? "purge" : "backup";

  if (context.library.storage === "v3") {
    const removed = await removeV3Node(context.library.root, { id: node.id });
    if (!removed.ok) return { ok: false, error: { code: removed.code, message: removed.message } };
    invalidateLibrary(context.library.root);
    return {
      ok: true,
      removed: { id: removed.id, title: removed.title, relativePath: node.relativePath },
    };
  }

  const outcome = await removeNodeFolder({
    root: context.library.root,
    relativePath: node.relativePath,
    mode,
  });
  if (outcome.ok !== true) return { ok: false, error: outcome.error };
  return {
    ok: true,
    removed: {
      id: node.id,
      title: node.title,
      relativePath: node.relativePath,
      mode,
      ...(outcome.backup === undefined ? {} : { backup: outcome.backup }),
    },
  };
}


/**
 * 落地一份提案（**只能由用户在面板里触发**，见客户端路由 `apply-plan`）。
 *
 * 逐条走与界面同样的写入口 `addPrerequisiteFromUi`；提案里标了 `existingNodeId` 的条目**复用**已有节点，
 * 其余才新建（`create: true`）。落地结果写回计划文件，供「撤销」使用。
 *
 * @param context - 已装载的库上下文。
 * @param root - 库根。
 * @param input - 计划 id +（可选）用户勾选的条目 id。
 * @returns 成功/失败；成功时带上更新后的计划。
 */
export async function applyPlanFromUi(
  context: LibraryContext,
  root: string,
  input: { planId: string; itemIds?: readonly string[] },
): Promise<UiEditResult & { plan?: Plan }> {
  const plan = await readPlan(root, input.planId);
  if (plan === null) {
    return { ok: false, error: { code: "plan_unknown", message: "找不到这份提案（可能已被清理或来自别的库）" } };
  }
  const selection = selectPlanItems(plan, input.itemIds);
  if (selection.ok !== true) {
    return { ok: false, error: { code: selection.code, message: selection.message } };
  }
  const created: Array<{ itemId: string; nodeId?: string; title: string }> = [];
  const reused: Array<{ itemId: string; nodeId?: string; title: string }> = [];
  const failed: Array<{ itemId: string; message: string }> = [];
  for (const item of selection.items) {
    const result = await addPrerequisiteFromUi(context, root, {
      fromId: item.fromId,
      title: item.title,
      // 提案时已存在同名节点 → 复用；否则新建
      create: item.existingNodeId === undefined,
      description: item.description,
      snippet: item.snippet,
      question: plan.question,
    });
    if (result.ok !== true) {
      failed.push({ itemId: item.id, message: result.error?.message ?? "写入失败" });
      continue;
    }
    const entry = { itemId: item.id, nodeId: result.added?.node?.id, title: item.title };
    if (result.added?.created === true) created.push(entry);
    else reused.push(entry);
  }
  plan.applied = { at: Date.now(), created, reused, failed };
  await savePlan(root, plan);
  return { ok: true, plan };
}

/**
 * 撤销一次落地：把这次**新建**出来的节点**移除身份**（`.meta/knowledgenet` 进回收站，用户文件保留）。
 *
 * 复用的节点不动（只解关系这件事这里不做：关系的移除有单独的入口，避免误删用户既有结构）。
 *
 * @param context - 已装载的库上下文。
 * @param root - 库根。
 * @param input - 计划 id。
 * @returns 成功/失败；成功时带上更新后的计划。
 */
export async function undoPlanFromUi(
  context: LibraryContext,
  root: string,
  input: { planId: string },
): Promise<UiEditResult & { plan?: Plan; undone?: number }> {
  const plan = await readPlan(root, input.planId);
  if (plan === null) {
    return { ok: false, error: { code: "plan_unknown", message: "找不到这份提案" } };
  }
  const applied = plan.applied;
  if (applied === undefined || applied === null) {
    return { ok: false, error: { code: "not_applied", message: "这份提案还没落地，没有可撤销的内容" } };
  }
  let undone = 0;
  const failed: Array<{ itemId: string; message: string }> = [];
  for (const entry of applied.created) {
    if (entry.nodeId === undefined) continue;
    const result = await removeNodeFromUi(context, { nodeId: entry.nodeId });
    if (result.ok === true) undone += 1;
    else failed.push({ itemId: entry.itemId, message: result.error?.message ?? "移除失败" });
  }
  plan.applied = { at: applied.at, created: [], reused: applied.reused, failed: [...applied.failed, ...failed] };
  await savePlan(root, plan);
  return { ok: true, plan, undone };
}
