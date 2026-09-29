/**
 * 守卫：面板里的诊断上报 `useEffect` 必须放在 `graph` / `effectiveFocus` **之后**。
 *
 * 为什么单独测：`useEffect(cb, [a, b])` 的依赖数组在**渲染期**读取，若 `a`/`b` 是同作用域里
 * 更靠后的 `const`，就会 TDZ（`Cannot access 'a' before initialization`）——整个面板白屏、
 * 界面上没有任何提示。这是实际踩过的坑（加 graph-focus 诊断时）。
 *
 * 这里刻意只断言**这一处**的先后关系（用整文件宽泛匹配 useEffect 依赖数组会产生误报，
 * 因为 `useCallback` 的依赖数组写法相同）。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PANEL = path.join(HERE, "..", "src", "client", "GraphPanel.tsx");

describe("面板源码顺序（防 TDZ 白屏）", () => {
  it("graph-focus 上报告必须在使用 graph / effectiveFocus 之后", async () => {
    const source = await readFile(PANEL, "utf8");
    const report = source.indexOf('reportDiagOnce("focus-incident"');
    const graph = source.indexOf("const graph = useMemo");
    const focus = source.indexOf("const effectiveFocus =");
    assert.ok(report > 0, "应当有 graph-focus 上报");
    assert.ok(graph > 0 && focus > 0);
    assert.ok(graph < report, "graph 必须在诊断上报之前定义");
    assert.ok(focus < report, "effectiveFocus 必须在诊断上报之前定义");
  });
});
