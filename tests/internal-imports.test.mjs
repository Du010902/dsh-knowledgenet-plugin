/**
 * 静态审计：**内部导出的函数，在别的文件里被调用时，必须确实导入过**。
 *
 * 为什么值得单独一条：这个坑已经反复咬人（`applyPlanFromUi`、`sessionCwdOf`、`createNodeFromUi`、
 * `useRef`…）。它们有个共同特征——**构建通过**（打包器不把自由变量当错误），
 * 但**运行时 `ReferenceError`**：工具报错、面板崩、"面板渲染出错"。
 * 靠人工盯不可能可靠，靠这条扫描可以。
 *
 * 判据（保守，避免误报）：
 * 1. 收集 `src/**` 里所有 `export function NAME` / `export const NAME =` 的名字；
 * 2. 对每个文件：若出现 `NAME(`（当作调用）或 `NAME,`（当作实参/依赖数组），
 *    且该文件里既没有**定义**它、也没有**导入**它 ⇒ 记为可疑；
 * 3. 同文件自己导出的名字不算（那就是定义处）。
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..", "src");

/** 递归收集源码文件（**排除 vendor**：那是逐字节冻结的上游副本，不手改也不审计它） */
async function collect(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "vendor" || entry.name === "node_modules") continue;
      out.push(...(await collect(full)));
    } else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * 已知的合理用例（不是漏导入）：
 * - `inject`：本仓库里以 `const { inject } = slots` 之类的**解构**出现，不是内部导出；
 * - `BADGES_ID` / `BADGES_ORDER`：由 `badges-options.ts` re-export，不走具名 import 语法。
 */
const KNOWN_OK = new Set(["inject", "BADGES_ID", "BADGES_ORDER"]);

/** 去掉注释与字符串字面量，避免把文档/文案误判成代码 */
function stripNoise(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

describe("内部函数调用必须先导入（防构建通过、运行时 ReferenceError）", () => {
  it("没有任何文件调用未导入的内部导出", async () => {
    const files = await collect(SRC);
    const sources = new Map();
    for (const file of files) sources.set(file, stripNoise(await readFile(file, "utf8")));

    // 1) 收集所有导出的名字
    const exported = new Set();
    for (const code of sources.values()) {
      for (const match of code.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) exported.add(match[1]);
      for (const match of code.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)\s*[:=]/g)) exported.add(match[1]);
    }

    // 2) 逐个文件核对
    const offenders = [];
    for (const [file, code] of sources) {
      const short = file.replace(`${SRC}\\`, "").replace(`${SRC}/`, "");
      const imported = new Set();
      for (const match of code.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from/g)) {
        for (const piece of match[1].split(",")) {
          const name = piece.trim().split(/\s+as\s+/)[0]?.trim();
          if (name !== undefined && name !== "") imported.add(name);
        }
      }
      for (const name of exported) {
        if (KNOWN_OK.has(name)) continue;
        // 本文件自己的定义/导出不算
        const definedHere = new RegExp(`(?:export\\s+)?(?:async\\s+)?(?:function|const|let|class|interface|type)\\s+${name}\\b`).test(code);
        if (definedHere || imported.has(name)) continue;
        // 只认**调用形态** `name(`（保守：宁少报不误报）
        const looksCalled = new RegExp(`(?:^|[^.\\w$])${name}\\s*\\(`).test(code);
        if (looksCalled) offenders.push(`${short}: ${name}`);
      }
    }

    assert.deepEqual(offenders, [], `这些调用在运行时会是 ReferenceError：\n${offenders.join("\n")}`);
  });
});
