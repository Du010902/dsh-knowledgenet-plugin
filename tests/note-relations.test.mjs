/**
 * **前置 / 被依赖列表里点节点 ⇒ 跳到那个节点的编辑界面** ✓
 * （用户实测："现在前置和被依赖中的节点，没有办法点击"✗）。
 *
 * 原来是 `<div className="kn-note-relation-item">{title}</div>` ✗ —— 点不动、也 Tab 不到 ✓。
 * 现在：列表项是 `<button>` ✓，点击把 **node id** 交给父面板 ✓，
 * 由父面板走同一条 `requestEdit` ✓ ⇒ 有未保存改动时先弹三选一 ✗
 * （不会因为「顺手点了个前置」就把正在写的草稿丢掉 ✓）。
 *
 * 这里没有 DOM 环境 ✓ ⇒ 用"源码契约 + 纯数据"两层钉住：
 * ① 组件必须渲染 button 且把 **id**（不是标题 ✗）交出去 ✓；
 * ② 编辑器与图谱面板的接线必须一路透到 `requestEdit` ✓；
 * ③ id→标题的映射用真实边/节点数据算一遍 ✓（保证点击拿到的 id 确实对应屏幕上那行标题 ✓）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, "..", "src", "client");
const relations = readFileSync(path.join(CLIENT, "NoteRelations.tsx"), "utf8");
const editor = readFileSync(path.join(CLIENT, "NodeDocumentEditor.tsx"), "utf8");
const panel = readFileSync(path.join(CLIENT, "GraphPanel.tsx"), "utf8");
const css = readFileSync(path.join(CLIENT, "panel.css"), "utf8");
const dictSource = readFileSync(path.join(CLIENT, "index.ts"), "utf8");

describe("关系列表可点：点一下切到那个节点 ✓", () => {
  it("列表项是**按钮** ✓（原来是 div ⇒ 点不动 ✗）", () => {
    assert.ok(/items\.map\(n => \([\s\S]{0,400}?<button/.test(relations), "列表项要渲染成 button ✓");
    assert.ok(relations.includes('className="kn-note-relation-item"'), "沿用原来的行样式类名 ✓");
    assert.ok(!/<div className="kn-note-relation-item"/.test(relations), "不许再退回不可点的 div ✗");
    assert.ok(relations.includes("type=\"button\""), "要显式 type=button ✓（别在表单里当提交按钮 ✗）");
  });

  it("交出去的是 **node id** ✓（标题会重复、也会被改 ✗）", () => {
    assert.ok(relations.includes("props.onOpenNode?.(n!.id)"), "点击必须传 id ✓");
    assert.ok(!relations.includes("props.onOpenNode?.(n!.title)"), "绝不能拿标题当身份 ✗");
    assert.ok(relations.includes("onOpenNode?:"), "props 上要有这个回调 ✓");
    assert.ok(relations.includes("disabled={props.onOpenNode === undefined}"), "没有回调时（只读）退化成不可点的行 ✓");
  });

  it("id→标题的映射确实来自图数据 ✓（点哪行就开哪个节点 ✓）", () => {
    /* 与组件同一套算法（纯数据重算一遍 ✓） */
    const graph = {
      nodes: [
        { id: "n1", title: ".git/info/exclude 是本机私有的" },
        { id: "n2", title: "改成只用" },
        { id: "n3", title: "克隆" },
      ],
      edges: [
        { fromId: "n3", toId: "n1" },
        { fromId: "n3", toId: "n2" },
        { fromId: "n1", toId: "n3" },
      ],
    };
    const pre = graph.edges.filter((e) => e.fromId === "n3");
    const itemIds = pre.map((e) => e.toId);
    const titles = itemIds.map((id) => graph.nodes.find((n) => n.id === id)?.title);
    assert.deepEqual(itemIds, ["n1", "n2"]);
    assert.deepEqual(titles, [".git/info/exclude 是本机私有的", "改成只用"], "正是截图里那两行 ✓");
    const depend = graph.edges.filter((e) => e.toId === "n3").map((e) => e.fromId);
    assert.deepEqual(depend, ["n1"], "被依赖方向反过来取 fromId ✓");
  });

  it("**切节点必须编辑目标 + 图谱聚焦一起改** ✗（否则会被「聚焦驱动」的 effect 拉回去 ✓）", () => {
    /*
     * 用户实测（第二张反馈）：点关系项"窗口抖一下、还停在原来那篇文档"✓。
     * 原因：只 `setEditingNodeId` ✗ ⇒ `effectiveFocus` 还是旧节点 ✓ ⇒
     * 那条"图谱聚焦变了就切编辑器"的 effect 立刻把新节点请求回旧的 ✗（一抖就回去了 ✓）。
     */
    assert.ok(/const applyEdit = useCallback\(/.test(panel), "要有一个「真正落地切换」的入口 ✓");
    const applyAt = panel.indexOf("const applyEdit = useCallback(");
    const applyBody = panel.slice(applyAt, applyAt + 700);
    assert.ok(applyBody.includes('if (next.kind === "open") setFocusId(next.nodeId);'), "open 时聚焦要跟着走 ✓");
    assert.ok(
      /setEditingNodeId\(next\.kind === "open" \? next\.nodeId : null\)/.test(applyBody),
      "编辑目标照旧要设 ✓",
    );
    /* requestEdit 的落地分支与两条待办路径都要走 applyEdit ✓（不许再散落 setEditingNodeId ✗） */
    assert.ok(/applyEdit\(next\);\s*\n\s*\}, \[editorDirty, applyEdit\]\)/.test(panel), "requestEdit 要走 applyEdit ✓");
    assert.ok(/if \(pending !== null\) applyEdit\(pending\);/.test(panel), "「丢弃并继续」也要走 applyEdit ✓");
    assert.ok(/if \(next === null\) applyEdit\(\{ kind: "close" \}\)/.test(panel), "「保存后继续」也要走 applyEdit ✓");
    assert.ok(
      /const requestEdit[\s\S]{0,1200}?if \(freshDirty \?\? editorDirty\) \{[\s\S]{0,120}?setLeaveDialog\(next\);[\s\S]{0,120}?return;/.test(panel),
      "弹三选一时**不许**先动聚焦 ✗（会变成「取消也切、再弹一次」的死循环 ✓）",
    );
    /* 「图谱聚焦驱动编辑器」这条能力必须保留 ✓（在图上点别的节点，编辑器要跟着走 ✓） */
    assert.ok(
      /if \(effectiveFocus === editingNodeId\) return;\s*\n\s*requestEdit\(\{ kind: "open", nodeId: effectiveFocus \}\)/.test(panel),
      "聚焦驱动切换的 effect 仍在 ✓",
    );
  });

  it("接线一路透到 `requestEdit` ✓（切节点要过「未保存改动」的三选一 ✓）", () => {
    assert.ok(editor.includes("onOpenNode={props.onOpenNode}"), "编辑器要把回调透给关系组件 ✓");
    assert.ok(editor.includes("onOpenNode?: ((nodeId: string) => void) | undefined;"), "编辑器 props 要声明 ✓");
    assert.ok(
      panel.includes('onOpenNode={(nodeId) => { requestEdit({ kind: "open", nodeId }); }}'),
      "图谱面板要用 requestEdit 切节点 ✓",
    );
    /* 不许自己直接 setEditingNodeId ✗：那样会绕过脏草稿保护 ✓ */
    assert.ok(panel.includes("const requestEdit = useCallback("), "仍然复用带保护的 requestEdit ✓");
    assert.ok(
      /const requestEdit[\s\S]{0,900}?if \(freshDirty \?\? editorDirty\) \{\s*setLeaveDialog\(next\);/.test(panel),
      "requestEdit 必须先问「有没有未保存改动」✓",
    );
  });

  it("按钮样式：抹掉默认外观、给悬停/键盘反馈 ✓", () => {
    assert.ok(/\.kn-note-relations \.kn-note-relation-item \{/.test(css), "要有一条（带上位选择器的）行样式 ✓");
    const at = css.indexOf(".kn-note-relations .kn-note-relation-item {");
    const block = css.slice(at, at + 500);
    for (const part of ["width: 100%", "text-align: left", "cursor: pointer", "border-radius"]) {
      assert.ok(block.includes(part), `行样式要有 ${part} ✓`);
    }
    assert.ok(/\.kn-note-relations \.kn-note-relation-item:hover:not\(:disabled\)/.test(css), "悬停要给出可点反馈 ✓");
    assert.ok(/\.kn-note-relations \.kn-note-relation-item:focus-visible/.test(css), "键盘聚焦要看得见 ✓");
  });
});

/**
 * **已理解的节点，后面带一个「已理解」标签；没理解的不做任何改变** ✓
 * （用户实测要求 ✓）。
 *
 * 这条要求有两个容易做错的方向 ✗：
 * ① 把"没标记"也画出来（灰色"未理解"）—— 用户明确说了**不做任何改变** ✗，
 *    而且"没标记"只代表没标过，不代表不懂 ✓；
 * ② 标签画成按钮里的**文字** ⇒ 读屏用户听到的按钮名会变成"克隆 已理解" ✗
 *    （状态另有编辑器头部那个真正的理解按钮承担 ✓）。
 * 所以这里钉住：只在 `=== true` 时渲染 ✓、标签是 `aria-hidden` 的装饰 ✓、
 * 且数据**一路从图谱面板透到关系组件** ✓（缺一段就永远不显示 ✓）。
 */
describe("关系列表里的「已理解」标签 ✓", () => {
  it("只在**真的标为已理解**时才多渲染那个 span ✓（没标记 ⇒ 与原来一模一样 ✗）", () => {
    assert.ok(
      relations.includes('props.understanding?.[n!.id] === true ?'),
      "必须按 node id 判 `=== true` 才渲染标签 ✓（falsy / undefined 一律不加 ✓）",
    );
    assert.ok(
      relations.includes('className="kn-note-relation-understood"'),
      "标签要有自己的类名 ✓",
    );
    /*
     * 标签必须**只在 `=== true`** 时渲染 ✓，而且是**同一个按钮里**的兄弟节点（与标题一起 ✓）：
     * 分成两个按钮的话，点标签就开不了那个节点 ✓、键盘也多一次 Tab ✓。
     * `[\s\S]{0,600}` 允许中间夹一段说明性注释 ✓（把理由写成注释时，这里就是第一个被卡住的地方 ✓）。
     */
    assert.ok(
      /understanding\?\.\[n!\.id\] === true \? <span[\s\S]{0,600}?aria-hidden="true"/.test(relations),
      "标签要标成装饰性（`aria-hidden`）✓ ⇒ 按钮的无障碍名字仍只有节点标题 ✓",
    );
    /* 不许反着来：把"未理解"也画成一个标签 ✗ */
    assert.ok(
      !/understanding[\s\S]{0,80}?notUnderstood/.test(relations),
      "没有理解的节点**不许**显示「未理解」标签 ✗（用户要求：不做任何改变 ✓）",
    );
    assert.ok(
      relations.includes('understood: "已理解"'),
      "回落文案要在本文件里 ✓（宿主与插件翻译都缺席时不许露出键名 ✗）",
    );
  });

  it("数据要一路透下来 ✓：GraphPanel → NodeDocumentEditor → NoteRelations", () => {
    /* ① 面板有这份数据（`api/knowledgenet.graph` 的 `understanding` ✓）⇒ 原样交给编辑器 ✓ */
    assert.ok(
      panel.includes("understanding={payload?.understanding ?? {}}"),
      "面板要把整份理解标记交给编辑器 ✓（缺席时给空对象 ⇒ 一个标签都不加 ✓）",
    );
    assert.ok(
      /understanding\?:\s*Record<string, boolean>/.test(panel),
      "面板的 payload 类型里要有 understanding ✓",
    );
    /* ② 编辑器只做透传 ✓（不许在编辑器里另发一次请求 ✗） */
    assert.ok(
      editor.includes("understanding={props.understanding}"),
      "编辑器要把 understanding 透给关系组件 ✓",
    );
    assert.ok(
      /understanding\?:\s*Record<string, boolean> \| undefined;/.test(editor),
      "编辑器的 props 里要声明它 ✓",
    );
    /* ③ 关系组件自己是按 id 查的 ✓ */
    assert.ok(
      /understanding\?:\s*Record<string, boolean> \| undefined;/.test(relations),
      "关系组件的 props 里要声明它 ✓",
    );
  });

  it("标签外观：与理解按钮同一个绿、行尾注脚、不换行 ✓", () => {
    const at = css.indexOf(".kn-note-relations .kn-note-relation-understood {");
    assert.notEqual(at, -1, "标签要有样式定义 ✓（否则退化成裸文字 ✗）");
    const block = css.slice(at, at + 500);
    for (const part of ["color: #167346", "white-space: nowrap", "font-size: 11px", "border-radius: 999px"]) {
      assert.ok(block.includes(part), `标签样式要有 ${part} ✓`);
    }
    /* 与理解按钮同一个语义色 ✓（两处颜色不一致会让用户以为是两回事 ✓） */
    assert.ok(
      css.includes('.kn-understanding-button[aria-pressed="true"] { color: #167346; }'),
      "参照色仍在 ✓（标签沿用它 ✓）",
    );
  });
});

/* ------------------- 「＋ 添加前置」入口移进「前置」弹窗 + 点外面关闭（用户第十三轮 ✓） ------------------- */

describe("「＋ 添加前置」入口移进「前置」弹窗 + 点旁边空白/Esc 关闭 ✓", () => {
  it("标题栏只剩两颗按钮（前置 / 被依赖），不再有顶层「添加前置」✗", () => {
    const barStart = relations.indexOf('<div className="kn-note-relations"');
    const popoverStart = relations.indexOf('<div className="kn-note-relations-popover">');
    assert.ok(barStart >= 0 && popoverStart > barStart, "要找得到关系组件根节点与弹窗 ✓");
    const header = relations.slice(barStart, popoverStart);
    assert.equal((header.match(/<button\b/g) ?? []).length, 2, "标题栏只有「前置」「被依赖」两颗按钮 ✓");
    assert.ok(header.includes('t("relPre"') && header.includes('t("relDepend"'), "两颗按钮是 前置 / 被依赖 ✓");
    assert.ok(!header.includes('t("relAdd")'), "标题栏不再有「＋ 添加前置」✗（用户要求移进弹窗 ✓）");
  });

  it("「＋ 添加前置」入口在「前置」弹窗里，且只在 mode === \"pre\" 时出现 ✓", () => {
    assert.ok(relations.includes('className="kn-note-relations-add"'), "弹窗里有入口按钮 ✓");
    assert.equal((relations.match(/className="kn-note-relations-add"/g) ?? []).length, 1, "入口只出现一次 ✓");
    assert.ok(
      /\{mode === "pre" \? \([\s\S]{0,400}?className="kn-note-relations-add"[\s\S]{0,400}?\{t\("relAdd"\)\}/.test(relations),
      "入口按钮只在「前置」弹窗（mode === \"pre\"）里渲染、文案走 relAdd ✓",
    );
  });

  it("点弹窗旁边空白 / Esc ⇒ 关闭 ✓（shadow DOM 安全：composedPath + 根节点 ref）", () => {
    assert.ok(relations.includes("const rootRef = useRef<HTMLDivElement | null>(null);"), "要用根节点 ref 认领面板 ✓");
    assert.ok(relations.includes('document.addEventListener("pointerdown", onPointerDown, true)'), "document 捕获 pointerdown ✓");
    assert.ok(relations.includes("event.composedPath()"), "shadow DOM 里要用 composedPath ✓");
    assert.ok(relations.includes("path.includes(root)"), "按根节点判断点里/点外 ✓");
    assert.ok(/if \(root !== null && path\.includes\(root\)\) return;/.test(relations), "点在弹窗里不关闭 ✓");
    assert.ok(/if \(mode === null\) return undefined;/.test(relations), "弹窗没打开不挂监听 ✓");
    assert.ok(/if \(event\.key === "Escape"\) close\(\);/.test(relations), "Esc 关闭 ✓");
    assert.ok(/const close = \(\): void => \{ setMode\(null\); setSnippet\(""\); \};/.test(relations), "关闭要收起弹窗并清掉本次 snippet ✓");
    assert.ok(/return \(\) => \{\s*document\.removeEventListener\("pointerdown", onPointerDown, true\);/.test(relations), "卸载要摘监听 ✓");
  });

  it("弹窗里的入口样式（分隔线）与中英词典文案 ✓", () => {
    assert.ok(/\.kn-note-relations-popover \.kn-note-relations-add \{/.test(css), "入口要有（带上位选择器的）样式 ✓");
    const at = css.indexOf(".kn-note-relations-popover .kn-note-relations-add {");
    const block = css.slice(at, at + 400);
    for (const part of ["margin-top", "padding-top", "border-top"]) assert.ok(block.includes(part), `入口样式要有 ${part} ✓`);
    const zh = dictSource.slice(dictSource.indexOf("const DICT_ZH"), dictSource.indexOf("const DICT_EN"));
    const en = dictSource.slice(dictSource.indexOf("const DICT_EN"));
    for (const key of ["relAdd", "relAddTitle", "relAddFromSelection"]) {
      assert.ok(zh.includes(`${key}:`), `中文词典要有 ${key} ✓`);
      assert.ok(en.includes(`${key}:`), `英文词典要有 ${key} ✓`);
    }
  });
});
