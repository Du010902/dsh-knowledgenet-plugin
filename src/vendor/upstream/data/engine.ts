/**
 * 知识图纯算法层
 *
 * 便携知识库重构后，前端不再提交整库快照：
 * - 节点、关系、目标的写入走 Rust 的细粒度命令，**ID 由 Rust 发号（UUIDv7）**；
 * - 笔记正文在 `nodes/<id>/note.md`，按需读写，绝不随图快照载入；
 * - 修订号由后端维护，写入命令返回新值。
 *
 * 所以这个文件只保留两类东西：
 *
 * 1. **纯查询算法**：前置/后继、精确匹配、相似候选、成环检测。界面用它做即时提示，
 *    测试用它锁住业务规则，两种用法共享同一份实现；
 * 2. **纯规划器** `planPrerequisites` / `planMerge`：先把「这样做会发生什么」算出来，
 *    交给界面即时反馈。真正的落地由 Rust 在同一事务里完成——这里的计划只是预览，
 *    不会被当作持久化输入（前端算出的 ID 也不再有任何权威性）。
 *
 * 约定：边 A → B 表示「为了理解 A，需要先理解 B」，
 * 因此入边 = 前置知识，出边 = 用到它的地方。
 */
import { RepositoryError } from "./errors.ts";
import type {
  AddResult,
  DependencyEdge,
  DroppedEdgeRef,
  Goal,
  GraphSnapshot,
  KnowledgeNode,
  LearnStatus,
} from "./types.ts";
import { normalizeTitle, searchKey } from "./types.ts";

/**
 * 只读图视图：算法只需要节点、关系与目标，不关心修订号和会话。
 * （完整的 `GraphSnapshot` 可以直接传进来。）
 */
export type GraphView = Pick<GraphSnapshot, "nodes" | "edges" | "goals">;

/* ---------------------------------- 基础工具 --------------------------------- */

export function nodeMap(ws: GraphView): Map<string, KnowledgeNode> {
  return new Map(ws.nodes.map((n) => [n.id, n]));
}

export function edgeMap(ws: GraphView): Map<string, DependencyEdge> {
  return new Map(ws.edges.map((e) => [e.id, e]));
}

export function nodesByIds(ws: GraphView, ids: string[]): KnowledgeNode[] {
  const m = nodeMap(ws);
  const out: KnowledgeNode[] = [];
  for (const id of ids) {
    const n = m.get(id);
    if (n) out.push(n);
  }
  return out;
}

export function titleOf(ws: GraphView, id: string): string {
  return nodeMap(ws).get(id)?.title ?? "(已删除)";
}

/** 某个节点的前置知识（入边），即「要理解它，得先理解谁」 */
export function prerequisitesOf(ws: GraphView, nodeId: string): KnowledgeNode[] {
  const ids = ws.edges.filter((e) => e.fromId === nodeId).map((e) => e.toId);
  return nodesByIds(ws, ids);
}

/** 某个节点被谁依赖（出边），即「理解它之后，可以回去搞懂谁」 */
export function dependentsOf(ws: GraphView, nodeId: string): KnowledgeNode[] {
  const ids = ws.edges.filter((e) => e.toId === nodeId).map((e) => e.fromId);
  return nodesByIds(ws, ids);
}

export function edgeBetween(
  ws: GraphView,
  fromId: string,
  toId: string,
): DependencyEdge | undefined {
  return ws.edges.find((e) => e.fromId === fromId && e.toId === toId);
}

/** 节点被引用次数（入边 + 出边），用于提示「这个知识点有几处在用」 */
export function referenceCount(ws: GraphView, nodeId: string): number {
  let n = 0;
  for (const e of ws.edges) if (e.fromId === nodeId || e.toId === nodeId) n++;
  return n;
}

/* ------------------------------- 搜索 / 复用 -------------------------------- */

/**
 * 搜索已有知识点。保留中文、英文、缩写与数学符号，不做激进的规范化，
 * 避免把「相关性」和「互相关」这类不同概念错误地当成同一个。
 *
 * 便携知识库的图快照里没有正文，因此搜索只覆盖标题与别名；
 * 正文检索属于后续的 FTS5 索引（本轮不做）。
 */
export function searchNodes(ws: GraphView, query: string, limit = 12): KnowledgeNode[] {
  const q = searchKey(query);
  if (!q) return [];
  const scored: Array<{ n: KnowledgeNode; score: number }> = [];
  for (const n of ws.nodes) {
    const title = searchKey(n.title);
    if (title === q) {
      scored.push({ n, score: 0 });
      continue;
    }
    if (n.aliases.some((a) => searchKey(a) === q)) {
      scored.push({ n, score: 1 });
      continue;
    }
    if (title.startsWith(q)) {
      scored.push({ n, score: 2 });
      continue;
    }
    if (title.includes(q)) {
      scored.push({ n, score: 3 });
      continue;
    }
    if (n.aliases.some((a) => searchKey(a).includes(q))) {
      scored.push({ n, score: 4 });
    }
  }
  scored.sort((a, b) => a.score - b.score || a.n.title.length - b.n.title.length);
  return scored.slice(0, limit).map((s) => s.n);
}

/** 精确命中已有节点（标题或别名完全一致）——这是「复用」而不是「新建」的判据 */
export function findExactMatch(ws: GraphView, title: string): KnowledgeNode | undefined {
  const q = searchKey(title);
  if (!q) return undefined;
  return ws.nodes.find(
    (n) => searchKey(n.title) === q || n.aliases.some((a) => searchKey(a) === q),
  );
}

/** 输入时的相似候选提示（弱匹配，交由使用者判断是否同一个知识点） */
export function findSimilar(ws: GraphView, title: string, limit = 5): KnowledgeNode[] {
  const q = searchKey(title);
  if (q.length < 2) return [];
  return searchNodes(ws, title, limit * 2)
    .filter((n) => searchKey(n.title) !== q)
    .slice(0, limit);
}

/* ------------------------------- 循环依赖检测 ------------------------------- */

/**
 * 判断新增边 from → to 是否会造成循环：沿 to 出发能否走回 from。
 * 返回造成循环的路径（不含新增边的起点），无循环返回 null。
 *
 * 后端会拒绝成环的写入；这里先算一遍是为了让界面在用户点击之前就能提示。
 */
export function findCycleIfLinked(
  ws: GraphView,
  fromId: string,
  toId: string,
): string[] | null {
  if (fromId === toId) return [fromId, toId];

  const out = new Map<string, string[]>();
  for (const e of ws.edges) {
    const list = out.get(e.fromId);
    if (list) list.push(e.toId);
    else out.set(e.fromId, [e.toId]);
  }

  const prev = new Map<string, string>();
  const queue: string[] = [toId];
  const seen = new Set<string>([toId]);

  while (queue.length > 0) {
    const cur = queue.shift() as string;
    if (cur === fromId) {
      const path = [fromId];
      let step = fromId;
      while (step !== toId) {
        step = prev.get(step) as string;
        path.push(step);
      }
      return path.reverse();
    }
    for (const next of out.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        prev.set(next, cur);
        queue.push(next);
      }
    }
  }
  return null;
}

/** 检测整张图中已存在的循环（用于提示，不阻止保存） */
export function findAllCycles(ws: GraphView): string[][] {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const out = new Map<string, string[]>();
  for (const e of ws.edges) {
    const list = out.get(e.fromId);
    if (list) list.push(e.toId);
    else out.set(e.fromId, [e.toId]);
  }

  const visit = (id: string) => {
    state.set(id, 1);
    stack.push(id);
    for (const next of out.get(id) ?? []) {
      const s = state.get(next) ?? 0;
      if (s === 1) {
        const at = stack.indexOf(next);
        cycles.push(stack.slice(at).concat(next));
      } else if (s === 0) {
        visit(next);
      }
    }
    stack.pop();
    state.set(id, 2);
  };

  for (const n of ws.nodes) {
    if ((state.get(n.id) ?? 0) === 0) visit(n.id);
  }
  return cycles;
}

/* ----------------------------- 批量新增前置知识（规划） ----------------------------- */

/**
 * 一项输入解析后的归属：
 * - `existing`：命中已有节点，只新增关系；
 * - `new`：需要新建节点（ID 由 Rust 发号）；
 * - `duplicate`：同一批次里重复输入，复用本批次即将新建的那个节点。
 */
export type PlannedPrerequisite =
  | { title: string; kind: "existing"; node: KnowledgeNode }
  | { title: string; kind: "new" }
  | { title: string; kind: "duplicate" };

/** 需要新增的关系：`toId` 为 null 表示目标节点是新节点，落地后由 Rust 补齐 ID */
export interface PlannedEdge {
  fromId: string;
  toId: string | null;
  title: string;
}

export interface PrerequisitePlan {
  parentId: string;
  /** 按输入顺序解析出的项（空标题被跳过，重复输入各占一项） */
  items: PlannedPrerequisite[];
  /** 真正需要新建的标题（同一批次重复只留一个，顺序为首次出现顺序） */
  createdTitles: string[];
  /** 命中的已有节点，按输入顺序排列；重复输入会重复出现（表示复用了多次） */
  reused: KnowledgeNode[];
  /** 需要新增的关系（已去掉父节点上已存在的那条） */
  newEdges: PlannedEdge[];
}

/**
 * 规划「给 parentId 批量新增前置知识」。
 *
 * 语义与后端 `add_prerequisites` 保持一致：
 * - 标题（或别名）完全一致就复用，不新建节点；同一批次里的重复输入只建一个节点；
 * - 整批是一个原子操作：任何一项会造成循环就整体拒绝（`ok: false`）；
 * - 空标题被忽略；父节点上已有的关系不重复添加。
 */
export function planPrerequisites(
  ws: GraphView,
  parentId: string,
  titles: string[],
): AddResult<PrerequisitePlan> {
  if (!nodeMap(ws).has(parentId)) {
    throw new RepositoryError("not_found", `节点不存在：${parentId}`);
  }

  const items: PlannedPrerequisite[] = [];
  const createdTitles: string[] = [];
  const reused: KnowledgeNode[] = [];
  const newEdges: PlannedEdge[] = [];
  const newTitleKeys = new Map<string, string>();
  let placeholderSeq = 0;

  // 影子图：逐项把自己的新增内容算进去，后面的项才能在「同批次已建节点」上判断循环
  const shadowNodes: KnowledgeNode[] = [...ws.nodes];
  const shadowEdges: DependencyEdge[] = [...ws.edges];

  for (const raw of titles) {
    const title = normalizeTitle(raw);
    if (!title) continue;
    const key = searchKey(title);
    const now = Date.now();

    let targetId: string;
    let planned: PlannedPrerequisite;
    const placeholder = newTitleKeys.get(key);
    if (placeholder) {
      // 同一批次里重复输入：复用本批次的待建项，不再多建一个节点。
      // 必须放在精确匹配之前：占位节点没有真实 ID，不能泄漏给界面当成已有节点。
      targetId = placeholder;
      planned = { title, kind: "duplicate" };
    } else {
      const existing = findExactMatch(
        { nodes: shadowNodes, edges: shadowEdges, goals: ws.goals },
        title,
      );
      if (existing) {
        targetId = existing.id;
        planned = { title, kind: "existing", node: existing };
        reused.push(existing);
      } else {
        targetId = `pending:${placeholderSeq}`;
        placeholderSeq += 1;
        newTitleKeys.set(key, targetId);
        createdTitles.push(title);
        shadowNodes.push(pendingNode(targetId, title));
        planned = { title, kind: "new" };
      }
    }

    const cycle = findCycleIfLinked(
      { nodes: shadowNodes, edges: shadowEdges, goals: ws.goals },
      parentId,
      targetId,
    );
    if (cycle) {
      // 循环链路读作「新增边 → 已有路径」：parentId → … → parentId
      return { ok: false, reason: "cycle", cycle: [parentId, ...cycle] };
    }

    items.push(planned);
    if (!edgeBetween({ nodes: shadowNodes, edges: shadowEdges, goals: ws.goals }, parentId, targetId)) {
      const edge: DependencyEdge = {
        id: `pending:edge:${shadowEdges.length}`,
        fromId: parentId,
        toId: targetId,
        relation: "",
        relationType: "prerequisite",
        createdAt: now,
        updatedAt: now,
      };
      shadowEdges.push(edge);
      newEdges.push({
        fromId: parentId,
        toId: planned.kind === "existing" ? targetId : null,
        title,
      });
    }
  }

  return { ok: true, value: { parentId, items, createdTitles, reused, newEdges } };
}

/** 规划用的占位节点：只有标题，ID 永远留在前端，不会写进知识库 */
function pendingNode(id: string, title: string): KnowledgeNode {
  return {
    id,
    title,
    aliases: [],
    status: "todo",
    createdAt: 0,
    updatedAt: 0,
    // 占位节点没有磁盘位置：位置与健康状态等真正落盘后由扫描给出
    relativePath: "",
    folderName: "",
    health: "ok",
    revision: 0,
    localMutation: true,
  };
}

/* -------------------------------- 合并重复节点（规划） -------------------------------- */

export interface MergePlan {
  sourceNodeId: string;
  targetNodeId: string;
  /** 合并后的目标节点元数据（别名、状态、更新时间）；正文合并由 Rust 追加段落 */
  target: KnowledgeNode;
  removedNodeId: string;
  /** 因源节点被删除而改接到目标的关系 */
  movedEdges: DependencyEdge[];
  /** 因重复或自环而丢弃的关系，附带改挂目标（自环没有替代边） */
  droppedEdges: DroppedEdgeRef[];
  goalsRepointed: Goal[];
  /** 合并后的完整图（不含会话与修订号），界面可即时预览，演示后端可直接落库 */
  graph: { nodes: KnowledgeNode[]; edges: DependencyEdge[]; goals: Goal[] };
}

/**
 * 规划把 sourceId 合并进 targetId。
 *
 * 规则与后端 `merge_nodes` 一致，只是这里不碰文件与数据库：
 * - 源节点的全部关系改接到目标；因此产生的重复边被去重，说明并列保留；
 * - 自环被丢弃，并明确标记「没有替代边」，方便调用方把挂在它上面的来源断开而不是改挂；
 * - 源标题进入目标别名，学习状态取更靠后的一个，目标标题跟随根节点的规则不在前端做；
 * - **可能形成循环时整体不落地**（返回 ok: false）：合并不能绕过循环依赖检查，
 *   否则把 A 合并进 C 可以得到 C→B→C 这样的环。
 */
export function planMerge(
  ws: GraphView,
  sourceId: string,
  targetId: string,
): AddResult<MergePlan> {
  if (sourceId === targetId) {
    throw new RepositoryError("invalid_input", "不能把节点合并到自身");
  }
  const byId = nodeMap(ws);
  const source = byId.get(sourceId);
  const target = byId.get(targetId);
  if (!source || !target) {
    throw new RepositoryError("not_found", "待合并的节点不存在");
  }

  const movedEdges: DependencyEdge[] = [];
  const droppedEdges: DroppedEdgeRef[] = [];
  const now = Date.now();
  const touchesSource = (e: DependencyEdge) => e.fromId === sourceId || e.toId === sourceId;

  /*
   * 全部用副本：保留边可能因为与被丢弃的边重复而并入对方的关系说明，
   * 直接改原对象会污染调用方手里的快照。
   */
  const keptEdges: DependencyEdge[] = [];
  const indexByPair = new Map<string, number>();
  for (const e of ws.edges) {
    if (touchesSource(e)) continue;
    indexByPair.set(`${e.fromId}->${e.toId}`, keptEdges.length);
    keptEdges.push({ ...e });
  }

  for (const e of ws.edges) {
    if (!touchesSource(e)) continue;
    const fromId = e.fromId === sourceId ? targetId : e.fromId;
    const toId = e.toId === sourceId ? targetId : e.toId;
    if (fromId === toId) {
      // 自环：没有对应的边可以接手，来源在持久层改挂为「无依赖边」
      droppedEdges.push({ droppedEdgeId: e.id, replacementEdgeId: null });
      continue;
    }

    const key = `${fromId}->${toId}`;
    const at = indexByPair.get(key);
    if (at !== undefined) {
      const kept = keptEdges[at] as DependencyEdge;
      // 去重不能连关系说明一起丢掉：两边都写过说明时并列保留
      keptEdges[at] = {
        ...kept,
        relation: mergeRelationText(kept.relation, e.relation),
        updatedAt: now,
      };
      droppedEdges.push({ droppedEdgeId: e.id, replacementEdgeId: kept.id });
      continue;
    }

    /*
     * 循环检查：把这条改接后的边加进影子图之前，先确认它不会形成环。
     * 逐条加入并逐条检查，等价于检查合并后的整张图——最终图里每一个环，
     * 都是在加入它的最后一条边时被发现的。
     */
    const cycle = findCycleIfLinked(
      { nodes: ws.nodes, edges: keptEdges, goals: ws.goals },
      fromId,
      toId,
    );
    if (cycle) return { ok: false, reason: "cycle", cycle: [fromId, ...cycle] };

    const moved: DependencyEdge = { ...e, fromId, toId, updatedAt: now };
    indexByPair.set(key, keptEdges.length);
    keptEdges.push(moved);
    movedEdges.push(moved);
  }

  const aliases = Array.from(
    new Set([...target.aliases, source.title, ...source.aliases].map(normalizeTitle)),
  ).filter((a) => a && searchKey(a) !== searchKey(target.title));

  const mergedTarget: KnowledgeNode = {
    ...target,
    aliases,
    status: pickStatus(target.status, source.status),
    updatedAt: now,
  };

  const goalsRepointed: Goal[] = [];
  const goals = ws.goals.map((g) => {
    if (g.rootNodeId !== sourceId) return g;
    const next = { ...g, rootNodeId: targetId };
    goalsRepointed.push(next);
    return next;
  });

  const nodes = ws.nodes
    .filter((n) => n.id !== sourceId)
    .map((n) => (n.id === targetId ? mergedTarget : n));

  return {
    ok: true,
    value: {
      sourceNodeId: sourceId,
      targetNodeId: targetId,
      target: mergedTarget,
      removedNodeId: sourceId,
      movedEdges,
      droppedEdges,
      goalsRepointed,
      graph: { nodes, edges: keptEdges, goals },
    },
  };
}

/** 合并两个学习状态时取「更靠后」的一个，避免把已理解退回未开始 */
function pickStatus(a: LearnStatus, b: LearnStatus): LearnStatus {
  const rank: Record<LearnStatus, number> = { todo: 0, learning: 1, done: 2 };
  return rank[a] >= rank[b] ? a : b;
}

/**
 * 合并两条重复边的关系说明。
 *
 * 两边都写了说明时不能只留一条：它们描述的是同一对节点，都是当初写下的
 * 「为什么需要它」，丢掉哪一句都是使用者自己的信息损失。
 */
function mergeRelationText(a: string, b: string): string {
  const left = a.trim();
  const right = b.trim();
  if (!left) return b;
  if (!right) return a;
  return `${left}；${right}`;
}
