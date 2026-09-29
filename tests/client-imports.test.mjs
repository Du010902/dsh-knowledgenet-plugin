/**
 * 客户端源码的**导入一致性**检查。
 *
 * 这条测试来自一次非常昂贵的调试：`badges.ts` 使用了 `GRAPH_API_ROUTE` 却没导入它，
 * 于是每次"创建知识库"都在函数里抛 `ReferenceError` —— 被 catch 吞掉后只上报成一句
 * `create-unavailable`，看起来像"网络/传输问题"，实际是自己少写一行 import。
 *
 * 打包器不会为 CJS 输出里的未定义全局变量报错，所以这类错误只能靠静态检查或运行时才发现。
 * 这里对几个跨模块共享的常量做一次朴素核对：**用到就必须在同文件里 import 或定义**。
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.join(HERE, "..", "src", "client");

/** 跨模块共享的常量：用到就必须 import（或在同文件里定义） */
const SHARED = ["GRAPH_API_ROUTE", "GRAPH_API_PATH", "PANEL_ID", "LOCALE_NS", "KB_KEY", "KB_CHANGED_EVENT"];

async function clientFiles() {
  const out = [];
  for (const entry of await readdir(CLIENT_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/\.tsx?$/.test(entry.name)) continue;
    out.push(path.join(CLIENT_DIR, entry.name));
  }
  return out;
}

describe("客户端导入一致性", () => {
  it("共享常量用到就必须 import（缺 import 会变成吞掉的 ReferenceError）", async () => {
    const problems = [];
    for (const file of await clientFiles()) {
      const source = await readFile(file, "utf8");
      const name = path.basename(file);
      for (const symbol of SHARED) {
        const used = new RegExp(`\\b${symbol}\\b`).test(source.replace(/^\s*import[^;]*;$/gm, ""));
        if (!used) continue;
        const declared = new RegExp(`(import|const|let|function)\\s[^;]*\\b${symbol}\\b`).test(source);
        if (!declared) problems.push(`${name} 使用了 ${symbol} 但没有 import/定义`);
      }
    }
    assert.deepEqual(problems, [], problems.join("；"));
  });
});
