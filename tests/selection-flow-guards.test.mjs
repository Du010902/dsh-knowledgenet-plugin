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

  /*
   * 形态按设计稿 `knowledgenet-picker-design.html`：被添加的知识点（可编辑 chip）+
   * 「添加为谁的前置」搜索区（带放大镜的输入框、推荐/搜索结果切换、可选中行）+ 底部状态行与确认。
   */
  it("「设为前置」弹窗保持设计稿的形态与交互", () => {
    for (const token of ["kn-pick-dialog", "kn-pick-chip", "kn-search-wrap", "kn-pick-row", "kn-pick-foot"]) {
      assert.ok(code.includes(token), `设计稿元素缺失：${token}`);
    }
    assert.ok(code.includes("PICK_SEARCH_ID"), "搜索框要有 id（<label htmlFor> 指向它）");
    assert.ok(code.includes('cx="10.5"'), "搜索框里要有放大镜图标");
    assert.ok(/aria-pressed=\{active\}/.test(code), "结果行要用 aria-pressed 表达选中（设计稿的高亮态）");
    assert.ok(code.includes("setSelectedTarget({ id: row.id, title: row.title })"), "点结果行 = 选中该目标");
    assert.ok(code.includes("void runQueue(target.id, draftsOf(picking), 0)"), "「确认添加」才真的写");
    assert.equal(
      /onClick=\{\(\) => \{ void runQueue\(id, draftsOf\(picking\), 0\); \}\}/.test(code),
      false,
      "点结果行不应再直接添加（设计稿是先选后确认）",
    );
    /*
     * 放大镜必须**显式给尺寸**：宿主页面里到处是 `… svg { width: … }` 规则，
     * 只靠我们的类选择器一旦被压过去，svg 会按 viewBox 撑满整行 —— 实测变成挡住半个弹窗的巨型放大镜 ✗。
     */
    assert.ok(code.includes("width={16}") && code.includes("height={16}"), "放大镜要写死宽高属性");
    assert.ok(/width: 16[^}]*height: 16/.test(code), "放大镜的行内样式要同时固定尺寸");
    /*
     * 图标与输入框必须是**同一行的两个 flex 子项**（而不是绝对定位盖在输入框上）：
     * 绝对定位那版实测图标和占位文字挤在同一条线上 ✗；flex 行让文字正好从 11+16+8 = 35px 处开始
     * （与设计稿的 `padding-left: 35px` 等价），图标不可能再飘 ✓。
     */
    assert.ok(code.includes('className="kn-search-input"'), "搜索框用自有类名，不蹭 `.kn-modal-input`");
    assert.equal(code.includes("position: absolute"), false, "图标不许再用绝对定位（会和文字打架）");
    assert.ok(/display: flex[\s\S]{0,160}gap: 8/.test(code), "搜索框外层要是一行 flex（图标 + 输入框）");
  });

  /*
   * 「收集知识点」弹窗（点浮条后出现的那个）形态按设计稿 `knowledgenet-multiselect-design.html`：
   * 头部可拖动 → 标签组（可改名、可 × 删除）→ 末尾输入框（Enter / 粘贴多行 / 退格删最后一个）
   * → 说明一行 → 底部计数与三个动作。
   */
  it("「收集知识点」弹窗保持设计稿的形态与交互", () => {
    for (const token of ["kn-ms-composer", "kn-ms-chip", "kn-ms-remove", "kn-ms-new", "kn-pick-foot"]) {
      assert.ok(code.includes(token), `设计稿元素缺失：${token}`);
    }
    assert.ok(code.includes('event.key === "Enter"'), "Enter 添加标签");
    assert.ok(code.includes("onPaste"), "粘贴多行要一次加多个标签");
    assert.ok(code.includes('event.key === "Backspace"'), "空输入时退格删掉最后一个标签");
    assert.ok(code.includes("multiCount"), "底部要显示「N 个知识点」");
    assert.ok(code.includes("appendChips("), "标签追加要走去重 + 上限那套逻辑");
    assert.equal(code.includes("kn-sel-textarea"), false, "旧的 textarea 形态必须撤掉（连样式一起）");
    /*
     * 收集弹窗的遮罩是 `pointer-events: none`（这样还能继续在对话里划词 ✓），
     * 所以弹窗本体必须**显式**打开指针事件 —— 漏了就是"整个弹窗点不动" ✗（旧 `.kn-sel-modal` 靠它救着）。
     */
    assert.ok(
      /kn-pick-dialog \{[\s\S]{0,400}pointer-events: auto/.test(code),
      "弹窗本体必须显式 pointer-events: auto，否则按钮和标签全都点不动",
    );
  });

  it("注入的样式表必须跟着这一版走（热更新不能留下上一版的 <style>）", () => {
    /*
     * 实测 ✗：插件重新安装后页面没有整体刷新，上一版留在 head 里的 `<style id="knowledgenet-selection-style">`
     * 让 `ensureStyle()` 直接 return ⇒ 这一版新增/修改的规则一条都不生效
     * （弹窗只有一半样式、放大镜被撑成巨型）。所以必须**更新已存在那份的 textContent**。
     */
    assert.ok(code.includes("existing.textContent !== rules"), "已存在的 <style> 要按这一版更新内容");
    assert.ok(code.includes("existing.textContent = rules"), "内容不同就替换");
    assert.equal(
      /getElementById\(STYLE_ID\) !== null\)\s*return/.test(code),
      false,
      "不能因为“已经有一个同 id 的 <style>”就直接 return",
    );
  });
});
