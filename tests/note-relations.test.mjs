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
