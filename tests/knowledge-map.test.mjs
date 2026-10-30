/**
 * 节点群分组的守门测试。
 *
 * 纯逻辑都在 `src/client/knowledge-map.ts`（可像 `plugin-locale.test.mjs` 那样直接 import .ts），
 * 这里钉住设计稿里那些**容易在后续改动里悄悄变掉**的规则：
 * ① 分组 = 连通分量、忽略箭头方向、孤立点合并成一个群 ✓；
 * ② 群的身份键只看成员集合（视角缓存按它分区，顺序无关）✓；
 * ③ 代表节点 / 计数 / 缩略图布局（确定、归一化、下标合法、抽样有上限）✓；
 * ④ 裁剪快照必须只留群内节点与**两端都在群内**的关系（否则上游边索引会错位）✓；
 * ⑤ 面板接线：默认整张图；右键节点「进入节点群」= **直接进入该节点所在的群** ✓。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  PREVIEW_MAX_NODES,
  buildKnowledgeMap,
  islandKeyOf,
  islandSnapshot,
} from "../src/client/knowledge-map.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, "..", "src", "client");

function makeNode(id, title, status = "todo") {
  return {
    id,
    title,
    aliases: [],
    status,
    createdAt: 0,
    updatedAt: 0,
    relativePath: "",
    folderName: "",
    health: "ok",
    revision: 0,
    localMutation: false,
  };
}

function makeEdge(id, fromId, toId) {
  return { id, fromId, toId, relation: "", relationType: "prerequisite", createdAt: 0, updatedAt: 0 };
}

function makeGraph(nodes, edges, extra = {}) {
  return { revision: 1, nodes, edges, goals: [], session: null, ...extra };
}

/** A─B─C 一条链、D─E 一对、F 孤立 */
function sampleGraph() {
  return makeGraph(
    [makeNode("a", "甲"), makeNode("b", "乙", "done"), makeNode("c", "丙"), makeNode("d", "丁"), makeNode("e", "戊"), makeNode("f", "己")],
    [makeEdge("e1", "a", "b"), makeEdge("e2", "c", "b"), makeEdge("e3", "d", "e")],
  );
}

describe("知识岛 = 连通分量（忽略依赖箭头方向）", () => {
  it("分岛、排序与归属：节点多的在前，未连接卡最后", () => {
    const model = buildKnowledgeMap(sampleGraph());
    assert.equal(model.totalNodes, 6);
    assert.equal(model.totalEdges, 3);
    assert.equal(model.islands.length, 3);
    assert.deepEqual(model.islands.map((island) => island.nodeCount), [3, 2, 1]);
    assert.deepEqual(model.islands.map((island) => island.isolated), [false, false, true]);
    assert.deepEqual(model.islands[0].nodeIds, ["b", "a", "c"], "岛内按度数降序");
    assert.equal(model.nodeToIsland.get("b"), model.islands[0].key);
    assert.equal(model.nodeToIsland.get("f"), model.islands[2].key);
  });

  it("代表节点 = 岛内入口节点（没有依赖者：没有别人把它当前置），同分按 ID", () => {
    const model = buildKnowledgeMap(sampleGraph());
    /* 边 A→B 表示 A 依赖 B ⇒ 甲、丙没有依赖者，是这棵树的入口；乙有依赖者 */
    assert.equal(model.islands[0].representativeId, "a", "甲是入口节点（丙与它同度，取小 ID）");
    assert.equal(model.islands[0].name, "甲");
    assert.equal(model.islands[1].representativeId, "d", "丁/戊同度 ⇒ 取小 ID");
    assert.equal(model.islands[2].representativeId, "f");
    assert.equal(model.islands[2].name, "己");
  });

  it("“已理解”计数来自节点状态（coloredGraph 的 done ✓）", () => {
    const model = buildKnowledgeMap(sampleGraph());
    assert.equal(model.islands[0].knownCount, 1, "乙是 done");
    assert.equal(model.islands[1].knownCount, 0);
  });

  it("多个孤立节点合并成一张「未连接节点」卡；单个孤立点仍用它的标题", () => {
    const two = buildKnowledgeMap(makeGraph([makeNode("x", "孤一"), makeNode("y", "孤二")], []));
    assert.equal(two.islands.length, 1);
    assert.equal(two.islands[0].isolated, true);
    assert.equal(two.islands[0].nodeCount, 2);
    assert.equal(two.islands[0].name, null, "多节点未连接卡由界面给本地化名称");
    assert.equal(two.islands[0].representativeId, null);

    const one = buildKnowledgeMap(makeGraph([makeNode("z", "单点")], []));
    assert.equal(one.islands.length, 1);
    assert.equal(one.islands[0].isolated, true);
    assert.equal(one.islands[0].name, "单点");
    assert.equal(one.islands[0].representativeId, "z");
  });
});

describe("岛的身份键与快照裁剪", () => {
  it("身份键只看成员集合（与顺序无关，集合不同则键不同）", () => {
    assert.equal(islandKeyOf(["b", "a", "c"]), islandKeyOf(["c", "a", "b"]));
    assert.notEqual(islandKeyOf(["a", "b"]), islandKeyOf(["a", "b", "c"]));
    assert.match(islandKeyOf(["a"]), /^isl-[a-z0-9]+$/);
  });

  it("计数与关系：同一对节点的重复边只算一条，自环忽略", () => {
    const graph = makeGraph(
      [makeNode("a", "甲"), makeNode("b", "乙")],
      [
        makeEdge("e1", "a", "b"),
        makeEdge("e2", "b", "a"),
        makeEdge("e3", "a", "b"),
        makeEdge("e4", "a", "a"),
        makeEdge("e5", "a", "缺"),
      ],
    );
    const model = buildKnowledgeMap(graph);
    assert.equal(model.islands.length, 1);
    assert.equal(model.islands[0].edgeCount, 1, "无向去重 ✓");
    assert.equal(model.totalEdges, 1);
  });

  it("islandSnapshot 只留岛内节点 / 两端都在岛内的关系 / 岛内的 goal", () => {
    const graph = sampleGraph();
    graph.goals = [
      { id: "g1", title: "目标一", rootNodeId: "b", createdAt: 0 },
      { id: "g2", title: "目标二", rootNodeId: "e", createdAt: 0 },
    ];
    const model = buildKnowledgeMap(graph);
    const island = model.islands[0];
    const snapshot = islandSnapshot(graph, island);
    assert.deepEqual(snapshot.nodes.map((node) => node.id).sort(), ["a", "b", "c"]);
    assert.deepEqual(snapshot.edges.map((edge) => edge.id).sort(), ["e1", "e2"], "跨岛关系必须裁掉（上游按索引用边）");
    assert.deepEqual(snapshot.goals.map((goal) => goal.id), ["g1"]);
    assert.equal(snapshot.revision, graph.revision, "其余字段原样保留");
  });

  it("空库：没有岛，计数为 0", () => {
    const model = buildKnowledgeMap(makeGraph([], []));
    assert.deepEqual(model.islands, []);
    assert.equal(model.totalNodes, 0);
    assert.equal(model.totalEdges, 0);
    assert.equal(model.nodeToIsland.size, 0);
  });
});

describe("缩略图布局（确定性、归一化、可画）", () => {
  it("同一份数据两次算出来完全一致（设计稿：岛的位置不能每次刷新都乱跳）", () => {
    const first = buildKnowledgeMap(sampleGraph());
    const second = buildKnowledgeMap(sampleGraph());
    assert.deepEqual(
      first.islands.map((island) => island.preview),
      second.islands.map((island) => island.preview),
    );
  });

  it("坐标归一化在 [0,1]，关系下标合法，代表节点恰好一个", () => {
    const model = buildKnowledgeMap(sampleGraph());
    for (const island of model.islands) {
      assert.equal(island.preview.points.length, island.nodeCount);
      for (const point of island.preview.points) {
        assert.ok(point.x >= 0 && point.x <= 1, `x 越界：${point.x}`);
        assert.ok(point.y >= 0 && point.y <= 1, `y 越界：${point.y}`);
        assert.ok(island.nodeIds.includes(point.id), "缩略图点必须来自岛内");
      }
      for (const [from, to] of island.preview.edges) {
        assert.ok(from >= 0 && from < island.preview.points.length, "边下标 a 越界");
        assert.ok(to >= 0 && to < island.preview.points.length, "边下标 b 越界");
      }
      const representatives = island.preview.points.filter((point) => point.representative);
      assert.equal(representatives.length, island.representativeId === null ? 0 : 1);
    }
  });

  it("单点岛画在正中（不会被缩放到边上）", () => {
    const model = buildKnowledgeMap(makeGraph([makeNode("z", "单点")], []));
    const point = model.islands[0].preview.points[0];
    assert.equal(point.x, 0.5);
    assert.equal(point.y, 0.5);
  });

  it("大岛按度数抽样（不超过上限），卡片计数仍按整岛统计", () => {
    const total = PREVIEW_MAX_NODES + 30;
    const nodes = [];
    const edges = [];
    for (let i = 0; i < total; i += 1) {
      nodes.push(makeNode(`n${String(i).padStart(3, "0")}`, `节点 ${i}`));
      if (i > 0) edges.push(makeEdge(`e${i}`, `n${String(i - 1).padStart(3, "0")}`, `n${String(i).padStart(3, "0")}`));
    }
    const model = buildKnowledgeMap(makeGraph(nodes, edges));
    assert.equal(model.islands.length, 1);
    const island = model.islands[0];
    assert.equal(island.nodeCount, total, "计数按整座岛");
    assert.equal(island.preview.points.length, PREVIEW_MAX_NODES, "缩略图抽样到上限");
    for (const [from, to] of island.preview.edges) {
      assert.ok(from < PREVIEW_MAX_NODES && to < PREVIEW_MAX_NODES, "抽样后的边只能指向抽样点");
    }
  });
});

describe("面板接线（静态守门）", () => {
  const panel = readFileSync(join(CLIENT, "GraphPanel.tsx"), "utf8");
  const menu = readFileSync(join(CLIENT, "GraphContextMenu.tsx"), "utf8");
  const css = readFileSync(join(CLIENT, "panel.css"), "utf8");

  it("默认整张图；右键节点「进入节点群」⇒ **直接进入该节点所在的群**（2026-10-30 最终要求 ✓）", () => {
    assert.ok(
      panel.includes("const [islandId, setIslandId] = useState<string | null>(null)"),
      "默认作用域 = 整张图（islandId 为 null）",
    );
    assert.equal(panel.includes('useState<"map" | "space">'), false, "不再有 map / space 两层 ✗");
    assert.equal(panel.includes("kn-map-stage"), false, "不再渲染独立地图层 ✗");
    assert.equal(panel.includes("kn-groups-trigger"), false, "右下角悬浮按钮已移除 ✗");
    assert.ok(panel.includes("mapModel.nodeToIsland.get(nodeId)"), "面板按右键节点找它所在的群");
    assert.ok(panel.includes("if (owner !== null) enterIsland(owner);"), "找到就**直接进入**这个群 ✓");
    assert.ok(menu.includes('tr("viewGroups")'), "节点右键菜单要有「进入节点群」一条");
    assert.ok(menu.includes("props.onViewGroups?.(nodeId)"), "点它要把右键节点 id 传给面板");
    assert.equal(panel.includes("groupsOpen"), false, "不再有「所有节点群供选择」的弹窗状态 ✗");
    assert.equal(existsSync(join(CLIENT, "NodeGroupPicker.tsx")), false, "选择弹窗组件已删除 ✗");
  });

  it("进了节点群：返回整张图 + 只喂裁剪图 + 按作用域分区视角缓存", () => {
    assert.ok(panel.includes("graph={visibleGraph}"), "三维视图拿到的必须是裁剪图");
    assert.ok(panel.includes("islandSnapshot(coloredGraph, island)"), "裁剪走纯函数");
    assert.ok(panel.includes("focusId={scopedFocus}"), "群外的全局聚焦不能带进空间（否则信息条报一个看不见的节点）");
    assert.ok(panel.includes("libraryKey={sceneLibraryKey}"), "视角缓存按作用域（库 + 节点群）分区");
    assert.ok(panel.includes("::island:"), "作用域键要拼进作用域身份");
    assert.ok(panel.includes('aria-label={t("backToWholeGraph")}'), "头行要有「返回整张图」图标按钮（读屏名 ✓）");
    assert.ok(panel.includes("onClick={backToWholeGraph}"), "点击回到整张图 ✓");
    assert.ok(panel.includes("<BackArrowIcon />"), "返回按钮用面板自己的箭头图标（shadow 里不能用宿主 sprite ✗）");
    assert.ok(panel.includes("disabled={editingNodeId !== null || leaveDialog !== null}"), "编辑器/三选一开着时不许切走");
  });

  it("Esc：从节点群回整张图；不再有图层切换 ✗", () => {
    assert.ok(panel.includes('onKeyDown={(event) => {'), "要有键盘返回");
    assert.ok(panel.includes('event.key !== "Escape"'), "只认 Esc");
    assert.ok(panel.includes("if (islandId !== null) setIslandId(null);"), "Esc 从节点群回整张图");
    assert.equal(panel.includes("setLayer("), false, "不许再出现 map/space 图层切换 ✗");
  });

  it("右键空白建独立节点仍然可用；图内输入弹窗上的右键不算空白", () => {
    assert.ok(panel.includes("onContextMenuCapture"), "保留捕获阶段右键");
    const at = panel.indexOf("onContextMenuCapture");
    const body = panel.slice(at, at + 1200);
    assert.ok(body.includes("requestCanvasMenu"), "空白处右键要能开「创建独立节点」");
    assert.ok(body.includes(".kn-prompt-backdrop"), "图内输入弹窗上的右键要跳过（不算空白）");
  });

  it("不再有节点群选择弹窗的组件/样式残留（最终方案不弹列表 ✗）", () => {
    assert.equal(panel.includes("NodeGroupPicker"), false, "面板不再引用选择弹窗组件");
    assert.equal(panel.includes("kn-groups"), false, "面板不再有选择弹窗元素");
    assert.equal(css.includes(".kn-groups-"), false, "panel.css 不再保留选择弹窗样式");
  });

  it("三维空间层保留点阵底纹（用户 2026-10-29 要求 ✓）", () => {
    assert.ok(css.includes("--kn-dot-grid:"), "点阵底纹要有一份定义");
    assert.ok(
      /\.kn-graph-stage \{[\s\S]{0,400}?background-image: var\(--kn-dot-grid\)/.test(css),
      "三维空间层用点阵底纹（画布透明清屏 ⇒ 会透出来 ✓）",
    );
    assert.ok(
      /\.kn-graph-stage \{[\s\S]{0,400}?background-size: 22px 22px/.test(css),
      "点阵网格 22px ✓",
    );
  });
});
