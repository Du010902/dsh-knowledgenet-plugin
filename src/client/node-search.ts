/**
 * 面板搜索框的**模糊匹配**：给一个关键词，挑出"匹配度最高"的那个知识点。
 *
 * 为什么单独一个纯模块：匹配规则（精确 / 前缀 / 包含 / 子序列 / 容一个错字）与打分都是**可测的逻辑**，
 * 而面板组件里混着 Shadow DOM、React、宿主取数 —— 放在那边就只能靠肉眼看 ✓。
 *
 * 打分梯度（同一档内再按"越紧凑越靠前"微调）：
 * | 情况 | 分数 |
 * |---|---|
 * | 完全相等 | 1000 |
 * | 目标以关键词开头 | 900 − 长度差 |
 * | 目标包含关键词 | 800 − 位置/长度惩罚 |
 * | 关键词是目标的**子序列**（跳过若干字） | 400~600，越紧凑越高 |
 * | 关键词与目标某个等长窗口只差 1–2 个字（打错字） | 300 − 距离惩罚 |
 * | 其余 | 0（不匹配） |
 *
 * 另外：**别名**也算命中（`aliases: [Attention, 注意机制]` 这种），但同分时标题优先 ✓。
 */

/** 可参与搜索的节点（面板载荷里 `NodeSummary` 的子集，多了也能收） */
export interface SearchableNode {
  id: string;
  title: string;
  aliases?: readonly string[];
}

/** 命中结果 */
export interface NodeMatch<T extends SearchableNode> {
  node: T;
  score: number;
  /** 命中的那段文字（标题或某个别名），用于给用户提示"匹配到了什么" */
  matched: string;
  /** 命中的是标题还是别名 */
  via: "title" | "alias";
}

/** 归一化：小写、去首尾空白、把连续空白压成一个空格 */
export function normalizeQuery(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** 标准编辑距离（只用于短窗口比较，长度都很小） */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = new Array<number>(cols);
  let next = new Array<number>(cols);
  for (let j = 0; j < cols; j += 1) prev[j] = j;
  for (let i = 1; i < rows; i += 1) {
    next[0] = i;
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      next[j] = Math.min(prev[j]! + 1, next[j - 1]! + 1, prev[j - 1]! + cost);
    }
    const swap = prev;
    prev = next;
    next = swap;
  }
  return prev[cols - 1]!;
}

/** 关键词是不是目标的子序列（按顺序、可以跳过若干字），是的话返回"紧凑度"0~1 */
function subsequenceCompactness(query: string, target: string): number {
  let cursor = 0;
  let gaps = 0;
  let lastHit = -1;
  for (let i = 0; i < query.length; i += 1) {
    const at = target.indexOf(query[i]!, cursor);
    if (at < 0) return 0;
    if (lastHit >= 0) gaps += at - lastHit - 1;
    lastHit = at;
    cursor = at + 1;
  }
  const span = lastHit + 1;
  if (span === 0) return 0;
  /* 覆盖率（命中的字占这一段的多少）× 位置权重（越靠前越好） */
  const coverage = query.length / span;
  const position = 1 - Math.min(1, lastHit / Math.max(1, target.length));
  return Math.max(0, coverage * 0.8 + position * 0.2 - Math.min(0.5, gaps * 0.02));
}

/**
 * 打一个目标字符串的分。
 * @param query - 已归一化的关键词（空串直接 0）。
 * @param target - 原始目标文字（内部会归一化）。
 * @returns 分数；0 表示不匹配。
 */
export function scoreTarget(query: string, target: string): number {
  const q = normalizeQuery(query);
  const t = normalizeQuery(target);
  if (q === "" || t === "") return 0;
  if (q === t) return 1000;

  /* 前缀 / 包含：越紧凑、越靠前越高 */
  if (t.startsWith(q)) return 900 - Math.min(80, t.length - q.length);
  const at = t.indexOf(q);
  if (at >= 0) return 800 - Math.min(120, at * 4 + (t.length - q.length));

  /* 子序列（中文里"注意机"→"注意力机制"这种跳字输入） */
  const compact = subsequenceCompactness(q, t);
  if (compact > 0) {
    /* 短查询靠子序列匹配太容易误命中（"的"能匹配一大片）⇒ 关键词至少 2 个字才算 */
    if (q.length >= 2) return 400 + Math.round(compact * 200);
  }

  /*
   * 容错：关键词与目标里的某个等长窗口只差 1~2 个字（打错字/多一个字）。
   * 只在关键词够长时启用（≥3 字，且 ≥6 字才允许差 2 个），否则会到处乱命中 ✓。
   */
  if (q.length >= 3) {
    const allowance = q.length >= 6 ? 2 : 1;
    let best = Number.POSITIVE_INFINITY;
    for (const size of [q.length - 1, q.length, q.length + 1]) {
      if (size <= 0) continue;
      for (let start = 0; start + size <= t.length; start += 1) {
        const distance = editDistance(q, t.slice(start, start + size));
        if (distance < best) best = distance;
        if (best === 0) break;
      }
      if (best === 0) break;
    }
    if (best <= allowance) return 300 - best * 40;
  }
  return 0;
}

/**
 * 在一批节点里挑"匹配度最高"的那个。
 *
 * 每个节点取 **标题与别名里的最高分**（别名命中扣 5 分，保证同分时标题优先 ✓）；
 * 全部为 0 时返回 `null`（调用方据此提示"没有匹配的节点"）。
 *
 * 同分时的排序键（保证**确定性**，同一份数据每次结果一样）：
 * ① 分数高者胜；② 标题短者胜（更具体）；③ 标题字典序；④ id。
 *
 * @param nodes - 候选节点（面板载荷里的 `nodes`）。
 * @param query - 用户输入（可为空 ⇒ 返回 null）。
 * @returns 命中结果，或 null。
 */
export function pickBestNode<T extends SearchableNode>(nodes: readonly T[], query: string): NodeMatch<T> | null {
  return rankNodes(nodes, query, 1)[0] ?? null;
}

/**
 * 把**所有**命中的节点按匹配度排好序返回（面板据此列出候选，让用户自己挑 ✓）。
 *
 * 为什么需要它（用户反馈 2026-10）：查询「车」时"回车""回车聚焦"都命中，
 * 而界面**替用户选了一个**并直接把镜头飞过去 ✗ —— 用户原话是"我们不应该替用户做决定"。
 * 所以界面改成**列候选**；这个函数就是那份候选列表的来源。
 *
 * @param nodes - 候选节点。
 * @param query - 用户输入（空 ⇒ 返回空数组）。
 * @param limit - 最多返回几条（默认 8；界面一般只展示前几条）。
 * @returns 按分数降序的命中列表（无命中 ⇒ 空数组）。
 */
export function rankNodes<T extends SearchableNode>(
  nodes: readonly T[],
  query: string,
  limit = 8,
): Array<NodeMatch<T>> {
  const q = normalizeQuery(query);
  if (q === "" || nodes.length === 0 || limit <= 0) return [];
  const hits: Array<NodeMatch<T>> = [];
  for (const node of nodes) {
    const titleScore = scoreTarget(q, node.title);
    let score = titleScore;
    let matched = node.title;
    let via: "title" | "alias" = "title";
    for (const alias of node.aliases ?? []) {
      const aliasScore = scoreTarget(q, alias) - 5;
      if (aliasScore > score) {
        score = aliasScore;
        matched = alias;
        via = "alias";
      }
    }
    if (score > 0) hits.push({ node, score, matched, via });
  }
  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.node.title.length !== b.node.title.length) return a.node.title.length - b.node.title.length;
    if (a.node.title !== b.node.title) return a.node.title < b.node.title ? -1 : 1;
    return a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0;
  });
  return hits.slice(0, limit);
}
