/**
 * 「提案审阅」：agent 只能**提案**（写出计划文件，一个节点都不建）；落地与撤销只在这里、由用户点击触发——
 * 这是"agent 建节点可控"的最后一环。
 *
 * **弹窗只有两个出口**（用户要求 2026-10-10："不用稍后再说，要么添加节点，要么取消这提案"）：
 * 1. 「创建选中的 N 条」⇒ 落地，弹窗立即消失 ✓；
 * 2. 「取消这提案」⇒ **丢弃**：客户端立刻隐藏 + 让宿主删掉计划文件 ✓（宿主还没更新时先本地记住、
 *    下次拉列表时补删 ✓），弹窗立即消失且**永不再弹** ✓。
 * 没有"稍后再说"，面板上也没有"待审提案"小入口 ✓ —— 待审就是"还没决定"，那就该弹 ✓。
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
  forgetDismissedPlan,
  markPlanDismissed,
  readDismissedPlans,
} from "./plan-dismissed.ts";
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
 * 已经**取消过**的提案记录（模块级 + localStorage ✓，见 `plan-dismissed.ts`）。
 *
 * 两条作用：
 * 1. 取消之后**立刻生效**，换会话/重开面板/重启 DSH 都不再弹 ✓；
 * 2. 宿主半是启动时加载的 ⇒ 还没重启时"删计划文件"那条路不存在，这次取消先记在本地 ✓，
 *    等宿主能删了再补删（`retryDiscarded` ✓）⇒ 磁盘最终干净 ✓。
 */
const dismissedPlans = new Map<string, string>(readDismissedPlans().map((entry) => [entry.id, entry.root]));

/**
 * 落地/撤销的「回执」显示多久。
 *
 * 用户要求：这些提示**不许长期占着面板**（实测：落地完那张「已按你的确认落地 / 撤销本次新建」
 * 会一直挂在那里 ✗）。所以它是一条**短暂回执**：到点自己消失 ✓；想立刻收起就点 × ✓。
 * 撤销入口只在窗口期内可用；过了之后要撤掉那几个空节点，用图谱的「删除当前节点」即可 ✓。
 */
const TRANSIENT_MS = 10_000;

/** 刚落地的提案：id → 回执（撤销入口只在窗口期内渲染 ✓） */
const freshlyApplied = new Map<string, { at: number; createdCount: number; createdAt: number }>();

/** 操作回执（「新建 2 个 · 复用 1 个」/「已撤销…」）：文本 + 落笔时间 ✓ */
type Receipt = { text: string; at: number };

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
    /** 「取消这提案」按钮（点击 = **丢弃**这份提案 ✓） */
    discard?: string;
    hint?: string;
    appliedTitle?: string;
    createdCount?: string;
    undo?: string;
    undoDone?: string;
    /** 关闭弹窗（× / Esc / 点背景）的提示：与"取消"同一语义（丢弃 ✓） */
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
  planDiscard: "取消这提案",
  planHint: "只有你点击才会真正建节点；取消会把这份提案丢掉",
  planAppliedTitle: "已按你的确认落地",
  planCreatedCount: "本次新建 {n} 个节点（文件保留，可撤销）",
  planUndo: "撤销本次新建",
  planUndoDone: "已撤销：{n} 个节点已删除（都是这次落地新建的）",
  planClose: "取消这提案（丢弃它）",
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
  /** 操作回执（短暂提示：到点自己消失 ✓） */
  const [note, setNote] = useState<Receipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 弹窗开着吗 ✓ */
  const [dialog, setDialog] = useState(false);
  /**
   * 用户已经**取消过**的提案 id（模块级 `dismissedPlans` 的渲染快照 ✓）。
   *
   * 取消 = 弹窗立即消失、且**永不再弹** ✓（用户要求）；同时会请宿主把计划文件删掉 ✓
   * （宿主还没更新时先本地记住，下次拉列表时补删 ✓）。
   */
  const [dismissed, setDismissed] = useState<string[]>(() => [...dismissedPlans.keys()]);
  /** 轮询计数：让 effect 重新拉一次 list-plans ✓ */
  const [pollTick, setPollTick] = useState(0);
  /** 回执/撤销窗口的滴答：让"到点自己消失"能真的重渲染一次 ✓ */
  const [receiptTick, setReceiptTick] = useState(0);

  const copy = {
    pendingTitle: props.copy?.pendingTitle ?? LITERAL.planPendingTitle,
    tagCreate: props.copy?.tagCreate ?? LITERAL.planTagCreate,
    tagReuse: props.copy?.tagReuse ?? LITERAL.planTagReuse,
    nothingSelected: props.copy?.nothingSelected ?? LITERAL.planNothingSelected,
    discard: props.copy?.discard ?? LITERAL.planDiscard,
    hint: props.copy?.hint ?? LITERAL.planHint,
    appliedTitle: props.copy?.appliedTitle ?? LITERAL.planAppliedTitle,
    createdCount: props.copy?.createdCount ?? LITERAL.planCreatedCount,
    undo: props.copy?.undo ?? LITERAL.planUndo,
    undoDone: props.copy?.undoDone ?? LITERAL.planUndoDone,
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

  /**
   * 请宿主**删掉计划文件**（「取消这提案」的正常路径 ✓）。
   * @param id - 提案 id。
   * @param root - 库根（补删时用记录里的 root ✓）。
   * @returns 宿主确认删掉了 ⇒ true ✓。
   */
  const discardOnHost = useCallback(async (id: string, root: string | undefined): Promise<boolean> => {
    if (root === undefined || root.trim() === "") return false;
    try {
      const body = await post({ kind: "discard-plan", root, planId: id });
      return body.ok === true;
    } catch {
      return false;
    }
  }, [post]);

  /**
   * **补删**：之前取消过、但宿主当时还不支持删除（宿主半是启动时加载的 ⇒ 刚更新完那条路还不存在 ✓）
   * 的提案，现在如果能删就删掉，并把本地记录也清掉 ✓。删不掉就留着记录，下次再试 ✓。
   * @param list - 刚拉到的提案列表（只对**还在列表里**的补删，省得每次都问一遍 ✓）。
   */
  const retryDiscarded = useCallback(async (list: readonly PlanSummary[]): Promise<void> => {
    const present = new Set(list.map((plan) => plan.id));
    for (const [id, root] of [...dismissedPlans]) {
      if (!present.has(id)) continue;
      if (await discardOnHost(id, root)) {
        dismissedPlans.delete(id);
        forgetDismissedPlan(id);
        setDismissed([...dismissedPlans.keys()]);
        report("plan-discard-retried", { ok: true });
      }
    }
  }, [discardOnHost]);

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
      /* 顺手补删：之前取消过、但当时宿主还删不掉的提案（宿主半更新后这里就清干净了 ✓） */
      void retryDiscarded(list);
    } catch {
      setPlans([]);
    }
  }, [post, props.root, retryDiscarded]);

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

  /**
   * 短暂回执的滴答：让「到点自己消失」真的重渲染一次 ✓。
   * 只在窗口期内跑（没有回执就不开定时器 ✓）。
   */
  useEffect(() => {
    const alive = note !== null && Date.now() - note.at < TRANSIENT_MS;
    if (!alive && freshlyApplied.size === 0) return;
    const timer = setInterval(() => setReceiptTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [note, receiptTick]);

  const pending = openPlans(plans, dismissed);
  const pendingIds = pending.map((plan) => plan.id).join(",");

  /**
   * 有待审提案 ⇒ 自动把弹窗摊开（用户要求：及时看见 ✓）。
   *
   * 现在**不做"弹过就不再弹"的抑制**了：既然只有两个出口（添加 / 取消），
   * "待审"就等于"还没决定" ⇒ 该弹就弹 ✓（刷新页面后接着弹也是对的 ✓；
   * 取消了的那份已经进了 `dismissed`，不会再出现 ✓）。
   */
  useEffect(() => {
    if (pending.length === 0) return;
    setDialog(true);
    report("plan-dialog-open", { count: pending.length });
  }, [pendingIds]);

  /**
   * **取消这提案 = 丢弃**（用户要求：不要"稍后再说" ✓）：
   * 弹窗立即消失、界面上立刻不再有它 ✓，并请宿主把计划文件删掉 ✓；
   * 宿主还删不掉（宿主半没更新）时先本地记住 ⇒ 下次拉列表时补删 ✓，
   * 用户这边**永远不再被它打扰** ✓。
   */
  const discard = useCallback((): void => {
    const targets = pending.map((plan) => plan.id);
    setDialog(false);
    if (targets.length === 0) return;
    for (const id of targets) dismissedPlans.set(id, props.root ?? "");
    setDismissed([...dismissedPlans.keys()]);
    setPlans((prev) => prev.filter((plan) => !targets.includes(plan.id)));
    report("plan-discard", { count: targets.length });
    void (async () => {
      for (const id of targets) {
        if (await discardOnHost(id, props.root)) {
          /* 宿主真的删掉了 ⇒ 本地记录也可以忘掉 ✓ */
          dismissedPlans.delete(id);
          forgetDismissedPlan(id);
          setDismissed([...dismissedPlans.keys()]);
        }
      }
    })();
  }, [pending, props.root, discardOnHost, report]);

  /** Esc = 取消这提案（与按钮同一语义 ✓；Enter 故意不绑：建节点必须是一次**明确的点击** ✗） */
  useEffect(() => {
    if (!dialog) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      discard();
    };
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("keydown", onKey, true); };
  }, [dialog, discard]);

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
      const created = (body.created as unknown[] | undefined)?.length ?? 0;
      setNote({ text, at: Date.now() });
      report("plan-applied", { created });
      /* **落地完成 ⇒ 弹窗立即消失** ✓（用户要求）；面板里只留一条**短暂回执**（含撤销 ✓） */
      setDialog(false);
      if (created > 0) freshlyApplied.set(plan.id, { at: Date.now(), createdCount: created, createdAt: plan.createdAt });
      props.onChanged?.();
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const undo = async (plan: { id: string }): Promise<void> => {
    setBusy(plan.id);
    setError(null);
    try {
      const body = await post({ kind: "undo-plan", root: props.root, planId: plan.id });
      if (body.ok !== true) {
        setError(body.error?.message ?? "撤销失败");
        report("plan-undo-failed", { message: body.error?.message ?? "" });
        return;
      }
      freshlyApplied.delete(plan.id);
      setReceiptTick((value) => value + 1);
      setNote({ text: copy.undoDone.replace("{n}", String(body.undone ?? 0)), at: Date.now() });
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

  /*
   * 短暂回执：到点自己消失 ✓（用户实测：落地完那张卡一直挂着 ✗）。
   * 用滴答重算一次"还在窗口期吗"，窗口过了就把 Map 里的记录也清掉（不留内存渣 ✓）。
   */
  const now = Date.now();
  const liveNote = note !== null && now - note.at < TRANSIENT_MS ? note : null;
  /* 回执只在**宿主仍报告"已落地且新建过"**时出现（列表刷新前后都不会留一张假卡 ✓） */
  const appliedNow = new Set(undoablePlans(plans).map((item) => item.id));
  const undoable = [...freshlyApplied.entries()]
    .filter(([id, entry]) => now - entry.at < TRANSIENT_MS && appliedNow.has(id))
    .map(([id, entry]) => ({ id, ...entry }));
  for (const [id, entry] of [...freshlyApplied]) {
    if (now - entry.at >= TRANSIENT_MS) freshlyApplied.delete(id);
  }

  /**
   * 面板里的小尾巴：只剩**落地后的短暂回执**（含撤销）与错误 ✓。
   *
   * **没有"还有 N 条提案待审"那种入口了**（用户要求：只有"添加节点"或"取消这提案"✓）——
   * 待审的提案一定会以弹窗出现，取消过的那份不会再回来 ✓。
   */
  const tail = undoable.length > 0 || liveNote !== null || error !== null
    ? <section className="kn-plan" data-kn-plan-review="1">
      {undoable.map((plan) => (
        <div className="kn-plan-card" key={`undo-${plan.id}`}>
          <div className="kn-plan-title">
            {copy.appliedTitle}
            <span className="kn-plan-meta">
              {formatPlanTime(plan.createdAt)}
              {/* 立刻收起（不想等那 10 秒 ✓） */}
              <button
                type="button"
                className="kn-plan-dismiss"
                aria-label={copy.close}
                title={copy.close}
                onClick={() => { freshlyApplied.delete(plan.id); setReceiptTick((value) => value + 1); }}
              >
                ×
              </button>
            </span>
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
      {liveNote === null ? null : <div className="kn-plan-note">{liveNote.text}</div>}
      {error === null ? null : <div className="kn-plan-error">{error}</div>}
    </section>
    : null;

  const dialogNode = dialog && pending.length > 0 && typeof document !== "undefined"
    ? createPortal(
      /* 点背景 / × / Esc 都等于「取消这提案」（丢弃 ✓）——弹窗只有这两个出口 ✓ */
      <div className="kn-pdialog-backdrop" role="presentation" onClick={discard}>
        <div className="kn-pdialog" role="dialog" aria-modal="true" aria-label={copy.pendingTitle} onClick={(event) => { event.stopPropagation(); }}>
          <div className="kn-pdialog-head">
            <span className="kn-pdialog-title">{copy.pendingTitle}</span>
            <button type="button" className="kn-pdialog-close" aria-label={copy.close} title={copy.close} onClick={discard}>×</button>
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
                    {/* 只有两个出口：取消这提案（= 丢弃） / 创建选中的 N 条 ✓ */}
                    <button type="button" className="kn-pdialog-btn" onClick={discard}>{copy.discard}</button>
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
