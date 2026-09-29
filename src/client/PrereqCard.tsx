/**
 * `kn_add_prerequisite` 的卡片：把「谁学到了什么、连上了什么」当场显示在对话里。
 *
 * 这也是「从回答里划词建前置」的可视结果：用户说完需求，模型调用工具，
 * 卡片就给出 A → B、是否新建、是否记下了出处；命中相近候选时显示候选并说明
 * 需要用户确认（不会擅自建重复节点）；成环/冲突则给出可读原因。
 */
import { useMemo } from "react";

import { makeTranslator, nodeLine, parseToolResult, prereqCardModel } from "./card-model.ts";
import { ShadowPanel } from "./shadow.tsx";

const LITERAL: Record<string, string> = {
  loading: "正在写入知识库…",
  unreadable: "这条工具结果不是可读的写入回执。",
  created: "新建节点",
  reused: "复用已有节点",
  evidence: "已记录出处",
  noEvidence: "未带出处",
  candidates: "命中相近知识点，需要先确认",
  candidatesHint: "请选择复用其中一个，或确认是不同概念后让我带 create 重新建立。",
  cycle: "会造成循环依赖，已拒绝",
  emptyStack: "学习栈是空的",
  failed: "写入失败",
};

export function PrereqCard(props: { phase?: string; block?: Parameters<typeof parseToolResult>[0]; t?: unknown }) {
  // t 固化：makeTranslator 每次返回新函数，放进依赖会引发重复效应（同类坑见 GraphPanel）
  const t = useMemo(() => makeTranslator(props.t, LITERAL), [props.t]);
  const parsed = useMemo(() => parseToolResult(props.block), [props.block]);

  if (props.phase !== "result") return <div className="kn-simple">{t("loading")}</div>;

  const model = prereqCardModel(parsed.data);
  const from = nodeLine(model.from);
  const to = nodeLine(model.node);

  return (
    <ShadowPanel height={null}>
      <div className="kn-head">
        <span className="kn-head-title">
          {from === "" ? "" : `${from} → `}{to === "" ? t("unreadable") : to}
        </span>
        <span className="kn-head-meta">
          {model.created ? t("created") : t("reused")}
          {model.edgeType === "" ? "" : ` · ${model.edgeType}`}
          {` · ${model.evidenceRecorded ? t("evidence") : t("noEvidence")}`}
        </span>
      </div>
      {model.relationDescription === "" ? null : (
        <div className="kn-body">
          <div className="kn-sect"><span className="kn-dim">{model.relationDescription}</span></div>
        </div>
      )}
      {model.needsConfirmation ? (
        <div className="kn-body">
          <div className="kn-warn">
            <div>{t("candidates")}</div>
            <span className="kn-chips">
              {model.candidates.map((candidate) => (
                <span key={candidate.id} className="kn-chip">{nodeLine(candidate)}</span>
              ))}
            </span>
            <div className="kn-dim">{t("candidatesHint")}</div>
          </div>
        </div>
      ) : null}
      {model.cycle.length > 0 ? (
        <div className="kn-body">
          <div className="kn-error">{t("cycle")}：{model.cycle.join(" → ")}</div>
        </div>
      ) : null}
      {parsed.ok || model.needsConfirmation || model.cycle.length > 0 ? null : (
        <div className="kn-body">
          <div className="kn-error">
            {t("failed")} — {parsed.error === undefined ? t("unreadable") : `${parsed.error.code}: ${parsed.error.message}`}
          </div>
        </div>
      )}
    </ShadowPanel>
  );
}
