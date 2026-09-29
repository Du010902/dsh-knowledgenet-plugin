/**
 * 三维渲染器（three）
 *
 * 只做渲染与资源生命周期，不含业务判断。画法**逐条对齐**
 * `design/workbench-ui-reference.html` 的 `spaceGraph`（521–834 行）：
 *
 * - 节点：球体不是「有粗糙度的 PBR 球 + 灯光」，而是一块**固定屏幕空间光照**的
 *   渐变球——左上一点白色高光、主体是状态色、边缘收进冷黑 `#132025`，
 *   外面再回勾一圈状态色作为轮廓（参考图 `drawSphere` 的 radial gradient 与 stroke）。
 *   高光方向跟着相机走，因此任何环绕角度看过去高光都在左上，和参考图一致。
 * - 选中：屏幕空间的两道环（r+9 @ .28、r+5 @ .08）＋ 球体放大 1.35；
 *   悬停放大 1.16；与选中无关的节点按 0.38 不透明度淡出。
 * - 连线：普通边细且半透明（.28，无关时 .13），并按深度做 `clamp(720/depth,.38,1)`
 *   的距离衰减；与当前节点相关的边走强调色、2px、并带一个小箭头。
 * - 星尘：低对比度的空间微粒，给「深度」一个参照物，不抢节点的视觉。
 *
 * 与参考图唯一的结构性差别是这里用真实三维管线（真实透视、真实遮挡），
 * 而参考图是二维 canvas 手写投影：因此「屏幕空间」的东西（高光方向、选中环、
 * 箭头大小、线宽）都在着色器里按 CSS 像素换算，不随缩放变化。
 *
 * 资源：几何 / 材质 / 属性都在 dispose 里释放，共享资源只有一个所有者。
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Quaternion,
  SRGBColorSpace,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
} from "three";
import type { InterleavedBufferAttribute } from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";

import { projectNodes, NEAR_PLANE, NODE_MIN_PIXELS as CAMERA_NODE_MIN_PIXELS, NODE_MAX_PIXELS as CAMERA_NODE_MAX_PIXELS } from "./camera.ts";
import type { SpaceGraph } from "./adapter.ts";
import type { SpacePalette, Rgb } from "./palette.ts";
import type { Bounds } from "./camera.ts";
import type { CameraBasis, ProjectedNode, Viewport } from "./types.ts";

/* ------------------------------ 画法常量 ------------------------------ */
/* 下面每个数字都能在 design/workbench-ui-reference.html 的 spaceGraph 里找到出处 */

/** 节点屏幕半径的下限 / 上限：与投影层共用同一对常量（单一来源） */
const NODE_MIN_PIXELS = CAMERA_NODE_MIN_PIXELS;
const NODE_MAX_PIXELS = CAMERA_NODE_MAX_PIXELS;
/** 选中 / 悬停时球体在屏幕上的放大倍数（参考图 drawSphere） */
const SELECTED_SCALE = 1.35;
const HOVER_SCALE = 1.16;
/** 与当前选中无关的节点 / 连线的不透明度（参考图 `opacity = dimmed ? .38 : 1`） */
const DIM_ALPHA = 0.38;
/** 普通连线的透明度：相关边之外的连线在「无关」时再淡一档 */
const EDGE_ALPHA = 0.28;
const EDGE_ALPHA_DIMMED = 0.13;
/**
 * 深度衰减的参考距离与相机距离之比。
 *
 * 参考图画的是 `clamp(720 / depth, .38, 1)`：它的默认机位距离是 560，
 * 也就是「1.3 倍机位距离」——目标平面上的连线取满值，越远越淡。
 * 拿包围体半径当基准会在小图上失真（两三个节点时云团半径很小，
 * 所有连线都会被压到 .38 的下限，整张图看起来没有关系）。
 * 按机位距离取比例，缩放到哪一档，线的浓淡都保持同一套相对关系。
 */
const EDGE_FADE_VIEW_RATIO = 1.3;
/** 衰减下限：再淡也要留出可辨认的对比度 */
const EDGE_FADE_MIN = 0.38;
/** 强调边（与当前节点相关）：2px、.92（参考图 drawEdges 的 active 分支） */
const ACTIVE_LINE_WIDTH = 2;
const ACTIVE_LINE_ALPHA = 0.92;
/** 箭头腿长（CSS 像素）与「太短就不画」的阈值：参考图 drawArrow 的 4.2 与 18 */
const ARROW_LEG_PIXELS = 4.2;
const ARROW_MIN_EDGE_PIXELS = 18;
/** 选中环：r+9 细环 @ .25，r+5 宽环 @ .06（参考图 drawSphere 的选中分支，验收清单 P2-4 再压了一档） */
const RING_OUTER_OFFSET = 9;
const RING_OUTER_HALF = 0.7;
const RING_OUTER_ALPHA = 0.25;
const RING_GLOW_OFFSET = 5;
const RING_GLOW_HALF = 2.5;
const RING_GLOW_ALPHA = 0.06;
/** 选中环方片比最外圈再外扩的像素数：给抗锯齿留余量 */
const RING_PADDING = 8;
/** 星尘数量（参考图是 95 个屏幕点） */
const DUST_COUNT = 95;
/** 星尘的屏幕直径（CSS 像素，1.3 ≈ 参考图 1.1 / 0.65 两档的平均观感） */
const DUST_PIXELS = 1.3;
/** 圆锥的局部 +Y 方向；箭头用四元数从它转到实际方向 */
const UP_AXIS = new Vector3(0, 1, 0);

let webgl2Probe: boolean | null = null;

/**
 * 当前环境是否真的能建 WebGL 2 上下文（Three.js 的 WebGLRenderer 需要它）。
 *
 * 结果缓存：每次挂载都新建探测画布再主动丢弃上下文，反复进出视图会白白攒下上下文
 * （无头环境实测 6 次来回产生 24 个）。探测失败属于环境能力，重试不会变；
 * 运行时上下文丢失走的是另一条路（canvas 的 webglcontextlost 事件）。
 */
export function webgl2Available(): boolean {
  if (typeof document === "undefined") return false;
  // 只缓存成功：偶发的探测失败（例如浏览器当时的上下文数量上限）不该让整个会话
  // 再也进不了三维视图，下一次挂载还有机会重新探测。
  if (webgl2Probe === true) return true;
  try {
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2");
    if (!gl) return false;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    webgl2Probe = true;
    return true;
  } catch {
    return false;
  }
}

/**
 * 设计令牌 → three 的颜色。
 *
 * 必须声明来源是 sRGB：three 的工作色彩空间是线性光，输出时再做一次
 * linear→sRGB 编码。直接把 CSS 的数值当线性值塞进去，出来的颜色会被提亮
 * （球体发白、连线和强调色都对不上），这正是「看着不像参考图」的原因之一。
 */
function toColor([r, g, b]: Rgb): Color {
  return new Color().setRGB(r, g, b, SRGBColorSpace);
}

/** 线性浮点三元组：着色器里统一用线性光，最后由 colorspace_fragment 编码一次 */
function toLinearRgb([r, g, b]: Rgb): Rgb {
  const color = toColor([r, g, b]);
  return [color.r, color.g, color.b];
}

/**
 * 球体着色器：把参考图的二维 radial gradient 搬到三维球面上。
 *
 * 参考图那一笔是 `createRadialGradient(x-.36r, y-.42r, .08r, x, y, r)`：
 * 两个圆之间的**锥形插值**，stop 依次是 白@.9 → 状态色@.98（t=.16）
 * → 状态色@.86（t=.7）→ `#132025`@.98（t=1）。这里在片段着色器里解同一个方程
 * `|p - (C0(1-t))| = r0 + (r1-r0)t`，因此球面每一像素落在哪一档与参考完全一致，
 * 而不是另调一条「差不多的」渐变。
 *
 * `p` 取观察空间法线的 xy：屏幕上离球心的偏移（长度 1 = 轮廓）。高光圆心
 * 固定在观察空间左上 `(-0.36, 0.42)`，所以环绕到任何角度高光都在左上。
 *
 * 颜色按线性光传入（instanceColor 由 setColorAt 写入线性值），
 * 最后统一由 `<colorspace_fragment>` 编码到输出空间，颜色因此与 CSS 令牌逐位一致。
 */
const NODE_VERTEX_SHADER = /* glsl */ `
  attribute float aDim;
  attribute float aSelected;
  attribute float aRadius;
  varying vec3 vViewNormal;
  varying vec3 vTint;
  varying float vDim;
  varying float vSelected;
  varying float vRadius;
  void main() {
    vTint = instanceColor;
    vDim = aDim;
    vSelected = aSelected;
    vRadius = max(aRadius, 1.0);
    vViewNormal = normalize(normalMatrix * mat3(instanceMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

const NODE_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uRim;
  uniform vec3 uHighlight;
  uniform vec3 uBackground;
  uniform vec3 uAccentStroke;
  uniform float uDimAlpha;
  varying vec3 vViewNormal;
  varying vec3 vTint;
  varying float vDim;
  varying float vSelected;
  varying float vRadius;
  void main() {
    vec3 n = normalize(vViewNormal);
    vec2 p = vec2(n.x, n.y);
    float s = length(p);

    /* 参考图的渐变几何：内圆 C0/0.08r，外圆 0/1r（都按球半径归一化） */
    vec2 c0 = vec2(-0.36, 0.42);
    float a = dot(c0, c0) - 0.8464;                       /* 0.3060 - 0.92² */
    float b = 2.0 * dot(p, c0) - 2.0 * dot(c0, c0) - 0.1472;
    float c = dot(p, p) - 2.0 * dot(p, c0) + dot(c0, c0) - 0.0064;
    float disc = max(0.0, b * b - 4.0 * a * c);
    float t = clamp((-b - sqrt(disc)) / (2.0 * a), 0.0, 1.0);

    /* 四个 stop 按「不透明度叠加在画布底色上」换算，与 canvas 的合成结果等价 */
    vec3 s0 = mix(uBackground, uHighlight, 0.9);
    vec3 s1 = mix(uBackground, vTint, 0.98);
    vec3 s2 = mix(uBackground, vTint, 0.86);
    vec3 s3 = mix(uBackground, uRim, 0.98);
    vec3 col = t < 0.16 ? mix(s0, s1, t / 0.16)
             : t < 0.70 ? mix(s1, s2, (t - 0.16) / 0.54)
             : mix(s2, s3, (t - 0.70) / 0.30);

    /*
     * 轮廓：参考图在球面上再 stroke 一圈状态色（选中时换成 accent-strong），
     * 线宽 0.8px（选中 1.7px）。线宽是**屏幕像素**，因此按该节点当前的
     * 屏幕半径换算成归一化带宽，凑近看也不会变成一圈粗边。
     */
    float halfWidth = mix(0.4, 0.85, vSelected) / vRadius;
    float stroke = 1.0 - smoothstep(halfWidth * 0.35, halfWidth, abs(s - 1.0));
    vec3 strokeColor = mix(vTint, uAccentStroke, vSelected);
    col = mix(col, strokeColor, stroke * mix(0.65, 0.18, vDim));

    /* 淡化：整体降到 38% 不透明度（参考图的 globalAlpha），背后的连线与星尘透出来 */
    gl_FragColor = vec4(col, mix(1.0, uDimAlpha, vDim));
    #include <colorspace_fragment>
  }
`;

/**
 * 选中环：一个正对相机的方片，环半径与线宽都在**着色器里按 CSS 像素**算。
 *
 * 用三维圆环几何（RingGeometry）做不到：它的粗细会随缩放变化，凑近时变成一个
 * 套住半个屏幕的大圈。参考图的环是屏幕空间的两笔描边，这里用同一套参数复刻。
 */
const RING_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const RING_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uAccent;
  uniform float uRadiusPx;
  uniform float uQuadPx;
  varying vec2 vUv;
  float ring(float d, float centre, float halfWidth) {
    return 1.0 - smoothstep(halfWidth - 0.6, halfWidth + 0.6, abs(d - centre));
  }
  void main() {
    float d = length(vUv - 0.5) * 2.0 * uQuadPx;
    float a = max(
      ring(d, uRadiusPx + ${RING_OUTER_OFFSET}.0, ${RING_OUTER_HALF}) * ${RING_OUTER_ALPHA},
      ring(d, uRadiusPx + ${RING_GLOW_OFFSET}.0, ${RING_GLOW_HALF}) * ${RING_GLOW_ALPHA}
    );
    if (a < 0.002) discard;
    gl_FragColor = vec4(uAccent, a);
    #include <colorspace_fragment>
  }
`;

/** 普通连线：逐顶点 RGBA（alpha 由深度衰减与「是否相关」算好后写进颜色属性） */
const EDGE_VERTEX_SHADER = /* glsl */ `
  varying vec4 vColor;
  void main() {
    vColor = color;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const EDGE_FRAGMENT_SHADER = /* glsl */ `
  varying vec4 vColor;
  void main() {
    gl_FragColor = vColor;
    #include <colorspace_fragment>
  }
`;

export class SpaceRenderer {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(50, 1, NEAR_PLANE, 4000);

  private readonly renderer: WebGLRenderer;
  private readonly group = new Group();
  private readonly nodeGeometry: SphereGeometry;
  private readonly nodeMaterial: ShaderMaterial;
  private readonly edgeMaterial: ShaderMaterial;
  private readonly activeMaterial: LineMaterial;
  private readonly arrowGeometry: ConeGeometry;
  private readonly arrowMaterial: MeshBasicMaterial;
  private readonly arrowPool: Mesh[] = [];
  private readonly ring: Mesh;
  private readonly ringMaterial: ShaderMaterial;
  private readonly dust: Points;
  private readonly dustMaterial: PointsMaterial;
  private readonly dummy = new Object3D();
  private readonly color = new Color();
  private readonly arrowDirection = new Vector3();
  private readonly arrowQuaternion = new Quaternion();
  private lastWidth = 0;
  private lastHeight = 0;
  private lastPixelRatio = 0;
  /** 坐标变过：强调边（宽线层）也要跟着挪，否则会停在上一帧的位置上 */
  private positionsDirty = false;
  /** 强调边的顶点缓冲：复用，避免每次重建都新建数组 */
  private activeSegments = new Float32Array(0);
  private activeColors = new Float32Array(0);
  /** 强调边当前配色：只跟主题有关，用来避免每帧重传颜色缓冲 */
  private activeColorKey = "";

  private graph: SpaceGraph | null = null;
  private nodes: InstancedMesh | null = null;
  /**
   * 每个节点的三个实例属性（球体着色器要用）：
   * - `aDim`：淡化程度 0/1，整体降到 38% 不透明度；
   * - `aSelected`：是否选中，决定轮廓线宽与颜色；
   * - `aRadius`：该节点当前在屏幕上的半径（CSS 像素），用来把 0.8px 线宽
   *   换算成归一化带宽——屏幕空间的常量不能写死在几何里。
   */
  private dimAttribute: InstancedBufferAttribute | null = null;
  private selectedAttribute: InstancedBufferAttribute | null = null;
  private radiusAttribute: InstancedBufferAttribute | null = null;
  private edges: LineSegments | null = null;
  private activeEdges: LineSegments2 | null = null;
  private projected: ProjectedNode[] = [];
  private positions: Float32Array = new Float32Array(0);
  private palette: SpacePalette;
  private selected: number | null = null;
  /** 选中节点的屏幕半径（CSS 像素）：屏幕空间的环按它套上去 */
  private selectedScreenRadius = 0;
  private hover: number | null = null;
  private related: Set<number> = new Set();
  private relatedEdges: Array<[number, number]> = [];
  /** 悬停 / 选中的关系（`graph.edges` 下标）：与 relatedEdges 一起画在宽线层 */
  private hoveredEdge: number | null = null;
  private selectedEdge: number | null = null;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, palette: SpacePalette) {
    this.palette = palette;
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "low-power",
    });
    this.renderer.setClearColor(0x000000, 0);
    this.scene.add(this.group);

    this.nodeGeometry = new SphereGeometry(1, 24, 16);
    /*
     * 球体质感完全由片段着色器给出（固定屏幕空间光照 + 冷黑边缘），
     * 因此这里不需要任何灯光，也不需要 PBR 材质：灯光会把状态色洗淡，
     * 而参考图的球是「一块颜色 + 一点高光 + 一圈暗边」。
     */
    this.nodeMaterial = new ShaderMaterial({
      vertexShader: NODE_VERTEX_SHADER,
      fragmentShader: NODE_FRAGMENT_SHADER,
      uniforms: {
        uRim: { value: new Color().setRGB(...toLinearRgb(palette.rimRgb)) },
        uHighlight: { value: new Color().setRGB(...toLinearRgb(palette.highlightRgb)) },
        uBackground: { value: new Color().setRGB(...toLinearRgb(palette.backgroundRgb)) },
        uAccentStroke: { value: new Color().setRGB(...toLinearRgb(palette.accentStrongRgb)) },
        uDimAlpha: { value: DIM_ALPHA },
      },
      // 淡化是真正的半透明（背后的连线与星尘透出来），不是把颜色调灰
      transparent: true,
      depthWrite: true,
    });

    this.edgeMaterial = new ShaderMaterial({
      vertexShader: EDGE_VERTEX_SHADER,
      fragmentShader: EDGE_FRAGMENT_SHADER,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
    });

    this.activeMaterial = new LineMaterial({
      color: 0xffffff,
      linewidth: ACTIVE_LINE_WIDTH,
      vertexColors: true,
      worldUnits: false,
      transparent: true,
      opacity: ACTIVE_LINE_ALPHA,
    });

    // 瘦长的小锥体：半径 0.58、高 2.2，缩放后是一个方向小箭头而不是大锥子
    this.arrowGeometry = new ConeGeometry(0.58, 2.2, 10);
    this.arrowGeometry.translate(0, -1.1, 0); // 尖端落在原点：定位时只算一个点
    this.arrowMaterial = new MeshBasicMaterial({ color: toColor(palette.accentRgb) });

    /*
     * 选中环：一个正对相机的方片，环半径与线宽在着色器里按屏幕像素算。
     * `depthTest: false` 让它在被别的节点挡住时仍然可见——「我选的是哪个」
     * 比严格遮挡更重要。
     */
    this.ringMaterial = new ShaderMaterial({
      vertexShader: RING_VERTEX_SHADER,
      fragmentShader: RING_FRAGMENT_SHADER,
      uniforms: {
        uAccent: { value: new Color().setRGB(...toLinearRgb(palette.accentRgb)) },
        uRadiusPx: { value: 12 },
        uQuadPx: { value: 12 + RING_OUTER_OFFSET + RING_PADDING },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
    });
    this.ring = new Mesh(new PlaneGeometry(2, 2), this.ringMaterial);
    this.ring.renderOrder = 10;
    this.ring.frustumCulled = false;
    this.ring.visible = false;
    this.group.add(this.ring);

    /*
     * 星尘：低对比度的空间微粒。
     *
     * 位置在一个单位球壳里随机撒点（用固定步长的确定性散列，不用 Math.random——
     * 同一张图每次进来看到的是同一片星空，不会「换个角度就换了背景」）。
     * 整组在 render 里按包围体缩放并缓慢自转：它跟随镜头产生视差，
     * 于是「深度」有了参照物；点的大小不随距离变化，和参考图的屏幕点一致
     * （参考图是 95 个固定半径的点）。
     */
    const dustPositions = new Float32Array(DUST_COUNT * 3);
    for (let i = 0; i < DUST_COUNT; i += 1) {
      const t = (i * 0.6180339887498949) % 1;
      const phi = Math.acos(1 - 2 * t);
      const theta = 2 * Math.PI * ((i * 0.7548776662466927) % 1);
      const radius = 0.55 + 0.45 * ((i * 0.4142135623730951) % 1);
      dustPositions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      dustPositions[i * 3 + 1] = radius * Math.cos(phi) * 0.72;
      dustPositions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
    }
    const dustGeometry = new BufferGeometry();
    dustGeometry.setAttribute("position", new BufferAttribute(dustPositions, 3));
    this.dustMaterial = new PointsMaterial({
      color: toColor(palette.dustRgb),
      size: DUST_PIXELS,
      sizeAttenuation: false,
      transparent: true,
      opacity: palette.dustAlpha,
      depthWrite: false,
    });
    this.dust = new Points(dustGeometry, this.dustMaterial);
    this.dust.frustumCulled = false;
    this.group.add(this.dust);
  }

  /** 换一批图数据：节点数变化时重建实例网格（数量固定，之后只改矩阵与颜色） */
  setGraph(graph: SpaceGraph): void {
    this.graph = graph;
    const count = graph.ids.length;

    if (this.nodes) {
      this.group.remove(this.nodes);
      this.nodes.dispose();
      this.nodes = null;
      this.dimAttribute = null;
      this.selectedAttribute = null;
      this.radiusAttribute = null;
    }
    if (this.edges) {
      this.group.remove(this.edges);
      this.edges.geometry.dispose();
      this.edges = null;
    }
    if (this.activeEdges) {
      this.group.remove(this.activeEdges);
      this.activeEdges.geometry.dispose();
      this.activeEdges = null;
    }

    if (count > 0) {
      const nodes = new InstancedMesh(this.nodeGeometry, this.nodeMaterial, count);
      // 每帧都改写矩阵：关掉视锥裁剪，避免用过期的包围球做错误裁剪
      nodes.frustumCulled = false;
      /*
       * 三个实例属性（淡化 / 是否选中 / 屏幕半径）都挂在几何上。
       *
       * 不能把淡化预先混进 instanceColor：那样高光与暗边缘仍是满亮度，
       * 会得到「一圈亮边包着一颗灰球」的观感，而不是参考图里整体退到背景中的半透明球。
       */
      this.dimAttribute = new InstancedBufferAttribute(new Float32Array(count), 1);
      this.selectedAttribute = new InstancedBufferAttribute(new Float32Array(count), 1);
      this.radiusAttribute = new InstancedBufferAttribute(new Float32Array(count).fill(8), 1);
      nodes.geometry.setAttribute("aDim", this.dimAttribute);
      nodes.geometry.setAttribute("aSelected", this.selectedAttribute);
      nodes.geometry.setAttribute("aRadius", this.radiusAttribute);
      const white = new Color(1, 1, 1);
      for (let i = 0; i < count; i += 1) nodes.setColorAt(i, white);
      this.nodes = nodes;
      this.group.add(nodes);

      // 逐顶点 RGBA：alpha 承担「相关 / 无关」与深度衰减，见 updateEdges()
      const edgePositions = new Float32Array(graph.edges.length * 2 * 3);
      const edgeColors = new Float32Array(graph.edges.length * 2 * 4);
      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new BufferAttribute(edgePositions, 3));
      geometry.setAttribute("color", new BufferAttribute(edgeColors, 4));
      const edges = new LineSegments(geometry, this.edgeMaterial);
      edges.frustumCulled = false;
      this.edges = edges;
      this.group.add(edges);

      const active = new LineSegments2(new LineSegmentsGeometry(), this.activeMaterial);
      active.frustumCulled = false;
      this.activeEdges = active;
      this.group.add(active);
    }

    this.positions = new Float32Array(count * 3);
    this.projected = [];
    this.positionsDirty = true;
    this.hoveredEdge = null;
    this.selectedEdge = null;
    this.setEmphasis(null, null, this.related, null, null);
  }

  /**
   * 只换显示数据（标题、状态、半径、边语义）：结构没变就不重建网格。
   * 状态改变只影响颜色，重建实例网格是纯粹的浪费。
   */
  refreshGraphData(graph: SpaceGraph): void {
    this.graph = graph;
    this.setEmphasis(this.selected, this.hover, this.related, this.hoveredEdge, this.selectedEdge);
  }

  /** 主题切换：重读设计令牌后只改材质颜色与雾色，不重建场景 */
  setPalette(palette: SpacePalette): void {
    this.palette = palette;
    (this.nodeMaterial.uniforms.uRim!.value as Color).setRGB(...toLinearRgb(palette.rimRgb));
    (this.nodeMaterial.uniforms.uHighlight!.value as Color).setRGB(
      ...toLinearRgb(palette.highlightRgb),
    );
    (this.nodeMaterial.uniforms.uBackground!.value as Color).setRGB(
      ...toLinearRgb(palette.backgroundRgb),
    );
    (this.ringMaterial.uniforms.uAccent!.value as Color).setRGB(...toLinearRgb(palette.accentRgb));
    (this.nodeMaterial.uniforms.uAccentStroke!.value as Color).setRGB(
      ...toLinearRgb(palette.accentStrongRgb),
    );
    this.arrowMaterial.color.copy(toColor(palette.accentRgb));
    this.dustMaterial.color.copy(toColor(palette.dustRgb));
    this.dustMaterial.opacity = palette.dustAlpha;
    this.activeColorKey = "";
    this.setEmphasis(this.selected, this.hover, this.related, this.hoveredEdge, this.selectedEdge);
  }

  setPositions(positions: Float32Array): void {
    if (positions.length !== this.positions.length) return;
    this.positions.set(positions);
    this.positionsDirty = true;
  }

  /**
   * 选中 / 悬停 / 相关集合变化：只重算颜色与强调边，不动坐标。
   *
   * 只有**选中**才会让整张图让位（参考图里 `dimmed` 判据就是 `selected`）：
   * 无关节点退到 38% 不透明度。悬停只放大球体、显示提示与名称——
   * 鼠标扫过时整张图忽明忽暗，比「没高亮」更让人读不下去。
   *
   * `hoveredEdge` / `selectedEdge` 是关系（连线）的下标：它们与「选中节点相关的边」
   * 一起走宽线 + 强调色 + 箭头那一层——连线的悬停与选中必须**看起来一样明显**，
   * 否则在 1px 的线上再叠一层淡淡的高亮，等于什么都没说。
   * 默认值让老的调用点（测试替身、单一参数调用）仍然可用。
   */
  setEmphasis(
    selected: number | null,
    hover: number | null,
    related: Set<number>,
    hoveredEdge: number | null = null,
    selectedEdge: number | null = null,
  ): void {
    const graph = this.graph;
    this.selected = selected;
    this.hover = hover;
    this.related = related;
    this.hoveredEdge = hoveredEdge;
    this.selectedEdge = selectedEdge;
    if (!graph || !this.nodes) return;

    const dims = this.dimAttribute;
    const selects = this.selectedAttribute;
    for (let i = 0; i < graph.ids.length; i += 1) {
      const status = graph.statuses[i] ?? "todo";
      const base = this.palette.statusRgb[status === "done" ? 2 : status === "learning" ? 1 : 0]!;
      /*
       * 选中/悬停不再靠「把颜色提亮」表达（那会把状态色洗掉），
       * 而是放大球体并套上屏幕空间的环——参考图就是这么做的。
       */
      this.color.setRGB(base[0], base[1], base[2], SRGBColorSpace);
      this.nodes.setColorAt(i, this.color);
      if (dims) dims.setX(i, selected !== null && !related.has(i) ? 1 : 0);
      if (selects) selects.setX(i, i === selected ? 1 : 0);
    }
    if (this.nodes.instanceColor) this.nodes.instanceColor.needsUpdate = true;
    if (dims) dims.needsUpdate = true;
    if (selects) selects.needsUpdate = true;

    // 与**选中**节点相关的边进入强调层（宽线 + 强调色 + 箭头）
    const relatedEdges: Array<[number, number]> = [];
    if (selected !== null) {
      for (const edge of graph.edges) {
        if (edge.from === selected || edge.to === selected) relatedEdges.push([edge.from, edge.to]);
      }
    }
    /*
     * 悬停 / 选中的那条关系也进强调层。
     *
     * 去重是必须的：它完全可能同时是与选中节点相关的边（例如选中节点的某条前置），
     * 重复推入会让宽线层把同一条线画两遍——颜色叠一层，看起来比别的强调边更亮。
     */
    for (const index of [hoveredEdge, selectedEdge]) {
      if (index === null || index === undefined) continue;
      const edge = graph.edges[index];
      if (!edge) continue;
      if (relatedEdges.some(([from, to]) => from === edge.from && to === edge.to)) continue;
      relatedEdges.push([edge.from, edge.to]);
    }
    this.relatedEdges = relatedEdges;
    this.syncArrowPool(relatedEdges.length);
    this.ring.visible = selected !== null;
    this.updateActiveEdges();
  }

  /**
   * 强调边（宽线层）。
   *
   * 与普通边一样每帧跟着节点走：只在强调集合变化时更新，就会在布局推进时
   * 停在旧坐标上，看起来像「高亮连线和节点脱开了」。
   */
  private updateActiveEdges(): void {
    const active = this.activeEdges;
    if (!active || this.relatedEdges.length === 0) {
      if (active) active.visible = false;
      return;
    }
    active.visible = true;
    const length = this.relatedEdges.length * 6;
    /*
     * 缓冲一次按「全部边」的容量分配。
     *
     * 强调集合随选中变化，边数会增会减；如果按当前条数分配，每次条数变化都会
     * 重建一次顶点缓冲，而 three 的 setPositions/setColors 每次调用都会新建
     * InstancedInterleavedBuffer 并覆盖旧的（旧缓冲不会被回收，直接漏在 GPU 上）。
     * 按图的最大规模分配一次，之后只改 instanceCount —— 这一层 frustumCulled=false，
     * 多出来的容量既不会被画出来，也不参与裁剪。
     */
    const capacity = Math.max(6, (this.graph?.edges.length ?? 0) * 6, length);
    const geometry = active.geometry;
    let startAttribute = geometry.getAttribute("instanceStart") as unknown as
      | InterleavedBufferAttribute
      | undefined;
    let colorAttribute = geometry.getAttribute("instanceColorStart") as unknown as
      | InterleavedBufferAttribute
      | undefined;
    if (
      startAttribute === undefined ||
      colorAttribute === undefined ||
      startAttribute.data.array.length !== capacity
    ) {
      this.activeSegments = new Float32Array(capacity);
      this.activeColors = new Float32Array(capacity);
      this.activeColorKey = "";
      geometry.setPositions(this.activeSegments);
      geometry.setColors(this.activeColors);
      startAttribute = geometry.getAttribute("instanceStart") as unknown as InterleavedBufferAttribute;
      colorAttribute = geometry.getAttribute("instanceColorStart") as unknown as InterleavedBufferAttribute;
    }

    // LineMaterial 自己会做 linear→sRGB 编码，因此这里必须喂线性值
    const accent = toLinearRgb(this.palette.edgeActiveRgb);
    const segments = this.activeSegments;
    const colors = this.activeColors;
    this.relatedEdges.forEach(([from, to], index) => {
      const a = this.pointAt(from);
      const b = this.pointAt(to);
      segments[index * 6] = a[0];
      segments[index * 6 + 1] = a[1];
      segments[index * 6 + 2] = a[2];
      segments[index * 6 + 3] = b[0];
      segments[index * 6 + 4] = b[1];
      segments[index * 6 + 5] = b[2];
    });
    // 只写前 length 个分量：后面的容量是预留的，不参与绘制（instanceCount 会截断）
    (startAttribute.data.array as Float32Array).set(segments.subarray(0, length));
    startAttribute.data.needsUpdate = true;

    const colorKey = `${accent[0]},${accent[1]},${accent[2]}`;
    if (this.activeColorKey !== colorKey) {
      this.activeColorKey = colorKey;
      for (let i = 0; i < length; i += 3) {
        colors[i] = accent[0];
        colors[i + 1] = accent[1];
        colors[i + 2] = accent[2];
      }
      (colorAttribute.data.array as Float32Array).set(colors.subarray(0, length));
      colorAttribute.data.needsUpdate = true;
    }
    // 真正画多少条：容量可以更大，画出来的永远是当前强调集合
    geometry.instanceCount = this.relatedEdges.length;
  }

  private pointAt(index: number): [number, number, number] {
    return [
      this.positions[index * 3] ?? 0,
      this.positions[index * 3 + 1] ?? 0,
      this.positions[index * 3 + 2] ?? 0,
    ];
  }

  private syncArrowPool(count: number): void {
    while (this.arrowPool.length < count) {
      const arrow = new Mesh(this.arrowGeometry, this.arrowMaterial);
      arrow.frustumCulled = false;
      this.arrowPool.push(arrow);
      this.group.add(arrow);
    }
    this.arrowPool.forEach((arrow, index) => {
      arrow.visible = index < count;
    });
  }

  /** 每帧：节点矩阵、连线端点、箭头、选中环、相机 */
  render(basis: CameraBasis, viewport: Viewport, fovDeg: number, bounds: Bounds): void {
    if (this.disposed) return;
    const graph = this.graph;
    const camera = this.camera;

    camera.fov = fovDeg;
    camera.aspect = viewport.width / Math.max(1, viewport.height);
    const cameraDistance = Math.hypot(
      basis.position[0] - bounds.center[0],
      basis.position[1] - bounds.center[1],
      basis.position[2] - bounds.center[2],
    );
    // near/far 按实际尺度设置：不用 near≈0 + far=∞ 掩盖裁剪问题
    camera.near = NEAR_PLANE;
    camera.far = Math.max(600, cameraDistance + bounds.radius * 6 + 400);
    camera.position.set(basis.position[0], basis.position[1], basis.position[2]);
    camera.up.set(basis.up[0], basis.up[1], basis.up[2]);
    camera.lookAt(
      basis.position[0] + basis.forward[0],
      basis.position[1] + basis.forward[1],
      basis.position[2] + basis.forward[2],
    );
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();

    /*
     * 「一个世界单位等于多少 CSS 像素」：参考图里的屏幕空间常量（半径上限、
     * 环偏移、箭头腿长）都要靠它换到世界尺度上。透视投影下它只跟深度有关。
     */
    const focal = 1 / Math.tan((fovDeg * Math.PI) / 360);
    const halfHeight = viewport.height / 2;

    /*
     * 星尘跟着包围体走，并**极慢**自转（0.6°/秒）。
     * 它的作用是在静止画面里给出深度参照，而不是让人盯着它看。
     */
    this.dust.position.set(bounds.center[0], bounds.center[1], bounds.center[2]);
    this.dust.scale.setScalar(Math.max(260, bounds.radius * 2.1));
    this.dust.rotation.y += 0.0006;

    if (graph && this.nodes) {
      for (let i = 0; i < graph.ids.length; i += 1) {
        const px = this.positions[i * 3] ?? 0;
        const py = this.positions[i * 3 + 1] ?? 0;
        const pz = this.positions[i * 3 + 2] ?? 0;
        const depth =
          (px - basis.position[0]) * basis.forward[0] +
          (py - basis.position[1]) * basis.forward[1] +
          (pz - basis.position[2]) * basis.forward[2];
        const worldPerPixel = depth > 1 ? depth / (focal * halfHeight) : 1 / (focal * halfHeight);
        const basePixels = Math.max(
          NODE_MIN_PIXELS,
          Math.min(NODE_MAX_PIXELS, (graph.radius[i] ?? 4) / worldPerPixel),
        );
        // 选中 / 悬停的放大发生在**屏幕半径**上（参考图：先取投影半径再乘倍数）
        const pixels =
          basePixels * (i === this.selected ? SELECTED_SCALE : i === this.hover ? HOVER_SCALE : 1);
        this.dummy.position.set(px, py, pz);
        this.dummy.scale.setScalar(pixels * worldPerPixel);
        this.dummy.updateMatrix();
        this.nodes.setMatrixAt(i, this.dummy.matrix);
        // 轮廓线宽按屏幕像素算，因此着色器要知道这一帧该节点画多大
        this.radiusAttribute?.setX(i, pixels);
        if (i === this.selected) this.selectedScreenRadius = pixels;
      }
      this.nodes.instanceMatrix.needsUpdate = true;
      if (this.radiusAttribute) this.radiusAttribute.needsUpdate = true;
      this.updateEdges(basis, bounds);
      // 强调边、箭头、选中环都必须跟着坐标走，不能停在上一帧
      if (this.positionsDirty) {
        this.positionsDirty = false;
        this.updateActiveEdges();
      }
      this.updateArrows(focal, halfHeight, basis);
      this.updateRing(focal, halfHeight, basis);
    }

    this.activeMaterial.resolution.set(viewport.width, viewport.height);
    const pixelRatio = Math.min(typeof devicePixelRatio === "number" ? devicePixelRatio : 1, 2);
    if (pixelRatio !== this.lastPixelRatio) {
      this.lastPixelRatio = pixelRatio;
      this.renderer.setPixelRatio(pixelRatio);
      // 星尘的尺寸写的是 CSS 像素，PointsMaterial 用的是设备像素
      this.dustMaterial.size = DUST_PIXELS * pixelRatio;
    }
    if (this.lastWidth !== viewport.width || this.lastHeight !== viewport.height) {
      this.lastWidth = viewport.width;
      this.lastHeight = viewport.height;
      this.renderer.setSize(viewport.width, viewport.height, false);
    }
    this.renderer.render(this.scene, camera);
  }

  /**
   * 普通连线：端点 + 逐顶点 RGBA。
   *
   * 与参考图一致，透明度由两件事决定：
   * 1. 是否与**选中**节点相关（相关不画，交给宽线层；无关 .13；没选中 .28）；
   * 2. 深度衰减 `clamp(fadeDistance / depth, .38, 1)`——近处的线更实，远处的融进背景。
   *
   * `fadeDistance` 按包围体半径取（参考图是 720，而它的云团半径约 200，
   * 即 3.6 倍）：写死 720 会让大图几乎不衰减、小图衰减过猛。
   *
   * 线宽写不进 WebGL 的普通线段（`LineBasicMaterial.linewidth` 在多数平台被忽略），
   * 因此「细且半透明」只由透明度表达；强调边交给宽线层（LineSegments2）。
   */
  private updateEdges(basis: CameraBasis, bounds: Bounds): void {
    const graph = this.graph;
    const edges = this.edges;
    if (!graph || !edges) return;
    const positionAttribute = edges.geometry.getAttribute("position") as BufferAttribute;
    const positions = positionAttribute.array as Float32Array;
    const colorAttribute = edges.geometry.getAttribute("color") as BufferAttribute;
    const colors = colorAttribute.array as Float32Array;

    const base = toLinearRgb(this.palette.edgeRgb);
    const focus = this.selected;
    // 衰减基准 = 1.3 × 机位距离（见 EDGE_FADE_VIEW_RATIO 的说明）
    const cameraDistance = Math.hypot(
      basis.position[0] - bounds.center[0],
      basis.position[1] - bounds.center[1],
      basis.position[2] - bounds.center[2],
    );
    const fadeDistance = EDGE_FADE_VIEW_RATIO * Math.max(40, cameraDistance);
    // 深度沿视线方向量：与投影用的是同一套基向量，不会两处各算一份
    const fx = basis.position[0];
    const fy = basis.position[1];
    const fz = basis.position[2];
    const [dx0, dy0, dz0] = basis.forward;

    graph.edges.forEach((edge, index) => {
      const a = this.pointAt(edge.from);
      const b = this.pointAt(edge.to);
      const offset = index * 6;
      positions[offset] = a[0];
      positions[offset + 1] = a[1];
      positions[offset + 2] = a[2];
      positions[offset + 3] = b[0];
      positions[offset + 4] = b[1];
      positions[offset + 5] = b[2];

      const depthA = (a[0] - fx) * dx0 + (a[1] - fy) * dy0 + (a[2] - fz) * dz0;
      const depthB = (b[0] - fx) * dx0 + (b[1] - fy) * dy0 + (b[2] - fz) * dz0;
      const depth = Math.max(1, (depthA + depthB) / 2);
      const depthFade = Math.max(EDGE_FADE_MIN, Math.min(1, fadeDistance / depth));
      const active = focus !== null && (edge.from === focus || edge.to === focus);
      /*
       * 相关边交给宽线层单独画一遍（2px 强调色），这里写 alpha 0：
       * 细线层再画一次会让强调边比参考图更亮更实。
       * 悬停 / 选中的那条关系同样走宽线层，因此这里一并压成 0。
       */
      const emphasized = active || index === this.hoveredEdge || index === this.selectedEdge;
      const alpha = emphasized
        ? 0
        : (focus !== null ? EDGE_ALPHA_DIMMED : EDGE_ALPHA) * depthFade;
      const colorOffset = index * 8;
      for (let k = 0; k < 2; k += 1) {
        colors[colorOffset + k * 4] = base[0];
        colors[colorOffset + k * 4 + 1] = base[1];
        colors[colorOffset + k * 4 + 2] = base[2];
        colors[colorOffset + k * 4 + 3] = alpha;
      }
    });
    positionAttribute.needsUpdate = true;
    colorAttribute.needsUpdate = true;
  }

  /** 箭头落在目标节点表面前，方位由两点连线给出；大小按 CSS 像素恒定 */
  private updateArrows(focal: number, halfHeight: number, basis: CameraBasis): void {
    const graph = this.graph;
    if (!graph) return;
    this.relatedEdges.forEach(([from, to], index) => {
      const arrow = this.arrowPool[index];
      if (!arrow) return;
      const start = this.pointAt(from);
      const end = this.pointAt(to);
      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      const dz = end[2] - start[2];
      const distance = Math.hypot(dx, dy, dz) || 1;
      const depth =
        (end[0] - basis.position[0]) * basis.forward[0] +
        (end[1] - basis.position[1]) * basis.forward[1] +
        (end[2] - basis.position[2]) * basis.forward[2];
      const worldPerPixel = depth > 1 ? depth / (focal * halfHeight) : 1 / (focal * halfHeight);
      // 参考图：投影长度不足 18px 就不画箭头，否则它比线段本身还长
      if (distance < ARROW_MIN_EDGE_PIXELS * worldPerPixel) {
        arrow.visible = false;
        return;
      }
      this.arrowDirection.set(dx / distance, dy / distance, dz / distance);
      // 圆锥几何的尖端在局部原点、锥体朝 -Y，因此把局部 +Y 转到「朝向目标」即可
      this.arrowQuaternion.setFromUnitVectors(UP_AXIS, this.arrowDirection);
      // 屏幕空间尺寸：锥高 2.2 × scale = 2 × 腿长（参考图 size = 4.2）
      const scale = (2 * ARROW_LEG_PIXELS * worldPerPixel) / 2.2;
      const nodePixels = Math.max(
        NODE_MIN_PIXELS,
        Math.min(NODE_MAX_PIXELS, (graph.radius[to] ?? 4) / worldPerPixel),
      );
      // 尖端落在球面外一点点：贴太近会被球体吞掉，离太远又像浮在连线中间
      const back = (nodePixels + 5) * worldPerPixel;
      arrow.position.set(
        end[0] - this.arrowDirection.x * back,
        end[1] - this.arrowDirection.y * back,
        end[2] - this.arrowDirection.z * back,
      );
      arrow.scale.setScalar(scale);
      arrow.quaternion.copy(this.arrowQuaternion);
      arrow.visible = true;
    });
  }

  /** 选中环：正对相机的一块方片，环的半径与线宽都在着色器里按 CSS 像素算 */
  private updateRing(focal: number, halfHeight: number, basis: CameraBasis): void {
    const selected = this.selected;
    if (selected === null || !this.graph) {
      this.ring.visible = false;
      return;
    }
    const point = this.pointAt(selected);
    const depth =
      (point[0] - basis.position[0]) * basis.forward[0] +
      (point[1] - basis.position[1]) * basis.forward[1] +
      (point[2] - basis.position[2]) * basis.forward[2];
    const worldPerPixel = depth > 1 ? depth / (focal * halfHeight) : 1 / (focal * halfHeight);
    const quadPixels = this.selectedScreenRadius + RING_OUTER_OFFSET + RING_PADDING;
    this.ring.position.set(point[0], point[1], point[2]);
    this.ring.scale.setScalar(quadPixels * worldPerPixel);
    this.ring.quaternion.copy(this.camera.quaternion);
    (this.ringMaterial.uniforms.uRadiusPx!.value as number) = this.selectedScreenRadius;
    (this.ringMaterial.uniforms.uQuadPx!.value as number) = quadPixels;
    this.ring.visible = true;
  }

  /** 一帧内的屏幕投影：标签、拾取、选中节点是否在视野内都用它 */
  project(basis: CameraBasis, viewport: Viewport, fovDeg: number): ProjectedNode[] {
    const graph = this.graph;
    if (!graph) return [];
    this.projected = projectNodes(
      this.positions,
      graph.radius,
      graph.ids,
      basis,
      viewport,
      fovDeg,
      this.projected,
    );
    return this.projected;
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.remove(...this.arrowPool);
    this.arrowPool.length = 0;
    if (this.nodes) this.nodes.dispose();
    if (this.edges) {
      this.edges.geometry.dispose();
      this.group.remove(this.edges);
    }
    if (this.activeEdges) {
      this.activeEdges.geometry.dispose();
      this.group.remove(this.activeEdges);
    }
    this.nodeGeometry.dispose();
    this.nodeMaterial.dispose();
    this.edgeMaterial.dispose();
    this.activeMaterial.dispose();
    this.arrowGeometry.dispose();
    this.arrowMaterial.dispose();
    this.ringMaterial.dispose();
    this.ring.geometry.dispose();
    this.dust.geometry.dispose();
    this.dustMaterial.dispose();
    this.scene.clear();
    /*
     * 只 dispose，不 forceContextLoss：React 在 StrictMode 下会反复挂载，
     * 同一个 canvas 元素会被复用，强制丢弃上下文会让下一次创建渲染器直接失败
     * （three 拿到一个已丢失的上下文，报 "reading 'precision'"）。
     * 画布本身随组件卸载被丢弃，上下文随之释放；探测用的画布已经做了缓存。
     */
    this.renderer.dispose();
  }
}
