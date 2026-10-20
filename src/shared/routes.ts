/**
 * 宿主与客户端半共用的常量（叶子模块，两个 bundle 都能安全引入）。
 *
 * 客户端**不能**从 `src/host/api.ts` 取这些值：那会把整条宿主模块图（含 `node:fs`）拖进浏览器包。
 */

/** 宿主注册用的绝对路径 */
export const GRAPH_API_PATH = "/api/knowledgenet.graph";
/** 浏览器侧使用的 document-relative 形式（走 Connection 的 HTTP 载体） */
export const GRAPH_API_ROUTE = GRAPH_API_PATH.slice(1);

/**
 * **按需加载的 Mermaid 运行时**（宿主 exact Fetch 路由；浏览器侧用同源 `<script src>` 取 ✓）。
 *
 * 为什么单独一条路由 ✗：`mermaid` 未压缩约 6.8 MB（minified 3.4 MB）✓，
 * 内联进 `client.js` 会让**每次页面启动**都多付约 0.45 s 的解析/编译成本 ✗。
 * 拆出去之后 `client.js` 回到 ~8.1 MB ✓，只有真的打开含图的笔记时才加载这个运行时 ✓
 * （页面启动 → 第一张图反而更快 ✓，见 `design/mermaid-note-blocks.md` §6）。
 */
export const MERMAID_RUNTIME_API_PATH = "/api/knowledgenet.mermaid.js";
/** 浏览器侧使用的 document-relative 形式 ✓ */
export const MERMAID_RUNTIME_ROUTE = MERMAID_RUNTIME_API_PATH.slice(1);

/**
 * 右侧栏标签页的标识：既是 tab type 的注册 `id`（`sidebar.right.pane.tab` 的 key），
 * 也是它的 `kind`（`openTab(kind)` 用它点名）。
 */
export const PANEL_ID = "knowledgenet";

/** 客户端文案命名空间 */
export const LOCALE_NS = "knowledgenet";
