/**
 * 工具集：P0 只读（图谱 / 查重 / 读节点）+ P1 写入（建前置 / 进入 / 返回 / 写笔记）。
 *
 * 工具定义刻意写成**裸对象字面量**，不 import 任何 `@deepseek-ai/*`：
 * 这样 Host 半在 profile 里既不需要解析宿主包，也不会因为宿主版本变化而装不上。
 *
 * 两条踩过的坑，改这里之前先看：
 * 1. `parameters` 会被**原样**当作函数 schema 发给模型（`ctx.tools.register` 只校验
 *    `output.schema`），所以它必须是标准 JSON Schema（`{ type: "object", properties, required }`）。
 *    `defineTool` 才接受「字段表」写法（`{ query: { type: "string", required: true } }`），
 *    裸注册用那种写法会被模型 API 拒绝：`schema must be a JSON Schema of 'type: "object"'`。
 * 2. `output.schema.type` 必须是 JSON Schema 支持的取值；`{ type: "json" }` 会在注册时被
 *    `assertSupportedJsonSchema` 拒掉（`schema.type must be one of object/array/…`）。
 *
 * 数据一律来自调用方**会话工作区**定位到的知识库；客户端不读库，读图靠工具结果。
 */
import { RepositoryError } from "../vendor/upstream/data/errors.ts";
import type { KnowledgeNode } from "../vendor/upstream/data/types.ts";
import { normalizeTitle } from "../vendor/upstream/data/types.ts";
import { dependentsOf, prerequisitesOf } from "../vendor/upstream/data/engine.ts";
import { readNodeMeta } from "../vendor/upstream/data/v2/nodeMeta.ts";
import { readRelations } from "../vendor/upstream/data/v2/relations.ts";
import { listResources } from "../vendor/upstream/data/v2/resources.ts";
import { resolveNodeArg, search, summarizeNode, type NodeSummary } from "./graph.ts";
import { readNode as readV3Node } from "./v3/store.ts";
import {
  loadLibrary,
  resolveLibraryRoot,
  sessionCwdOf,
  type LibraryContext,
} from "./library.ts";
import { newPlanId, normalizePlanItems, readPlan, savePlan, type Plan } from "./plans.ts";
import { CREATION_QUOTA, CREATION_WINDOW_MS, takeCreationQuota } from "./creation-quota.ts";

import { addPrerequisite, readNote, writeNote } from "./mutate.ts";
import { graphPayload } from "./payload.ts";
import { GRAPH_API_PATH } from "../shared/routes.ts";
import { currentIdOf, stackAfterBack, stackAfterEnter, stackOf } from "./stack.ts";
import { runtimeStatus } from "./status.ts";

export interface KnowledgeNetConfig {
  /** 留空则按会话 cwd 向上找最近的 library.json */
  libraryRoot?: string | null;
  /** 返回给模型的节点上限（默认 400） */
  maxNodes?: number | null;
}

function renderJson(value: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(value) }];
}

function errorPayload(error: unknown, code = "unknown"): Record<string, unknown> {
  if (error instanceof RepositoryError) {
    // 「找不到库」与「找不到某个节点」是两种错，调用方按 code 决定提示什么
    const detail = error.detail as { kind?: string; createPath?: string } | undefined;
    /*
     * `library_missing` = 这个工作区还没建知识库（新模型：`<工作区>/.dsh_knowledge/` 不存在）。
     * 这与路由侧 errorBody 的映射保持一致：带上建议创建位置，模型可以据此告诉用户
     * "打开右侧「知识库图谱」就会自动创建"，而不是回报一个含糊的"找不到库"。
     */
    if (detail?.kind === "library_missing") {
      return {
        ok: false,
        error: {
          code: "library_missing",
          message: error.message,
          ...(typeof detail.createPath === "string" ? { createPath: detail.createPath } : {}),
        },
      };
    }
    const resolved = detail?.kind === "library" ? "library_unavailable" : error.code;
    return { ok: false, error: { code: resolved, message: error.message } };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: { code, message } };
}

function fail(code: string, message: string): Record<string, unknown> {
  return { ok: false, error: { code, message } };
}

/** 解析调用方会话对应的知识库；失败时抛 RepositoryError（由各工具转成可读错误） */
export async function openFor(
  exec: unknown,
  config: KnowledgeNetConfig,
  options: { refresh?: boolean } = {},
): Promise<LibraryContext> {
  const root = await resolveLibraryRoot(sessionCwdOf(exec), config.libraryRoot);
  const library = await loadLibrary(root, options);
  return { library, snapshot: library.snapshot };
}

export function createTools(config: KnowledgeNetConfig = {}): Array<Record<string, unknown>> {
  return [
    {
      name: "kn_list_graph",
      description:
        "列出当前知识库（DSH 工作区）里的知识点与依赖关系。方向约定：A → B 表示「为了理解 A，"
        + "需要先理解 B」，即 B 是 A 的前置知识。返回每个节点的标题、相对路径、学习状态与前置计数，"
        + "以及 goals（学习入口）。需要看某个节点周围的一跳关系时优先用它并传 focusId。",
      parameters: {
        type: "object",
        properties: {
          rootId: { type: "string", description: "可选：要聚焦的节点 id；不传则用第一个学习目标。" },
          maxNodes: { type: "number", description: "可选：返回节点上限，默认 400。" },
          refresh: { type: "boolean", description: "可选：为 true 时跳过缓存重新扫描知识库。" },
        },
      },
      output: { schema: { type: "object" }, render: (_args: unknown, value: unknown) => renderJson(value) },
      async execute(args: Record<string, unknown>, exec: unknown) {
        try {
          const context = await openFor(exec, config, { refresh: args.refresh === true });
          // 与 /api/knowledgenet.graph 共用同一份构造逻辑：卡片、面板、模型看到的永远同形
          return {
            ok: true,
            ...graphPayload(context, {
              rootId: args.rootId as string | undefined,
              maxNodes: args.maxNodes as number | undefined,
            }),
          };
        } catch (error) {
          return errorPayload(error, "library_unavailable");
        }
      },
    },
    {
      name: "kn_find_node",
      description:
        "【只读】只查库，**不创建任何节点、不改任何关系**；用户说「搜索 / 找找 / 有哪些」时就用它，"
        + "不要为了顺手补全而调用任何写入工具。"
        + "在知识库里按标题/别名查找知识点，用于「这个概念已经有了吗」这类复用判断。"
        + "返回 exact（标题完全一致）与 similar（相近候选）。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "要查找的标题或别名。" },
          limit: { type: "number", description: "可选：相似候选上限，默认 8。" },
        },
        required: ["query"],
      },
      output: { schema: { type: "object" }, render: (_args: unknown, value: unknown) => renderJson(value) },
      async execute(args: Record<string, unknown>, exec: unknown) {
        const query = typeof args.query === "string" ? normalizeTitle(args.query) : "";
        if (query === "") return fail("invalid_input", "query 不能为空");
        try {
          const context = await openFor(exec, config);
          const limit = typeof args.limit === "number" ? Math.min(Math.max(Math.trunc(args.limit), 1), 50) : 8;
          const found = search(context.snapshot, query, limit);
          return { ok: true, query, exact: found.exact, similar: found.similar };
        } catch (error) {
          return errorPayload(error, "library_unavailable");
        }
      },
    },
    {
      name: "kn_read_node",
      description:
        "读取一个知识点的完整信息：元数据、主文档正文（笔记）、它的前置知识与后继节点、"
        + "以及依赖边（存在库里的 `graph.json`，含「为什么依赖」的说明与来源）。"
        + "先用它拿到上下文，再决定要不要建新的前置知识。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "节点 id（与 path 二选一）。" },
          path: { type: "string", description: "节点相对知识库根的路径，例如 Nodes/注意力机制（与 id 二选一）。" },
          title: { type: "string", description: "标题（与 id/path 三选一，精确匹配）。" },
          noteMaxChars: { type: "number", description: "可选：正文返回字数上限，默认 6000。" },
        },
      },
      output: { schema: { type: "object" }, render: (_args: unknown, value: unknown) => renderJson(value) },
      async execute(args: Record<string, unknown>, exec: unknown) {
        try {
          const context = await openFor(exec, config);
          const node = resolveNodeArg(context.snapshot, {
            id: args.id as string | undefined,
            path: args.path as string | undefined,
            title: args.title as string | undefined,
          });
          if (node === undefined) {
            return fail("not_found", "没有找到该节点：请用 kn_find_node 确认真实标题或路径。");
          }

          /*
           * **v3 分支必须在 v2 读取之前**：v2 的 `readNodeMeta` 对 v3 节点（`Nodes/x.md`）
           * 会先抛 `node_missing` ✗ —— 放在后面就永远走不到（这是我第一版的错，集成测试抓到了 ✓）。
           */
          const noteMaxCharsV3 =
            typeof args.noteMaxChars === "number" && args.noteMaxChars > 0
              ? Math.trunc(args.noteMaxChars)
              : 6000;
          if (context.library.storage === "v3") {
            const read = await readV3Node(context.library.root, { id: node.id });
            if (!read.ok) return { ok: false, error: { code: read.code, message: read.message } };
            const full = read.node.note ?? "";
            const truncated = full.length > noteMaxCharsV3;
            return {
              ok: true,
              node: {
                ...summarizeNode(node),
                primaryDocument: node.relativePath,
                createdAt: node.createdAt,
                updatedAt: node.updatedAt,
              },
              note: {
                path: node.relativePath,
                text: truncated ? full.slice(0, noteMaxCharsV3) : full,
                truncated,
                byteLength: Buffer.byteLength(full, "utf8"),
                maxChars: noteMaxCharsV3,
              },
              prerequisites: prerequisitesOf(context.snapshot, node.id).map(summarizeNode),
              dependents: dependentsOf(context.snapshot, node.id).map(summarizeNode),
              relations: read.prerequisites.map((edge) => ({
                id: edge.id,
                toNodeId: edge.toId,
                toTitle: context.snapshot.nodes.find((item) => item.id === edge.toId)?.title ?? "",
                relationType: edge.type,
                description: edge.description ?? "",
                evidence:
                  edge.source === undefined
                    ? []
                    : [{
                      threadId: null,
                      messageId: edge.source.messageId ?? null,
                      snippet: edge.source.snippet ?? "",
                    }],
              })),
              resources: [],
            };
          }

          const nodeRel = node.relativePath;
          const meta = (await readNodeMeta(context.library.vfs, nodeRel)).meta;
          const noteMaxChars =
            typeof args.noteMaxChars === "number" && args.noteMaxChars > 0
              ? Math.trunc(args.noteMaxChars)
              : 6000;

          const note = await readNote(context, node, noteMaxChars);

          const relations = await readRelations(context.library.vfs, nodeRel, node.id).catch(() => null);
          const resources = await listResources(context.library.vfs, nodeRel).catch(() => []);

          return {
            ok: true,
            node: {
              ...summarizeNode(node),
              primaryDocument: meta.primaryDocument,
              createdAt: node.createdAt,
              updatedAt: node.updatedAt,
            },
            note: {
              path: note.path,
              text: note.text,
              truncated: note.truncated,
              byteLength: note.byteLength,
              maxChars: noteMaxChars,
            },
            prerequisites: prerequisitesOf(context.snapshot, node.id).map(summarizeNode),
            dependents: dependentsOf(context.snapshot, node.id).map(summarizeNode),
            relations:
              relations === null
                ? []
                : relations.file.outgoing.map((edge) => ({
                    id: edge.id,
                    toNodeId: edge.toNodeId,
                    toTitle: edge.toTitleSnapshot,
                    relationType: edge.type,
                    description: edge.description,
                    evidence: edge.evidence.map((item) => ({
                      threadId: item.threadId,
                      messageId: item.messageId,
                      snippet: item.snippet,
                    })),
                  })),
            resources: resources.map((resource) => ({
              id: resource.id,
              title: resource.title,
              type: resource.type,
            })),
          };
        } catch (error) {
          return errorPayload(error, "library_unavailable");
        }
      },
    },
    {
      name: "kn_add_prerequisite",
      description:
        "把「当前（或指定）知识点还不懂的一个概念」记成它的前置知识：A → B，B 是 A 的前置。"
        + "先查重：标题完全一致就复用已有节点；只命中相近候选时**不会**擅自建点，"
        + "而是返回 candidates 让你先问用户「复用哪个 / 还是新建」；确认是不同概念后带 create: true 重试。"
        + "从回答里划词得到的原文放进 evidence.snippet，这样关系会带上出处（可回溯到哪次回答）。"
        + "成环会被拒绝；节点元数据与关系文件都有修订号/哈希守卫，冲突时不会覆盖。"
        + "【写入纪律·必须遵守】这是**写操作**，且节点不存在时会真的新建："
        + "① 用户只要求“搜索/看看/有哪些”时**不得调用本工具**（用 kn_find_node / kn_list_graph）；"
        + "② 调用前要在回复里说明“准备把 B 作为 A 的前置（新建/复用）”，并**等用户同意**；"
        + "③ 同一轮最多用一次；需要一次处理多个概念时，**必须**改用 kn_propose_prerequisites 提交提案，"
        + "由用户在面板里审阅后再落地；④ 超过配额会被拒绝并提示你改用提案。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "要设为前置的概念标题（从回答里选中的文字归一化后）。" },
          fromId: { type: "string", description: "可选：归属节点（依赖方）的 id；缺省用会话当前学习节点。" },
          fromPath: { type: "string", description: "可选：归属节点的相对路径（与 fromId 二选一）。" },
          create: { type: "boolean", description: "可选：为 true 时明确要求新建节点（跳过「相近候选先确认」）。" },
          relationType: { type: "string", description: "可选：关系类型，默认 prerequisite。" },
          description: { type: "string", description: "可选：为什么 A 需要 B（回来后恢复上下文用）。" },
          snippet: { type: "string", description: "可选：触发这次建点的原文片段（来源记录）。" },
          question: { type: "string", description: "可选：当时用户的问题（来源记录）。" },
          messageId: { type: "string", description: "可选：来源消息 id（来源记录）。" },
        },
        required: ["title"],
      },
      output: { schema: { type: "object" }, render: (_args: unknown, value: unknown) => renderJson(value) },
      async execute(args: Record<string, unknown>, exec: unknown) {
        try {
          const context = await openFor(exec, config);
          const sessionId = (exec as { agent?: { id?: string } } | undefined)?.agent?.id ?? null;
          /*
           * 【硬上限】新建节点必须一次一个、且同一会话在窗口内不超过配额。
           * 这是**代码里的**约束（不靠模型自觉）：超了就拒绝，并明确让它改用提案工具。
           * 实测背景：用户只说"搜索相关知识点"，模型却连续建了大量节点。
           */
          const fromAgent = (exec as { agent?: unknown } | undefined)?.agent !== undefined;
          // 配额只对"真的由 agent 发起"的调用生效：直接调用（测试/脚本）不受限
          if (args.create === true && fromAgent) {
            const verdict = takeCreationQuota(sessionId);
            if (verdict.ok !== true) {
              return {
                ok: false,
                error: {
                  code: "creation_quota_exceeded",
                  message:
                    `本轮已新建 ${verdict.used} 个节点（窗口 ${Math.round(CREATION_WINDOW_MS / 60000)} 分钟内上限 `
                    + `${CREATION_QUOTA} 个），已拒绝继续新建。`
                    + "请先向用户说明要建哪些，并用 kn_propose_prerequisites 提交提案，由用户在面板里审阅落地。",
                },
                quota: { used: verdict.used, limit: CREATION_QUOTA },
              };
            }
          }
          const result = await addPrerequisite(
            context,
            {
              title: String(args.title ?? ""),
              fromId: args.fromId as string | undefined,
              fromPath: args.fromPath as string | undefined,
              create: args.create === true,
              relationType: args.relationType as string | undefined,
              description: args.description as string | undefined,
              evidence: {
                sessionId,
                messageId: (args.messageId as string | undefined) ?? null,
                snippet: args.snippet as string | undefined,
                question: (args.question as string | undefined) ?? null,
              },
            },
            { currentId: currentIdOf(sessionOf(exec)) },
          );
          // 写操作会让库缓存失效；立刻重扫一次，保证紧随其后的逐轮注入仍然拿得到节点标题
          if (result.ok === true) await refreshQuietly(context.library.root);
          return { ...result, currentStack: stackOf(sessionOf(exec)) };
        } catch (error) {
          return errorPayload(error, "library_unavailable");
        }
      },
    },
    {
      name: "kn_enter_node",
      description:
        "进入一个知识点（把它压到学习栈顶）：之后「当前知识点」就是它，逐轮注入的上下文与后续建前置都会以它为准。"
        + "沿依赖往下学（先弄懂前置）时用它；学完用 kn_back 回到上一层。标题/路径/id 都可以，"
        + "栈从会话事件流折叠得到，因此换会话、恢复、fork 都不会丢。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "节点 id（与 path/title 三选一）。" },
          path: { type: "string", description: "节点相对知识库根的路径。" },
          title: { type: "string", description: "节点标题（精确匹配）。" },
        },
      },
      output: { schema: { type: "object" }, render: (_args: unknown, value: unknown) => renderJson(value) },
      async execute(args: Record<string, unknown>, exec: unknown) {
        try {
          const context = await openFor(exec, config);
          const node = resolveNodeArg(context.snapshot, {
            id: args.id as string | undefined,
            path: args.path as string | undefined,
            title: args.title as string | undefined,
          });
          if (node === undefined) {
            return fail("not_found", "没有找到该节点：请用 kn_find_node 确认真实标题或路径。");
          }
          const session = sessionOf(exec);
          const stack = stackAfterEnter(session, node.id);
          return {
            ok: true,
            current: summarizeNode(node),
            stackDepth: stack.length,
            prerequisites: prerequisitesOf(context.snapshot, node.id).map((item) => ({
              id: item.id,
              title: item.title,
              status: item.status,
            })),
            dependents: dependentsOf(context.snapshot, node.id).map((item) => ({
              id: item.id,
              title: item.title,
              status: item.status,
            })),
            note: "已进入该节点；返回上一层用 kn_back。",
          };
        } catch (error) {
          return errorPayload(error, "library_unavailable");
        }
      },
    },
    {
      name: "kn_back",
      description: "弹出学习栈顶，回到上一层知识点（深度优先学习里的「返回」）。返回新的当前节点；栈空时返回 ok: false。",
      parameters: { type: "object", properties: {} },
      output: { schema: { type: "object" }, render: (_args: unknown, value: unknown) => renderJson(value) },
      async execute(_args: Record<string, unknown>, exec: unknown) {
        try {
          const context = await openFor(exec, config);
          const session = sessionOf(exec);
          const { previous, stack } = stackAfterBack(session);
          if (previous === null) {
            return fail("empty_stack", "学习栈是空的：还没有用 kn_enter_node 进入过任何知识点。");
          }
          const current = stack.length === 0
            ? null
            : context.snapshot.nodes.find((node) => node.id === stack[stack.length - 1]);
          return {
            ok: true,
            left: previous,
            current: current === undefined || current === null ? null : summarizeNode(current),
            stackDepth: stack.length,
          };
        } catch (error) {
          return errorPayload(error, "library_unavailable");
        }
      },
    },
    {
      name: "kn_write_note",
      description:
        "写当前（或指定）知识点的主文档正文。默认按「刚读过」处理：先取磁盘上的修订号再写，"
        + "期间被外部（编辑器/桌面版）改过就拒绝并返回 actualRevision，绝不静默覆盖；"
        + "要强制覆盖请显式带上刚读到的 expectedRevision（仍然会被哈希守卫拦一次）。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "新的主文档正文（整体替换）。" },
          id: { type: "string", description: "可选：节点 id；缺省用会话当前学习节点。" },
          path: { type: "string", description: "可选：节点相对路径。" },
          title: { type: "string", description: "可选：节点标题。" },
          expectedRevision: { type: "number", description: "可选：手上那份的文档修订号。" },
        },
        required: ["text"],
      },
      output: { schema: { type: "object" }, render: (_args: unknown, value: unknown) => renderJson(value) },
      async execute(args: Record<string, unknown>, exec: unknown) {
        try {
          const context = await openFor(exec, config);
          const session = sessionOf(exec);
          const explicit = resolveNodeArg(context.snapshot, {
            id: args.id as string | undefined,
            path: args.path as string | undefined,
            title: args.title as string | undefined,
          });
          const currentId = currentIdOf(session);
          const node: KnowledgeNode | undefined = explicit
            ?? (currentId === null ? undefined : context.snapshot.nodes.find((item) => item.id === currentId));
          if (node === undefined) {
            return fail(
              "invalid_input",
              "没有指定节点，且会话还没有当前学习节点：先用 kn_enter_node 进入一个知识点。",
            );
          }
          const expected = typeof args.expectedRevision === "number" ? Math.trunc(args.expectedRevision) : undefined;
          const result = await writeNote(context, node, String(args.text ?? ""), expected);
          if (result.ok === true) await refreshQuietly(context.library.root);
          return result;
        } catch (error) {
          return errorPayload(error, "library_unavailable");
        }
      },
    },
    {
      name: "kn_status",
      description:
        "诊断用工具：只在面板打不开、或怀疑本插件没生效时调用。报告运行时状态——面板数据路由是否已注册、"
        + "逐轮注入是否生效、当前学习栈，以及知识库能否定位。日常学习不需要它。",
      parameters: { type: "object", properties: {} },
      output: { schema: { type: "object" }, render: (_args: unknown, value: unknown) => renderJson(value) },
      async execute(_args: Record<string, unknown>, exec: unknown) {
        const status = runtimeStatus();
        const session = sessionOf(exec);
        const stack = stackOf(session);
        let library: Record<string, unknown> | null = null;
        let libraryError: Record<string, unknown> | null = null;
        try {
          const context = await openFor(exec, config);
          library = {
            root: context.library.root,
            name: context.library.manifest.title,
            nodes: context.snapshot.nodes.length,
            edges: context.snapshot.edges.length,
            goals: context.snapshot.goals.length,
            issues: context.library.report.issues.length,
          };
        } catch (error) {
          const payload = errorPayload(error, "library_unavailable");
          libraryError = (payload.error ?? null) as Record<string, unknown> | null;
        }
        const routeRegistered = status?.api?.registered === true;
        return {
          ok: true,
          status: status ?? null,
          route: GRAPH_API_PATH,
          routeRegistered,
          probes: status?.probes ?? [],
          clientDiag: status?.clientDiag ?? [],
          library,
          libraryError,
          currentStack: stack,
          currentNodeId: stack.length > 0 ? stack[stack.length - 1] : null,
          hint: routeRegistered
            ? "面板数据路由已注册。"
            : "面板数据路由**未注册**：宿主模块只有重启 DSH 才会重新加载（刷新页面只更新客户端半，"
              + "所以面板会显示纯文本 not found）。重启后若仍未注册，请把本结果里的 status 发出来。",
        };
      },
    },
    {
      name: "kn_propose_prerequisites",
      description:
        "提交一份「新建/挂接前置」的**提案**：只写计划文件，**不建节点、不改关系**。"
        + "只要需要一次处理多个概念（或用户还没明确同意逐个建），就用它而不是反复调 kn_add_prerequisite。"
        + "返回 planId 与条目清单；**落地只能由用户在「知识库图谱」面板里点击完成，你不能自行落地**。"
        + "提交后请把 planId 与清单告诉用户，等用户审阅。",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            description: "提案条目：每条的 {fromId, title}，可选 description（为什么 A 需要 B）与 snippet（原文出处）。",
            items: {
              type: "object",
              properties: {
                fromId: { type: "string", description: "归属节点（A → B 里的 A）的 id。" },
                title: { type: "string", description: "前置概念标题（要新建或复用的那个）。" },
                description: { type: "string", description: "可选：为什么 A 需要 B。" },
                snippet: { type: "string", description: "可选：触发它的原文片段。" },
              },
              required: ["fromId", "title"],
            },
          },
          summary: { type: "string", description: "可选：一句话说明为什么提这些。" },
          question: { type: "string", description: "可选：当时的用户问题（来源记录）。" },
        },
        required: ["items"],
      },
      output: { schema: { type: "object" }, render: (_args: unknown, value: unknown) => renderJson(value) },
      async execute(args: Record<string, unknown>, exec: unknown) {
        try {
          const context = await openFor(exec, config);
          const raw = Array.isArray(args.items) ? (args.items as Array<Record<string, unknown>>) : [];
          const items = normalizePlanItems(
            raw.map((item) => ({
              fromId: String(item.fromId ?? ""),
              title: String(item.title ?? ""),
              description: item.description as string | undefined,
              snippet: item.snippet as string | undefined,
            })),
          );
          if (items.length === 0) {
            return { ok: false, error: { code: "empty_plan", message: "提案里没有有效条目（每条都要 fromId + title）" } };
          }
          // 提案时就已存在同名节点的，标注出来：落地时**复用**而不是新建
          for (const item of items) {
            const hit = search(context.snapshot, item.title, 3).exact;
            if (hit !== null) item.existingNodeId = hit.id;
          }
          const sessionId = (exec as { agent?: { id?: string } } | undefined)?.agent?.id ?? null;
          const plan: Plan = {
            id: newPlanId(),
            createdAt: Date.now(),
            items,
            ...(sessionId === null ? {} : { sessionId }),
            ...(typeof args.summary === "string" && args.summary !== "" ? { summary: args.summary } : {}),
            ...(typeof args.question === "string" && args.question !== "" ? { question: args.question } : {}),
          };
          await savePlan(context.library.root, plan);
          return {
            ok: true,
            planId: plan.id,
            items: items.map((item) => ({
              id: item.id,
              fromId: item.fromId,
              title: item.title,
              willReuseExisting: item.existingNodeId !== undefined,
            })),
            note: "提案已提交。请在「知识库图谱」面板里审阅后由用户点击落地；提案本身没有创建任何节点。",
          };
        } catch (error) {
          return errorPayload(error, "library_unavailable");
        }
      },
    },
    {
      name: "kn_plan_status",
      description:
        "查询一份提案的状态（**只读**，不写任何东西）：是否已落地、新建了哪些节点、有没有失败条目。"
        + "用于向用户汇报「你确认后建了哪几个」。",
      parameters: {
        type: "object",
        properties: { planId: { type: "string", description: "kn_propose_prerequisites 返回的计划 id。" } },
        required: ["planId"],
      },
      output: { schema: { type: "object" }, render: (_args: unknown, value: unknown) => renderJson(value) },
      async execute(args: Record<string, unknown>, exec: unknown) {
        try {
          const context = await openFor(exec, config);
          const plan = await readPlan(context.library.root, String(args.planId ?? ""));
          if (plan === null) return { ok: false, error: { code: "plan_unknown", message: "找不到这份提案" } };
          return {
            ok: true,
            planId: plan.id,
            itemCount: plan.items.length,
            applied: plan.applied !== undefined && plan.applied !== null,
            created: plan.applied?.created ?? [],
            reused: plan.applied?.reused ?? [],
            failed: plan.applied?.failed ?? [],
          };
        } catch (error) {
          return errorPayload(error, "library_unavailable");
        }
      },
    },
  ];
}

// 配额放在轻量模块里（见 creation-quota.ts 的说明：直接放这里会让单测无法导入）
export { CREATION_QUOTA, CREATION_WINDOW_MS, takeCreationQuota, resetCreationQuotaForTurn } from "./creation-quota.ts";
/** 取调用方会话对象（`agent.session`）；测试与非 Agent 调用返回 undefined */
export function sessionOf(exec: unknown): unknown {
  return (exec as { agent?: { session?: unknown } } | undefined)?.agent?.session;
}

/** 写完之后补一次扫描：失败也不影响已经落盘的写入，所以静默 */
async function refreshQuietly(root: string): Promise<void> {
  await loadLibrary(root, { refresh: true }).catch(() => undefined);
}

