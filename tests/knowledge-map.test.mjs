/**
 * 平面总览层（知识地图）的守门测试。
 *
 * 两层视图的纯逻辑都在 `src/client/knowledge-map.ts`（可像 `plugin-locale.test.mjs` 那样直接 import .ts），
 * 这里钉住设计稿里那些**容易在后续改动里悄悄变掉**的规则：
 * ① 分岛 = 连通分量、忽略箭头方向、孤立点合并成一张卡 ✓；
 * ② 岛的身份键只看成员集合（视角缓存按它分区，顺序无关）✓；
 * ③ 代表节点 / 计数 / 缩略图布局（确定、归一化、下标合法、抽样有上限）✓；
 * ④ 裁剪快照必须只留岛内节点与**两端都在岛内**的关系（否则上游边索引会错位）✓；
 * ⑤ 面板接线：地图是默认层、空间层只喂裁剪后的图、换岛按岛键分区视角缓存 ✓。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  const mapComponent = readFileSync(join(CLIENT, "KnowledgeMap.tsx"), "utf8");
  const css = readFileSync(join(CLIENT, "panel.css"), "utf8");

  it("地图是**默认层**；空间层第一次进入才挂载（地图阶段不替看不见的 WebGL 付成本）", () => {
    assert.ok(panel.includes('useState<"map" | "space">("map")'), "默认 layer 必须是 map");
    assert.ok(panel.includes("spaceMounted"), "空间层要记录是否已经挂载过");
  });

  it("空间层只喂**裁剪后的图**，且按岛键分区视角缓存", () => {
    assert.ok(panel.includes("graph={visibleGraph}"), "三维视图拿到的必须是裁剪图");
    assert.ok(panel.includes("islandSnapshot(coloredGraph, island)"), "裁剪走纯函数");
    assert.ok(panel.includes("focusId={scopedFocus}"), "岛外的全局聚焦不能带进空间（否则信息条报一个看不见的节点）");
    assert.ok(panel.includes("libraryKey={sceneLibraryKey}"), "视角缓存按作用域（库 + 岛）分区");
    assert.ok(panel.includes("::island:"), "岛键要拼进作用域身份");
  });

  it("空库右键建节点仍可用：地图背景也在右键捕获范围内", () => {
    assert.ok(panel.includes("onContextMenuCapture"), "保留捕获阶段右键");
    const at = panel.indexOf("onContextMenuCapture");
    const body = panel.slice(at, at + 900);
    assert.ok(body.includes("requestCanvasMenu"), "地图空白处右键要能开「创建节点」");
    assert.ok(body.includes('closest(".kn-island")'), "卡片上的右键要跳过（不算空白）");
  });

  it("空间层用**返回图标按钮**（不是文字面包屑）回地图；编辑器开着时不允许离开", () => {
    assert.ok(panel.includes('onKeyDown={(event) => {'), "要有键盘返回");
    assert.ok(panel.includes('event.key !== "Escape"'), "只认 Esc");
    assert.ok(panel.includes('setLayer("map")'), "Esc / 返回按钮最终把层切回 map");
    assert.ok(panel.includes('aria-label={t("backToMap")}'), "空间层要有返回地图的图标按钮（读屏名 ✓）");
    assert.ok(panel.includes('title={t("backToMap")}'), "hover 说明 ✓");
    assert.ok(panel.includes("<BackArrowIcon />"), "返回按钮用面板自己的箭头图标（shadow 里不能用宿主 sprite ✗）");
    assert.ok(panel.includes("disabled={editingNodeId !== null || leaveDialog !== null}"), "编辑器/三选一开着时不许回地图");
    /* 用户 2026-10 反馈："左上角突然多出来的文字块不喜欢" ⇒ 头行不许再渲染文字面包屑 ✗ */
    assert.equal(panel.includes("kn-crumbs"), false, "头行不许再有文字面包屑");
    assert.equal(panel.includes("wholeGraphName"), false, "不许再用旧的整图名字段");
  });

  it("地图用「当前空间」标记表达当前在哪座岛（头行不重复写岛名 ✓）", () => {
    assert.ok(panel.includes("currentIslandId={islandId}"), "把当前作用域交给地图");
    assert.ok(mapComponent.includes("currentIslandId === island.key"), "命中当前岛的卡片要能标出来");
    assert.ok(mapComponent.includes('t("currentSpace")'), "当前岛卡片显示「当前空间」而不是「进入空间」");
    assert.ok(new RegExp("\\.kn-island\\.is-current\\s*[,{]").test(css), "当前岛卡片要有样式");
  });

  it("地图组件确实渲染 SVG 缩略图，且样式都定义在注入的 panel.css 里（Shadow DOM 边界）", () => {
    assert.ok(mapComponent.includes("<svg"), "岛卡要有缩略图");
    assert.ok(mapComponent.includes("kn-island-svg"), "缩略图类名");
    for (const cls of ["kn-map-stage", "kn-map", "kn-map-grid", "kn-island", "kn-map-foot", "kn-map-whole", "kn-map-empty"]) {
      assert.ok(new RegExp(`\\.${cls}\\s*[,{]`).test(css), `${cls} 必须有样式定义`);
    }
    assert.ok(css.includes(".kn-map-stage[data-visible=\"false\"]"), "地图也要用显隐而不是卸载");
  });
});
