/**
 * 「划词 → 添加前置」的组件层守门测试。
 *
 * 为什么用静态扫描：这三个缺陷都在**多行 + 异步**的交界处，浏览器里很难手工复现，但后果都很硬：
 * 1. 多行共用一个标题 ⇒ 第 1 行建点、后面几行精确命中同一个节点、又被关系去重吃掉 ⇒ **静默丢行**；
 * 2. 「相近候选」对话框里 `setTitle(...)` 之后立刻发请求 ⇒ 读到的还是这次渲染闭包里的旧标题
 *    ⇒ 又命中同一批候选 ⇒ 点几次都不动（死循环）；
 * 3. 浮条点击时才现读 `window.getSelection()` ⇒ 浏览器在 mousedown 时已经把选区收掉 ⇒“点了没反应”。
 *
 * 三条都已修（见 `chat-selection.ts` 的 `draftPrereqs` 与 `ChatSelectionBar.tsx` 的 `runQueue` /
 * `resolveCandidate` / `bar.text` 回落），这里把修法钉住，防止再退回去。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BAR = path.join(HERE, "..", "src", "client", "ChatSelectionBar.tsx");

const source = await readFile(BAR, "utf8");
/** 去掉注释，避免把"说明文字"当成代码 */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .map((line) => line.replace(/\/\/.*$/, ""))
  .join("\n");

describe("划词添加前置：三条回归的守门", () => {
  it("多行按每条草稿各自的标题发请求（不再共用一个标题状态）", () => {
    assert.ok(code.includes("draftPrereqs("), "必须用 draftPrereqs 生成每条的标题");
    assert.ok(code.includes("title: nodeTitle"), "请求体里的 title 必须来自这条草稿");
    assert.equal(/\bsetTitle\(/.test(code), false, "共用的 title 状态必须已经删掉");
  });

  it("命中相近候选时走 resolveCandidate（不再用旧闭包标题重发）", () => {
    assert.ok(code.includes("resolveCandidate("), "候选决定必须走 resolveCandidate");
    assert.equal(code.includes("joinSnippets(snippets)"), false, "不得再拿空的 snippets 当出处");
    assert.ok(code.includes("pending.index + 1"), "用户决定后必须从下一条继续跑队列");
  });

  it("浮条点击有回落路径，且按下时不许浏览器收掉选区", () => {
    assert.ok(code.includes('live === "" ? bar.text : live'), "读不到现选区时必须回落到浮条记下的原文");
    assert.ok(code.includes("onMouseDown={(event) => { event.preventDefault(); }}"), "按下时不许让浏览器收掉选区");
  });

  /*
   * 回归：用户看到的推荐是**别的库**的节点（`.git/info/exclude…`、`最短路径算法`、`载噪比` …），
   * 点下去宿主只答"找不到节点"。根因是记忆（MRU）与标题缓存都是跨库的最后值，
   * 而旧的补标题逻辑以为"标题已经有了"就跳过请求 ⇒ 过滤被跳过 ⇒ 陌生 id 被照原样列出来。
   */
  it("推荐必须以**当前库的节点表**为准：没拿到就一个都不显示", () => {
    assert.ok(code.includes("keepKnownTargets("), "推荐必须经过 keepKnownTargets 过滤（当前库才显示）");
    assert.equal(code.includes("hydratedCount"), false, "旧的“有标题就直接列出”的判断必须删掉");
    assert.ok(code.includes("setLibraryTitles(null)"), "打开弹窗时必须先把节点表置为“不知道”");
    assert.ok(code.includes("void loadLibraryNodes()"), "打开弹窗时必须真去读一次当前库");
  });

  it("归属节点在别的库里时自愈（宿主答 node_not_found 就从记忆里删掉）", () => {
    assert.ok(code.includes('code === "node_not_found"'), "必须识别 node_not_found");
    assert.ok(code.includes("forgetTarget(fromId)"), "必须把跨库残留的 id 从记忆里清掉");
  });
});
