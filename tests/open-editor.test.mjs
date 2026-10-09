/**
 * 「这个库开着哪篇笔记的编辑器」这份记忆的契约。
 *
 * 它存在的理由（用户实测）：从笔记里点「打开新对话」如果换了会话，
 * `GraphPanel` 会随右侧栏的会话停靠面一起被卸载 ⇒ 组件 state 里的"编辑器开着哪篇"丢了，
 * 于是"侧边栏和标签都在、编辑弹窗没了"✗。所以这份记忆必须按**库身份**放在组件外 ✓。
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  clearOpenEditors,
  forgetOpenEditor,
  openEditorNode,
  rememberOpenEditor,
} from "../src/client/open-editor.ts";

describe("编辑器窗口的库级记忆", () => {
  beforeEach(() => clearOpenEditors());

  it("记下之后能读回；空库身份 / 空节点一律不记", () => {
    rememberOpenEditor("root:D:/kb", "n1");
    assert.equal(openEditorNode("root:D:/kb"), "n1");
    rememberOpenEditor("", "n1");
    rememberOpenEditor("root:D:/kb", "");
    assert.equal(openEditorNode(""), null, "没认出库 ⇒ 一律答「没开」 ✓");
  });

  it("忘掉之后读不到（用户关掉编辑器，就不许再被恢复出来）", () => {
    rememberOpenEditor("root:D:/kb", "n1");
    forgetOpenEditor("root:D:/kb");
    assert.equal(openEditorNode("root:D:/kb"), null);
    forgetOpenEditor("root:other");
  });

  it("按库身份分区：A 库的编辑器不会跑到 B 库的面板里", () => {
    rememberOpenEditor("root:D:/a", "a1");
    rememberOpenEditor("root:D:/b", "b1");
    assert.equal(openEditorNode("root:D:/a"), "a1");
    assert.equal(openEditorNode("root:D:/b"), "b1");
    forgetOpenEditor("root:D:/a");
    assert.equal(openEditorNode("root:D:/a"), null);
    assert.equal(openEditorNode("root:D:/b"), "b1", "别的库不受影响 ✓");
  });

  it("同一个库只记最后打开的那一篇", () => {
    rememberOpenEditor("root:D:/kb", "n1");
    rememberOpenEditor("root:D:/kb", "n2");
    assert.equal(openEditorNode("root:D:/kb"), "n2");
  });
});
