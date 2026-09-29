/**
 * 防回归：客户端源码里**不得**再出现已退休机制的标识符。
 *
 * 为什么需要这条测试：`GraphPanel` 里曾残留一个依赖数组 `[declared, …]` —— 构建**不会**报错
 * （它只是个自由变量），但渲染期会 `ReferenceError`，面板直接崩成"面板渲染出错"（用户实测截图）。
 * 这类"构建能过、运行时才炸"的残留，只有静态扫描能低成本拦住。
 *
 * 退休清单（新模型：库在 `<工作区>/.dsh_knowledge/`，不再有登记表）：
 * 登记表 `declared` / `isDeclaredPath` / `readDeclared` / `browserKbStorage` / `DeclaredKnowledgeBase`、
 * 门禁 `blockedByWorkspace`，以及被删除的组件 `AddLibraryButton` / `LibraryBadges` / `GraphGuideCard`。
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(HERE, "..", "src", "client");

/** 已退休、不得再出现在客户端源码里的标识符（注释里提到是可以的，见下面的过滤） */
const RETIRED = [
  "isDeclaredPath",
  "readDeclared",
  "browserKbStorage",
  "DeclaredKnowledgeBase",
  "blockedByWorkspace",
  "AddLibraryButton",
  "LibraryBadges",
  "GraphGuideCard",
  "kb-reconcile",
  "sync-declared",
];

/** 去掉行注释与块注释，避免把"说明文字"误判成代码 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("客户端不得再引用已退休的机制（新模型：目录自描述）", () => {
  it("没有任何客户端文件残留退休标识符", async () => {
    const files = (await readdir(CLIENT_DIR)).filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"));
    assert.ok(files.length > 0, "客户端目录应有源码");
    const offenders = [];
    for (const name of files) {
      const code = stripComments(await readFile(join(CLIENT_DIR, name), "utf8"));
      for (const token of RETIRED) {
        if (code.includes(token)) offenders.push(`${name}: ${token}`);
      }
    }
    assert.deepEqual(offenders, [], `这些残留会让面板在运行时炸掉：\n${offenders.join("\n")}`);
  });

  it("面板不再依赖登记表状态（避免依赖数组引用不存在的变量）", async () => {
    const panel = stripComments(await readFile(join(CLIENT_DIR, "GraphPanel.tsx"), "utf8"));
    // 典型的崩溃形态：`}, [declared, graph, ...])`
    assert.equal(/\[\s*declared\b/.test(panel), false, "依赖数组里不该再有 declared");
  });

  /*
   * 第二类"构建能过、运行时才炸"：**用了 hook 却忘了从 react 导入**。
   * 实测踩过（`useRef` 未导入 ⇒ 面板一挂载就 `ReferenceError: useRef is not defined`），
   * 所以逐个文件核对：源码里出现过的 hook 必须在那份文件的 `from "react"` 导入里。
   */
  it("每个客户端文件用到的 React hook 都必须已导入", async () => {
    const HOOKS = [
      "useState", "useEffect", "useMemo", "useCallback", "useRef", "useLayoutEffect",
      "useReducer", "useContext", "useSyncExternalStore", "useId", "useTransition",
      "useDeferredValue", "useImperativeHandle",
    ];
    const files = (await readdir(CLIENT_DIR)).filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"));
    const offenders = [];
    for (const name of files) {
      const code = stripComments(await readFile(join(CLIENT_DIR, name), "utf8"));
      const imported = /import\s*\{([^}]*)\}\s*from\s*"react"/.exec(code)?.[1] ?? "";
      for (const hook of HOOKS) {
        if (new RegExp(`\\b${hook}\\b`).test(code) && !new RegExp(`\\b${hook}\\b`).test(imported)) {
          offenders.push(`${name}: ${hook}`);
        }
      }
    }
    assert.deepEqual(offenders, [], `这些 hook 没导入，组件一挂载就会 ReferenceError：\n${offenders.join("\n")}`);
  });
});
