/**
 * 名称标签的屏幕预算与遮挡判断（纯计算）
 *
 * 《空间图谱技术方案》6.1：中文标签用有限、自行投影的 HTML 标题层，
 * 因此“哪些标题该出现、出现在哪”必须先用一套可测试的规则算出来，
 * 而不是让每个节点各自渲染一个卡片。
 *
 * 规则顺序就是优先级顺序：
 * 1. 相机后方、视锥外直接排除；
 * 2. 选中 → 悬停 → 搜索命中 → 重要邻接 → 近处普通节点；
 * 3. 普通标题受预算限制，并让开前景节点（避免文字雾）；
 * 4. 屏幕网格做包围盒冲突检测；
 * 5. 结果按优先级排序，DOM 层只负责把文字摆到算好的位置。
 *
 * `measure` 由调用方注入（浏览器里用离屏 canvas），所以这一层不依赖 DOM，可单测。
 */
import type { LabelCandidate, LabelPlacement, LabelPlanInput } from "./types.ts";

/** 普通标题的预算：桌面端从 30–50 个起调，小窗口按面积缩小 */
export function labelBudget(width: number, height: number): number {
  return Math.max(14, Math.min(50, Math.round((width * height) / 19000)));
}

/**
 * 「智能」密度下普通名称的硬上限。
 *
 * 直接取参考图的公式 `Math.max(7, Math.min(14, Math.floor(width / 95)))`：
 * 名称是用来定位的，不是用来铺满屏幕的——宽屏上 14 个已经足够认路，
 * 再多就退化成一层文字雾（`labelBudget` 是面积上限，二者取更小的那个）。
 */
export function labelCap(width: number): number {
  return Math.max(7, Math.min(14, Math.floor(width / 95)));
}

/** 相关邻接名称的上限：参考图 `relatedCount >= 7` 之后就不再放 */
export const RELATED_LABEL_CAP = 7;

/** 标题与节点之间的垂直间距（CSS 像素，参考图是 `y = item.y - radius - 11`） */
const LABEL_GAP = 11;
/** 网格格子大小：用于包围盒冲突检测 */
const GRID = 40;
/** 迟滞加成：上一帧已经在显示的标题优先保留，减少相机移动时的闪烁 */
const RETAIN_BONUS = 40;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** 简易屏幕网格：只跟可能相交的格子比较，标签多了也不会退化成两两比较 */
class BoxGrid {
  private cells = new Map<string, Box[]>();

  private key(cx: number, cy: number): string {
    return `${cx},${cy}`;
  }

  add(box: Box): void {
    const x0 = Math.floor(box.x / GRID);
    const y0 = Math.floor(box.y / GRID);
    const x1 = Math.floor((box.x + box.width) / GRID);
    const y1 = Math.floor((box.y + box.height) / GRID);
    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cy = y0; cy <= y1; cy += 1) {
        const key = this.key(cx, cy);
        const list = this.cells.get(key);
        if (list) list.push(box);
        else this.cells.set(key, [box]);
      }
    }
  }

  hits(box: Box): boolean {
    const x0 = Math.floor(box.x / GRID);
    const y0 = Math.floor(box.y / GRID);
    const x1 = Math.floor((box.x + box.width) / GRID);
    const y1 = Math.floor((box.y + box.height) / GRID);
    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cy = y0; cy <= y1; cy += 1) {
        const list = this.cells.get(this.key(cx, cy));
        if (!list) continue;
        for (const other of list) if (overlaps(box, other)) return true;
      }
    }
    return false;
  }
}

export interface LabelPlanResult {
  placements: LabelPlacement[];
  /** 因预算或冲突被跳过的普通标题数量（可解释「为什么有些名字没出现」） */
  skipped: number;
}

export function planLabels(input: LabelPlanInput, retain?: Set<string>): LabelPlanResult {
  const { candidates, viewport, density, inset } = input;
  const placements: LabelPlacement[] = [];
  let skipped = 0;
  if (candidates.length === 0 || viewport.width <= 0 || viewport.height <= 0) {
    return { placements, skipped };
  }

  const showAll = density === "all";
  // 「智能」密度取面积预算与参考图硬上限里更小的那个；「全部名称」由用户负责，不设限
  const budget = showAll
    ? Number.POSITIVE_INFINITY
    : Math.min(labelBudget(viewport.width, viewport.height), labelCap(viewport.width));
  const grid = new BoxGrid();
  let normalShown = 0;
  let relatedShown = 0;

  const ordered = [...candidates].sort((a, b) => {
    const bonusA = retain?.has(a.id) ? RETAIN_BONUS : 0;
    const bonusB = retain?.has(b.id) ? RETAIN_BONUS : 0;
    return b.priority + bonusB - (a.priority + bonusA) || a.depth - b.depth;
  });

  for (const candidate of ordered) {
    if (density === "related" && candidate.tone === "normal" && !retain?.has(candidate.id)) {
      // 「仅相关名称」：只留下选中/悬停/邻接相关的那一批
      skipped += 1;
      continue;
    }
    /*
     * 三个档位（与参考图一致）：
     * - 强制显示（选中 / 悬停）：不受预算、冲突与遮挡影响，永远出现；
     * - 相关邻接：超出 7 个就不再放，但仍要让开已经放下的标题；
     * - 普通：受预算与遮挡限制。
     */
    const forced = candidate.forced === true || candidate.tone === "selected";
    const related = !forced && candidate.important;
    const width = input.measure(candidate.text, candidate.font, candidate.weight);
    // 参考图的冲突盒是固定 18px 高（`const box = {..., h: 18}`）
    const height = 18;
    const anchorX = candidate.x;
    const anchorY = candidate.y - candidate.radius - LABEL_GAP;
    const box: Box = {
      x: anchorX - width / 2,
      y: anchorY - height,
      width,
      height,
    };

    /*
     * 视锥外（含相机后方）、或标题会越出画布边缘的候选直接排除。
     *
     * 水平留白 6px 与参考图一致（`box.x < 6 || box.x + box.w > width - 6`）。
     * 刻意不把 x 夹到画布内：那会让视野外的节点把名字"贴"在边缘上，
     * 看起来像节点就在那里。视野外的节点改由方向提示与定位入口负责
     * （选中节点在视野外时，界面会提示按 F 返回）。
     */
    const margin = 6;
    if (
      !Number.isFinite(candidate.x) ||
      candidate.depth <= 0 ||
      box.x < margin ||
      box.x + width > viewport.width - margin ||
      anchorY < inset.top ||
      anchorY > viewport.height - inset.bottom
    ) {
      skipped += 1;
      continue;
    }

    if (!forced && !showAll) {
      if (related ? relatedShown >= RELATED_LABEL_CAP : normalShown >= budget) {
        skipped += 1;
        continue;
      }
      if (grid.hits(box)) {
        skipped += 1;
        continue;
      }
      if (isOccluded(candidate, candidates)) {
        skipped += 1;
        continue;
      }
    }

    grid.add(box);
    if (related) relatedShown += 1;
    else if (!forced) normalShown += 1;
    placements.push({
      id: candidate.id,
      text: candidate.text,
      x: anchorX,
      y: anchorY,
      font: candidate.font,
      weight: candidate.weight,
      tone: candidate.tone,
    });
  }

  return { placements, skipped };
}

/**
 * 前景遮挡：更近的节点压在标题位置上时，远处名称就不该透出来。
 *
 * 只对普通标题生效；选中与悬停有独立保留区，宁可轻微压住也要显示，
 * 否则「我选了它却看不到名字」比文字被挡一点更糟。
 */
function isOccluded(candidate: LabelCandidate, all: LabelCandidate[]): boolean {
  for (const other of all) {
    if (other.id === candidate.id) continue;
    if (other.depth >= candidate.depth - 2) continue;
    const dx = Math.abs(other.x - candidate.x);
    const dy = Math.abs(other.y - (candidate.y - candidate.radius));
    if (dx < other.radius + 3 && dy < other.radius + 10) return true;
  }
  return false;
}
