/**
 * `kn_list_graph` 的工具卡片：把工具结果里那张图直接画出来。
 *
 * 数据通道（本方案的关键约束）：客户端半读不到磁盘，也没有 `host.call`；
 * 因此图**必须**来自会话日志里的工具结果 —— 这正是这里解析 `block.content[0].text`
 * 的原因：模型看到的那段 JSON，就是界面画的东西，两者不会说两套话。
 *
 * 组件只依赖标准 owner props（phase/block）与 `t`（locale 缺失时回落到字面文案）。
 */
import { useMemo, useState } from "react";
import type { GraphSnapshot } from "../vendor/upstream/data/types.ts";
import { GraphSpace } from "../vendor/upstream/components/GraphSpace.tsx";
import { makeTranslator, parseToolResult, type ToolResultBlock } from "./card-model.ts";
import { ShadowPanel } from "./shadow.tsx";

export interface GraphCardProps {
  phase?: string;
  block?: ToolResultBlock;
  t?: (key: string) => string;
}

interface GraphPayload {
  ok?: boolean;
  error?: { code?: string; message?: string };
  library?: { root?: string; name?: string };
  focusId?: string | null;
  goals?: GraphSnapshot["goals"];
  nodes?: GraphSnapshot["nodes"];
  edges?: GraphSnapshot["edges"];
  counts?: { nodes?: number; edges?: number; issues?: number };
  truncated?: boolean;
  revision?: number;
}

const LITERAL: Record<string, string> = {
  title: "知识库图谱",
  loading: "正在读取知识库…",
  unreadable: "这条工具结果不是可解析的知识库图数据。",
  failed: "读取知识库失败",
  hint: "点击卡片可切换聚焦节点",
  counts: "节点 {n} · 依赖 {e}",
  truncated: "（已截断显示）",
  noNodes: "这个知识库里还没有知识点。",
};

export function GraphCard(props: GraphCardProps) {
  // t 固化：makeTranslator 每次返回新函数，放进依赖会引发重复效应（同类坑见 GraphPanel）
  const t = useMemo(() => makeTranslator(props.t, LITERAL), [props.t]);
  const parsed = useMemo(() => parseToolResult(props.block), [props.block]);
  const data = parsed.ok ? (parsed.data as GraphPayload) : null;

  const [focusId, setFocusId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);

  const graph = useMemo<GraphSnapshot | null>(() => {
    if (data === null) return null;
    return {
      revision: typeof data.revision === "number" ? data.revision : 0,
      nodes: data.nodes ?? [],
      edges: data.edges ?? [],
      goals: data.goals ?? [],
      session: null,
    };
  }, [data]);

  if (props.phase !== "result") {
    return <div className="kn-simple">{t("loading")}</div>;
  }
  if (data === null || graph === null) {
    const isFailure = parsed.error !== undefined && parsed.error.code !== "unreadable";
    const message = isFailure
      ? `${parsed.error?.code ?? "error"}: ${parsed.error?.message ?? ""}`
      : t("unreadable");
    return (
      <div className={`kn-simple${isFailure ? " kn-error" : ""}`}>
        {isFailure ? `${t("failed")} — ${message}` : message}
      </div>
    );
  }

  const effectiveFocus = focusId ?? data.focusId ?? null;
  const nodeCount = data.counts?.nodes ?? graph.nodes.length;
  const edgeCount = data.counts?.edges ?? graph.edges.length;

  return (
    <ShadowPanel height={460}>
      <div className="kn-head">
        <span className="kn-head-title">{t("title")}</span>
        <span className="kn-head-meta">
          {t("counts", { n: nodeCount, e: edgeCount })}
          {data.truncated === true ? ` ${t("truncated")}` : ""}
        </span>
        {graph.nodes.length > 1 ? <span className="kn-head-hint">{t("hint")}</span> : null}
      </div>
      <div className="kn-graph">
        {graph.nodes.length === 0 ? (
          <div className="kn-msg">{t("noNodes")}</div>
        ) : (
          <GraphSpace
            graph={graph}
            rootId={data.focusId ?? null}
            focusId={effectiveFocus}
            onEnter={(id: string) => setFocusId(id)}
            view={{ zoom, onZoomChange: setZoom }}
          />
        )}
      </div>
    </ShadowPanel>
  );
}
