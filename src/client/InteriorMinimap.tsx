/**
 * 右下角的**视角位置图**：把"相机站在操作球的哪里"画成两张正交的位置平面图。
 *
 * ## 它表达什么（先把语义说清楚）
 *
 * 它显示的是**相机位置**（人在显示世界里的位置），**不是图谱的朝向** ✗。
 * 拖动只旋转图谱（`scene`），人到球心的位置不变 ⇒ 位置图不动是**正确**的 ✓
 * （别把这个正确行为当成"仪表卡住了"）。
 *
 * ## 为什么是两张图（文档 `design/minimap-position-continuity-analysis.md`）
 *
 * 一张二维图无法无损表达三维位置：旧实现只画 `forward/up` 两个分量、把 `right` 丢掉 ✗ ——
 * 相机位于 `(600,0,0)` 时两个分量都是 0 ⇒ 眼睛被画到**圆心**，读数却写着 2R ✗。
 * 现在给两张共享球心/尺度的正交投影（**深度/上下** 与 **深度/左右**），三分量都看得见 ✓，
 * `hypot(depth, up, right)` 就是真实距离 ✓（无损）。
 *
 * ## 另外三条硬要求
 *
 * 1. **参考轴固定**：轴在该库视图首次建立时定下来，之后不随相机朝向变 ✗
 *    （否则定位或滚转会让整张图与历史轨迹一起漂，看着像相机在动 ✗）。
 * 2. **球外不再硬夹**：球内线性、球外严格单调压缩（渐近到 1.32 倍球半径 ✓）——
 *    旧的"超过 1.4R 就停在边上"会让 3.28R / 3R / 2R 画在同一个点上 ✗。
 * 3. **图标不许被裁**：圆心 + 最大图上半径 + 图标/提示圈 + 边距必须落在 viewBox 内 ✓（下面有断言）。
 *
 * 轨迹采样以"**真正提交**过的位置"为基准（旧实现先更新基准再看时间闸门 ⇒ 慢速小步攒不出点 ✗）；
 * 换库/重建（`sceneKey` 变化）或球心、半径参考变化时清空历史 ✓。
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import {
  INTERIOR_STATE_EVENT,
  type InteriorStateDetail,
} from "./interior-controller.ts";
import {
  minimapAxesFrom,
  minimapComponents,
  minimapForwardIn,
  minimapPlotOffset,
  minimapPlottedRatio,
  trailSampleStep,
  MINIMAP_EXTERIOR_HEADROOM,
  type MinimapAxes,
  type MinimapComponents,
} from "./interior-navigation.ts";
import type { Vec3 } from "./trackball.ts";

/* ------------------------------ 几何常量（留白） ------------------------------ */

/*
 * 尺寸要**一次算清所有会被画出来的东西** ✗ —— 复查指出的遗漏：
 * 之前只算了眼睛与提示圈，漏了**方向箭头**和**朝内/朝外符号**，
 * 于是位置在球下方（例如 2R）时符号会延伸到 62.85、超出 62 的画布被裁 ✗。
 * 现在所有常量都进同一个留白模型（见下面的 DECOR_EXTENT / MAX_EXTENT ✓）。
 */

/** 单张位置图的画布尺寸（viewBox 单位） */
const SIZE = 68;
/** 球心在画布中的位置 */
const CENTER = SIZE / 2;
/** 球在画布上的半径（图上半径 1 就画到这里 ✓） */
const BALL_RADIUS = 16;
/** 眼睛图标的最大半宽/半高 */
const EYE_HALF_WIDTH = 5.5;
const EYE_HALF_HEIGHT = 4;
/** "位置在球外（比例被压缩）"提示圈的半径 */
const OUTSIDE_RING = 6;
/** 方向箭头长度，以及"投影太短就改用朝内/朝外符号"的阈值 ✓ */
const ARROW_LENGTH = 9;
const ARROW_MIN_LENGTH = 0.18;
/** 朝内/朝外符号：半径，以及它相对眼睛下缘的间距 ✓ */
const SYMBOL_RADIUS = 3.2;
const SYMBOL_GAP = 5;

/**
 * 眼睛之外**还需要多少留白**（取四个方向里最大的那个 ✓）：
 * - 右/左：箭头长度、提示圈、眼睛半宽；
 * - 下：朝内/朝外符号（眼睛半高 + 间距 + 符号半径）与箭头；
 * - 上：眼睛半高。
 * 少算任何一项都会让极端方向被裁 ✗（复查就是抓到了漏算符号这一条 ✓）。
 */
const DECOR_EXTENT = Math.max(
  ARROW_LENGTH,
  OUTSIDE_RING,
  EYE_HALF_WIDTH,
  EYE_HALF_HEIGHT,
  EYE_HALF_HEIGHT + SYMBOL_GAP + SYMBOL_RADIUS,
);

/**
 * 留白校验：最远的眼睛（含图标、提示圈、箭头、方向符号）必须完整落在画布内 ✓
 * （文档要求验证右侧/底部/四角；这里在模块加载时就断言，而不是等截图才发现被裁 ✗）
 */
const MAX_EXTENT = CENTER + (1 + MINIMAP_EXTERIOR_HEADROOM) * BALL_RADIUS + DECOR_EXTENT;
if (MAX_EXTENT > SIZE) {
  throw new Error(
    `小地图留白不足：最远延伸到 ${MAX_EXTENT.toFixed(2)}，画布只有 ${SIZE} ✗`
    + `（眼睛图标 / 提示圈 / 箭头 / 方向符号都要算进去 ✓）`,
  );
}

/** 轨迹保留几个采样 */
const TRAIL_LENGTH = 6;
/** 轨迹采样间隔（毫秒）与位移阈值（相对球半径） */
const TRAIL_INTERVAL_MS = 120;
const TRAIL_MIN_MOVE_RATIO = 0.004;
/** 球心/半径变化超过这个量就认为"换了布局参考" ⇒ 清空轨迹 ✓ */
const REFERENCE_EPSILON = 1e-3;

interface Snapshot {
  /** 固定参考轴下的三分量与真实距离 ✓ */
  components: MinimapComponents;
  /** 当前视线（画方向箭头 ✓） */
  forward: Vec3;
  radius: number;
}

/** 一张位置图的纵轴取哪条（横轴永远是固定深度轴 ✓） */
type PanelAxis = "up" | "right";
const AXES_LABEL: Record<PanelAxis, string> = { up: "↑↓", right: "↔" };

/**
 * 小地图组件。
 * @param props.hostRef - 图区容器：用来认领属于自己那块画布的状态事件 ✓。
 * @param props.active - 视图是否可见（不可见就清空，免得留着上一个场景的点 ✗）。
 * @param props.sceneKey - 场景标识（库 + 节点集合）：变化即清空位置图与历史轨迹 ✓。
 * @returns 两张正交位置图 + 真实距离读数。
 */
export function InteriorMinimap({
  hostRef,
  active,
  sceneKey,
}: {
  hostRef: RefObject<HTMLElement | null>;
  active: boolean;
  sceneKey: string;
}): ReactNode {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [trail, setTrail] = useState<Vec3[]>([]);
  /** 固定参考轴（建立后不再随相机朝向变 ✓） */
  const axesRef = useRef<MinimapAxes | null>(null);
  /** 轨迹采样基准：**只跟真正提交过的位置** ✓ */
  const trailBaseRef = useRef<{ lastEye: Vec3 | null; lastAt: number }>({ lastEye: null, lastAt: 0 });
  /** 上一次的球心/半径：用于发现"换了布局参考" ✓ */
  const referenceRef = useRef<{ center: Vec3; radius: number } | null>(null);

  useEffect(() => {
    const onState = (event: Event): void => {
      const detail = (event as CustomEvent<InteriorStateDetail>).detail;
      if (detail === undefined || detail === null || !(detail.radius > 0)) return;
      const container = hostRef.current;
      if (container === null || !container.contains(detail.host)) return;

      const center: Vec3 = [...detail.center];
      const eye: Vec3 = [...detail.eye];
      /* 球心或半径变了 ⇒ 换了布局参考 ⇒ 历史轨迹一律清空（别把旧场景的点投到新场景 ✗） */
      const reference = referenceRef.current;
      if (reference !== null
        && (Math.hypot(
          center[0] - reference.center[0],
          center[1] - reference.center[1],
          center[2] - reference.center[2],
        ) > REFERENCE_EPSILON
          || Math.abs(detail.radius - reference.radius) / reference.radius > REFERENCE_EPSILON)) {
        setTrail([]);
        trailBaseRef.current = { lastEye: null, lastAt: 0 };
      }
      referenceRef.current = { center, radius: detail.radius };

      /* 参考轴：只在这里**建立一次** ✓（之后相机怎么转都不动它 ✗） */
      if (axesRef.current === null) {
        axesRef.current = minimapAxesFrom(detail.forward, detail.up, detail.right);
      }
      setSnapshot({
        components: minimapComponents(eye, center, axesRef.current),
        forward: [...detail.forward],
        radius: detail.radius,
      });

      /* 轨迹：位移阈值 + 时间闸门；**只有真正提交时才更新基准** ✓ */
      const now = typeof performance !== "undefined" ? performance.now() : 0;
      const base = trailBaseRef.current;
      const step = trailSampleStep(
        base.lastEye,
        eye,
        detail.radius,
        now,
        base.lastAt,
        TRAIL_MIN_MOVE_RATIO,
        TRAIL_INTERVAL_MS,
      );
      if (step.committed) {
        trailBaseRef.current = { lastEye: step.lastEye, lastAt: step.lastAt };
        setTrail((previous) => [...previous, eye].slice(-TRAIL_LENGTH));
      }
    };
    window.addEventListener(INTERIOR_STATE_EVENT, onState);
    return () => { window.removeEventListener(INTERIOR_STATE_EVENT, onState); };
  }, [hostRef]);

  /* 不可见 / 换库换场景 ⇒ 全部清空（含参考轴：新库重新建立 ✓） */
  useEffect(() => {
    setSnapshot(null);
    setTrail([]);
    axesRef.current = null;
    referenceRef.current = null;
    trailBaseRef.current = { lastEye: null, lastAt: 0 };
  }, [active, sceneKey]);

  if (!active || snapshot === null) return null;

  const { components, forward, radius } = snapshot;
  const rawRatio = radius > 0 ? components.distance / radius : 0;
  /** 球外按比例压缩：**方向不变、长度取压缩后的图上半径** ✓（每世界单位的比例，不是两个比值相除 ✗） */
  const plot = (depth: number, lateral: number, distance: number): { x: number; y: number } => {
    const offset = minimapPlotOffset(depth, lateral, distance, radius);
    return { x: CENTER + offset.x * BALL_RADIUS, y: CENTER - offset.y * BALL_RADIUS };
  };

  const drawPanel = (axis: PanelAxis): ReactNode => {
    const lateral = axis === "up" ? components.up : components.right;
    const eye = plot(components.depth, lateral, components.distance);
    /* 方向箭头：当前视线在该图平面里的分量 ✓ */
    const axes = axesRef.current ?? minimapAxesFrom(forward, [0, 1, 0], [1, 0, 0]);
    const view = minimapForwardIn(axes, forward);
    const arrowX = view.forward;
    const arrowY = axis === "up" ? view.up : view.right;
    const arrowLength = Math.hypot(arrowX, arrowY);
    /* 视线几乎垂直于本图平面 ⇒ 用"朝内 / 朝外"符号，别退化成看不出方向的箭头 ✗ */
    const perpendicular = arrowLength < ARROW_MIN_LENGTH;
    const outward = (axis === "up" ? view.right : view.up) > 0;
    const arrowScale = arrowLength > 1e-9 ? ARROW_LENGTH / arrowLength : 0;
    const center = referenceRef.current;

    return (
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE} key={axis}>
        <circle className="kn-minimap-ball" cx={CENTER} cy={CENTER} r={BALL_RADIUS} />
        <line
          className="kn-minimap-axis"
          x1={CENTER - BALL_RADIUS - 5}
          y1={CENTER}
          x2={CENTER + BALL_RADIUS + 5}
          y2={CENTER}
        />
        {/* 这一张图的纵轴记号（固定参考 ✓） */}
        <text className="kn-minimap-glyph" x={4} y={11}>{AXES_LABEL[axis]}</text>
        {/* 走过的路径：世界坐标 → **固定**参考轴 ✓（历史不会随朝向漂 ✗） */}
        {center === null ? null : trail.slice(0, -1).map((sample, index) => {
          const dot = minimapComponents(sample, center.center, axes);
          const at = plot(dot.depth, axis === "up" ? dot.up : dot.right, dot.distance);
          return (
            <circle
              key={`${axis}-${index}`}
              className="kn-minimap-trail"
              cx={at.x}
              cy={at.y}
              r={1.6}
              opacity={0.12 + (index + 1) * (0.5 / TRAIL_LENGTH)}
            />
          );
        })}
        {/* 球心 = 固定转动中心 */}
        <circle className="kn-minimap-center" cx={CENTER} cy={CENTER} r={2.2} />
        {/* 视角当前位置 */}
        <g transform={`translate(${eye.x} ${eye.y})`}>
          {rawRatio > 1 ? <circle className="kn-minimap-clamped" cx={0} cy={0} r={OUTSIDE_RING} /> : null}
          <ellipse className="kn-minimap-eye-outline" cx={0} cy={0} rx={EYE_HALF_WIDTH} ry={EYE_HALF_HEIGHT} />
          {/* 瞳孔指向**视线在该图平面里的投影** ✓；垂直时用居中实心点，不假装朝左 ✗ */}
          {perpendicular
            ? <circle className="kn-minimap-pupil" cx={0} cy={0} r={1.8} />
            : (
              <circle
                className="kn-minimap-pupil"
                cx={arrowX * arrowScale * 0.45}
                cy={-arrowY * arrowScale * 0.45}
                r={1.7}
              />
            )}
        </g>
        {/* 方向：要么箭头（真实投影 ✓），要么"朝内 ⊗ / 朝外 ⊙"符号 ✓ */}
        {perpendicular ? (
          <g
            className="kn-minimap-outward"
            transform={`translate(${eye.x} ${eye.y + EYE_HALF_HEIGHT + SYMBOL_GAP})`}
          >
            <circle cx={0} cy={0} r={SYMBOL_RADIUS} />
            {outward
              ? <circle className="kn-minimap-outward-dot" cx={0} cy={0} r={1.3} />
              : (
                <>
                  <line x1={-2.2} y1={-2.2} x2={2.2} y2={2.2} />
                  <line x1={-2.2} y1={2.2} x2={2.2} y2={-2.2} />
                </>
              )}
          </g>
        ) : (
          <line
            className="kn-minimap-arrow"
            x1={eye.x}
            y1={eye.y}
            x2={eye.x + arrowX * arrowScale}
            y2={eye.y - arrowY * arrowScale}
          />
        )}
      </svg>
    );
  };

  return (
    <div className="kn-minimap" aria-hidden="true" data-testid="kn-minimap">
      <div className="kn-minimap-row">
        {drawPanel("up")}
        {drawPanel("right")}
      </div>
      {/* 真实距离读数：图上半径**经过压缩** ⇒ 数值仍给真实比例 ✓；球外加 ↗ 提示 ✓ */}
      <div className="kn-minimap-distance">
        {rawRatio > 1 ? "↗ " : ""}
        {rawRatio.toFixed(2)}R
      </div>
    </div>
  );
}
