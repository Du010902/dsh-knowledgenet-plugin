import { readUnderstanding, setUnderstanding } from "./understanding.ts";
/**
 * 宿主侧 HTTP（Fetch）路由：给**常驻面板**取数据用。
 *
 * 为什么需要它：编译型插件的客户端半没有 `host.call`，也用不了仓内生成的 `ctx.remote.*`；
 * 但 DSH 提供了官方通道 —— `ctx.connection.fetch.register(...)` 注册精确 Fetch 路由，
 * 客户端半用 document-relative 的 `fetch('api/...')` 读（浏览器走同源路由、Electron 走 IPC 桥）。
 * shipped 的 `/export`（session-log-export）就是这么做的，这里照同一套写。
 *
 * 载荷与 `kn_list_graph` **共用** `graphPayload`：卡片、面板、模型看到的永远同形同源。
 */

import { RepositoryError } from "../vendor/upstream/data/errors.ts";
import { GRAPH_API_PATH, GRAPH_API_ROUTE } from "../shared/routes.ts";
import { createLibrary, describeFolder, isLibraryRoot, invalidateLibrary, lastLibraryRoot, loadLibrary, resolveLibraryRoot } from "./library.ts";
import { addPrerequisiteFromUi, applyPlanFromUi, removeNodeFromUi, removePrerequisiteFromUi, searchTargets, undoPlanFromUi } from "./graph-edit.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { imageDirAbsolute, resolveImageTarget, withNameSuffix } from "./note-images-host.ts";
import {
  contentTypeForImage,
  extensionFromMime,
  imageDisplayUrl,
  imageRelativePath,
  parseDataUrl,
  sanitizeImageName,
} from "../shared/note-images.ts";
import { createSubdirectory } from "./create-dir.ts";
import { createNodeFromUi } from "./mutate.ts";
import { readNodeDocument, saveNodeDocument } from "./node-document.ts";
/* 轻量格式检查住在 store 里（只读 library.json ✓；库模块带 Node 参数属性 ⇒ 单测导不进来 ✗） */
import { checkLibraryFormat } from "./v3/store.ts";
import { isLibrarySession } from "./isolation.ts";
import { reevaluateIsolation } from "./isolation-state.ts";
import { listPlans } from "./plans.ts";
import { graphPayload } from "./payload.ts";
import { recordClientDiag, recordNoteApi, recordProbe } from "./status.ts";
import type { KnowledgeNetConfig } from "./tools.ts";

// 常量定义在 src/shared/routes.ts（客户端半也要用，而它不能引入宿主模块图）
export { GRAPH_API_PATH, GRAPH_API_ROUTE };

const PANEL_HINT =
  "还没有可用的知识库：请把「含 library.json 的知识库根目录」作为当前会话的工作区，"
  + "或者在上方输入框里填一个库根路径。";

interface SessionLike {
  session?: { header?: { cwd?: string } };
}

interface ConnectionRegistrar {
  get?(name: string): unknown;
  agents?: { get?(id: string): { session?: { header?: { cwd?: unknown } } } | undefined };
  /** 会话存储：`Session.header.cwd`。**全新会话还没有 agent，但它已经在会话存储里** */
  sessions?: { get?(id: string): { header?: { cwd?: unknown } } | undefined };
}

function jsonResponse(body: unknown, status = 200, head = false): Response {
  const text = JSON.stringify(body);
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  };
  if (head) return new Response(null, { status, headers });
  return new Response(text, { status, headers });
}

function errorBody(error: unknown): { code: string; message: string; createPath?: string } {
  if (error instanceof RepositoryError) {
    const detail = error.detail as { kind?: string; createPath?: string } | undefined;
    /*
     * `library_missing` = "这个工作区还没建知识库"，是**正常状态**、不是错误。
     * 面板据此**静默创建** `<工作区>/.dsh_knowledge/`（用户要求），所以把建议位置一起带上。
     */
    if (detail?.kind === "library_missing") {
      return {
        code: "library_missing",
        message: error.message,
        ...(typeof detail.createPath === "string" ? { createPath: detail.createPath } : {}),
      };
    }
    return {
      code: detail?.kind === "library" ? "library_unavailable" : error.code,
      message: error.message,
    };
  }
  return { code: "unknown", message: error instanceof Error ? error.message : String(error) };
}

/**
 * 会话 id → 该会话工作区的 cwd。
 *
 * 两条来源，缺一不可：
 * - `ctx.agents.get(id).session.header.cwd`：与工具侧 `sessionCwdOf` 一致的活会话路径；
 * - `ctx.sessions.get(id).header.cwd`：**刚建、还没 agent 的会话只在这里**——
 *   只有第一条时，"新会话"会被判成"问不到 cwd"，进而被误判成"工作区不是知识库"。
 */
function cwdOfSession(ctx: ConnectionRegistrar, sessionId: string): string | undefined {
  const pick = (value: unknown): string | undefined => {
    const shaped = value as
      | { session?: { header?: { cwd?: unknown } }; header?: { cwd?: unknown } }
      | undefined;
    const cwd = shaped?.session?.header?.cwd ?? shaped?.header?.cwd;
    return typeof cwd === "string" && cwd !== "" ? cwd : undefined;
  };
  try {
    const fromAgent = pick(ctx.agents?.get?.(sessionId));
    if (fromAgent !== undefined) return fromAgent;
  } catch {
    // 走下一来源
  }
  try {
    return pick(ctx.sessions?.get?.(sessionId));
  } catch {
    return undefined;
  }
}

/** 库根解析结果：`sessionUnknown` 区分「宿主还不知道这个会话的工作区」与「工作区不是知识库」 */
export interface RootResolution {
  root: string | null;
  sessionUnknown: boolean;
  /** 解析时用到的会话 cwd（探针留痕用） */
  cwd?: string | null;
  /**
   * 「这个工作区还没建知识库」时带上建议创建位置。
   *
   * 为什么必须从这里带出去：`resolveLibraryRoot` 抛的错误里本来就有 `library_missing` +
   * `createPath`，但这里曾用 `.catch(() => null)` 把它抹掉 ✗，于是路由只能回落到
   * `library_unavailable` + 旧提示 ⇒ **面板的"首次打开静默创建"永远不会被触发**（实测踩到）。
   */
  missing?: { createPath: string } | undefined;
}

/** 从一个错误里读出"该在哪儿建库"（不是这种错就返回 undefined） */
function missingFrom(error: unknown): { createPath: string } | undefined {
  const detail = (error as { detail?: { kind?: string; createPath?: string } } | undefined)?.detail;
  if (detail?.kind !== "library_missing") return undefined;
  return typeof detail.createPath === "string" && detail.createPath !== ""
    ? { createPath: detail.createPath }
    : undefined;
}

/**
 * 库根解析顺序：显式 root → 会话 cwd → 插件配置 → 「最近装载过的库」。
 *
 * 但**显式给 `sessionId` 是个强声明**：它表示「问的是这个会话的作用域」。这种情况下
 * 找不到库就如实返回 null，绝不拿别的会话用过的库顶上——否则「这个工作区是不是知识库」
 * 这类判断会被一个无关的库污染（右侧栏要不要显示入口卡片就靠它）。
 */
export async function resolveRequestedRoot(
  ctx: ConnectionRegistrar,
  config: KnowledgeNetConfig,
  options: { root?: string | null; sessionId?: string | null } = {},
): Promise<RootResolution> {
  const explicit = typeof options.root === "string" ? options.root.trim() : "";
  if (explicit !== "") {
    if (options.exact === true) {
      // 「这个目录本身是不是知识库」：只看这一层，**不向上找**
      // （把库的子目录开成工作区时，那按约定只是普通工作区）
      const isRoot = await isLibraryRoot(explicit);
      return { root: isRoot ? explicit : null, sessionUnknown: false, cwd: explicit };
    }
    /*
     * 显式 root 的两种语义都要接受（新模型下客户端会把**工作区路径**放这里）：
     * ① 它本身就是库根（`<root>/library.json`）⇒ 直接用它（显式配置的语义）；
     * ② 它是**工作区**（里面有 `.dsh_knowledge/`）⇒ 解析出子目录里的库根。
     * ② 还带着 `missing`：工作区还没建库时把创建位置带出去，面板据此静默创建。
     */
    if (await isLibraryRoot(explicit)) {
      return { root: explicit, sessionUnknown: false, cwd: explicit };
    }
    try {
      return { root: await resolveLibraryRoot(explicit, null), sessionUnknown: false, cwd: explicit };
    } catch (error) {
      return { root: null, sessionUnknown: false, cwd: explicit, missing: missingFrom(error) };
    }
  }
  const asked = typeof options.sessionId === "string" && options.sessionId !== "";
  if (asked) {
    const cwd = cwdOfSession(ctx, options.sessionId as string);
    // 问到了 cwd：这里找不到库就是「工作区不是知识库」——但要把"该在哪儿建"带出去，
    // 否则面板收不到 `library_missing`，静默创建永远不会发生（新模型的核心体验）。
    if (cwd !== undefined) {
      try {
        return { root: await resolveLibraryRoot(cwd, config.libraryRoot), sessionUnknown: false, cwd };
      } catch (error) {
        return { root: null, sessionUnknown: false, cwd, missing: missingFrom(error) };
      }
    }
    // 没问到 cwd：宿主还不知道这个会话的工作区（例如会话刚建）。**不要**回落，
    // 否则会把别的库当成这个会话的答案；如实上报，让调用方稍后重问。
    return { root: null, sessionUnknown: true, cwd: null };
  }
  if (typeof config.libraryRoot === "string" && config.libraryRoot.trim() !== "") {
    const configured = await resolveLibraryRoot(undefined, config.libraryRoot).catch(() => null);
    if (configured !== null) return { root: configured, sessionUnknown: false, cwd: null };
  }
  return { root: lastLibraryRoot() ?? null, sessionUnknown: false, cwd: null };
}

/** 处理一次面板数据请求（导出以便单测直接调用，不必起 HTTP） */
export async function graphApiPayload(
  ctx: ConnectionRegistrar,
  config: KnowledgeNetConfig,
  request: { url: string; method?: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  let url: URL;
  try {
    url = new URL(request.url, "http://dsh.local/");
  } catch {
    return { status: 200, body: { ok: false, error: { code: "invalid_url", message: String(request.url) } } };
  }

  
  const askedSession = url.searchParams.get("sessionId");
  const askedRoot = url.searchParams.get("root");

  // 只读的目录状态探测：客户端据此决定"弹创建确认"还是"直接给出为什么不能创建"
  if (url.searchParams.get("probe") === "1" && askedRoot !== null && askedRoot.trim() !== "") {
    const folder = await describeFolder(askedRoot);
    recordProbe({ at: Date.now(), sessionId: askedSession, root: askedRoot, cwd: folder.state, code: `folder_${folder.state}` });
    return { status: 200, body: { ok: true, folder } };
  }

  /** 每次回答都留痕：入口卡片没出现时，`kn_status` 能直接说出客户端问了什么、宿主答了什么 */
  const answer = (body: Record<string, unknown>): { status: number; body: Record<string, unknown> } => {
    const error = body.error as { code?: string } | undefined;
    const code = body.ok === true ? "library" : (error?.code ?? "unknown");
    recordProbe({
      at: Date.now(),
      sessionId: askedSession,
      root: askedRoot,
      cwd: lastResolutionCwd,
      code,
    });
    return { status: 200, body };
  };
  let lastResolutionCwd: string | null = null;

  try {
    const resolution = await resolveRequestedRoot(ctx, config, {
      root: askedRoot,
      sessionId: askedSession,
      // 「这个目录本身是不是知识库」——客户端用它做入口门禁，必须拒绝"库里的子目录"
      exact: url.searchParams.get("exact") === "1",
    });
    lastResolutionCwd = resolution.cwd ?? null;
    if (resolution.root === null) {
      // 三种"没有库"必须分开：
      // - session_unknown：宿主还不知道这个会话的工作区 ⇒ 稍后重问；
      // - library_missing：工作区**还没建**知识库 ⇒ 带创建位置，让面板静默创建（新模型）；
      // - library_unavailable：其它情况（例如显式 root 指向的不是库）。
      const missing = resolution.missing;
      if (!resolution.sessionUnknown && missing !== undefined) {
        return answer({
          ok: false,
          error: {
            code: "library_missing",
            message: `这个工作区还没有知识库：可以创建在 ${missing.createPath}`,
            createPath: missing.createPath,
          },
        });
      }
      return answer(
        resolution.sessionUnknown
          ? {
            ok: false,
            error: {
              code: "session_unknown",
              message: "宿主还没拿到这个会话的工作区路径（会话刚建或尚未开始），稍后重问即可。",
            },
          }
          : { ok: false, error: { code: "library_unavailable", message: PANEL_HINT } },
      );
    }
    const root = resolution.root;
    const refresh = url.searchParams.get("refresh") === "1";
    const library = await loadLibrary(root, { refresh });
    const focusId = url.searchParams.get("focusId");
    const maxNodesRaw = url.searchParams.get("maxNodes");
    const maxNodes = maxNodesRaw === null || maxNodesRaw.trim() === "" ? undefined : Number(maxNodesRaw);
    const payload = graphPayload(
      { library, snapshot: library.snapshot },
      {
        focusId: focusId === null || focusId.trim() === "" ? undefined : focusId.trim(),
        maxNodes: Number.isFinite(maxNodes as number) ? (maxNodes as number) : undefined,
      },
    );
    return answer({ ok: true, ...payload, understanding: await readUnderstanding(root) });
  } catch (error) {
    return answer({ ok: false, error: errorBody(error) });
  }
}

/**
 * 处理路由请求：
 * - GET/HEAD 取图数据（`exact=1` 时只认目录本身是不是知识库）；
 * - POST `{kind:'diag'}` 收客户端结构指纹；
 * - POST `{kind:'create-library', root, title?}` 把一个目录初始化为知识库（**绝不覆盖**已有清单）。
 *
 * 抽成独立函数是为了能直接单测——不必真的起 HTTP。
 */
/**
 * **取图**（GET/HEAD ✓）：把库内相对路径解析成图片目录里的文件 ✓，越界一律拒 ✗。
 */
async function imageBytesResponse(
  ctx: ConnectionRegistrar,
  config: KnowledgeNetConfig,
  options: { path: unknown; root: unknown; sessionId: unknown; head: boolean },
): Promise<{ status: number; body: Record<string, unknown>; raw?: Response }> {
  const resolution = await resolveRequestedRoot(ctx, config, {
    root: typeof options.root === "string" ? options.root : "",
    sessionId: typeof options.sessionId === "string" ? options.sessionId : "",
  }).catch(() => null);
  const root = resolution?.root ?? null;
  if (root === null) {
    return { status: 404, body: { ok: false, error: { code: "library_missing", message: PANEL_HINT } } };
  }
  const absolute = resolveImageTarget(root, config.imageDir, options.path);
  if (absolute === null) {
    return { status: 400, body: { ok: false, error: { code: "invalid_path", message: "图片路径不合法" } } };
  }
  try {
    const bytes = await readFile(absolute);
    const name = absolute.split(/[\\/]/).pop() ?? "image.png";
    return {
      status: 200,
      body: {},
      raw: new Response(options.head ? null : bytes, {
        status: 200,
        headers: { "content-type": contentTypeForImage("", name), "cache-control": "no-cache" },
      }),
    };
  } catch {
    return { status: 404, body: { ok: false, error: { code: "image_missing", message: "找不到这张图片" } } };
  }
}

/**
 * **存图**（POST `{kind:'image-save', name, dataUrl, root?, sessionId?}` ✓）。
 *
 * 落盘位置 = `imageDirAbsolute(库根, config.imageDir)` ✓ ⇒ 默认就是 `<库根>/image/` ✓
 * （用户要的 `.dsh_knowledge/image/` ✓；`imageDir` 可配置 ✓）。
 * 重名**不覆盖** ✓：加 4 位随机后缀 ✓。
 * 返回值给的是**库内相对路径** ✓（客户端把这一串写进 Markdown ✓）。
 */
async function saveImageRequest(
  ctx: ConnectionRegistrar,
  config: KnowledgeNetConfig,
  options: { name: unknown; dataUrl: unknown; root: unknown; sessionId: unknown },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const parsed = parseDataUrl(options.dataUrl);
  if (parsed === null) {
    return {
      status: 200,
      body: { ok: false, error: { code: "bad_image", message: "图片数据不合法或超过 12 MiB" } },
    };
  }
  const resolution = await resolveRequestedRoot(ctx, config, {
    root: typeof options.root === "string" ? options.root : "",
    sessionId: typeof options.sessionId === "string" ? options.sessionId : "",
  }).catch(() => null);
  const root = resolution?.root ?? null;
  if (root === null) {
    return { status: 200, body: { ok: false, error: { code: "library_missing", message: PANEL_HINT } } };
  }
  const extension = extensionFromMime(parsed.mime);
  const wanted = sanitizeImageName(options.name, extension);
  const directory = imageDirAbsolute(root, config.imageDir);
  await mkdir(directory, { recursive: true });
  let target = resolveImageTarget(root, config.imageDir, wanted);
  if (target === null) {
    return { status: 200, body: { ok: false, error: { code: "invalid_name", message: "文件名不合法" } } };
  }
  // 独占创建避免同时插图时覆盖已有文件；只对文件名碰撞重试。
  for (let attempt = 0; ; attempt += 1) {
    try {
      await writeFile(target, parsed.bytes, { flag: "wx" });
      break;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST" || attempt >= 5) throw error;
      const renamed = sanitizeImageName(withNameSuffix(wanted, randomBytes(8).toString("hex")), extension);
      const next = resolveImageTarget(root, config.imageDir, renamed);
      if (next === null) throw new Error("Invalid image destination");
      target = next;
    }
  }
  const fileName = target.split(/[\\/]/).pop() ?? wanted;
  return {
    status: 200,
    body: {
      ok: true,
      path: imageRelativePath(config.imageDir, fileName),
      bytes: parsed.bytes.byteLength,
      /* 顺手给一条可显示的 URL ✓（客户端也可以自己拼 ✓，两边用同一个函数 ✓） */
      url: imageDisplayUrl(GRAPH_API_ROUTE, imageRelativePath(config.imageDir, fileName)),
    },
  };
}
export async function handleApiRequest(
  ctx: ConnectionRegistrar,
  config: KnowledgeNetConfig,
  request: { url: string; method?: string; json?: () => Promise<unknown> },
): Promise<{ status: number; body: Record<string, unknown>; raw?: Response }> {
  const method = (request.method ?? "GET").toUpperCase();
  /*
   * **取图**（GET ✓）：`?kind=image&path=image/xxx.png` ⇒ 直接回字节 ✓。
   * —— 笔记的 Markdown 里存的是**库内相对路径** ✓，显示时由编辑器换成这条同源 URL ✓
   * （用户要求"图片默认存到 `.dsh_knowledge/image/`，路径可配置"✓；见 `src/shared/note-images.ts` ✓）。
   * 这条必须在下面那句"非 POST ⇒ 当图谱载荷"**之前** ✓。
   */
  if (method === "GET" || method === "HEAD") {
    const imageRequest = new URL(request.url).searchParams;
    if (imageRequest.get("kind") === "image") {
      return await imageBytesResponse(ctx, config, {
        path: imageRequest.get("path"),
        root: imageRequest.get("root"),
        sessionId: imageRequest.get("sessionId"),
        head: method === "HEAD",
      });
    }
    return await graphApiPayload(ctx, config, { url: request.url, method });
  }

  let payload: unknown;
  try {
    payload = await request.json?.();
  } catch (error) {
    return { status: 200, body: { ok: false, error: { code: "bad_body", message: String(error) } } };
  }
  const record = payload as {
    kind?: unknown;
    name?: unknown;
    dataUrl?: unknown;
    area?: unknown;
    outcome?: unknown;
    root?: unknown;
    title?: unknown;
    fromId?: unknown;
    edgeId?: unknown;
    sessionId?: unknown;
    create?: unknown;
    description?: unknown;
    snippet?: unknown;
    nodeId?: unknown;
    question?: unknown;
    query?: unknown;
    /** 节点正文编辑：完整正文与读取时的整文件指纹 ✓ */
    text?: unknown;
    hash?: unknown;
    /**
     * 客户端给的请求号 ✓（只用于留痕对齐：`noteApi` ↔ 客户端 `note-open-*` ✓；
     * **不参与任何判定** ✗，见 `design/plugin-note-editor-loading-recheck.md` 问题三 ✓）。
     */
    requestId?: unknown;
  } | null | undefined;
  if (record === null || typeof record !== "object") {
    return { status: 200, body: { ok: false, error: { code: "bad_body", message: "请求体必须是对象" } } };
  }

  /*
   * **插入图片**（POST `{kind:'image-save', name, dataUrl, root?, sessionId?}` ✓）：
   * 落盘到 `<库根>/<imageDir>/` ✓（默认 `image` ⇒ 用户要的 `.dsh_knowledge/image/` ✓），
   * 回的是**库内相对路径** ✓ ⇒ 客户端把这一串写进 Markdown ✓（显示时再换成同源 URL ✓）。
   */
  if (record.kind === "set-understanding") {
    if (typeof record.nodeId !== "string" || typeof record.understood !== "boolean") return { status: 400, body: { ok: false, error: { code: "bad_body", message: "理解状态不合法" } } };
    const resolved = await resolveRequestedRoot(ctx, config, { root: typeof record.root === "string" ? record.root : undefined, sessionId: typeof record.sessionId === "string" ? record.sessionId : undefined });
    if (!resolved.root) return { status: 200, body: { ok: false, error: { code: "library_unavailable", message: "找不到知识库" } } };
    try { const understanding = await setUnderstanding(resolved.root, record.nodeId, record.understood); return { status: 200, body: { ok: true, understanding } }; }
    catch (error) { return { status: 200, body: { ok: false, error: { code: "state_write_failed", message: error instanceof Error ? error.message : String(error) } } }; }
  }
  if (record.kind === "image-save") {
    return await saveImageRequest(ctx, config, {
      name: record.name,
      dataUrl: record.dataUrl,
      root: record.root,
      sessionId: record.sessionId,
    });
  }
  // 「创建新知识库」：唯一的写入口，且只在目录里**没有** library.json 时才会写
  if (record.kind === "create-library") {
    const root = typeof record.root === "string" ? record.root : "";
    const title = typeof record.title === "string" ? record.title : undefined;
    /*
     * 新模型下目标目录是 `<工作区>/.dsh_knowledge`，它**还不存在**（首次打开面板时静默创建）。
     * `createLibrary` 要求"目标目录存在且为空"，所以先补建目录（已存在就跳过）。
     */
    if (root !== "") {
      try {
        await mkdir(root, { recursive: true });
      } catch (error) {
        return {
          status: 200,
          body: {
            ok: false,
            error: {
              code: "mkdir_failed",
              message: error instanceof Error ? error.message : String(error),
            },
          },
        };
      }
    }
    const result = await createLibrary(root, title);
    if (result.ok) {
      invalidateLibrary(result.root);
      /*
       * 建库之后立刻**重新裁决隔离**：这个工作区现在有知识库了，
       * 于是它的会话应当能看到 `kn_*` 工具（而不是等到下一个会话）。
       */
      const cwd = root.replace(/[\\/][^\\/]*$/, "");
      reevaluateIsolation((candidate) => isLibrarySession(candidate || cwd));
      return {
        status: 200,
        body: { ok: true, library: { root: result.root, title: result.title, libraryId: result.libraryId } },
      };
    }
    return { status: 200, body: { ok: false, error: { code: result.code, message: result.message } } };
  }

  /*
   * 界面上的图上编辑（右键节点加前置 / 右键连线删依赖）。
   * 都复用上游写入口：加前置走 addPrerequisite、删边走 removeEdge（带修订号/哈希守卫）。
   */
  /*
   * 「创建知识库」第一步：在选定位置下新建一个文件夹。
   * 自己实现（而不是让客户端调 uiWorkspace.createDirectory）：能把失败原因原样带回界面。
   */
  if (record.kind === "create-directory") {
    const result = await createSubdirectory({
      parent: typeof record.parent === "string" ? record.parent : "",
      name: typeof record.name === "string" ? record.name : "",
    });
    return {
      status: 200,
      body: result.ok === true ? { ok: true, path: result.path } : { ok: false, error: result.error },
    };
  }

  /*
   * 客户端把「已登记的知识库」同步过来（唯一权威来自「添加知识库」按钮的登记）。
   */
  if (record.kind === "create-node") {
    const resolved = await resolveRequestedRoot(ctx, config, {
      root: typeof record.root === "string" ? record.root : undefined,
      sessionId: typeof record.sessionId === "string" ? record.sessionId : undefined,
    });
    if (resolved.root === undefined) {
      return { status: 200, body: { ok: false, error: { code: "library_unavailable", message: "找不到知识库" } } };
    }
    try {
      const library = await loadLibrary(resolved.root, { refresh: true });
      const created = await createNodeFromUi(
        { library, snapshot: library.snapshot },
        { title: typeof record.title === "string" ? record.title : "" },
      );
      if (created.ok === true) invalidateLibrary(resolved.root);
      return {
        status: 200,
        body: created.ok === true ? { ok: true, node: created.node } : { ok: false, error: created.error },
      };
    } catch (error) {
      return {
        status: 200,
        body: {
          ok: false,
          error: { code: "create_node_failed", message: error instanceof Error ? error.message : String(error) },
        },
      };
    }
  }

  /*
   * 「提案 → 用户在面板审阅 → 落地」。
   *
   * 注意：**落地只能从这条客户端路由进来**（用户在面板里点击），agent 的工具没有落地能力——
   * 这是"可控"的硬保证，不靠模型自觉。
   */
  if (record.kind === "list-plans" || record.kind === "apply-plan" || record.kind === "undo-plan") {
    const resolved = await resolveRequestedRoot(ctx, config, {
      root: typeof record.root === "string" ? record.root : undefined,
      sessionId: typeof record.sessionId === "string" ? record.sessionId : undefined,
    });
    if (resolved.root === undefined) {
      return { status: 200, body: { ok: false, error: { code: "library_unavailable", message: "找不到知识库" } } };
    }
    try {
      const library = await loadLibrary(resolved.root, { refresh: record.kind !== "list-plans" });
      const context = { library, snapshot: library.snapshot };
      if (record.kind === "list-plans") {
        const plans = await listPlans(resolved.root);
        return {
          status: 200,
          body: {
            ok: true,
            plans: plans.map((plan) => ({
              id: plan.id,
              createdAt: plan.createdAt,
              summary: plan.summary ?? "",
              itemCount: plan.items.length,
              applied: plan.applied !== undefined && plan.applied !== null,
              createdCount: plan.applied?.created.length ?? 0,
              items: plan.items.map((item) => ({
                id: item.id,
                fromId: item.fromId,
                title: item.title,
                reuse: item.existingNodeId !== undefined,
              })),
            })),
          },
        };
      }
      const planId = typeof record.planId === "string" ? record.planId : "";
      if (record.kind === "apply-plan") {
        const itemIds = Array.isArray(record.itemIds)
          ? record.itemIds.filter((id): id is string => typeof id === "string")
          : undefined;
        const result = await applyPlanFromUi(context, resolved.root, { planId, itemIds });
        if (result.ok === true) invalidateLibrary(resolved.root);
        return {
          status: 200,
          body:
            result.ok === true
              ? {
                  ok: true,
                  planId,
                  created: result.plan?.applied?.created ?? [],
                  reused: result.plan?.applied?.reused ?? [],
                  failed: result.plan?.applied?.failed ?? [],
                }
              : { ok: false, error: result.error },
        };
      }
      const undone = await undoPlanFromUi(context, resolved.root, { planId });
      if (undone.ok === true) invalidateLibrary(resolved.root);
      return {
        status: 200,
        body: undone.ok === true
          ? { ok: true, planId, undone: undone.undone ?? 0 }
          : { ok: false, error: undone.error },
      };
    } catch (error) {
      return {
        status: 200,
        body: {
          ok: false,
          error: { code: "plan_failed", message: error instanceof Error ? error.message : String(error) },
        },
      };
    }
  }

  /*
   * 「选目标节点」用的搜索：把这段原文挂到哪个知识点下面。
   * 复用工具侧的同一套 search，保证界面与模型看到的结果一致。
   */
  if (record.kind === "search-nodes") {
    const resolved = await resolveRequestedRoot(ctx, config, {
      root: typeof record.root === "string" ? record.root : undefined,
      sessionId: typeof record.sessionId === "string" ? record.sessionId : undefined,
    });
    if (resolved.root === undefined) {
      return { status: 200, body: { ok: false, error: { code: "library_unavailable", message: "找不到知识库" } } };
    }
    try {
      const library = await loadLibrary(resolved.root, {});
      const context = { library, snapshot: library.snapshot };
      const nodes = searchTargets(context, typeof record.query === "string" ? record.query : "", 10);
      return { status: 200, body: { ok: true, nodes } };
    } catch (error) {
      return { status: 200, body: { ok: false, error: { code: "library_unavailable", message: error instanceof Error ? error.message : String(error) } } };
    }
  }
  /*
   * 「节点正文编辑」（`design/node-note-editor-plan.md`）：
   * `read-node-document` 读全文 + 实际路径 + **整文件指纹**；
   * `save-node-document` 带指纹做**比较交换**，冲突时回带最新正文 ✓。
   * 只读写正文，front-matter 身份由存储层维护 ✗；路径由宿主按 nodeId 解析 ✓。
   */
  if (record.kind === "read-node-document" || record.kind === "save-node-document") {
    const apiStarted = Date.now();
    const requestId = typeof record.requestId === "string" ? record.requestId : "";
    const resolved = await resolveRequestedRoot(ctx, config, {
      root: typeof record.root === "string" ? record.root : undefined,
      sessionId: typeof record.sessionId === "string" ? record.sessionId : undefined,
    });
    const rootMs = Date.now() - apiStarted;
    if (resolved.root === undefined) {
      return { status: 200, body: { ok: false, error: { code: "library_unavailable", message: "找不到知识库" } } };
    }
    /*
     * **不再为读写一篇正文加载整个图谱** ✗
     * （`design/plugin-note-editor-loading-recheck.md` 问题一 ✓）：
     * 原来这里 `loadLibrary(root)` 只是为了确认格式 ✗ —— 缓存过期（1.5s ✓）就全库扫一遍 ✓，
     * 有扫描在飞还得等它 ✓（实测扫描能到 8 秒 ✓）。现在只读 `library.json` 一个小文件 ✓。
     *
     * 顺带把错误分类分清 ✗：旧格式 ⇒ `unsupported_format` ✓；不是知识库 ⇒ `library_unavailable` ✓；
     * 读不了 ⇒ `read_failed` ✓（原来看不出区别，磁盘问题会伪装成格式问题 ✓）。
     */
    const formatStarted = Date.now();
    const format = await checkLibraryFormat(resolved.root);
    const formatMs = Date.now() - formatStarted;
    if (format.ok === false) {
      recordNoteApi({
        at: apiStarted,
        requestId,
        kind: record.kind === "read-node-document" ? "read" : "save",
        totalMs: Date.now() - apiStarted,
        rootMs,
        formatMs,
        outcome: format.code,
      });
      return { status: 200, body: { ok: false, error: { code: format.code, message: format.message } } };
    }
    const nodeId = typeof record.nodeId === "string" ? record.nodeId : "";
    if (record.kind === "read-node-document") {
      const result = await readNodeDocument(resolved.root, nodeId, { requestId });
      recordNoteApi({
        at: apiStarted,
        requestId,
        kind: "read",
        totalMs: Date.now() - apiStarted,
        rootMs,
        formatMs,
        outcome: result.ok === true ? "ok" : result.code,
      });
      return result.ok === true
        ? { status: 200, body: { ok: true, document: result.document } }
        : { status: 200, body: { ok: false, error: { code: result.code, message: result.message } } };
    }
    if (typeof record.text !== "string") {
      return { status: 200, body: { ok: false, error: { code: "bad_body", message: "缺少 text" } } };
    }
    const result = await saveNodeDocument(resolved.root, {
      nodeId,
      text: record.text,
      /*
       * 指纹**原样传下去**（缺失/空白/类型不对由存储侧判 `bad_body` 并拒写 ✓）——
       * 面板这条保存接口必须带指纹 ✗：它存在的意义就是"不覆盖外部修改" ✓。
       */
      hash: record.hash,
    });
    if (result.ok === true) {
      /* 落盘成功 ⇒ 让面板下次取数拿到新修订 ✓（图谱不必重建布局 ✓） */
      invalidateLibrary(resolved.root);
      recordNoteApi({
        at: apiStarted,
        requestId,
        kind: "save",
        totalMs: Date.now() - apiStarted,
        rootMs,
        formatMs,
        outcome: "ok",
      });
      return { status: 200, body: { ok: true, document: result.document } };
    }
    recordNoteApi({
      at: apiStarted,
      requestId,
      kind: "save",
      totalMs: Date.now() - apiStarted,
      rootMs,
      formatMs,
      outcome: result.code,
    });
    return {
      status: 200,
      body: {
        ok: false,
        error: {
          code: result.code,
          message: result.message,
          ...(result.latest === undefined ? {} : { latest: result.latest }),
        },
      },
    };
  }

  /*
   * 「删除当前节点」：按库自己的语义**移除节点身份**
   * （`.meta/knowledgenet` 移进 `<root>/.knowledgenet/trash/node-metadata/`，用户的文件夹与文件一个不动）。
   */
  if (record.kind === "remove-node") {
    const resolved = await resolveRequestedRoot(ctx, config, {
      root: typeof record.root === "string" ? record.root : undefined,
      sessionId: typeof record.sessionId === "string" ? record.sessionId : undefined,
    });
    if (resolved.root === undefined) {
      return { status: 200, body: { ok: false, error: { code: "library_unavailable", message: "找不到知识库" } } };
    }
    try {
      const library = await loadLibrary(resolved.root, { refresh: true });
      const result = await removeNodeFromUi(
        { library, snapshot: library.snapshot },
        {
          nodeId: typeof record.nodeId === "string" ? record.nodeId : "",
        },
      );
      if (result.ok === true) invalidateLibrary(resolved.root);
      return {
        status: 200,
        body: result.ok === true ? { ok: true, removed: result.removed } : { ok: false, error: result.error },
      };
    } catch (error) {
      return {
        status: 200,
        body: {
          ok: false,
          error: { code: "remove_failed", message: error instanceof Error ? error.message : String(error) },
        },
      };
    }
  }
  if (record.kind === "add-prerequisite" || record.kind === "remove-prerequisite") {
    const resolved = await resolveRequestedRoot(ctx, config, {
      root: typeof record.root === "string" ? record.root : undefined,
      sessionId: typeof record.sessionId === "string" ? record.sessionId : undefined,
    });
    if (resolved.root === undefined) {
      return {
        status: 200,
        body: { ok: false, error: { code: resolved.sessionUnknown ? "session_unknown" : "library_unavailable", message: "找不到知识库" } },
      };
    }
    let library;
    try {
      library = await loadLibrary(resolved.root, { refresh: true });
    } catch (error) {
      return {
        status: 200,
        body: { ok: false, error: { code: "library_unavailable", message: error instanceof Error ? error.message : String(error) } },
      };
    }
    // `loadLibrary` 给的是 LoadedLibrary；写入口要的是 { library, snapshot }
    const context = { library, snapshot: library.snapshot };
    const edit = record.kind === "add-prerequisite"
      ? await addPrerequisiteFromUi(context, resolved.root, {
          fromId: typeof record.fromId === "string" ? record.fromId : "",
          title: typeof record.title === "string" ? record.title : "",
          create: record.create === true,
          description: typeof record.description === "string" ? record.description : undefined,
          snippet: typeof record.snippet === "string" ? record.snippet : undefined,
          question: typeof record.question === "string" ? record.question : undefined,
        })
      : await removePrerequisiteFromUi(context, resolved.root, {
          fromId: typeof record.fromId === "string" ? record.fromId : "",
          edgeId: typeof record.edgeId === "string" ? record.edgeId : "",
        });
    if (edit.ok) return { status: 200, body: { ok: true, added: edit.added, removed: edit.removed } };
    return { status: 200, body: { ok: false, error: edit.error ?? { code: "write_failed", message: "写入失败" } } };
  }

  /*
   * 走到这里说明这个 POST **没有匹配上任何已知操作**，原本会掉进"客户端诊断上报"分支，
   * 而诊断体要求 `area` —— 于是用户看到的是「操作失败：缺少 area」，完全指不到真正的原因
   * （实测：客户端刷新后已在用新操作，但宿主还没重启）。这里改成明确回答。
   */
  if (record.kind !== undefined && record.kind !== "diag") {
    return {
      status: 200,
      body: {
        ok: false,
        error: {
          code: "unknown_kind",
          message: `宿主不认识这个操作：${String(record.kind)}（宿主可能还没重启，请重启 DSH 后再试）`,
        },
      },
    };
  }
  if (record.area === undefined) {
    return { status: 200, body: { ok: false, error: { code: "bad_body", message: "缺少 area" } } };
  }
  // 只收标量/数组字段：文本与路径都不该出现在上报里（客户端本来就只发结构指纹）
  const entry: Record<string, unknown> = {
    at: Date.now(),
    area: String(record.area),
    outcome: String(record.outcome ?? "unknown"),
  };
  for (const [key, value] of Object.entries(record)) {
    if (key === "kind" || key === "area" || key === "outcome") continue;
    if (value === null || ["string", "number", "boolean"].includes(typeof value) || Array.isArray(value)) {
      entry[key] = value;
    }
  }
  recordClientDiag(entry as { at: number; area: string; outcome: string });
  return { status: 200, body: { ok: true } };
}

/** 路由注册结果：面板与 `kn_status` 都据此给出可读诊断 */
export interface ApiRegistration {
  path: string;
  registered: boolean;
  /** 没注册成功时的原因（面板/状态工具会显示它，而不是让用户猜） */
  reason?: string;
}

/** 注册路由；没有 connection 服务（例如 headless 组合）时返回未注册与原因，不抛错 */
export function registerApi(ctx: unknown, config: KnowledgeNetConfig): ApiRegistration {
  const registrar = ctx as ConnectionRegistrar;
  // Cordis 注入后的作用域里，服务既可以用 get() 取，也可以当属性读
  // （shipped 的 bundle/web-app 就是 `connectionCtx.connection.…`），这里两条都试。
  const connection = (registrar.get?.("connection")
    ?? (registrar as { connection?: unknown }).connection) as
    | { fetch?: { register?: (route: Record<string, unknown>) => unknown } }
    | undefined;
  if (connection === undefined) {
    return { path: GRAPH_API_PATH, registered: false, reason: "看不到 connection 服务（宿主组合里没有它？）" };
  }
  const register = connection.fetch?.register;
  if (typeof register !== "function") {
    return { path: GRAPH_API_PATH, registered: false, reason: "connection 服务没有 fetch.register" };
  }

  const handler = async (request: Request): Promise<Response> => {
    const head = request.method === "HEAD";
    const { status, body, raw } = await handleApiRequest(registrar, config, {
      url: request.url,
      method: request.method,
      json: () => request.json() as Promise<unknown>,
    });
    /* 取图那条路直接回字节 ✓（JSON 包装会把图片编码坏 ✗） */
    if (raw !== undefined) return raw;
    return jsonResponse(body, status, head);
  };

  try {
    register({
      path: GRAPH_API_PATH,
      // POST 用于客户端上报诊断（载体的 ConnectionFetchMethod 支持 GET | HEAD | POST）
      methods: ["GET", "HEAD", "POST"],
      requestBody: "buffered",
      fetch: handler,
    });
    return { path: GRAPH_API_PATH, registered: true };
  } catch (error) {
    return {
      path: GRAPH_API_PATH,
      registered: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}