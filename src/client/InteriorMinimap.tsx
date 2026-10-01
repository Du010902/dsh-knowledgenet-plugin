/**
 * 右下角的**实时截面小地图**：把用户手绘的那张平面图搬进界面。
 *
 * 图上有什么（对应他的画）：
 * - 一个大圆 = 操作包围球；
 * - 圆心的小点 = **固定转动中心** C（黑点）；
 * - 一只眼睛 = 视角（相机）当前在球里的位置；眼睛朝向 = 视线方向（往球里看）；
 * - 一串渐渐变淡的眼睛 = 刚才走过的路径（他画里那排眼睛 ✓）。
 *
 * 关键：位置不是示意的 —— 眼睛到圆心的**图上距离**就是 `|P − C| / 半径`（真实比例）✓，
 * 于是"滚轮深入球体、穿过黑点、继续往外"这件事在图上直接看得见 ✓。
 *
 * 数据来源：控制器在每次相机变化后广播的 `kn-interior-state` 事件
 * （引擎在上游组件内部创建，插件拿不到实例；这条通道不用改上游 ✓）。
 * 面板用 `contains()` 认领属于自己那块画布的事件，多视图/多标签页不会串 ✓。
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import {
  INTERIOR_STATE_EVENT,
  type InteriorStateDetail,
} from "./interior-controller.ts";
import { distanceRatio, minimapPoint, shouldSampleTrail } from "./interior-navigation.ts";

/** 画布尺寸（viewBox 单位）与球的图上半径 */
const SIZE = 100;
const BALL_RADIUS = 33;
/** 轨迹保留几个采样（他画里那排依次渐远的眼睛 ✓） */
const TRAIL_LENGTH = 6;
/** 轨迹采样间隔（毫秒）：拖动时每个 pointermove 都记会糊成一团 ✗ */
const TRAIL_INTERVAL_MS = 120;
/** 同一个 eye 的重复广播不再追加轨迹（用"移动量占半径的比例"判断 ✓） */
const TRAIL_MIN_MOVE_RATIO = 0.004;
/** 超出这个半径倍数就夹到框边（真实位置还在更外面）✓ */
const CLAMP_RATIO = 1.4;

/**
 * 一个采样：**保存世界坐标下的相机位置**，绘制时才投到"当前"截面 ✓。
 *
 * 为什么不能直接存截面坐标（文档 P2）：截面是随相机朝向定义的 ✗ ——
 * 定位改了朝向后，不同时刻的截面坐标根本不是同一个空间，连起来就是假轨迹 ✗。
 * 存世界坐标则任何时候都能统一投影 ✓。
 */
interface Sample {
  eye: [number, number, number];
}

interface Snapshot {
  /** 归一化截面坐标：横轴 = 沿视线的深度（球心在前方为正 ✓），纵轴 = 相机上方向偏移 ✓ */
  nx: number;
  ny: number;
  /** 到球心的距离 / 半径（距离读数 ✓；纵轴改用 up 分量后图上距离不再是真实距离 ✓） */
  ratio: number;
}

/**
 * 小地图组件。
 * @param props.hostRef - 图区容器：用来认领属于自己那块画布的事件 ✓。
 * @param props.active - 视图是否可见（不可见就不画，省得留着上一个库的位置 ✗）。
 * @returns SVG 小地图。
 */
export function InteriorMinimap({
  hostRef,
  active,
}: {
  hostRef: RefObject<HTMLElement | null>;
  active: boolean;
}): ReactNode {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [trail, setTrail] = useState<Sample[]>([]);
  const lastSampleRef = useRef(0);
  /** 最近一次采样用的世界坐标与截面定义（去重 + 轨迹重投影都要用 ✓） */
  const lastEyeRef = useRef<[number, number, number] | null>(null);
  /** 当前截面：绘制轨迹时要按**当前**朝向统一重投影 ✓ */
  const sectionRef = useRef<{ center: [number, number, number]; forward: [number, number, number]; up: [number, number, number]; radius: number } | null>(null);

  useEffect(() => {
    const onState = (event: Event): void => {
      const detail = (event as CustomEvent<InteriorStateDetail>).detail;
      if (detail === undefined || detail === null || !(detail.radius > 0)) return;
      const container = hostRef.current;
      /* 只认自己这块画布里的事件（引擎宿主元素是它的后代）✓ */
      if (container === null || !container.contains(detail.host)) return;
      sectionRef.current = {
        center: [...detail.center],
        forward: [...detail.forward],
        up: [...detail.up],
        radius: detail.radius,
      };
      const point = minimapPoint(detail);
      setSnapshot({
        nx: point.depth / detail.radius,
        /* 纵轴用相机上方向的分量（连续，不会因为 up 分量过零而左右横跳 ✓） */
        ny: -point.lateral / detail.radius,
        ratio: distanceRatio(point.distance, detail.radius),
      });
      /* 轨迹：世界坐标 + 时间采样 + 去重（同一位置反复广播不再追加 ✗）✓ */
      const eye: [number, number, number] = [detail.eye[0], detail.eye[1], detail.eye[2]];
      if (!shouldSampleTrail(lastEyeRef.current, eye, detail.radius, TRAIL_MIN_MOVE_RATIO)) return;
      lastEyeRef.current = eye;
      const now = typeof performance !== "undefined" ? performance.now() : 0;
      if (now - lastSampleRef.current >= TRAIL_INTERVAL_MS) {
        lastSampleRef.current = now;
        setTrail((prev) => [...prev, { eye }].slice(-TRAIL_LENGTH));
      }
    };
    window.addEventListener(INTERIOR_STATE_EVENT, onState);
    return () => { window.removeEventListener(INTERIOR_STATE_EVENT, onState); };
  }, [hostRef]);

  /* 切走/换库时清掉旧位置，免得留着一个不属于当前图的点 ✗ */
  useEffect(() => {
    if (!active) {
      setSnapshot(null);
      setTrail([]);
      lastEyeRef.current = null;
    }
  }, [active]);

  /** 归一化截面坐标 → SVG 坐标（球心在正中，球面 = BALL_RADIUS）✓ */
  const toSvg = (point: { nx: number; ny: number }): { x: number; y: number } => {
    const length = Math.hypot(point.nx, point.ny);
    const k = length > CLAMP_RATIO ? CLAMP_RATIO / length : 1;
    return {
      x: SIZE / 2 + point.nx * k * BALL_RADIUS,
      y: SIZE / 2 + point.ny * k * BALL_RADIUS,
    };
  };

  /** 把轨迹里的**世界坐标**投到当前截面（朝向变了也不会连成假轨迹 ✓） */
  const trailSnapshot = (sample: Sample): Snapshot | null => {
    const section = sectionRef.current;
    if (section === null) return null;
    const point = minimapPoint({
      center: section.center,
      eye: sample.eye,
      forward: section.forward,
      up: section.up,
      radius: section.radius,
    });
    return {
      nx: point.depth / section.radius,
      ny: -point.lateral / section.radius,
      ratio: distanceRatio(point.distance, section.radius),
    };
  };

  if (!active || snapshot === null) return null;
  const eye = toSvg(snapshot);
  const clamped = snapshot.ratio > CLAMP_RATIO;

  return (
    <div className="kn-minimap" aria-hidden="true" data-testid="kn-minimap">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE}>
        {/* 球体 */}
        <circle className="kn-minimap-ball" cx={SIZE / 2} cy={SIZE / 2} r={BALL_RADIUS} />
        {/* 过球心的水平基线：方便读出"深度"（他画里那条穿过所有眼睛的横线 ✓） */}
        <line
          className="kn-minimap-axis"
          x1={SIZE / 2 - BALL_RADIUS - 6}
          y1={SIZE / 2}
          x2={SIZE / 2 + BALL_RADIUS + 6}
          y2={SIZE / 2}
        />
        {/* 走过的路径：世界坐标投到**当前**截面，越早越淡 ✓ */}
        {trail.slice(0, -1).map((sample, index) => {
          const projected = trailSnapshot(sample);
          if (projected === null) return null;
          const dot = toSvg(projected);
          return (
            <circle
              key={`${index}-${dot.x.toFixed(2)}-${dot.y.toFixed(2)}`}
              className="kn-minimap-trail"
              cx={dot.x}
              cy={dot.y}
              r={2}
              opacity={0.12 + (index + 1) * (0.5 / TRAIL_LENGTH)}
            />
          );
        })}
        {/* 球心 = 固定转动中心（黑点） */}
        <circle className="kn-minimap-center" cx={SIZE / 2} cy={SIZE / 2} r={2.4} />
        {/* 视角（相机）当前位置：一只朝球里看的眼睛 ✓ */}
        <g transform={`translate(${eye.x} ${eye.y})`}>
          {/* 真实位置在框外（超出 1.4 倍半径）⇒ 虚线圈提示"这里只是被夹到边上" ✓ */}
          {clamped ? <circle className="kn-minimap-clamped" cx={0} cy={0} r={9.5} /> : null}
          <path className="kn-minimap-eye-outline" d="M -7 0 Q 0 -5.2 7 0 Q 0 5.2 -7 0 Z" />
          {/* 瞳孔偏向左（= 往球里、往深处看 ✓） */}
          <circle className="kn-minimap-pupil" cx={-2.1} cy={0} r={1.9} />
        </g>
        {/*
          * 距离读数：纵轴改用 up 分量之后，"图上距离 = 真实距离"不再成立，
          * 所以把到球心的距离单独标出来（单位 = 操作球半径 ✓）——文档要求"另给距离指标" ✓。
          */}
        <text className="kn-minimap-distance" x={SIZE / 2} y={SIZE - 2} textAnchor="middle">
          {snapshot.ratio.toFixed(2)}R
        </text>
      </svg>
    </div>
  );
}
