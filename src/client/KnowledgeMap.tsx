/**
 * 平面总览层：知识地图。
 *
 * 这一层只回答「知识库里有哪些群岛」，不画岛与岛之间的关系，也不让距离带语义。
 * 点一座岛 ⇒ 交给面板进入"只含这座岛"的空间视图（`GraphPanel` 负责裁剪数据与视角记忆）。
 *
 * 为什么自绘而不是套宿主组件：面板在 **Shadow DOM** 里，宿主的内联 UI 组件（Pill / Button /
 * SegmentedTabs …）的样式在宿主文档的样式表里，进不了 shadow root ⇒ 渲染出来是未样式化的裸控件 ✗。
 * 宿主的覆盖层组件（Modal / ImageLightbox 等）之所以能复用，是因为它们 portal 到 `document.body` ✓。
 * 这一层是**内联 UI**，所以按插件自己的 token/类名体系自绘（评估见 `design/knowledge-map-two-layer.md`）。
 */
import { useMemo } from "react";

import type { IslandPreview, KnowledgeMapModel } from "./knowledge-map.ts";

/** 缩略图的坐标系（宽高比与卡片里那块预览一致） */
const PREVIEW_WIDTH = 100;
const PREVIEW_HEIGHT = 72;

/** 渲染层用的翻译函数（由面板注入，保证三层取词与中英字典一致 ✓） */
type Translate = (key: string, values?: Record<string, string | number>) => string;

export interface KnowledgeMapProps {
  model: KnowledgeMapModel;
  /** 当前空间作用域（null = 整张图）：给对应岛卡打「当前空间」标记（头行不再重复写岛名 ✓） */
  currentIslandId?: string | null;
  onEnterIsland: (islandKey: string) => void;
  onEnterWhole: () => void;
  t: Translate;
}

/**
 * 知识地图（平面层）本体。
 *
 * @param props - 岛模型、当前作用域、进入回调与翻译函数。
 * @returns 地图内容；空库时给"右键新建"的提示。
 */
export function KnowledgeMap({ model, currentIslandId = null, onEnterIsland, onEnterWhole, t }: KnowledgeMapProps) {
  const empty = model.totalNodes === 0;
  const islandTotal = model.islands.length;
  const shownIslands = model.islands;
  const showWhole = !empty && islandTotal > 1;
  const meta = t("mapMeta", {
    nodes: model.totalNodes,
    edges: model.totalEdges,
    islands: islandTotal,
  });
  return (
    <div className="kn-map">
      <div className="kn-map-head">
        <div className="kn-map-eyebrow">{t("mapEyebrow")}</div>
        <h2 className="kn-map-title">{t("mapTitle")}</h2>
        <p className="kn-map-sub">{t("mapSubtitle")}</p>
        <div className="kn-map-meta-row">
          <span className="kn-map-meta">{meta}</span>
          <button type="button" className="kn-map-whole" onClick={onEnterWhole} hidden={!showWhole}>
            {t("wholeGraphAction")}
            <span className="kn-map-whole-arrow" aria-hidden="true">↗</span>
          </button>
        </div>
        <div className="kn-map-legend">
          <span className="kn-map-legend-dot is-known" aria-hidden="true" />
          <span className="kn-map-legend-text">{t("mapLegendKnown")}</span>
          <span className="kn-map-legend-dot" aria-hidden="true" />
          <span className="kn-map-legend-text">{t("mapLegendUnknown")}</span>
        </div>
      </div>

      {empty ? (
        <div className="kn-map-empty">
          <div className="kn-map-empty-title">{t("noNodes")}</div>
          <div className="kn-map-empty-hint">{t("emptyHint")}</div>
          <div className="kn-map-empty-hint">{t("mapEmptyHint")}</div>
        </div>
      ) : (
        <div className="kn-map-scroll">
          <div className="kn-map-grid">
            {shownIslands.map((island, index) => {
              const label = island.name ?? t("isolatedIsland");
              const isCurrent = currentIslandId === island.key;
              const code = island.isolated
                ? t("islandCodeLoose", { count: island.nodeCount })
                : t("islandCode", { index: String(index + 1).padStart(2, "0") });
              const islandMeta = t("islandMeta", { nodes: island.nodeCount, edges: island.edgeCount });
              const aria = island.name === null
                ? t("islandAriaIsolated", { nodes: island.nodeCount, edges: island.edgeCount })
                : t("islandAria", { name: label, nodes: island.nodeCount, edges: island.edgeCount });
              return (
                <button
                  key={island.key}
                  type="button"
                  className={[
                    "kn-island",
                    island.isolated ? "is-isolated" : "",
                    isCurrent ? "is-current" : "",
                  ].filter(Boolean).join(" ")}
                  onClick={() => { onEnterIsland(island.key); }}
                  aria-label={aria}
                  title={label}
                >
                  <span className="kn-island-preview" aria-hidden="true">
                    <IslandPreviewGraphic preview={island.preview} />
                  </span>
                  <span className="kn-island-body">
                    <span className="kn-island-code">{code}</span>
                    <span className="kn-island-name">{label}</span>
                    <span className="kn-island-meta">{islandMeta}</span>
                    <span className="kn-island-enter">
                      {isCurrent ? t("currentSpace") : t("enterSpace")}
                      <span className="kn-island-enter-arrow" aria-hidden="true">↗</span>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="kn-map-foot">{t("mapHint")}</div>
    </div>
  );
}

/**
 * 岛卡里的小型拓扑图。
 *
 * 用 SVG 而不是 canvas：几十个点，SVG 足够快、还能跟随 CSS 主题 token 变色 ✓。
 *
 * @param props.preview - 归一化到 [0,1] 的确定性布局。
 * @returns 可直接放进卡片的 SVG。
 */
function IslandPreviewGraphic({ preview }: { preview: IslandPreview }) {
  const dotRadius = useMemo(() => {
    const count = preview.points.length;
    return count > 80 ? 1.25 : count > 40 ? 1.55 : 1.9;
  }, [preview.points.length]);
  return (
    <svg
      className="kn-island-svg"
      viewBox={`0 0 ${PREVIEW_WIDTH} ${PREVIEW_HEIGHT}`}
      role="presentation"
      focusable="false"
    >
      {preview.edges.map(([from, to], index) => {
        const a = preview.points[from];
        const b = preview.points[to];
        if (a === undefined || b === undefined) return null;
        return (
          <line
            key={`e-${index}`}
            className="kn-island-link"
            x1={a.x * PREVIEW_WIDTH}
            y1={a.y * PREVIEW_HEIGHT}
            x2={b.x * PREVIEW_WIDTH}
            y2={b.y * PREVIEW_HEIGHT}
          />
        );
      })}
      {preview.points.map((point) => (
        <g key={point.id}>
          {point.representative ? (
            <circle
              className="kn-island-ring"
              cx={point.x * PREVIEW_WIDTH}
              cy={point.y * PREVIEW_HEIGHT}
              r={dotRadius + 2.6}
            />
          ) : null}
          <circle
            className={point.known ? "kn-island-dot is-known" : "kn-island-dot"}
            cx={point.x * PREVIEW_WIDTH}
            cy={point.y * PREVIEW_HEIGHT}
            r={point.representative ? dotRadius + 0.6 : dotRadius}
          />
        </g>
      ))}
    </svg>
  );
}
