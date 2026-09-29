/**
 * 守门：客户端用到的 `kn-*` 类名，必须在**注入的样式**里有定义。
 *
 * 为什么需要：`GraphContextMenu` 的命名弹窗曾经完全没样式（退化成浏览器默认控件、跑到窗口左下角，
 * 用户实测截图 ✗）—— 因为 `.kn-modal-backdrop` / `.kn-modal-actions` / `.kn-modal-btn` 这些规则
 * 原本住在「添加知识库」的样式表里，清理那个入口时被一起删掉了 ✗。
 * portal 到 body 的组件，样式必须和组件同一个模块注入；这条测试就是防"用了没定义"。
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(HERE, "..", "src", "client");
const VENDOR_DIR = resolve(HERE, "..", "src", "vendor");

/** 已知的例外（由宿主/上游提供的类，或纯状态标记） */
const ALLOWED = new Set([]);

async function readClientFiles() {
  const names = (await readdir(CLIENT_DIR)).filter((n) => /\.(tsx?|css)$/.test(n));
  return Promise.all(names.map(async (name) => ({ name, code: await readFile(join(CLIENT_DIR, name), "utf8") })));
}

/**
 * vendor（上游逐字节副本）里定义的类名。
 *
 * 客户端会渲染 vendor 组件，那些组件自带 `kn-*` 类（如 `kn-box`、`kn-pill-*`），
 * 样式在 vendor 里 ⇒ 只扫 src/client 会误报。
 */
async function readVendorDefined() {
  const out = new Set();
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        await walk(full);
      } else if (/\.(tsx?|css)$/.test(entry.name)) {
        const code = await readFile(full, "utf8");
        for (const match of code.matchAll(/\.(kn-[a-z0-9-]+)\s*[,{:\s]/g)) out.add(match[1]);
      }
    }
  }
  await walk(VENDOR_DIR);
  return out;
}

describe("客户端类名必须都有样式定义（防「删了样式表、控件退化成默认模样」）", () => {
  it("所有用到的 kn-* 类名都在某个样式字符串里定义过", async () => {
    const files = await readClientFiles();
    const defined = await readVendorDefined();
    const used = new Map(); // 类名 → 首次出现的文件

    for (const { name, code } of files) {
      // 定义：CSS 选择器形态 `.kn-xxx {` / `.kn-xxx,` / `.kn-xxx:`
      for (const match of code.matchAll(/\.(kn-[a-z0-9-]+)\s*[,{:]/g)) defined.add(match[1]);
      // 使用：className 字符串（含模板串）里的类名
      for (const match of code.matchAll(/className\s*=\s*[{]?["'`]([^"'`]*)/g)) {
        for (const token of match[1].split(/\s+/)) {
          if (/^kn-[a-z0-9-]+$/.test(token) && !used.has(token)) used.set(token, name);
        }
      }
    }

    const missing = [...used.entries()]
      .filter(([cls]) => !defined.has(cls) && !ALLOWED.has(cls))
      .map(([cls, file]) => `${file}: ${cls}`);

    assert.deepEqual(missing, [], `这些类名没有样式定义，控件会退化成浏览器默认样子：\n${missing.join("\n")}`);
  });

  it("弹窗类名覆盖（回归：命名弹窗曾经完全没样式）", async () => {
    const files = await readClientFiles();
    const all = files.map((f) => f.code).join("\n");
    for (const cls of ["kn-modal-backdrop", "kn-modal", "kn-modal-title", "kn-modal-actions", "kn-modal-btn"]) {
      assert.ok(new RegExp(`\\.${cls}\\s*[,{:]`).test(all), `${cls} 必须有样式定义`);
    }
  });

  /*
   * 回归：菜单的 z-index 必须高于那层**透明遮罩**。
   * 曾经菜单 10000、遮罩 10001 ⇒ 透明遮罩盖住菜单 ⇒ 点「创建节点」被遮罩接走（它只做 setMenu(null)）
   * ⇒ 表现成"点了没反应"（用户实测）。这类层级错误肉眼很难发现，钉一条断言最省事。
   */
  it("右键菜单的层级必须高于透明遮罩", async () => {
    const files = await readClientFiles();
    const all = files.map((f) => f.code).join("\n");
    const zOf = (selector) => {
      const at = all.indexOf(`.${selector} {`);
      assert.notEqual(at, -1, `${selector} 应有样式定义`);
      const found = /z-index:\s*(\d+)/.exec(all.slice(at, at + 400));
      assert.notEqual(found, null, `${selector} 应有 z-index`);
      return Number(found[1]);
    };
    const menu = zOf("kn-menu");
    const backdrop = zOf("kn-modal-backdrop");
    assert.ok(menu > backdrop, `菜单层级(${menu})必须高于遮罩(${backdrop})，否则点击会被遮罩吃掉`);
  });
});
