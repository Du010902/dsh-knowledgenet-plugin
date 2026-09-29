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
 * 右侧栏标签页的标识：既是 tab type 的注册 `id`（`sidebar.right.pane.tab` 的 key），
 * 也是它的 `kind`（`openTab(kind)` 用它点名）。
 */
export const PANEL_ID = "knowledgenet";

/** 客户端文案命名空间 */
export const LOCALE_NS = "knowledgenet";
