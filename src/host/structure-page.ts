/** Serialize metadata-only graph pages under node, edge and complete JSON character budgets. */
export function structurePage<N, E>(options: {
  nodes: readonly N[]; edges: readonly E[]; offset: number; edgeOffset: number;
  maxNodes: number; maxEdges: number; maxChars: number; library: object; revision: string | number;
}) {
  const { nodes, edges, offset, edgeOffset, maxNodes, maxEdges, maxChars } = options;
  const selectedNodes: N[] = []; const selectedEdges: E[] = [];
  const result = () => ({
    ok: true, mode: "overview", library: options.library, revision: options.revision,
    nodes: selectedNodes, edges: selectedEdges,
    counts: { nodes: nodes.length, edges: edges.length }, offset, edgeOffset,
    nextOffset: offset + selectedNodes.length < nodes.length ? offset + selectedNodes.length : null,
    nextEdgeOffset: edgeOffset + selectedEdges.length < edges.length ? edgeOffset + selectedEdges.length : null,
    truncated: offset > 0 || edgeOffset > 0 || offset + selectedNodes.length < nodes.length || edgeOffset + selectedEdges.length < edges.length,
    pagingNote: "节点和边独立分页。续读时用 nextOffset / nextEdgeOffset；已完成的一侧使用 counts 中的总数。只有两侧从零完整读取，才是全库结构。结构不含正文。",
  });
  const fits = () => JSON.stringify(result()).length <= maxChars;
  if (!fits()) return { ok: false, error: { code: "structure_budget_too_small", message: "结构字符预算不足以容纳分页信息，请增加 structureMaxChars。" } };
  // Alternate records so a wide node page cannot permanently starve relationship pagination.
  let nodeBlocked = false; let edgeBlocked = false;
  while (true) {
    let added = false;
    if (!nodeBlocked && selectedNodes.length < maxNodes && offset + selectedNodes.length < nodes.length) {
      selectedNodes.push(nodes[offset + selectedNodes.length]);
      if (!fits()) { selectedNodes.pop(); nodeBlocked = true; } else added = true;
    }
    if (!edgeBlocked && selectedEdges.length < maxEdges && edgeOffset + selectedEdges.length < edges.length) {
      selectedEdges.push(edges[edgeOffset + selectedEdges.length]);
      if (!fits()) { selectedEdges.pop(); edgeBlocked = true; } else added = true;
    }
    if (!added) break;
  }
  if ((!selectedNodes.length && offset < nodes.length) || (!selectedEdges.length && edgeOffset < edges.length)) {
    // A caller can finish the other stream first; impossible records must fail instead of looping.
    if (!selectedNodes.length && !selectedEdges.length) return { ok: false, error: { code: "structure_record_too_large", message: "单条结构记录超出字符预算，请增加 structureMaxChars 或使用搜索和局部查询。" } };
  }
  return result();
}
