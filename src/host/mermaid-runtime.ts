/**
 * **按需加载的 Mermaid 运行时路由**（宿主侧 ✓）。
 *
 * 为什么要有这条路由 ✗：`mermaid` 未压缩约 6.8 MB ✓，内联进 `client.js` 会让**每次页面启动**
 * 都多付约 0.45 s 的解析/编译成本 ✗（实测见 `design/mermaid-note-blocks.md` §6）。
 * 拆出来之后：`client.js` 回到 ~8.1 MB ✓，只有真的打开含图笔记时才用同源 `<script src>` 取
 * `client.mermaid.js`（3.4 MB minified ✓）。
 *
 * 为什么用 `connection.fetch.register` 的 exact 路由 ✗：
 * - 它与面板数据走同一套 `/api` 载体与鉴权围栏 ✓（Host/Origin 检查 + 浏览器 cookie ✓）；
 * - 同源 `<script src>` 的 GET 会**带着 cookie**、**不带 Origin** ✓ ⇒ 正好穿过围栏 ✓
 *   （实测见 `tmp/lazy-proto/REPORT.md` §4；DSH 自己的所有客户端插件 bundle 也是同源 script ✓）；
 * - 浏览器 peer 的 principal 是 `owner` ✓ ⇒ exact 路由的 owner-only 检查放行 ✓。
 *
 * 缓存：URL 里带 `?v=<构建期内容 hash>` ✓ + `immutable` ✓ ⇒ 重新构建换 URL、旧 URL 自然失效 ✓。
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MERMAID_RUNTIME_API_PATH } from "../shared/routes.ts";

/** 宿主模块（index.js）所在目录 = 插件包根 ✓ —— 运行时文件与它同级 ✓ */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const RUNTIME_FILE = "client.mermaid.js";
/** 实际读文件的目录 ✓（默认包根；单测里由 `__setMermaidRuntimeDirForTest` 指向仓库根 ✓） */
let runtimeDir = PLUGIN_DIR;

/**
 * **仅测试用**：把运行时文件目录改到别处 ✓（单测直接 import 本文件时 `import.meta.url`
 * 是 `src/host/` 而不是包根 ✗）。传 `null` 恢复默认 ✓。
 * @param dir - 目录（`null` = 恢复包根 ✓）。
 */
export function __setMermaidRuntimeDirForTest(dir: string | null): void {
  runtimeDir = dir ?? PLUGIN_DIR;
  runtimeBytes = null;
}

/** 路由注册结果（与 `ApiStatus` 同形 ✓，避免反向依赖） */
export interface MermaidRuntimeRegistration {
  path: string;
  registered: boolean;
  reason?: string;
}

/** 进程内缓存的运行时字节 ✓（只读一次；读失败不缓存 ⇒ 重装/重启后可重试 ✓） */
let runtimeBytes: Promise<Buffer> | null = null;

/**
 * 读运行时文件 ✓（进程内缓存 ✓）。
 * @returns 文件字节 ✓。
 */
function readRuntime(): Promise<Buffer> {
  if (runtimeBytes === null) {
    const pending = readFile(join(runtimeDir, RUNTIME_FILE)).catch((error: unknown) => {
      /* 失败不要缓存 rejected promise ✗：用户重装插件后本进程还能重试 ✓ */
      runtimeBytes = null;
      throw error;
    });
    runtimeBytes = pending;
    return pending;
  }
  return runtimeBytes;
}

/**
 * 注册 `GET/HEAD /api/knowledgenet.mermaid.js` ✓。
 *
 * @param ctx - Cordis 作用域（与 `api.ts` 的 `registerApi` 同一套取法 ✓）。
 * @returns 注册结果 ✓（失败原因写清楚 ✓，`kn_status` 里能看到 ✓）。
 */
export function registerMermaidRuntime(ctx: unknown): MermaidRuntimeRegistration {
  const registrar = ctx as
    | {
        get?(name: string): unknown;
        connection?: unknown;
      }
    | undefined;
  const connection = (registrar?.get?.("connection") ?? registrar?.connection) as
    | { fetch?: { register?: (route: Record<string, unknown>) => unknown } }
    | undefined;
  const register = connection?.fetch?.register;
  if (typeof register !== "function") {
    return {
      path: MERMAID_RUNTIME_API_PATH,
      registered: false,
      reason: "看不到 connection.fetch.register（宿主组合里没有它？）",
    };
  }

  const handler = async (request: Request): Promise<Response> => {
    const head = request.method === "HEAD";
    try {
      const bytes = await readRuntime();
      return new Response(head ? null : bytes, {
        status: 200,
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          /* URL 带构建期 hash ⇒ 同一个 URL 的内容不会变 ✓ */
          "cache-control": "public, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
        },
      });
    } catch (error) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: "mermaid_runtime_missing",
            message: `${RUNTIME_FILE} 读取失败（插件安装不完整或宿主还没重启？）：`
              + (error instanceof Error ? error.message : String(error)),
          },
        }),
        { status: 404, headers: { "content-type": "application/json; charset=utf-8" } },
      );
    }
  };

  try {
    register({
      path: MERMAID_RUNTIME_API_PATH,
      methods: ["GET", "HEAD"],
      requestBody: "buffered",
      fetch: handler,
    });
    return { path: MERMAID_RUNTIME_API_PATH, registered: true };
  } catch (error) {
    return {
      path: MERMAID_RUNTIME_API_PATH,
      registered: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
