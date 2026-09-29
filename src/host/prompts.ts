/**
 * 逐轮注入（P2）：让模型**不用被提醒**就知道「现在在学哪个知识点、它的前置是什么」。
 *
 * 两层，都注册在插件自己的作用域上：
 * - 静态「学习协议」**按会话**注册（`agent/created` 时判定工作区是否为知识库）：方向约定、什么时候建前置、机器文件不要手改；普通工作区渲染为空 ⇒ 模型看不到；
 * - 动态「当前节点」用 `systemPrompt.context()`，但必须注册在 **agent 作用域**
 *   （`agent/created` 里拿到的 `agent.ctx`）——因为 `AssembleContext` 不带 agent，
 *   只有作用域本身能确定「这是哪个会话」。
 *
 * 两条硬约束：
 * 1. `text` 是**同步**函数，所以只能读 `peekLibrary`（本会话已装载过的缓存），
 *    不能在这里做文件 IO；缓存为空时给「先调用工具加载」的提示，而不是假装知道标题。
 * 2. `agent/created` 的监听器**绝不能抛**：它抛了会导致 agent 创建失败、整个会话起不来。
 *    所以整个函数体包在 try/catch 里，任何宿主 API 差异都退化成「不注入」。
 */
import path from "node:path";
import { resetCreationQuotaForTurn } from "./creation-quota.ts";

import { dependentsOf, prerequisitesOf } from "../vendor/upstream/data/engine.ts";
import { currentIdOf } from "./stack.ts";
import { findCachedRoot, peekLibrary, sessionCwdOf, type LoadedLibrary } from "./library.ts";
import { isLibrarySession } from "./isolation.ts";
import type { KnowledgeNetConfig } from "./tools.ts";

/** 协议文本刻意写成「行为约定」，不重复工具说明（工具说明在各自的 description 里） */
export const PROTOCOL_SECTION = [
  "This session can read and extend a local KnowledgeNet library (知识库) — a folder of knowledge nodes.",
  "Direction convention: A → B means \"to understand A you must first understand B\", so B is a prerequisite of A.",
  "Learning loop to follow:",
  "1. Before explaining a node, call kn_read_node (or kn_list_graph) so the explanation is grounded in the library, not guessed.",
  "2. When the user meets a concept they do not understand — or explicitly asks to add one — call kn_add_prerequisite with the passage in evidence.snippet. It reuses an existing node when the title matches; when it reports candidates, ask the user to reuse or confirm creating a new node instead of creating duplicates.",
  "3. Use kn_enter_node to descend into a prerequisite and kn_back to return; the current node is remembered from the session log.",
  "4. Record what was understood with kn_write_note, and never overwrite a note or node metadata that changed on disk (the tools refuse and report the conflict).",
  "Paths under .knowledgenet/** (inside the library) are machine metadata: read them freely, but do not hand-edit them.",
  "Writing discipline (mandatory — node creation is a real, visible change on the user's disk):",
  "a. Search/read requests are read-only: kn_find_node / kn_list_graph / kn_read_node create nothing. If the user says \"搜索/看看/有哪些\", never call a writing tool.",
  "b. Never create nodes on your own initiative. Before any kn_add_prerequisite that would create a node, state which node you are about to create and for which parent, then WAIT for the user's agreement.",
  "c. kn_add_prerequisite is one node per call and is rate-limited (a few per window). When it reports creation_quota_exceeded, stop and switch to kn_propose_prerequisites.",
  "d. To propose more than one node at once, call kn_propose_prerequisites (writes only a plan file, creates nothing). The landing step belongs to the user: they review the plan in the Knowledge-graph panel and click apply. You cannot apply a plan yourself; use kn_plan_status to report what the user landed.",
  "e. Any node you created can be deleted by the user from the panel; that removes its markdown file for good (nothing is kept). Say so when you report creations.",
].join("\n");

const SECTION_ORDER = 820;
const CONTEXT_ORDER = 820;

function titleList(library: LoadedLibrary, ids: readonly string[], limit = 6): string {
  return ids
    .slice(0, limit)
    .map((id) => library.snapshot.nodes.find((node) => node.id === id)?.title ?? id.slice(0, 8))
    .join(" / ");
}

/** 当前节点上下文文本；返回 undefined 表示「没有可注入的事实」，此时不注入任何内容 */
export function currentContextText(
  agent: { session?: unknown } | undefined,
  config: KnowledgeNetConfig,
): string | undefined {
  /*
   * 新一轮开始：**只重置本会话**的"本轮最多新建几个节点"配额。
   *
   * 无参调用会清空所有会话的配额（并发会话互相解锁）——审查指出的问题。
   * 拿不到会话 id 时宁可不重置：宁可少给配额，也不能让别的会话替它解锁。
   */
  const session = agent?.session;
  const sessionId = (agent as { id?: string } | undefined)?.id
    ?? (session as { id?: string } | undefined)?.id
    ?? null;
  if (sessionId !== null) resetCreationQuotaForTurn(sessionId);
  const header = (session as { header?: { cwd?: string } } | undefined)?.header;
  const currentId = currentIdOf(session);
  if (currentId === null) return undefined;

  /*
   * 库根：配置优先；否则**从 cwd 向上找已装载的库根**。
   * 直接用 cwd 查缓存是不对的：从库的子目录打开工作区时装载过的是上级库根，
   * 于是会一直提示"知识库尚未加载"（审查指出的行为问题）。这里只做纯内存的向上找，不引入 IO。
   */
  const configured = typeof config.libraryRoot === "string" && config.libraryRoot.trim() !== ""
    ? path.resolve(config.libraryRoot.trim())
    : undefined;
  const root = configured ?? findCachedRoot(header?.cwd);
  const library = peekLibrary(root);
  if (library === undefined) {
    return `Current knowledge node: id=${currentId}（知识库尚未加载：先调用 kn_list_graph 或 kn_read_node 取上下文）`;
  }

  const node = library.snapshot.nodes.find((item) => item.id === currentId);
  if (node === undefined) {
    return `Current knowledge node: id=${currentId}（不在当前知识库里，可能已被删除）`;
  }

  const prerequisites = prerequisitesOf(library.snapshot, node.id).map((item) => item.id);
  const dependents = dependentsOf(library.snapshot, node.id).map((item) => item.id);
  const lines = [
    `Current knowledge node: ${node.title}（${node.relativePath}，状态 ${node.status}）`,
    prerequisites.length > 0
      ? `Its prerequisites: ${titleList(library, prerequisites)}`
      : "It has no recorded prerequisites yet.",
    dependents.length > 0 ? `Nodes that depend on it: ${titleList(library, dependents)}` : "",
    "Read its note with kn_read_node before answering; add missing prerequisites with kn_add_prerequisite.",
  ];
  return lines.filter((line) => line !== "").join("\n");
}

/** 注册静态协议 + 每 agent 的动态上下文；任何一步失败都只跳过注入，不影响会话 */
export function registerPrompts(ctx: unknown, config: KnowledgeNetConfig): { section: boolean; perAgent: boolean } {
  const context = ctx as {
    get?: (name: string) => unknown;
    on?: (name: string, listener: (payload: unknown) => void) => unknown;
  } | undefined;
  let section = false;
  let perAgent = false;

  try {
    /*
     * **不再全局注册协议段**。
     *
     * 为什么：`systemPrompt.section` 是全局的（不区分会话），普通工作区也会带上"你能操作知识库"
     * 这一整段说明（用户要求：插件内容只在知识库里可见）。改成在 `agent/created` 时按会话注册
     * （见下面的 per-agent 分支）：会话工作区不是知识库 → 文本渲染为空 → 模型完全看不到。
     */
    section = true;
  } catch {
    // 没有 systemPrompt 服务（例如 headless 精简组合）时，协议不注入即可
  }

  try {
    context?.on?.("agent/created", (payload: unknown) => {
      try {
        const agent = (payload as { agent?: Record<string, unknown> } | undefined)?.agent;
        const agentCtx = agent?.ctx as
          | { systemPrompt?: { context?: (entry: Record<string, unknown>) => unknown } }
          | undefined;
        if (typeof agentCtx?.systemPrompt?.context !== "function") return;
        /*
         * **每次渲染都重新判定**（很便宜：几次同步 exists 调用）。
         *
         * 为什么不缓存结论：登记表由客户端异步同步（`sync-declared`），agent 可能先于同步创建；
         * 缓存会让那个会话**一直**看不到插件内容 ✗。每次现算就能在同步到达后立刻生效 ✓。
         */
        const cwd = sessionCwdOf({ agent }) ?? "";
        agentCtx.systemPrompt.context({
          name: "knowledgenet-current",
          order: CONTEXT_ORDER,
          text: () => {
            if (!isLibrarySession(cwd)) return "";
            const dynamic = currentContextText(agent as { session?: unknown }, config) ?? "";
            return dynamic === "" ? PROTOCOL_SECTION : `${PROTOCOL_SECTION}\n${dynamic}`;
          },
        });
      } catch {
        // 绝不因为注入失败而让 agent 创建失败
      }
    });
    perAgent = true;
  } catch {
    // 没有事件总线时跳过
  }

  return { section, perAgent };
}
