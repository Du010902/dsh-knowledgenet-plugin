/**
 * 「知识库」换字形与注册形状的测试。
 *
 * 背景：工作区那一行没有插槽，只能用它稳定的 DOM 标记（`data-row-key="workspace:<id>"`）
 * 生成最小 CSS；做法是藏掉宿主文件夹 SVG、用 mask 画知识库图标。所以这里要钉住：
 * 选择器用属性、图标是编码过的 data URL、只写一次、不再有文字胶囊、空集合不产出规则。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ICON_VAR, graphIconDataUrl, libraryBadgeCss, workspaceEntries } from "../src/client/badges-css.ts";
import { BADGES_ID, BADGES_ORDER, badgesOptions } from "../src/client/badges-options.ts";

describe("知识库换字形样式", () => {
  it("按 data-row-key=workspace:<id> 换掉字形：藏 SVG + mask 画知识库图标", () => {
    const css = libraryBadgeCss(["w-1"]);
    assert.match(css, /\[data-row-key="workspace:w-1"\]/);
    assert.match(css, /svg \{ display: none; \}/, "要藏掉宿主的文件夹字形");
    assert.match(css, /mask: var\(--kn-libid-icon\)/, "用 mask 画自己的图标（颜色走 currentColor）");
    assert.match(css, /-webkit-mask:/, "Chromium 前缀也带上");
    assert.match(css, /background-color: currentColor/, "颜色跟随行本身，亮暗主题/选中态自动适配");
  });

  it("不再有文字胶囊（上一版效果已撤掉）", () => {
    const css = libraryBadgeCss(["w-1"]);
    assert.ok(!css.includes("::after"), "不应再挂 ::after 胶囊");
    assert.ok(!css.includes("content: \"知识库\""), "不应再有文字");
  });

  it("图标 data URL 经过编码，且整张表只声明一次", () => {
    const css = libraryBadgeCss(["a", "b"]);
    const occurrences = css.split(ICON_VAR + ":").length - 1;
    assert.equal(occurrences, 1, "图标变量只声明一次");
    assert.match(css, /data:image\/svg\+xml,/);
    assert.ok(!/data:image\/svg\+xml,[^"]*[<>#]/.test(css), "URL 里不能出现未编码的 < > #");
    const url = graphIconDataUrl();
    assert.ok(url.startsWith('url("data:image/svg+xml,'));
    assert.equal(decodeURIComponent(url.slice('url("data:image/svg+xml,'.length, -2)).includes("<svg"), true);
  });

  it("多个工作区各一组规则，重复 id 只留一份", () => {
    const css = libraryBadgeCss(["a", "b", "a"]);
    // 每个工作区两条规则：藏 SVG 的选择器 + ::before 的选择器
    assert.equal(css.split('[data-row-key="workspace:a"]').length - 1, 2);
    assert.equal(css.split('[data-row-key="workspace:b"]').length - 1, 2);
  });

  it("空集合不产出任何规则（调用方据此不注入 style）", () => {
    assert.equal(libraryBadgeCss([]), "");
    assert.equal(libraryBadgeCss(["", ""]), "");
  });

  it("id 里的引号被转义，不会把样式表搞坏", () => {
    assert.match(libraryBadgeCss(['w"1']), /workspace:w\\"1/);
  });
});

describe("从工作区快照取条目", () => {
  it("真实形状（items[].workspaceId/path）", () => {
    const entries = workspaceEntries({
      items: [
        { workspaceId: "w1", path: "D:\\a", title: "A", sessionIds: [] },
        { workspaceId: "w2", path: "D:\\b", title: "B", sessionIds: [] },
      ],
    });
    assert.deepEqual(entries, [{ workspaceId: "w1", path: "D:\\a" }, { workspaceId: "w2", path: "D:\\b" }]);
  });

  it("缺 id 的条目被跳过；缺 path 的保留（只是没法判定）", () => {
    assert.deepEqual(workspaceEntries({ items: [{ title: "无 id" }, { workspaceId: "w3" }] }), [
      { workspaceId: "w3", path: undefined },
    ]);
  });

  it("认不出来就返回空表", () => {
    assert.deepEqual(workspaceEntries(undefined), []);
    assert.deepEqual(workspaceEntries({}), []);
    assert.deepEqual(workspaceEntries("不是对象"), []);
  });
});

describe("换字形注入器的注册形状", () => {
  it("注册到 sidebar.footer.action，带必填 id 与 order", () => {
    const options = badgesOptions();
    assert.equal(options.name, "sidebar.footer.action");
    assert.equal(options.id, BADGES_ID);
    assert.equal(options.order, BADGES_ORDER);
    assert.ok(!("inject" in options), "组件不需要注入面：判定数据都在标准 props 里");
    assert.ok(!("locale" in options));
  });

  it("locale 给了才带上", () => {
    assert.equal(badgesOptions({ locale: "knowledgenet" }).locale, "knowledgenet");
  });
});
