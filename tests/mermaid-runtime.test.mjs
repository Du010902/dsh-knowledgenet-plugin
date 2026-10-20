/**
 * **按需加载的 Mermaid 运行时路由**测试（宿主侧 ✓）。
 *
 * 测两件事：
 * 1. `registerMermaidRuntime()` 用 `connection.fetch.register` 注册 `GET/HEAD` 精确路由 ✓
 *    （路径 / 方法 / 响应头 / 字节 ✓）；
 * 2. 取不到 connection 服务时**如实报告未注册 + 原因** ✓（`kn_status` 里能看到 ✓），不抛异常 ✓。
 *
 * 真正的浏览器加载链路由 `tests/mermaid-note.browser.mjs` 覆盖 ✓。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { __internal } from "../index.js";
import { __setMermaidRuntimeDirForTest, registerMermaidRuntime } from "../src/host/mermaid-runtime.ts";
import { MERMAID_RUNTIME_API_PATH } from "../src/shared/routes.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, "..");

/** 假 registrar：把注册的 route 记下来 ✓ */
function fakeRegistrar() {
  let registered;
  const ctx = {
    get: (name) => (name === "connection"
      ? { fetch: { register: (route) => { registered = route; } } }
      : undefined),
  };
  return { ctx, route: () => registered };
}

describe("Mermaid 运行时路由注册", () => {
  /* 单测直接 import 本模块时 import.meta.url 指向 src/host/ ⇒ 把运行时目录改到包根 ✓ */
  __setMermaidRuntimeDirForTest(path.resolve(HERE, ".."));
  it("注册 /api/knowledgenet.mermaid.js 的 GET/HEAD 精确路由", () => {
    const fake = fakeRegistrar();
    const result = registerMermaidRuntime(fake.ctx);
    assert.deepEqual(result, { path: MERMAID_RUNTIME_API_PATH, registered: true });
    const route = fake.route();
    assert.equal(route.path, MERMAID_RUNTIME_API_PATH);
    assert.deepEqual(route.methods, ["GET", "HEAD"]);
    assert.equal(route.requestBody, "buffered");
    assert.equal(typeof route.fetch, "function");
  });

  it("GET 返回 client.mermaid.js 字节 + 可长期缓存；HEAD 返回空体", async () => {
    const fake = fakeRegistrar();
    registerMermaidRuntime(fake.ctx);
    const route = fake.route();
    const expected = await readFile(path.join(PLUGIN, "client.mermaid.js"));

    const get = await route.fetch(new Request(`http://127.0.0.1${MERMAID_RUNTIME_API_PATH}`, { method: "GET" }));
    assert.equal(get.status, 200);
    assert.equal(get.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(get.headers.get("x-content-type-options"), "nosniff");
    assert.match(get.headers.get("cache-control") ?? "", /immutable/);
    const body = Buffer.from(await get.arrayBuffer());
    assert.deepEqual(body, expected, "返回的字节必须与 client.mermaid.js 完全一致");

    const head = await route.fetch(new Request(`http://127.0.0.1${MERMAID_RUNTIME_API_PATH}`, { method: "HEAD" }));
    assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0, "HEAD 不应返回正文 ✓");
  });

  it("看不到 connection 服务时报告未注册 + 原因（不抛异常）", () => {
    const result = registerMermaidRuntime({ get: () => undefined });
    assert.equal(result.registered, false);
    assert.equal(result.path, MERMAID_RUNTIME_API_PATH);
    assert.match(result.reason ?? "", /fetch\.register/);
  });

  it("register 抛错时报告失败原因（不抛异常）", () => {
    const ctx = { get: () => ({ fetch: { register: () => { throw new Error("already registered"); } } }) };
    const result = registerMermaidRuntime(ctx);
    assert.equal(result.registered, false);
    assert.match(result.reason ?? "", /already registered/);
  });
});

describe("构建产物里的同一个路由也真的能给出文件", () => {
  it("从 index.js 的 __internal 注册出来的路由能读到包根里的 client.mermaid.js", async () => {
    const fake = fakeRegistrar();
    const result = __internal.registerMermaidRuntime(fake.ctx);
    assert.equal(result.registered, true);
    const route = fake.route();
    const expected = await readFile(path.join(PLUGIN, "client.mermaid.js"));
    const response = await route.fetch(
      new Request(`http://127.0.0.1${MERMAID_RUNTIME_API_PATH}`, { method: "GET" }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
  });
});
