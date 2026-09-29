/**
 * 守门：客户端的**效应依赖不得引用"每次渲染都会变"的翻译函数**。
 *
 * 真实事故（用户实测 + 代码审查确认 ✓）：`GraphPanel` 里
 *
 * ```ts
 * const t = makeTranslator(props.t, LITERAL);   // 每次渲染都是新函数
 * const load = useCallback(..., [attempt, t, target]);   // ⇒ load 每次都变
 * useEffect(() => { void load(); }, [load]);             // ⇒ 每渲染都发请求
 * ```
 *
 * 取数成功 → setState → 再渲染 → 新的 `t` → 新的 `load` → 再取数 ⇒ **自激循环**：
 * 一直打宿主（每次都要解析库、构图）、不断唤醒三维渲染，桌面端拖动窗口时明显卡顿。
 *
 * 两条断言：① `makeTranslator` 的结果必须用 `useMemo` 固化；② 依赖数组里不得出现裸 `t`。
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(HERE, "..", "src", "client");

async function readFiles() {
  const names = (await readdir(CLIENT_DIR)).filter((n) => n.endsWith(".ts") || n.endsWith(".tsx"));
  return Promise.all(names.map(async (name) => ({ name, code: await readFile(join(CLIENT_DIR, name), "utf8") })));
}

/** 去掉注释，避免把说明文字当成代码 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("效应依赖卫生（防自激重渲染循环）", () => {
  it("makeTranslator 的结果必须用 useMemo 固化", async () => {
    const offenders = [];
    for (const { name, code } of await readFiles()) {
      const src = stripComments(code);
      if (!src.includes("makeTranslator(")) continue;
      // 定义它的文件本身不算（`export function makeTranslator(...)`）
      if (/export\s+function\s+makeTranslator\s*\(/.test(src)) continue;
      // 允许的唯一形态：useMemo(() => makeTranslator(...), [...])
      if (!/useMemo\(\s*\(\)\s*=>\s*makeTranslator\(/.test(src)) offenders.push(name);
    }
    assert.deepEqual(offenders, [], `这些文件里的翻译函数每次渲染都会变，放进依赖会引发重复效应：\n${offenders.join("\n")}`);
  });

  it("依赖数组里不得出现裸 t（必须走 tRef 或不进依赖）", async () => {
    const offenders = [];
    for (const { name, code } of await readFiles()) {
      const src = stripComments(code);
      for (const line of src.split("\n")) {
        // 只看依赖数组那一行：`}, [a, b]);`
        const match = /\}\s*,\s*\[([^\]]*)\]/.exec(line);
        if (match === null) continue;
        const deps = match[1];
        // 裸 t：前后不是单词字符（tRef / target / item 都不算）
        if (/(^|[\s,])t([\s,]|$)/.test(deps)) offenders.push(`${name}: [${deps.trim()}]`);
      }
    }
    assert.deepEqual(offenders, [], `这些依赖数组含裸 t，会让回调每次渲染都变：\n${offenders.join("\n")}`);
  });

  it("浮条的写入目标必须现读 DOM，不得使用可能陈旧的 pathRef", async () => {
    const code = await readFile(join(CLIENT_DIR, "ChatSelectionBar.tsx"), "utf8");
    const src = stripComments(code);
    /*
     * 真实事故 ✗：写入目标用了 `pathRef.current`，而它可能还停在上一个仓库
     * ⇒ 在**没有知识库**的仓库里问的却是别的仓库（那里有库 ✓）⇒ 误判。
     * 规则：写入目标只允许用"现读"的状态（这里是 domWorkspacePath() 读当前选中会话所属工作区）✓。
     */
    const start = src.indexOf("const resolveWriteTarget");
    assert.notEqual(start, -1, "找不到 resolveWriteTarget（写入目标的唯一来源）");
    const end = src.indexOf("\n  };", start);
    const body = src.slice(start, end === -1 ? undefined : end);
    assert.ok(body.includes("domWorkspacePath()"), "写入目标应现读 domWorkspacePath()");
    if (body.includes("pathRef.current")) {
      assert.ok(
        body.includes("lastScopeRef.current.startsWith"),
        "用 pathRef.current 做回退时，必须校验它属于当前会话（lastScopeRef）",
      );
    }
    /*
     * 用户要求：未分组（没有工作区归属）的会话不参与 ✓ —— 判据是"没有工作区路径 ⇒ 不给写入目标" ✓，
     * 且这件事必须发生在询问宿主之前（否则白打请求 ✓）。
     */
    assert.ok(body.includes('return { root: "", createPath: "" }'), "没有工作区归属时应直接返回空目标");
    const denyAt = body.indexOf('return { root: "", createPath: "" }');
    const probeAt = body.indexOf("await ask(");
    assert.ok(probeAt === -1 || denyAt < probeAt, "空目标的判断必须发生在询问宿主之前");
  });

  it("创建节点必须自己解析写入目标（否则会静默失败）", async () => {
    const code = await readFile(join(CLIENT_DIR, "ChatSelectionBar.tsx"), "utf8");
    const src = stripComments(code);
    const start = src.indexOf("const createStandalone");
    assert.notEqual(start, -1, "找不到 createStandalone");
    const end = src.indexOf("\n  };", start);
    const body = src.slice(start, end === -1 ? undefined : end);
    /*
     * 真实事故 ✗：创建动作依赖"门禁刚好跑过"来填 `libraryRootRef`/`createPathRef`，
     * 而多选分支被提到门禁之前 ⇒ 点"创建"什么都没发生，且提示只写在已隐藏的浮条上 ⇒ 静默失败。
     * 规则：创建动作必须**自己**解析一次写入目标 ✓。
     */
    assert.ok(body.includes("resolveWriteTarget()"), "createStandalone 必须自己解析写入目标");
  });
it("resolveWriteTarget 必须自己声明 sessionId（抽函数时最容易漏）", async () => {
    const code = await readFile(join(CLIENT_DIR, "ChatSelectionBar.tsx"), "utf8");
    const src = stripComments(code);
    const start = src.indexOf("const resolveWriteTarget");
    assert.notEqual(start, -1, "找不到 resolveWriteTarget");
    const end = src.indexOf("\n  };", start);
    const body = src.slice(start, end === -1 ? undefined : end);
    /*
     * 真实事故 ✗：这段逻辑原在 gateNow 里，用的 sessionId 是它的局部变量；
     * 抽成独立函数后漏了声明 ⇒ ReferenceError（且抛在 try 之前）⇒ 点"创建"毫无反应 ✓。
     */
    if (/\bsessionId\b/.test(body)) {
      assert.ok(body.includes("const sessionId ="), "用到 sessionId 就必须在函数内声明它");
    }
  });
it("共用辅助必须定义在使用之前（抽函数最容易造出跨作用域的 ReferenceError）", async () => {
    const code = await readFile(join(CLIENT_DIR, "ChatSelectionBar.tsx"), "utf8");
    const src = stripComments(code);
    /*
     * 真实事故 ✗（两次同类）：
     *  ① `resolveWriteTarget` 用到 `sessionId`，但那是 `gateNow` 的局部变量 ⇒ ReferenceError；
     *  ② `resolveWriteTarget` 调用 `ask`，而 `ask` 定义在 `gateNow` 内部 ⇒ 同样 ReferenceError，
     *     且被自己的 catch 吞掉 ⇒ 表现为"找不到当前工作区 / 点了没创建" ✗。
     * 规则：`ask` 必须在 `resolveWriteTarget` 之前定义（同作用域 ✓）。
     */
    const askAt = src.indexOf("const ask = async");
    const useAt = src.indexOf("const resolveWriteTarget = async");
    assert.notEqual(askAt, -1, "找不到 ask 的定义");
    assert.notEqual(useAt, -1, "找不到 resolveWriteTarget 的定义");
    assert.ok(askAt < useAt, "ask 必须在 resolveWriteTarget 之前定义（否则跨作用域 ReferenceError）");
  });
});