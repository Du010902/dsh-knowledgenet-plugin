/**
 * KnowledgeNet × DSH —— 插件 Host 半入口。
 *
 * 形态：Cordis 函数式插件（`export function apply`），`inject: ['tools']` 等待工具注册表。
 * 职责边界：
 * - 把**本地知识库**（v2 开放文件格式）读进来并允许受控写入，作为一组工具暴露给模型；
 * - 逐轮把「当前学习节点 + 它的前置」注入上下文，让模型不必被提醒；
 * - 注册一条精确 Fetch 路由（`/api/knowledgenet.graph`）给**常驻面板**取数据；
 * - 不持有全局「当前库」单例：库由调用方会话的 cwd 决定（见 library.ts），
 *   面板没有会话绑定时用「最近装载过的库」兜底（见 lastLibraryRoot）；
 * - 学习栈从会话事件流折叠（见 stack.ts），因此 resume/fork/重启都不丢；
 * - 不 import 任何 `@deepseek-ai/*`，一切都通过 `ctx` 服务使用。
 */
import { createTools, type KnowledgeNetConfig } from "./tools.ts";
import { findCachedRoot, lastLibraryRoot, loadLibrary, peekLibrary, resolveLibraryRoot, isLibraryRoot, createLibrary, sessionCwdOf } from "./library.ts";
import { NodeVfs } from "./node-vfs.ts";
import { neighborhood, resolveNodeArg, search, summarizeNode } from "./graph.ts";
import { addPrerequisite, createNodeFromUi, readNote, writeNote } from "./mutate.ts";
import { __setCreationQuotaForTest, resetCreationQuotaForTurn } from "./creation-quota.ts";
import { listPlans } from "./plans.ts";
import { addPrerequisiteFromUi, applyPlanFromUi, removePrerequisiteFromUi, undoPlanFromUi } from "./graph-edit.ts";
import { currentContextText, registerPrompts, PROTOCOL_SECTION } from "./prompts.ts";
import { currentIdOf, foldStack, stackAfterBack, stackAfterEnter, stackOf } from "./stack.ts";
import {
  GRAPH_API_PATH,
  GRAPH_API_ROUTE,
  graphApiPayload,
  handleApiRequest,
  registerApi,
  resolveRequestedRoot,
} from "./api.ts";
import {
  clampMaxNodes,
  clipGraph,
  DEFAULT_MAX_NODES,
  focusOf,
  graphPayload,
  MAX_EDGES,
  MAX_EDGE_DESCRIPTION,
  MAX_PAYLOAD_BYTES,
} from "./payload.ts";
import { recordIsolation, runtimeStatus, patchRuntimeStatus, setRuntimeStatus } from "./status.ts";
import { isLibrarySession } from "./isolation.ts";
import { reevaluateIsolation, registerAgentIsolation, __resetIsolationStatesForTest } from "./isolation-state.ts";


export const name = "knowledgenet";

/** `ctx.tools` 就绪之前不激活（prompts 与路由走可选 `ctx.get`，不加入 inject，避免缺少服务时永久 pending） */
export const inject = ["tools"];

interface MinimalContext {
  tools?: { register(definition: unknown): unknown };
  get?(name: string): unknown;
  on?(name: string, listener: (payload: unknown) => void): unknown;
}

interface MinimalContext {
  tools?: { register(definition: unknown): unknown };
  get?(name: string): unknown;
  on?(name: string, listener: (payload: unknown) => void): unknown;
  /** Cordis 的可选注入：服务就绪时在其作用域里执行回调，服务缺席也不会让插件 pending */
  inject?(names: string[], callback: (scoped: unknown) => unknown): unknown;
}

export function apply(ctx: MinimalContext, config: KnowledgeNetConfig = {}): void {
  const tools = ctx.tools;
  /** 本插件注册的全部工具名（隔离时整批 deny 用；直接从注册内容取，避免漏掉将来新增的工具） */
  const toolNames: string[] = [];
  if (tools !== undefined && typeof tools.register === "function") {
    for (const tool of createTools(config)) {
      tools.register(tool);
      const name = (tool as { name?: unknown }).name;
      if (typeof name === "string" && name !== "") toolNames.push(name);
    }
  }

  /*
   * **只在知识库会话里可见**：普通工作区把 `kn_*` 从该会话的可见工具里摘掉。
   *
   * 依据 harness 的工具注册表能力（`packages/core/tools/lib/types/index.d.ts`）：
   * `restrict({ deny })` = "Restrict global tools for the calling agent scope" ——
   * 在 **agent 作用域**调用，只影响那一个会话（同进程里别的知识库会话不受影响）。
   *
   * 判定在 `agent/created` 时刻**同步**做（不做扫描，只向上找 library.json），
   * 所以首轮就不会漏出去；拿不到 agent 作用域工具面时**只记录不报错**（工具照旧全局可见）。
   */
  if (typeof ctx.on === "function") {
    try {
      ctx.on("agent/created", (payload: unknown) => {
        try {
          const agent = (payload as { agent?: Record<string, unknown> } | undefined)?.agent;
          const cwd = sessionCwdOf({ agent }) ?? "";
          const reveal = (): boolean => isLibrarySession(cwd);
          const scoped = (agent?.ctx as { tools?: { restrict?: (filter: object) => unknown } } | undefined)?.tools;
          const hidden = registerAgentIsolation(
            cwd,
            () => {
              if (typeof scoped?.restrict !== "function") return null;
              try {
                return scoped.restrict({ deny: toolNames }) as () => void;
              } catch {
                return null;
              }
            },
            reveal(),
          );
          recordIsolation({
            sessionCwd: cwd === "" ? null : cwd,
            isLibrary: reveal(),
            restricted: hidden,
            ...(typeof scoped?.restrict === "function" ? {} : { reason: "no-agent-tools" }),
          });
        } catch (error) {
          recordIsolation({
            sessionCwd: null,
            isLibrary: false,
            restricted: false,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      });
    } catch {
      // 没有事件总线时跳过隔离（工具仍全局可见，但不影响任何功能）
    }
  }

  const prompts = registerPrompts(ctx, config);
  const startedAt = Date.now();
  // 先记「等待中」：真正的注册发生在 connection 就绪时（见下）。
  // 这样即使注册一直没发生，kn_status 也能说出原因，而不是留一句 not found。
  setRuntimeStatus({
    api: { path: GRAPH_API_PATH, registered: false, reason: "等待 connection 服务" },
    prompts,
    startedAt,
  });

  /*
   * 为什么用 `ctx.inject(['connection'], …)` 而不是 `ctx.get('connection')`：
   * connection 由 client/connection 的 RpcHost 在自己的 fiber 里提供，激活时刻从别的行
   * 用 get() 取不到（连 shipped 的 bundle/web-app 自己也是 inject 它，见
   * packages/bundle/web-app/src/index.ts:253）。inject 会在服务就绪后于可见作用域里执行回调，
   * 服务缺席时插件照样激活——正好符合「路由是可选能力」的定位。
   */
  if (typeof ctx.inject === "function") {
    try {
      ctx.inject(["connection"], (scoped: unknown) => {
        patchRuntimeStatus({ api: registerApi(scoped ?? ctx, config) });
      });
    } catch (error) {
      patchRuntimeStatus({
        api: {
          path: GRAPH_API_PATH,
          registered: false,
          reason: `ctx.inject('connection') 失败：${error instanceof Error ? error.message : String(error)}`,
        },
      });
    }
  } else {
    patchRuntimeStatus({ api: registerApi(ctx, config) });
  }
}

/**
 * 供插件自带测试直接调用（`Loader.unwrapExports` 取的是 `apply`/default，
 * 多出的具名导出不影响插件装载）。
 */
export const __internal = {
  NodeVfs,
  loadLibrary,
  peekLibrary,
  resolveLibraryRoot,
  isLibraryRoot,
  createLibrary,
  createNodeFromUi,
  addPrerequisiteFromUi,
  removePrerequisiteFromUi,
  applyPlanFromUi,
  undoPlanFromUi,
  listPlans,
  /** 测试用：放开/改回"本轮最多新建几个节点"的配额（生产按轮重置，见 creation-quota.ts） */
  setCreationQuotaForTest: __setCreationQuotaForTest,
  resetCreationQuotaForTurn,
  findCachedRoot,
  reevaluateIsolation,
  isLibrarySession,
  __resetIsolationStatesForTest,
  clipGraph,
  DEFAULT_MAX_NODES,
  MAX_EDGES,
  MAX_EDGE_DESCRIPTION,
  MAX_PAYLOAD_BYTES,
  runtimeStatus,
  foldStack,
  lastLibraryRoot,
  summarizeNode,
  search,
  neighborhood,
  resolveNodeArg,
  createTools,
  addPrerequisite,
  readNote,
  writeNote,
  currentContextText,
  registerPrompts,
  PROTOCOL_SECTION,
  foldStack,
  stackOf,
  stackAfterEnter,
  stackAfterBack,
  currentIdOf,
  graphPayload,
  graphApiPayload,
  handleApiRequest,
  registerApi,
  resolveRequestedRoot,
  clipGraph,
  clampMaxNodes,
  focusOf,
  GRAPH_API_PATH,
  GRAPH_API_ROUTE,
  runtimeStatus,
  patchRuntimeStatus,
};
