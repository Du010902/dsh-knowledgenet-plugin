/**
 * 右键菜单与「添加前置节点」弹窗的守门测试（用户 2026-10-29 要求）。
 *
 * 1. 空白处右键：菜单**只有一条**「创建独立节点」（不再有"这张图"标题，也不叫"创建节点"）；
 *    建出来的节点不连任何关系，会归入地图的「独立节点」卡。
 * 2. 地图卡：原来的「未连接节点」改名「独立节点」。
 * 3. 右键节点 →「添加前置节点」：弹窗**只出现在图谱界面上方**（渲染在 `.graph` 里、用
 *    shadow 里的 `.kn-prompt-*` 样式，不再 portal 到 body 铺满整个窗口）；
 *    输入时下面列出**知识库里已有的节点**（复用面板搜索的打分，点一下填进输入框）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(HERE, "..", "src", "client", name), "utf8");

const menu = read("GraphContextMenu.tsx");
const panel = read("GraphPanel.tsx");
const css = read("panel.css");
const dict = read("index.ts");

/** PromptDialog 的函数体（用来确认它不再走 body portal） */
function promptDialogBody() {
  const start = menu.indexOf("function PromptDialog");
  const end = menu.indexOf("export interface GraphContextMenuProps");
  assert.ok(start > 0 && end > start, "要能找到 PromptDialog 的函数体");
  return menu.slice(start, end);
}

describe("空白处右键：只有「创建独立节点」", () => {
  it("菜单项叫「创建独立节点」，且空白菜单不再有标题", () => {
    assert.ok(menu.includes("createIndependentNode"), "要有「创建独立节点」文案键");
    assert.ok(menu.includes('tr("createIndependentNode")'), "菜单项使用该文案");
    assert.ok(
      menu.includes('menu.kind === "canvas" ? null :'),
      "空白菜单不渲染标题（只有一条动作 ✓）",
    );
    assert.equal(
      menu.includes('props.copy.canvasMenuTitle ?? tr("canvasMenuTitle")'),
      false,
      "空白菜单不能再显示「这张图」标题 ✗",
    );
  });

  it("创建说明写清「独立节点 / 不与任何节点相连 / 归入地图的独立节点」", () => {
    assert.ok(menu.includes("不与任何节点相连"), "说明要写清独立节点语义");
    assert.ok(menu.includes("会归入地图的「独立节点」"), "要告诉用户它会出现在地图的独立节点卡里");
    assert.ok(menu.includes('createNodeConfirm'), "确认按钮独立一个文案（不与菜单项同名）");
  });
});

describe("添加前置弹窗：只出现在图谱界面上方 + 已有节点候选", () => {
  it("图内弹窗（shadow 里的 .kn-prompt，不再 portal 到 body 铺满窗口）", () => {
    const body = promptDialogBody();
    assert.ok(body.includes('className="kn-prompt-backdrop"'), "用图内弹窗的遮罩");
    assert.ok(body.includes('className="kn-prompt"'), "弹窗卡用 .kn-prompt");
    assert.ok(body.includes("autoFocus"), "输入框自动聚焦 ✓");
    assert.equal(body.includes('className="kn-modal-backdrop"'), false, "不再用全窗口 modal ✗");
    assert.equal(body.includes("document.body"), false, "不再 portal 到 body ✗");
  });

  it("输入时列出知识库里已有的节点（复用搜索打分，排除当前节点自己）", () => {
    assert.ok(menu.includes("rankNodes("), "候选复用面板搜索的打分（标题/别名都算命中 ✓）");
    assert.ok(
      menu.includes("suggestions={props.nodes.filter((node) => node.id !== prompt.fromId)}"),
      "候选池来自当前知识库节点，并排除被加前置的那个节点 ✓",
    );
    assert.ok(menu.includes('tr("suggestLabel")'), "候选列表要有读屏名字");
    assert.ok(menu.includes('className="kn-prompt-suggest-item"'), "候选项是按钮（可点选 ✓）");
    assert.ok(menu.includes("setValue(title)"), "点候选把名字填进输入框 ✓");
  });

  it("样式定义在注入 Shadow Root 的 panel.css 里，并且贴顶（界面上方）", () => {
    for (const cls of [
      "kn-prompt-backdrop",
      "kn-prompt",
      "kn-prompt-title",
      "kn-prompt-body",
      "kn-prompt-input",
      "kn-prompt-suggest",
      "kn-prompt-suggest-item",
      "kn-prompt-actions",
      "kn-prompt-btn",
      "kn-prompt-error",
    ]) {
      assert.ok(new RegExp(`\\.${cls}\\s*[,{]`).test(css), `样式要有 .${cls}`);
    }
    assert.ok(
      /\.kn-prompt-backdrop \{[\s\S]{0,400}?align-items: flex-start/.test(css),
      "弹窗要对齐到图谱上方（flex-start），不是屏幕正中 ✗",
    );
    assert.ok(
      /\.kn-prompt-backdrop \{[\s\S]{0,400}?position: absolute/.test(css),
      "要相对图谱区域绝对定位（只覆盖图谱）✓",
    );
  });
});

describe("节点右键：进入节点群 = 直接进入该节点所在的群（2026-10-30 用户最终要求）", () => {
  it("节点菜单里点了直接进群，不再弹「所有节点群供选择」的弹窗", () => {
    assert.ok(menu.includes('tr("viewGroups")'), "节点右键菜单要有「进入节点群」一条");
    assert.ok(menu.includes("props.onViewGroups?.(nodeId)"), "点这一条要把右键节点的 id 传给面板");
    assert.ok(panel.includes("mapModel.nodeToIsland.get(nodeId)"), "面板按节点 id 找它所在的群");
    assert.ok(panel.includes("if (owner !== null) enterIsland(owner);"), "找到就**直接进入**这个群 ✓");
    assert.equal(panel.includes("groupsOpen"), false, "不再有选择弹窗状态 ✗");
    assert.equal(panel.includes("NodeGroupPicker"), false, "不再引用选择弹窗组件 ✗");
    assert.ok(dict.includes('viewGroups: "进入节点群"'), "文案走中英词典 ✓");
  });
});

describe("独立节点文案（词典保留）", () => {
  it("中英词典同步（中文不再出现「未连接节点」）", () => {
    assert.ok(dict.includes('isolatedIsland: "独立节点"'), "中文词典 = 独立节点");
    assert.ok(dict.includes('islandCodeLoose: "独立节点 / {count} 个"'), "中文角标 = 独立节点");
    assert.ok(dict.includes('isolatedIsland: "Standalone nodes"'), "英文词典 = Standalone nodes");
    assert.equal(dict.includes("未连接节点"), false, "不该再有旧的「未连接节点」文案 ✗");
  });

  it("新增的菜单/候选文案中英词典都有（插件的 locale 三层取词 ✓）", () => {
    for (const key of ["createIndependentNode", "createNodeConfirm", "suggestLabel"]) {
      const zh = new RegExp(`^  ${key}:`, "m").test(dict);
      const en = new RegExp(`^  ${key}:`, "m").test(dict.slice(dict.indexOf("const DICT_EN")));
      assert.ok(zh && en, `中英词典都要有 ${key}`);
    }
  });
});
