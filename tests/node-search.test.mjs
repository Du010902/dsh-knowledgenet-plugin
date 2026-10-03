/**
 * 面板搜索框的**模糊匹配**（`src/client/node-search.ts`）。
 *
 * 用户要求（2026-10）：在「知识库图谱」里加一个类似浏览器地址栏的搜索框，
 * 输入关键词后**模糊搜到匹配度最高的节点**并聚焦过去。
 *
 * 这里钉两件事：
 * 1. **打分的序**：完全相等 > 前缀 > 包含 > 子序列 > 容错（打错一个字）；
 * 2. 选出来的结果**必须确定**（同分不能"每次点结果不一样"），并且别名也算命中、但同分时标题优先 ✓。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const { normalizeQuery, pickBestNode, rankNodes, scoreTarget } = await import("../src/client/node-search.ts");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const panel = await readFile(path.join(HERE, "..", "src", "client", "GraphPanel.tsx"), "utf8");
const css = await readFile(path.join(HERE, "..", "src", "client", "panel.css"), "utf8");

const NODES = [
  { id: "n1", title: "注意力机制", aliases: ["Attention", "注意机制"] },
  { id: "n2", title: "注意力机制的应用", aliases: [] },
  { id: "n3", title: "自注意力", aliases: ["self-attention"] },
  { id: "n4", title: "最短路径算法", aliases: ["Dijkstra"] },
  { id: "n5", title: "载噪比", aliases: [] },
];

describe("打分：梯度与归一化", () => {
  it("归一化：大小写、首尾空白、连续空格", () => {
    assert.equal(normalizeQuery("  AttenTION  "), "attention");
    assert.equal(normalizeQuery("最短  路径"), "最短 路径");
  });

  it("完全相等 = 1000", () => {
    assert.equal(scoreTarget("注意力机制", "注意力机制"), 1000);
    assert.equal(scoreTarget("  ATTENTION ", "attention"), 1000, "大小写与空白不该影响");
  });

  it("序：相等 > 前缀 > 包含 > 子序列 > 容错", () => {
    const exact = scoreTarget("自注意力", "自注意力");
    const prefix = scoreTarget("注意", "注意力机制");
    const contains = scoreTarget("力机", "注意力机制");
    const sub = scoreTarget("注意机", "注意力机制");
    const typo = scoreTarget("注意力机志", "注意力机制");
    assert.ok(exact > prefix, `相等(${exact}) 应高于前缀(${prefix})`);
    assert.ok(prefix > contains, `前缀(${prefix}) 应高于包含(${contains})`);
    assert.ok(contains > sub, `包含(${contains}) 应高于子序列(${sub})`);
    assert.ok(sub > typo, `子序列(${sub}) 应高于容错(${typo})`);
    assert.ok(typo > 0, "打错一个字仍应命中");
  });

  it("前缀比「出现在中间」分高；越紧凑越高", () => {
    assert.ok(scoreTarget("注意", "注意力机制") > scoreTarget("机制", "注意力机制"));
    assert.ok(scoreTarget("注意", "注意力") > scoreTarget("注意", "注意力机制的应用"));
  });

  it("英文大小写不敏感；子序列命中（缩写）", () => {
    assert.ok(scoreTarget("attn", "Attention") > 0, "子序列：a-t-t-n");
    assert.ok(scoreTarget("DIJK", "Dijkstra") > 0);
  });

  it("不匹配就是 0；单个字也允许（前缀/包含），但不会靠子序列乱命中", () => {
    assert.equal(scoreTarget("zzz", "注意力机制"), 0);
    assert.equal(scoreTarget("", "注意力机制"), 0);
    assert.equal(scoreTarget("注意", ""), 0);
    assert.ok(scoreTarget("注", "注意力机制") > 0, "单字前缀仍然算");
    /* 单字不做子序列匹配：否则「的」会命中一大片 */
    assert.equal(scoreTarget("的", "最短路径"), 0);
    assert.equal(scoreTarget("的", "自注意力"), 0);
  });
});

describe("选点：匹配度最高 + 结果确定", () => {
  it("精确标题赢过「包含同词」的长标题", () => {
    const hit = pickBestNode(NODES, "注意力机制");
    assert.equal(hit?.node.id, "n1");
    assert.equal(hit?.via, "title");
  });

  it("别名也能命中（并报出命中的是哪段文字）", () => {
    const hit = pickBestNode(NODES, "Dijkstra");
    assert.equal(hit?.node.id, "n4");
    assert.equal(hit?.via, "alias");
    assert.equal(hit?.matched, "Dijkstra");
  });

  it("同分时标题优先于别名（别名命中扣一点点）", () => {
    const nodes = [
      { id: "alias-owner", title: "完全无关的名字", aliases: ["注意力机制"] },
      { id: "title-owner", title: "注意力机制", aliases: [] },
    ];
    assert.equal(pickBestNode(nodes, "注意力机制")?.node.id, "title-owner");
  });

  it("同分时标题更短的胜出，且结果可复现（不是随机挑一个）", () => {
    const nodes = [
      { id: "b", title: "图谱算法", aliases: [] },
      { id: "a", title: "图谱算法", aliases: [] },
    ];
    const first = pickBestNode(nodes, "图谱算法");
    const again = pickBestNode(nodes, "图谱算法");
    assert.equal(first?.node.id, "a", "同标题时按 id 定序，结果稳定");
    assert.equal(again?.node.id, first?.node.id, "同一份数据两次结果必须一致");
  });

  it("没有匹配 / 空关键词 ⇒ null（面板据此提示「没有匹配」）", () => {
    assert.equal(pickBestNode(NODES, "完全不存在的东西"), null);
    assert.equal(pickBestNode(NODES, "   "), null);
    assert.equal(pickBestNode([], "注意力"), null);
  });

  it("中文跳字输入也能落到正确节点（子序列）", () => {
    assert.equal(pickBestNode(NODES, "注意机")?.node.id, "n1");
    assert.equal(pickBestNode(NODES, "自注意")?.node.id, "n3");
  });
});

describe("候选列表：命中多个时全都列出来（用户自己挑）", () => {
  /*
   * 用户反馈 2026-10：查询「车」时"回车""回车聚焦"都命中，
   * 界面却**替用户选了一个**并把镜头飞过去 ✗ —— 原话："我们不应该替用户做决定，
   * 可以把可能的结果列出来，让用户自己选择"。
   */
  const CARS = [
    { id: "c1", title: "回车", aliases: [] },
    { id: "c2", title: "回车聚焦", aliases: [] },
    { id: "c3", title: "停车", aliases: [] },
    { id: "c4", title: "完全无关", aliases: [] },
  ];

  it("「车」把**所有**含车的节点都列出来（不再只给一个）", () => {
    const hits = rankNodes(CARS, "车");
    assert.deepEqual(
      hits.map((hit) => hit.node.id).sort(),
      ["c1", "c2", "c3"],
      "三个含「车」的节点都要出现，无关的那个不许进来",
    );
    assert.equal(hits.length, 3);
  });

  it("按匹配度排序：前缀命中 > 包含命中；同为包含时短的在前", () => {
    const nodes = [
      { id: "a", title: "车流分析", aliases: [] },   // 以「车」开头 ⇒ 前缀命中
      { id: "b", title: "回车", aliases: [] },       // 「车」在中间（下标 1）
      { id: "c", title: "回车聚焦", aliases: [] },   // 同样在中间，但标题更长 ⇒ 排后面
    ];
    const ids = rankNodes(nodes, "车").map((hit) => hit.node.id);
    assert.deepEqual(ids, ["a", "b", "c"], "前缀在前，然后同档里短的在前");
  });

  it("limit 生效、空关键词返回空数组、结果可复现", () => {
    assert.equal(rankNodes(CARS, "车", 2).length, 2);
    assert.deepEqual(rankNodes(CARS, "   "), []);
    assert.deepEqual(rankNodes(CARS, "zzz"), []);
    assert.deepEqual(rankNodes([], "车"), []);
    assert.deepEqual(rankNodes(CARS, "车", 0), []);
    const a = rankNodes(CARS, "车").map((hit) => hit.node.id);
    const b = rankNodes(CARS, "车").map((hit) => hit.node.id);
    assert.deepEqual(a, b, "同一份数据两次排名必须一致");
  });

  it("别名命中也会进候选，并标出命中的是哪段别名", () => {
    const hits = rankNodes(
      [
        { id: "x", title: "最短路径算法", aliases: ["Dijkstra"] },
        { id: "y", title: "图论基础", aliases: [] },
      ],
      "dijkstra",
    );
    assert.equal(hits.length, 1);
    assert.equal(hits[0].via, "alias");
    assert.equal(hits[0].matched, "Dijkstra");
  });

  it("pickBestNode 仍然等于候选里的第一条（两套入口不许各算一套）", () => {
    assert.equal(pickBestNode(CARS, "车")?.node.id, rankNodes(CARS, "车", 1)[0]?.node.id);
    assert.equal(pickBestNode(CARS, "zzz"), null);
  });
});

describe("面板接线：搜索框 → 模糊匹配 → 聚焦（静态守门）", () => {
  /*
   * 用户要求（2026-10）：面板里加一个**类似浏览器地址栏**的搜索框；
   * 输入关键词 → 模糊搜到匹配度最高的节点 → **聚焦过去**。
   *
   * 这里钉住"接线"，逻辑本身由上面的行为测试覆盖 ✓。三个容易退化的点：
   * 1. 回车与点箭头必须走**同一条路**（用 `<form onSubmit>`，别各写一份）；
   * 2. 聚焦 = `setFocusId`（选中）+ **`focusNode` 相机命令**（镜头对上去）——
   *    上游把"选择"与"定位"严格分开了，只 `setFocusId` 的话镜头不会动 ✗；
   * 3. 边打字只算提示，**只有回车/点箭头才动镜头**（否则每敲一个字就飞一次 ✗）。
   */
  it("搜索框形态：和刷新按钮同一行（照浏览器那条工具行）", () => {
    assert.ok(panel.includes('className="kn-search"'), "搜索块用自有类名");
    assert.ok(panel.includes('role="search"'), "语义上是一块搜索区域");
    assert.ok(panel.includes("<SearchGlyphIcon />"), "框里有放大镜");
    assert.ok(panel.includes("<SubmitArrowIcon />"), "右侧有提交箭头");
    assert.ok(panel.includes('className="kn-search-field"'), "输入框用自有类名");
    assert.ok(panel.includes('placeholder={t("searchPlaceholder")}'), "占位符走文案表");
    /*
     * **位置**：必须在头部那一行里（与「重新整理 / 刷新」同一行），而不是另起一行 ✗
     * （用户反馈：位置不对，应该排在刷新按钮后面，像浏览器那样）。
     * 判据：搜索块的起点落在头部 div 的起止之间 ✓。
     * 注意头部类名是**条件表达式**（搜索打开时多一个 `is-search-open`）⇒ 只能按子串找，别写 `className="…"`。
     */
    const headStart = panel.indexOf("kn-head kn-head-panel");
    const headEnd = panel.indexOf("</div>", headStart);
    const searchAt = panel.indexOf('className="kn-search"');
    assert.ok(headStart > 0 && searchAt > headStart && searchAt < headEnd, "搜索框要长在头部那一行里");
    assert.ok(panel.indexOf("<RefreshRingIcon />") < searchAt, "并且排在那颗刷新按钮**后面**");
  });

  it("候选浮层不能被头部行的 overflow 裁掉，且与输入框等宽", () => {
    /*
     * 实测踩过：`.kn-root-fill .kn-head-panel` 带 `overflow: hidden` ⇒ 绝对定位的候选列表
     * 会被整行裁掉，渲染出来**什么都看不见** ✗（这条是渲染预览时才发现的）。
     * 所以搜索打开时给头部加修饰类，并有一条把 `overflow` 打开的高优先级规则 ✓。
     */
    assert.ok(panel.includes('className={searchOpen ? "kn-head kn-head-panel is-search-open"'), "搜索打开时头部要加修饰类");
    assert.match(css, /\.kn-root-fill \.kn-head-panel\.is-search-open \{\s*overflow: visible;\s*\}/, "修饰类要把 overflow 打开");
    assert.match(css, /\.kn-search-list \{[\s\S]{0,300}position: absolute/, "候选列表是浮层");
    assert.match(css, /\.kn-search-list \{[\s\S]{0,300}z-index: \d/, "浮层要盖在画布上方");

    /*
     * **宽度与输入框一致**（用户反馈 2026-10："可选列表尺寸太长了，让它和搜索栏保持一样长"）：
     * 之前浮层挂在整块 `.kn-search` 上 ⇒ 它会一直伸到右侧箭头那边、还盖住状态文字 ✗。
     * 现在挂在**输入框那一格**（`.kn-search-box`）里面，左右贴 0 ⇒ 天然等宽 ✓。
     */
    const boxAt = panel.indexOf('className="kn-search-box"');
    const listAt = panel.indexOf('className="kn-search-list"');
    const submitAt = panel.indexOf('type="submit"');
    assert.ok(boxAt > 0 && listAt > boxAt && listAt < submitAt, "候选列表要在输入框那一格内、提交按钮之前");
    assert.match(css, /\.kn-search-box \{[\s\S]{0,700}position: relative/, "定位上下文在输入框那一格上");
    assert.match(css, /\.kn-search-list \{[\s\S]{0,200}left: 0;[\s\S]{0,80}right: 0;/, "左右都贴 0 ⇒ 与输入框等宽");
  });

  it("回车与点箭头同一条路；只有提交才动镜头", () => {
    assert.ok(
      panel.includes('onSubmit={(event) => { event.preventDefault(); submitSearch(); }}'),
      "回车要走 form 的 submit（与点箭头同一个入口）",
    );
    assert.ok(panel.includes('type="submit"'), "箭头是 submit 按钮");
    assert.ok(panel.includes("const submitSearch = (): void =>"), "要有一个明确的提交函数");
    assert.ok(
      panel.includes("focusSearchResult(searchActive)"),
      "回车聚焦的是**当前高亮**那条候选（不是写死的第一条）✗",
    );
    /* 边打字只更新候选：onChange 里不许出现聚焦/相机命令 */
    const onChange = panel.slice(panel.indexOf("onChange={(event) => { setSearchQuery"), panel.indexOf("onChange={(event) => { setSearchQuery") + 120);
    assert.equal(/focusNodeById|setCameraCommand/.test(onChange), false, "打字过程中不许动镜头");
  });

  it("候选列表：列出多条、点谁聚焦谁（不替用户决定）", () => {
    assert.ok(panel.includes('className="kn-search-list"'), "要有候选列表容器");
    assert.ok(panel.includes('role="listbox"'), "候选列表用 listbox 语义");
    assert.ok(panel.includes('role="option"'), "每一行是一个 option");
    assert.ok(panel.includes("searchMatches.map("), "把**所有**候选都渲染出来（不是只渲染第一条）");
    assert.ok(panel.includes("const [searchActive, setSearchActive] = useState(0)"), "要有高亮下标");
    assert.ok(panel.includes("onClick={() => { focusSearchResult(index); }}"), "点某一行就聚焦那一行");
    assert.ok(panel.includes('id={`${SEARCH_LIST_ID}-${index}`}'), "每行要有 id（输入框用 activedescendant 指过来）");
    /* 键盘：↑↓ 移动高亮、Esc 收起 —— 别把"替用户决定"又写回来 */
    assert.ok(panel.includes('event.key === "ArrowDown"'), "↑↓ 要在候选间移动");
    assert.ok(panel.includes('event.key === "ArrowUp"'));
    assert.ok(panel.includes('event.key === "Escape"'), "Esc 要能收起候选");
  });

  it("聚焦 = 选中 + focusNode 相机命令（上游只 setFocus 不会动镜头）", () => {
    assert.ok(panel.includes("const focusNodeById = useCallback((id: string): void => {"), "要有聚焦函数");
    assert.ok(panel.includes("setFocusId(id)"), "先选中");
    assert.ok(
      panel.includes('type: "focusNode", nodeId: id, source: "toolbar"'),
      "再发一条 focusNode 相机命令（与双击节点、按 F 同一条路）",
    );
    assert.ok(
      panel.includes("const [cameraCommand, setCameraCommand] = useState<CameraCommand | null>(null)"),
      "相机命令类型用上游那份（focusNode / fitAll 都在里面），别写窄的",
    );
  });

  it("模糊匹配用共用模块；没命中只提示、不动镜头", () => {
    assert.ok(panel.includes("rankNodes("), "候选列表走 node-search 的排名");
    assert.ok(panel.includes("searchMissed"), "要能区分「没命中」");
    assert.ok(panel.includes('t("searchMiss")'), "没命中要有文字提示");
    const submit = panel.slice(panel.indexOf("const submitSearch = (): void =>"), panel.indexOf("const submitSearch = (): void =>") + 420);
    assert.ok(submit.includes("if (searchMatches.length === 0)"), "没命中要提前返回");
    assert.ok(submit.includes("search-miss"), "没命中要有诊断上报（便于排查为什么没焦点） ");
  });

  it("候选浮层要压过下方的节点笔记编辑卡片（头行自成一个层级）", () => {
    /*
     * 用户实测（2026-10-03，编辑文档时）：头行搜索框的候选列表被**节点笔记卡片**挡住了一半 ✗。
     *
     * 根因不在候选列表的选择器，而是**头行从来没有层级** ✓：
     * `.kn-head-panel` 与 `.kn-graph` 是同一个 flex 列里的兄弟，都没有 `position`
     * ⇒ 后出现的 `.kn-graph` 整体压在头行上；而编辑浮层（`.kn-editor`，`z-index: 12`）
     * 长在 `.kn-graph` 里面 ⇒ 连候选列表一起盖住 ✗。
     *
     * 所以钉住"头行要有定位 + 层级"，并顺带校验几个数值仍保持"编辑卡片 < 头行 < 全屏弹层" ✓。
     */
    const headLayer = css.match(
      /\.kn-root-fill \.kn-head,\s*\.kn-root-fill \.kn-head-panel \{[^}]*position:\s*relative[^}]*z-index:\s*(\d+)/,
    );
    assert.ok(headLayer !== null, "要有一条把 .kn-head / .kn-head-panel 设为定位元素并给层级的规则");
    const headZ = Number(headLayer[1]);
    assert.ok(Number.isFinite(headZ), "头行要有明确的 z-index");

    /* 头行在 DOM 里排在图层之前（`.kn-graph` 是它的下一个兄弟）✓ */
    const headAt = panel.indexOf('"kn-head kn-head-panel"');
    const graphAt = panel.indexOf('className="kn-graph"');
    assert.ok(headAt > 0 && graphAt > headAt, "头行必须排在图层之前（沙箱 / 三维视图都挂在图层里）");

    const editorZ = Number((css.match(/\.kn-editor \{[\s\S]{0,200}?z-index:\s*(\d+)/) ?? [])[1]);
    assert.ok(Number.isFinite(editorZ), "编辑卡片要有明确的 z-index");
    assert.ok(headZ > editorZ, `头行层级要高于编辑卡片（${headZ} > ${editorZ}）`);

    const searchZ = Number((css.match(/\.kn-search-list \{[\s\S]{0,200}?z-index:\s*(\d+)/) ?? [])[1]);
    assert.ok(Number.isFinite(searchZ), "候选列表要有明确的 z-index");
    assert.ok(searchZ > 0, "候选列表要浮在输入框之上");

    /* 全屏的建前置弹窗 / 右键菜单仍在头行之上：头行的层级只解决"与编辑卡片"这一层 ✓ */
    const modalZ = Number((css.match(/\.kn-modal-backdrop \{[\s\S]{0,120}?z-index:\s*(\d+)/) ?? [])[1]);
    if (Number.isFinite(modalZ)) assert.ok(modalZ > headZ, `全屏弹层要高于头行（${modalZ} > ${headZ}）`);
  });
});
