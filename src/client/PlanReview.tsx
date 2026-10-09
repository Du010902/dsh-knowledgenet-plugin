/**
 * 「提案审阅」：agent 只能**提案**（写出计划文件，一个节点都不建）；落地与撤销只在这里、由用户点击触发——
 * 这是"agent 建节点可控"的最后一环。
 *
 * 两部分（用户要求，2026-10）：
 * 1. **弹窗**：待审提案做成一个**悬浮在当前聊天窗口上的弹窗**（portal 到 body ✓），
 *    落地完成、或用户取消/关掉之后**立即消失** ✓；关掉过的提案不再自己弹回来
 *    （计划文件仍在库里，面板上留一个小入口可以再打开 ✓）。
 * 2. **面板里的小尾巴**：已落地的「撤销」卡片、结果说明与错误留在这里（它们不抢视线 ✓）。
 *
 * 另外两条实测约定：
 * - **及时刷新**：agent 提交提案只写库里的计划文件，图的 `revision` 不会变 ⇒ 只靠"图数据变了才拉"
 *   会一直看不见（用户实测：切走再切回才出现 ✗）。所以这里**自己按秒轮询** `list-plans` ✓。
 * - **默认不全选**：一件 30 条的提案默认只勾前 `APPLY_DEFAULT_LIMIT` 条（见 plan-view.ts ✓）。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { GRAPH_API_ROUTE } from "../shared/routes.ts";
import { ensurePlanDialogStyle } from "./plan-dialog-css.ts";
import {
  describeApply,
  formatPlanTime,
  mergeSelection,
  openPlans,
  selectionLabel,
  undoablePlans,
  type ApplyOutcome,
  type PlanSummary,
} from "./plan-view.ts";

/** 提案轮询间隔：agent 交完提案，用户最多等这么久就能看到弹窗 ✓（一次 list-plans 很便宜） */
const PLAN_POLL_MS = 2000;

/**
 * 已经**关掉过**的提案 id（模块级，跨面板重挂保留 ✓）。
 *
 * 为什么必须放在组件外：用户取消之后换会话/重开面板，若每个新组件实例都从零开始，
 * 弹窗会**又自己弹回来**（正是用户不要的行为 ✗）。计划文件仍在库里，随时能从面板的小入口再打开 ✓。
 * 纯内存：刷新页面即忘（下一轮提示重新开始，可接受 ✓）。
 */
const dismissedPlans = new Set<string>();

/** 已经自动弹过一次的提案 id（模块级：同一份提案不反复打扰 ✓） */
const autoOpenedPlans = new Set<string>();

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
    /** 面板上那个"还有提案待审"小入口；`{n}` 会被替换成条数 ✓ */
    reopen?: string;
    /** 关闭弹窗（× / Esc / 点背景）的按钮/提示文案 ✓ */
    close?: string;
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
 * 默认文案：宿主 locale 服务缺席、或调用方没传 `copy` 时的兜底 ✓。
 *
 * 键名与插件词典（`index.ts` 的 DICT_ZH / DICT_EN）**同名**，
 * 这样守门测试（"组件字面兜底字典的键必须在中英词典里都有 ✓"）能一路盯住不漏翻译 ✓。
 */
const LITERAL: Record<string, string> = {
  planPendingTitle: "agent 提交了一份提案",
  planTagCreate: "新建",
  planTagReuse: "已存在·复用",
  planNothingSelected: "未勾选",
  planLater: "稍后再说",
  planHint: "只有你点击才会真正建节点",
  planAppliedTitle: "已按你的确认落地",
  planCreatedCount: "本次新建 {n} 个节点（文件保留，可撤销）",
  planUndo: "撤销本次新建",
  planUndoDone: "已撤销：{n} 个节点已删除（都是这次落地新建的）",
  planReopen: "有 {n} 条提案待审",
  planClose: "关闭",
};

/**
 * 提案审阅区 + 提案弹窗。
 * @param props - 库根、刷新钩子与上报。
 * @returns 有待审/可撤销内容时渲染（弹窗按需 portal 到 body）✓。
 */
export function PlanReview(props: PlanReviewProps): ReactNode {
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 弹窗开着吗 ✓ */
  const [dialog, setDialog] = useState(false);
  /**
   * 用户已经**关掉过**的提案 id（模块级 `dismissedPlans` 的渲染快照 ✓）。
   *
   * 关掉 = 弹窗立即消失、且**不许自己再弹回来** ✓（用户要求）；计划文件仍然留在库里，
   * 面板上那个小入口随时能把它再摊开 ✓。
   */
  const [dismissed, setDismissed] = useState<string[]>(() => [...dismissedPlans]);
  /** 轮询计数：让 effect 重新拉一次 list-plans ✓ */
  const [pollTick, setPollTick] = useState(0);

  /** 记下"这些提案关掉过了"（同时写进模块级集合，重挂面板也不忘 ✓） */
  const dismissPlans = useCallback((ids: readonly string[]): void => {
    for (const id of ids) dismissedPlans.add(id);
    setDismissed([...dismissedPlans]);
  }, []);

  const copy = {
    pendingTitle: props.copy?.pendingTitle ?? LITERAL.planPendingTitle,
    tagCreate: props.copy?.tagCreate ?? LITERAL.planTagCreate,
    tagReuse: props.copy?.tagReuse ?? LITERAL.planTagReuse,
    nothingSelected: props.copy?.nothingSelected ?? LITERAL.planNothingSelected,
    later: props.copy?.later ?? LITERAL.planLater,
    hint: props.copy?.hint ?? LITERAL.planHint,
    appliedTitle: props.copy?.appliedTitle ?? LITERAL.planAppliedTitle,
    createdCount: props.copy?.createdCount ?? LITERAL.planCreatedCount,
    undo: props.copy?.undo ?? LITERAL.planUndo,
    undoDone: props.copy?.undoDone ?? LITERAL.planUndoDone,
    reopen: props.copy?.reopen ?? LITERAL.planReopen,
    close: props.copy?.close ?? LITERAL.planClose,
  };

  const report = (step: string, detail: Record<string, unknown> | null = null): void => {
    try {
      props.report?.(step, detail);
    } catch {
      // 上报失败不影响功能
    }
  };

  /** 弹窗是 portal 到 body 的 ⇒ 样式得自己注进 head ✓（面板的 shadow 样式管不到它） */
  useEffect(() => {
    if (typeof document === "undefined") return;
    ensurePlanDialogStyle(document);
  }, []);

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
  }, [reload, props.reloadToken, pollTick]);

  /**
   * **及时刷新**（用户实测问题）：agent 提交提案只写计划文件，图的 revision 不变 ⇒
   * 只靠 reloadToken 会一直看不见，切走再切回才出现 ✗。这里自己按秒拉一次 ✓。
   */
  useEffect(() => {
    if (props.root === undefined || props.root.trim() === "") return;
    const timer = setInterval(() => setPollTick((value) => value + 1), PLAN_POLL_MS);
    return () => clearInterval(timer);
  }, [props.root]);

  const pending = openPlans(plans, dismissed);
  const undoable = undoablePlans(plans);
  const pendingIds = pending.map((plan) => plan.id).join(",");

  /**
   * 有新提案 ⇒ 自动把弹窗摊开（用户要求：及时看见 ✓）。
   * 每个提案只自动弹一次：关掉过的（dismissed）与已经自动弹过的都不再触发 ✓。
   */
  useEffect(() => {
    const fresh = pending.filter((plan) => !autoOpenedPlans.has(plan.id));
    if (fresh.length === 0) return;
    for (const plan of fresh) autoOpenedPlans.add(plan.id);
    setDialog(true);
    report("plan-dialog-open", { count: fresh.length });
  }, [pendingIds]);

  /** 取消 / 关掉：弹窗立即消失，且这些提案不再自动弹回来 ✓ */
  const dismiss = useCallback((): void => {
    setDialog(false);
    if (pending.length === 0) return;
    dismissPlans(pending.map((plan) => plan.id));
    report("plan-dialog-dismiss", { count: pending.length });
  }, [pending, dismissPlans, report]);

  /** Esc = 取消（Enter 故意不绑：建节点必须是一次**明确的点击** ✗） */
  useEffect(() => {
    if (!dialog) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dismiss();
    };
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("keydown", onKey, true); };
  }, [dialog, dismiss]);

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
      /* **落地完成 ⇒ 弹窗立即消失** ✓（用户要求；撤销入口留在面板里 ✓） */
      setDialog(false);
      dismissPlans([plan.id]);
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
      setNote(copy.undoDone.replace("{n}", String(body.undone ?? 0)));
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

  const toggle = (plan: PlanSummary, itemId: string): void => {
    setSelected((prev) => {
      const current = prev[plan.id] ?? [];
      const next = current.includes(itemId) ? current.filter((id) => id !== itemId) : [...current, itemId];
      // 记一条：万一"点了没反应"，读 kn_status 就知道是点击没进来还是状态被别处覆盖了
      report("plan-toggle", { picked: next.length, total: plan.items.length });
      return { ...prev, [plan.id]: next };
    });
  };

  /** 面板里的小尾巴：待审入口 / 已落地的撤销 / 结果与错误 ✓ */
  const tail = pending.length > 0 || undoable.length > 0 || note !== null || error !== null
    ? <section className="kn-plan" data-kn-plan-review="1">
      {pending.length > 0 ? (
        <button type="button" className="kn-btn" onClick={() => { setDialog(true); report("plan-dialog-reopen", { count: pending.length }); }}>
          {copy.reopen.replace("{n}", String(pending.length))}
        </button>
      ) : null}
      {undoable.map((plan) => (
        <div className="kn-plan-card" key={`undo-${plan.id}`}>
          <div className="kn-plan-title">
            {copy.appliedTitle}
            <span className="kn-plan-meta">{formatPlanTime(plan.createdAt)}</span>
          </div>
          <div className="kn-plan-summary">
            {copy.createdCount.replace("{n}", String(plan.createdCount))}
          </div>
          <div className="kn-plan-actions">
            <button type="button" className="kn-btn" disabled={busy === plan.id} onClick={() => { void undo(plan); }}>
              {copy.undo}
            </button>
          </div>
        </div>
      ))}
      {note === null ? null : <div className="kn-plan-note">{note}</div>}
      {error === null ? null : <div className="kn-plan-error">{error}</div>}
    </section>
    : null;

  const dialogNode = dialog && pending.length > 0 && typeof document !== "undefined"
    ? createPortal(
      <div className="kn-pdialog-backdrop" role="presentation" onClick={dismiss}>
        <div className="kn-pdialog" role="dialog" aria-modal="true" aria-label={copy.pendingTitle} onClick={(event) => { event.stopPropagation(); }}>
          <div className="kn-pdialog-head">
            <span className="kn-pdialog-title">{copy.pendingTitle}</span>
            <button type="button" className="kn-pdialog-close" aria-label={copy.close} title={copy.close} onClick={dismiss}>×</button>
          </div>
          <div className="kn-pdialog-body">
            {pending.map((plan) => {
              const picked = selected[plan.id] ?? [];
              const label = selectionLabel(picked.length, plan.items.length);
              return (
                <div className="kn-pdialog-card" key={plan.id}>
                  <div className="kn-pdialog-cardhead">
                    <span className="kn-pdialog-cardtitle">{`${plan.items.length} 条`}</span>
                    <span className="kn-pdialog-meta">{formatPlanTime(plan.createdAt)}</span>
                  </div>
                  {plan.summary === "" ? null : <div className="kn-pdialog-summary">{plan.summary}</div>}
                  <div className="kn-pdialog-items">
                    {plan.items.map((item) => (
                      <label className="kn-pdialog-item" key={item.id}>
                        <input type="checkbox" checked={picked.includes(item.id)} onChange={() => { toggle(plan, item.id); }} />
                        <span className="kn-pdialog-item-title">{item.title}</span>
                        <span className={`kn-pdialog-tag${item.reuse ? " is-reuse" : ""}`}>
                          {item.reuse ? copy.tagReuse : copy.tagCreate}
                        </span>
                      </label>
                    ))}
                  </div>
                  <div className="kn-pdialog-actions">
                    <span className="kn-pdialog-hint">{copy.hint}</span>
                    <button type="button" className="kn-pdialog-btn" onClick={dismiss}>{copy.later}</button>
                    <button
                      type="button"
                      className="kn-pdialog-btn is-primary"
                      disabled={busy === plan.id || picked.length === 0}
                      onClick={() => { void apply(plan); }}
                    >
                      {label === "" ? copy.nothingSelected : label}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          {error === null ? null : <div className="kn-pdialog-error">{error}</div>}
        </div>
      </div>,
      document.body,
    )
    : null;

  return <>{tail}{dialogNode}</>;
}
