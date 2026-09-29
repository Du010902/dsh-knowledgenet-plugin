/**
 * 「提案 → 用户审阅 → 落地」两段式里的**提案存储与校验**（轻量模块：只依赖 fs，便于单测）。
 *
 * 为什么要有这一层：agent 的「添加前置」在节点不存在时会**真的建目录**，而模型很可能一次建一堆
 * （实测：用户只说"搜索相关知识点"，却新建了大量节点）。所以把"建多个"改成一件正经事：
 *
 * 1. agent 只能**提案**（`kn_propose_prerequisites`）：写出计划，**一个节点都不建**；
 * 2. 计划落盘在 `<库>/.knowledgenet/plans/<planId>.json`（库自己的数据目录，不动用户文件）；
 * 3. **只有用户在面板里点击**才能落地（客户端走 HTTP 路由，不是 agent 的工具）；
 * 4. 落地结果（建了哪些节点）记回计划里，供「撤销」使用。
 *
 * 关键不变量：**本模块只读写计划文件**，不碰节点、不碰关系——建的入口在别处（见 graph-edit.ts）。
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ROOT_META_DIR } from "../vendor/upstream/data/v2/paths.ts";

/** 计划文件所在目录（相对库根） */
export const PLANS_DIR = `${ROOT_META_DIR}/plans`;

/** 一条待建/待挂的前置 */
export interface PlanItem {
  /** 计划内稳定 id（用户可按条勾选） */
  id: string;
  /** 归属节点（A → B 里的 A） */
  fromId: string;
  /** 前置概念标题（要建或要复用的那个） */
  title: string;
  /** 为什么 A 需要 B */
  description?: string;
  /** 触发它的原文片段（写进 relation 的 evidence） */
  snippet?: string;
  /** 提案时就已存在同名节点时填它的 id（落地时会复用而不是新建） */
  existingNodeId?: string;
}

/** 一份提案 */
export interface Plan {
  id: string;
  createdAt: number;
  /** 提交提案的会话（仅用于展示） */
  sessionId?: string;
  /** 当时的用户问题（来源记录） */
  question?: string;
  /** 提案理由（给用户看的一句话） */
  summary?: string;
  items: PlanItem[];
  /** 落地记录；null/缺省 = 尚未落地 */
  applied?:
    | {
        at: number;
        /** 落地成功建出来的节点（供撤销） */
        created: Array<{ itemId: string; nodeId?: string; title: string }>;
        /** 复用已有节点、没有新建的条目 */
        reused: Array<{ itemId: string; nodeId?: string; title: string }>;
        failed: Array<{ itemId: string; message: string }>;
      }
    | null;
}

/** 计划条数上限：一份提案最多这么多条（再多就不是"提案"了） */
export const MAX_PLAN_ITEMS = 30;
/** 默认勾选上限：一次落地最多建几个（用户仍可逐条勾选） */
export const DEFAULT_APPLY_LIMIT = 10;

/** 计划文件路径（相对库根） */
export function planRelPath(id: string): string {
  return `${PLANS_DIR}/${id}.json`;
}

/**
 * 生成计划 id：时间前缀 + 随机后缀（可读、可排序、不撞）。
 * @param now - 时间来源（可注入）。
 * @param random - 0..1 随机来源（可注入）。
 * @returns 形如 `20250101-120000-ab12cd` 的 id。
 */
export function newPlanId(now: Date = new Date(), random: () => number = Math.random): string {
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14); // YYYYMMDDHHMMSS
  const suffix = Math.floor(random() * 0xffffff).toString(16).padStart(6, "0");
  return `${stamp}-${suffix}`;
}

/**
 * 规范化一份提案：去空条目、按标题+归属去重、限制条数、补 id。
 * @param items - 原始条目（agent 给的）。
 * @param idFactory - 条目 id 生成器（可注入，便于测试）。
 * @returns 规范化后的条目（可能为空数组）。
 */
export function normalizePlanItems(
  items: readonly Partial<PlanItem>[],
  idFactory: (index: number) => string = (index) => `i${index + 1}`,
): PlanItem[] {
  const out: PlanItem[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const fromId = typeof raw.fromId === "string" ? raw.fromId.trim() : "";
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    if (fromId === "" || title === "") continue;
    const key = `${fromId}::${title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const item: PlanItem = { id: idFactory(out.length), fromId, title };
    if (typeof raw.description === "string" && raw.description !== "") item.description = raw.description;
    if (typeof raw.snippet === "string" && raw.snippet !== "") item.snippet = raw.snippet;
    if (typeof raw.existingNodeId === "string" && raw.existingNodeId !== "") item.existingNodeId = raw.existingNodeId;
    out.push(item);
    if (out.length >= MAX_PLAN_ITEMS) break;
  }
  return out;
}

/**
 * 校验一份计划是否可落地。
 * @param plan - 计划。
 * @param selectedIds - 用户勾选的条目 id；不传表示全选。
 * @returns 通过时给出要落地的条目；否则给出原因。
 */
export function selectPlanItems(
  plan: Plan,
  selectedIds?: readonly string[],
): { ok: true; items: PlanItem[] } | { ok: false; code: string; message: string } {
  if (plan.applied !== undefined && plan.applied !== null) {
    return { ok: false, code: "already_applied", message: "这份提案已经落地过了" };
  }
  if (plan.items.length === 0) {
    return { ok: false, code: "empty_plan", message: "这份提案里没有可落地的条目" };
  }
  if (selectedIds === undefined) return { ok: true, items: [...plan.items] };
  const wanted = new Set(selectedIds);
  const items = plan.items.filter((item) => wanted.has(item.id));
  if (items.length === 0) return { ok: false, code: "nothing_selected", message: "没有勾选任何条目" };
  return { ok: true, items };
}

/**
 * 写入计划（原子替换：先写临时文件再改名）。
 * @param root - 库根。
 * @param plan - 计划。
 */
export async function savePlan(root: string, plan: Plan): Promise<void> {
  const dir = join(root, PLANS_DIR);
  await mkdir(dir, { recursive: true });
  const target = join(root, planRelPath(plan.id));
  const temp = `${target}.tmp`;
  await writeFile(temp, JSON.stringify(plan, null, 2), "utf8");
  await rm(target, { force: true });
  const { rename } = await import("node:fs/promises");
  await rename(temp, target);
}

/**
 * 读一份计划。
 * @param root - 库根。
 * @param id - 计划 id。
 * @returns 计划；不存在或坏了则 null。
 */
export async function readPlan(root: string, id: string): Promise<Plan | null> {
  if (typeof id !== "string" || id.trim() === "") return null;
  try {
    const text = await readFile(join(root, planRelPath(id.trim())), "utf8");
    const parsed = JSON.parse(text) as Plan;
    if (typeof parsed?.id !== "string" || !Array.isArray(parsed.items)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 列出库里所有提案（新到旧）。
 * @param root - 库根。
 * @returns 计划列表（读坏的跳过）。
 */
export async function listPlans(root: string): Promise<Plan[]> {
  let names: string[] = [];
  try {
    names = await readdir(join(root, PLANS_DIR));
  } catch {
    return [];
  }
  const plans: Plan[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const plan = await readPlan(root, name.slice(0, -".json".length));
    if (plan !== null) plans.push(plan);
  }
  return plans.sort((a, b) => b.createdAt - a.createdAt);
}
