/**
 * `kn_read_node` 的卡片：元数据 + 前置/后继 + 依赖说明 + 正文摘录。
 *
 * 全部数据来自工具结果本身（会话日志），客户端不读磁盘 —— 与图谱卡片同一条通道。
 */
import { useMemo } from "react";

import { makeTranslator, nodeCardModel, parseToolResult, type NodeRef } from "./card-model.ts";
import { ShadowPanel } from "./shadow.tsx";

const LITERAL: Record<string, string> = {
  hasEvidence: "有出处",
  loading: "正在读取知识点…",
  unreadable: "这条工具结果不是可读的知识点数据。",
  failed: "读取知识点失败",
  prerequisites: "它的前置知识",
  dependents: "依赖它的地方",
  relations: "依赖说明与来源",
  none: "（暂无）",
  note: "正文摘录",
  truncated: "（已截断）",
  resources: "资料",
};

function chips(refs: NodeRef[], t: (key: string) => string) {
  if (refs.length === 0) return <span className="kn-dim">{t("none")}</span>;
  return (
    <span className="kn-chips">
      {refs.map((ref) => (
        <span key={ref.id === "" ? ref.title : ref.id} className="kn-chip">
          {ref.status === undefined ? ref.title : `${ref.title} · ${ref.status}`}
        </span>
      ))}
    </span>
  );
}

export function NodeCard(props: { phase?: string; block?: Parameters<typeof parseToolResult>[0]; t?: unknown }) {
  // t 固化：makeTranslator 每次返回新函数，放进依赖会引发重复效应（同类坑见 GraphPanel）
  const t = useMemo(() => makeTranslator(props.t, LITERAL), [props.t]);
  const parsed = useMemo(() => parseToolResult(props.block), [props.block]);

  if (props.phase !== "result") return <div className="kn-simple">{t("loading")}</div>;
  if (!parsed.ok) {
    const detail = parsed.error === undefined ? t("unreadable") : `${parsed.error.code}: ${parsed.error.message}`;
    return <div className="kn-simple kn-error">{t("failed")} — {detail}</div>;
  }

  const model = nodeCardModel(parsed.data);
  return (
    <ShadowPanel height={null}>
      <div className="kn-head">
        <span className="kn-head-title">{model.title}</span>
        <span className="kn-head-meta">{model.path}{model.status === "" ? "" : ` · ${model.status}`}</span>
      </div>
      <div className="kn-body">
        <div className="kn-sect">
          <span className="kn-sect-title">{t("prerequisites")}</span>
          {chips(model.prerequisites, t)}
        </div>
        <div className="kn-sect">
          <span className="kn-sect-title">{t("dependents")}</span>
          {chips(model.dependents, t)}
        </div>
        {model.relations.length > 0 ? (
          <div className="kn-sect">
            <span className="kn-sect-title">{t("relations")}</span>
            <ul className="kn-list">
              {model.relations.map((relation) => (
                <li key={`${relation.title}-${relation.description}`}>
                  <span className="kn-arrow">→</span> {relation.title}
                  {relation.description === "" ? null : <span className="kn-dim">：{relation.description}</span>}
                  {relation.hasEvidence ? <span className="kn-tag">{t("hasEvidence")}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {model.resources.length > 0 ? (
          <div className="kn-sect">
            <span className="kn-sect-title">{t("resources")}</span>
            <span className="kn-chips">
              {model.resources.map((resource) => (
                <span key={`${resource.title}-${resource.type}`} className="kn-chip">
                  {resource.title} · {resource.type}
                </span>
              ))}
            </span>
          </div>
        ) : null}
        {model.noteText === "" ? null : (
          <div className="kn-sect">
            <span className="kn-sect-title">
              {t("note")}
              {model.noteTruncated ? ` ${t("truncated")}` : ""}
            </span>
            <pre className="kn-note">{model.noteText}</pre>
          </div>
        )}
      </div>
    </ShadowPanel>
  );
}
