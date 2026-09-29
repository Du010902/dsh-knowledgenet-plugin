/**
 * 三维视图的取色
 *
 * 颜色**不在组件里写死**，而是读 `src/styles/tokens.css` 上的设计令牌：
 * 深浅主题、以后调整某个状态色，三维视图都跟着变，不需要两处维护。
 * 只有画布背景是例外——它必须和 `.graph` 的底色一致，否则雾化会把两层颜色对不上。
 *
 * 这个模块不依赖 three：渲染层要的是 0–1 浮点，DOM 标签层要的是 CSS 字符串，
 * 一次读出来两边共用。
 */
export type Rgb = [number, number, number];

export interface SpacePalette {
  isDark: boolean;
  /** 画布底色（CSS 字符串，供标签描边与降级提示使用） */
  background: string;
  /** 画布底色（浮点，供 three 的雾与背景使用） */
  backgroundRgb: Rgb;
  /** 三种学习状态的颜色，顺序与 STATUS_ORDER 一致：未开始 / 学习中 / 已理解 */
  statusRgb: [Rgb, Rgb, Rgb];
  /** 依赖连线与强调连线 */
  edgeRgb: Rgb;
  edgeActiveRgb: Rgb;
  /** 选中环、箭头 */
  accentRgb: Rgb;
  /** 选中节点轮廓（参考图的 `--accent-strong`） */
  accentStrongRgb: Rgb;
  /**
   * 球体的暗边缘与高光。
   *
   * 参考图的写法与主题无关：暗边缘固定 `#132025`，高光是近白色
   * （`drawSphere` 的 radial gradient 两端），因此这里不跟着深浅主题变。
   */
  rimRgb: Rgb;
  highlightRgb: Rgb;
  /** 星尘的颜色与不透明度（参考图 `rgba(129,172,166,.16)` / `rgba(39,79,72,.14)`） */
  dustRgb: Rgb;
  dustAlpha: number;
  labelSelected: string;
  labelRelated: string;
  labelNormal: string;
}

const FALLBACK: Record<string, string> = {
  "--canvas": "#fafbfc",
  "--text": "#20282e",
  "--secondary": "#606d78",
  "--muted": "#7c8892",
  "--border": "#e4e8ec",
  "--edge": "#cbd3da",
  "--edge-graph": "#849995",
  "--todo": "#74878d",
  "--dust": "#274f48",
  "--accent": "#24786b",
  "--accent-strong": "#0c6f59",
  "--success": "#378776",
  "--warning": "#ac7c3b",
};

/** `#rgb` / `#rrggbb` / `rgb(...)` 都能解析；认不出来时退回兜底色，不抛异常 */
export function parseColor(value: string, fallback: string = "#7c8892"): Rgb {
  return parse(value) ?? parse(fallback) ?? [0.5, 0.5, 0.5];
}

function parse(value: string): Rgb | null {
  const text = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const digits = hex[1]!;
    const expand = digits.length === 3 ? digits.split("").map((c) => c + c).join("") : digits;
    return [
      parseInt(expand.slice(0, 2), 16) / 255,
      parseInt(expand.slice(2, 4), 16) / 255,
      parseInt(expand.slice(4, 6), 16) / 255,
    ];
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (rgb) {
    const parts = rgb[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.every((n) => Number.isFinite(n))) {
      return [parts[0]! / 255, parts[1]! / 255, parts[2]! / 255];
    }
  }
  return null;
}

export function readPalette(root?: HTMLElement | null): SpacePalette {
  const element = root ?? (typeof document === "undefined" ? null : document.documentElement);
  const isDark = element?.dataset.theme === "dark";
  const styles = element && typeof getComputedStyle === "function" ? getComputedStyle(element) : null;
  const css = (name: string): string => {
    const value = styles?.getPropertyValue(name)?.trim();
    return value || FALLBACK[name] || "#7c8892";
  };
  return {
    isDark,
    background: css("--canvas"),
    backgroundRgb: parseColor(css("--canvas"), isDark ? "#151a1f" : "#fafbfc"),
    statusRgb: [
      // 未开始用 `--todo`：参考图的空间视图把「未开始」固定成 #74878d，
      // 而不是文字用的 muted 灰
      parseColor(css("--todo"), "#74878d"),
      parseColor(css("--warning"), "#ac7c3b"),
      parseColor(css("--success"), "#378776"),
    ],
    edgeRgb: parseColor(css("--edge-graph"), isDark ? "#5d7479" : "#849995"),
    edgeActiveRgb: parseColor(css("--accent"), "#24786b"),
    accentRgb: parseColor(css("--accent"), "#24786b"),
    accentStrongRgb: parseColor(css("--accent-strong"), "#0c6f59"),
    // 与参考图一致：暗边缘固定冷黑，高光近白，深浅主题都用同一对端点
    rimRgb: parseColor("#132025", "#132025"),
    highlightRgb: [1, 1, 1],
    // 星尘不借用标签令牌：参考图给的是带青味的暗色 + 很低的不透明度
    dustRgb: parseColor(css("--dust"), isDark ? "#81aca6" : "#274f48"),
    // 浅色下星尘要再实一点，否则在近白底上几乎看不见（验收清单 P2-4）
    dustAlpha: isDark ? 0.16 : 0.18,
    labelSelected: css("--accent-strong"),
    labelRelated: css("--text"),
    labelNormal: css("--secondary"),
  };
}

/** 主题切换（含跟随系统变化）时回调：三维取色必须跟着重读 */
export function watchPalette(callback: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}
