/**
 * 面板里的「提案审阅」区。
 *
 * agent 只能**提案**（写出计划文件，一个节点都不建）；落地与撤销都只在这里、由用户点击触发——
 * 这是"agent 建节点可控"的最后一环。
 *
 * 关键交互：
 * - 默认**不全选**（前 10 条），一件 30 条的提案不会因为"点一下"就建 30 个；
 * - 每条显示"将新建 / 将复用"；落地后显示"新建 N 个 · 复用 M 个"；
 * - 已落地且新建过节点的提案提供「撤销」：把这些节点的身份移进回收站（**用户文件保留**）。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { GRAPH_API_ROUTE } from "../shared/routes.ts";
import {
  defaultSelection,
  describeApply,
  formatPlanTime,
  pendingPlans,
  mergeSelection,
  selectionLabel,
  undoablePlans,
  type ApplyOutcome,
  type PlanSummary,
} from "./plan-view.ts";

export interface PlanReviewProps {
  /** 当前库根（面板已知）；没有就不渲染 */
  root?: string;
  /** 数据版本：变化时重新拉取提案（落地后由调用方改） */
  reloadToken?: number | string;
  /** 落地/撤销成功后通知面板刷新图谱 */
  onChanged?: () => void;
  /** 逐步上报 */
  report?: (step: string, detail?: Record<string, unknown> | null) => void;
  /** 文案（都有中文默认值，可不传） */
  copy?: {
    pendingTitle?: string;
    tagCreate?: string;
    tagReuse?: string;
    nothingSelected?: string;
    later?: string;
    hint?: string;
    appliedTitle?: string;
    createdCount?: string;
    undo?: string;
    undoDone?: string;
  };
}

interface PlanListResponse {
  ok?: boolean;
  plans?: PlanSummary[];
  error?: { message?: string };
}

/** 一次路由调用的返回（放宽类型，避免把 host 形状写死） */
type PostResult = { ok?: boolean; error?: { message?: string } } & Record<string, unknown>;

/**
 * 提案审阅区。
 * @param props - 库根、刷新钩子与上报。
 * @returns 有待审/可撤销内容时渲染一块，否则 null。
 */
export function PlanReview(props: PlanReviewProps): ReactNode {
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const report = (step: string, detail: Record<string, unknown> | null = null): void => {
    try {
      props.report?.(step, detail);
    } catch {
      // 上报失败不影响功能
    }
  };

  const post = useCallback(async (body: Record<string, unknown>): Promise<PostResult> => {
    const response = await fetch(GRAPH_API_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    return (await response.json()) as PostResult;
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    if (props.root === undefined || props.root.trim() === "") return;
    try {
      const body = (await post({ kind: "list-plans", root: props.root })) as PlanListResponse;
      const list = body.ok === true ? (body.plans ?? []) : [];
      setPlans(list);
      /*
       * 默认勾选：**只给"第一次见到"的提案**套默认（前 N 条）。
       *
       * 之前每次 reload 都无条件重置成默认前 N 条，而面板只要数据一刷新就会 reload
       * （reloadToken 变）⇒ 用户勾了第 11 条，下一拍又被抹掉，表现就是"点了选不上"（实测反馈）。
       * 用户已经做过的选择，刷新不该丢。
       */
      setSelected((prev) => mergeSelection(prev, list));
      report("plan-list", { count: list.length });
    } catch {
      setPlans([]);
    }
  }, [post, props.root]);

  useEffect(() => {
    void reload();
  }, [reload, props.reloadToken]);

  const pending = pendingPlans(plans);
  const undoable = undoablePlans(plans);

  const apply = async (plan: PlanSummary): Promise<void> => {
    const ids = selected[plan.id] ?? [];
    if (ids.length === 0) return;
    setBusy(plan.id);
    setError(null);
    try {
      const body = await post({ kind: "apply-plan", root: props.root, planId: plan.id, itemIds: ids });
      if (body.ok !== true) {
        setError(body.error?.message ?? "落地失败");
        report("plan-apply-failed", { message: body.error?.message ?? "" });
        return;
      }
      const text = describeApply(body as ApplyOutcome);
      setNote(text);
      report("plan-applied", { created: (body.created as unknown[] | undefined)?.length ?? 0 });
      props.onChanged?.();
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const undo = async (plan: PlanSummary): Promise<void> => {
    setBusy(plan.id);
    setError(null);
    try {
      const body = await post({ kind: "undo-plan", root: props.root, planId: plan.id });
      if (body.ok !== true) {
        setError(body.error?.message ?? "撤销失败");
        report("plan-undo-failed", { message: body.error?.message ?? "" });
        return;
      }
      setNote(props.copy?.undoDone ?? `已撤销：${String(body.undone ?? 0)} 个节点已删除（它们是这次落地新建的）`);
      report("plan-undone", { undone: Number(body.undone ?? 0) });
      props.onChanged?.();
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  if (props.root === undefined || props.root.trim() === "") return null;
  if (pending.length === 0 && undoable.length === 0) return null;

  const toggle = (plan: PlanSummary, itemId: string): void => {
    setSelected((prev) => {
      const current = prev[plan.id] ?? [];
      const next = current.includes(itemId) ? current.filter((id) => id !== itemId) : [...current, itemId];
      // 记一条：万一"点了没反应"，读 kn_status 就知道是点击没进来还是状态被别处覆盖了
      report("plan-toggle", { picked: next.length, total: plan.items.length });
      return { ...prev, [plan.id]: next };
    });
  };

  return (
    <section className="kn-plan" data-kn-plan-review="1">
      {pending.map((plan) => {
        const picked = selected[plan.id] ?? [];
        const label = selectionLabel(picked.length, plan.items.length);
        return (
          <div className="kn-plan-card" key={plan.id}>
            <div className="kn-plan-title">
              {props.copy?.pendingTitle ?? "agent 提交了一份提案"}
              <span className="kn-plan-meta">{formatPlanTime(plan.createdAt)} · {plan.items.length} 条</span>
            </div>
            {plan.summary === "" ? null : <div className="kn-plan-summary">{plan.summary}</div>}
            <div className="kn-plan-items">
              {plan.items.map((item) => (
                <label className="kn-plan-item" key={item.id}>
                  <input
                    type="checkbox"
                    checked={picked.includes(item.id)}
                    onChange={() => { toggle(plan, item.id); }}
                  />
                  <span className="kn-plan-item-title">{item.title}</span>
                  <span className={`kn-plan-tag${item.reuse ? " is-reuse" : ""}`}>
                    {item.reuse ? (props.copy?.tagReuse ?? "已存在·复用") : (props.copy?.tagCreate ?? "新建")}
                  </span>
                </label>
              ))}
            </div>
            <div className="kn-plan-actions">
              <button
                type="button"
                className="kn-btn is-on"
                disabled={busy === plan.id || picked.length === 0}
                onClick={() => { void apply(plan); }}
              >
                {label === "" ? (props.copy?.nothingSelected ?? "未勾选") : label}
              </button>
              <button
                type="button"
                className="kn-btn"
                onClick={() => { setPlans((prev) => prev.filter((item) => item.id !== plan.id)); }}
              >
                {props.copy?.later ?? "稍后再说"}
              </button>
              <span className="kn-plan-hint">{props.copy?.hint ?? "只有你点击才会真正建节点"}</span>
            </div>
          </div>
        );
      })}

      {undoable.map((plan) => (
        <div className="kn-plan-card" key={`undo-${plan.id}`}>
          <div className="kn-plan-title">
            {props.copy?.appliedTitle ?? "已按你的确认落地"}
            <span className="kn-plan-meta">{formatPlanTime(plan.createdAt)}</span>
          </div>
          <div className="kn-plan-summary">
            {(props.copy?.createdCount ?? "本次新建 {n} 个节点（文件保留，可撤销）").replace("{n}", String(plan.createdCount))}
          </div>
          <div className="kn-plan-actions">
            <button
              type="button"
              className="kn-btn"
              disabled={busy === plan.id}
              onClick={() => { void undo(plan); }}
            >
              {props.copy?.undo ?? "撤销本次新建"}
            </button>
          </div>
        </div>
      ))}

      {note === null ? null : <div className="kn-plan-note">{note}</div>}
      {error === null ? null : <div className="kn-plan-error">{error}</div>}
    </section>
  );
}
