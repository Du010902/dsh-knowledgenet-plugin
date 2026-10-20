/**
 * **Mermaid 运行时的构建入口** ✓（单独打成 IIFE，由宿主路由按需提供 ✓）。
 *
 * 这个文件**不会**进 `client.js` ✗ —— `build.mjs` 的 `buildMermaidRuntime()` 只把它打成
 * `<包根>/client.mermaid.js` ✓；浏览器在第一次真的遇到 Mermaid 图时才用同源 `<script src>` 取它 ✓
 * （见 `src/client/mermaid-renderer.ts` 的 `loadRuntimeScript` ✓）。
 *
 * 为什么要拆出去 ✗：mermaid 未压缩约 6.8 MB ✓，内联进 `client.js` 会让每次页面启动都多付
 * 约 0.45 s 的解析/编译成本 ✗（动态 import 只推迟"求值"，省不了"解析"✓）。
 *
 * 约定：**只有一个全局出口** `window.__KN_MERMAID__` ✓（client 侧据此判断加载成功/版本不匹配 ✓）。
 * 该文件与 `client.js` 必须来自**同一次构建** ✓（`build.mjs` 会先建运行时、把它的内容 hash
 * 作为 `?v=` 写进 `client.js` ✓）。
 */
import mermaid from "mermaid";

declare global {
  interface Window {
    /** 由本运行时写入；client 侧加载完成后从这里取 ✓ */
    __KN_MERMAID__?: typeof mermaid;
  }
}

window.__KN_MERMAID__ = mermaid;
