/**
 * 右下角**视角位置图**的测试（依 `design/minimap-position-continuity-analysis.md`）。
 *
 * 文档确认的三处空间误差，这里逐条钉住：
 * 1. **第三轴被丢掉**：旧实现只画 forward/up 两个分量 ⇒ 相机在 (600,0,0) 时被画到圆心，
 *    读数却写着 2R ✗。现在两张正交投影，三分量都在 ✓，`hypot` 就是真实距离 ✓。
 * 2. **球外硬夹**：旧的"超过 1.4R 就停在 1.4R"让 3.28R / 3R / 2R 全画在同一个点 ✗。
 *    现在球内线性、球外严格单调压缩 ✓。
 * 3. **图标可能被裁**：圆心 + 最大图上半径 + 图标/提示圈必须落在 viewBox 内 ✓。
 *
 * 另外两条连续性要求：
 * - **参考轴固定**：只改相机朝向（eye 不动）时位置标记不得移动 ✓；
 * - **轨迹采样基准只跟真正提交的位置** ✓（旧实现先更新基准再看时间闸门 ⇒ 慢速小步攒不出点 ✗）。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  MINIMAP_EXTERIOR_HEADROOM,
  minimapAxesFrom,
  minimapComponents,
  minimapForwardIn,
  minimapPlotOffset,
  minimapPlottedRatio,
  trailSampleStep,
} from "../src/client/interior-navigation.ts";
import { quatFromAxisAngle, rotateVec } from "../src/client/trackball.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const minimapSource = await readFile(path.join(HERE, "..", "src", "client", "InteriorMinimap.tsx"), "utf8");
const panelSource = await readFile(path.join(HERE, "..", "src", "client", "GraphPanel.tsx"), "utf8");
const controllerSource = await readFile(path.join(HERE, "..", "src", "client", "interior-controller.ts"), "utf8");
const css = await readFile(path.join(HERE, "..", "src", "client", "panel.css"), "utf8");

/** 单位姿态的参考轴：forward = −Z、up = +Y、right = +X ✓ */
const AXES = minimapAxesFrom([0, 0, -1], [0, 1, 0], [1, 0, 0]);
const C = [0, 0, 0];

describe("三分量都在：沿被旧实现丢掉的第三轴移动也要看得出来", () => {
  it("相机在 (600,0,0)：depth/up 都是 0，但 right = 600 ⇒ 不再被画到圆心 ✗", () => {
    const components = minimapComponents([600, 0, 0], C, AXES);
    /* 注意：`-dot(...)` 会得到 `-0`，严格相等下 `-0 !== 0` ⇒ 用绝对值断言 ✓ */
    assert.ok(Math.abs(components.depth) < 1e-12, "深度分量确实是 0");
    assert.ok(Math.abs(components.up) < 1e-12, "纵分量确实是 0");
    assert.equal(components.right, 600, "**第三轴**必须保留 ✓（旧实现丢掉它 ⇒ 眼睛画在圆心 ✗）");
    assert.equal(components.distance, 600, "真实距离 600（= 2R）✓");
  });

  it("三个分量无损：hypot(depth, up, right) === 真实距离（任意位置与姿态）", () => {
    const turn = quatFromAxisAngle([0.3, 1, 0.2], 0.9);
    const rotated = minimapAxesFrom(
      rotateVec(turn, [0, 0, -1]),
      rotateVec(turn, [0, 1, 0]),
      rotateVec(turn, [1, 0, 0]),
    );
    for (const eye of [[0, 0, 900], [600, 0, 0], [120, -80, 40], [-200, 300, -500]]) {
      const components = minimapComponents(eye, C, rotated);
      const distance = Math.hypot(...eye);
      assert.ok(
        Math.abs(Math.hypot(components.depth, components.up, components.right) - distance) < 1e-9,
        `三分量必须无损（eye=${eye}）`,
      );
      assert.ok(Math.abs(components.distance - distance) < 1e-9, "真实距离读数准确 ✓");
    }
  });

  it("固定参考轴：只改相机朝向（eye 不动）⇒ 位置分量一个都不变 ✓，方向分量在变 ✓", () => {
    const eye = [200, 0, 0];
    const before = minimapComponents(eye, C, AXES);
    const turn = quatFromAxisAngle([0, 1, 0], Math.PI / 2);
    const forward = rotateVec(turn, [0, 0, -1]);
    const after = minimapComponents(eye, C, AXES);
    assert.deepEqual(after, before, "位置分量不许随朝向变 ✗（参考轴固定 ✓）");
    const viewBefore = minimapForwardIn(AXES, [0, 0, -1]);
    const viewAfter = minimapForwardIn(AXES, forward);
    assert.ok(Math.abs(viewBefore.forward - viewAfter.forward) > 0.5, "朝向分量应当变化 ✓");
  });
});

describe("球外不再硬夹：每个非零距离变化都在图上响应", () => {
  const plotted = (distance) => minimapPlottedRatio(distance, 300);

  it("球面正好是 1；球内线性", () => {
    assert.equal(plotted(0), 0);
    assert.ok(Math.abs(plotted(150) - 0.5) < 1e-12, "球内线性 ✓");
    assert.ok(Math.abs(plotted(300) - 1) < 1e-12, "球面 = 1 ✓");
  });

  it("**严格单调**：2R / 3R / 3.28R 不再画在同一点（旧实现全挤在 1.4 ✗）", () => {
    const sequence = [1.4, 2, 3, 3.28, 5, 10].map((ratio) => plotted(ratio * 300));
    for (let index = 1; index < sequence.length; index += 1) {
      assert.ok(
        sequence[index] > sequence[index - 1] + 1e-9,
        `球外必须严格单调：${sequence[index - 1].toFixed(4)} → ${sequence[index].toFixed(4)}`,
      );
    }
    const two = plotted(600);
    const three = plotted(900);
    const far = plotted(984);
    assert.ok(
      three > two + 0.02 && far > three + 0.005,
      `三点必须明显分开：${two.toFixed(3)} / ${three.toFixed(3)} / ${far.toFixed(3)}`,
    );
  });

  it("压缩有界且连续：渐近到 1 + HEADROOM，球面处连续 ✓", () => {
    const limit = 1 + MINIMAP_EXTERIOR_HEADROOM;
    assert.ok(Math.abs(plotted(300) - 1) < 1e-12, "球面连续 ✓");
    assert.ok(plotted(1e6) <= limit && plotted(1e6) > limit - 1e-6, "渐近到上限 ✓");
    for (const ratio of [1.001, 1.01, 1.1]) {
      assert.ok(plotted(ratio * 300) >= 1, "球外不许低于球面 ✓");
      assert.ok(plotted(ratio * 300) < limit, "球外不许越过上限 ✓");
    }
    assert.equal(minimapPlottedRatio(600, 0), 0, "半径非法 ⇒ 0，不产生 NaN ✓");
  });

  it("**图上偏移**：模长正好等于压缩后的半径、方向不变、球外真的分得开 ✓", () => {
    /*
     * 这一条是渲染预览逼出来的：压缩系数必须按"**每世界单位**"算
     * （`plotted / distance` ✓），写成 `plotted / raw`（两个比值相除 ✗）
     * 会把 2R 又缩回圆心附近（实测与球心几乎重叠 ✗）。
     */
    for (const [x, y, distance] of [[600, 0, 600], [0, 984, 984], [900, 0, 900], [0, 0, 0]]) {
      const offset = minimapPlotOffset(x, y, distance, 300);
      const expected = minimapPlottedRatio(distance, 300);
      assert.ok(
        Math.abs(Math.hypot(offset.x, offset.y) - expected) < 1e-12,
        `偏移模长必须等于压缩后的图上半径（输入 ${x},${y}）`,
      );
      if (distance > 1e-9) {
        /* 方向保持：偏移与输入分量成同一比例 ✓ */
        assert.ok(Math.abs(offset.x * y - offset.y * x) < 1e-9, "方向不许被改动 ✓");
      }
    }
    /* 三个球外位置在图上必须明显分开（旧实现硬夹 ⇒ 全在同一点 ✗） */
    const two = minimapPlotOffset(600, 0, 600, 300).x;
    const three = minimapPlotOffset(900, 0, 900, 300).x;
    const ten = minimapPlotOffset(3000, 0, 3000, 300).x;
    assert.ok(three > two + 0.05 && ten > three + 0.02, `球外必须分得开：${two.toFixed(3)} / ${three.toFixed(3)} / ${ten.toFixed(3)}`);
    /* 第三轴位置（(600,0,0)）在"深度/左右"那张图里必须明显离开圆心 ✓ */
    const thirdAxis = minimapPlotOffset(0, 600, 600, 300);
    assert.ok(Math.abs(thirdAxis.x) < 1e-12, "深度分量为 0 ⇒ 横轴在球心处 ✓");
    assert.ok(Math.abs(thirdAxis.y) > 0.6, `第三轴位置必须离开圆心（旧实现画在圆心 ✗），实际 ${thirdAxis.y.toFixed(3)}`);
  });
});

describe("轨迹采样：基准只跟真正提交的位置", () => {
  it("慢速小步能累计出采样点（旧实现先更新基准 ⇒ 永远攒不出来 ✗）", () => {
    let base = { lastEye: null, lastAt: 0 };
    let committed = 0;
    /* 每步只动 1 世界单位（小于阈值 0.004R = 1.2），但累计到 10 ⇒ 必须提交 ✓ */
    for (let step = 1; step <= 10; step += 1) {
      const eye = [0, 0, 900 - step];
      const result = trailSampleStep(base.lastEye, eye, 300, step * 1000, base.lastAt);
      base = { lastEye: result.lastEye, lastAt: result.lastAt };
      if (result.committed) committed += 1;
    }
    assert.ok(committed >= 1, `累计移动必须留下轨迹点，实际提交 ${committed} 次`);
  });

  it("时间闸门内的移动不提交、也**不动基准** ✓", () => {
    const first = trailSampleStep(null, [0, 0, 900], 300, 0, 0);
    assert.equal(first.committed, true, "第一次直接提交 ✓");
    const base = { lastEye: first.lastEye, lastAt: first.lastAt };
    const tooSoon = trailSampleStep(base.lastEye, [0, 0, 800], 300, 50, base.lastAt);
    assert.equal(tooSoon.committed, false, "间隔不够 ⇒ 不提交 ✓");
    assert.deepEqual(tooSoon.lastEye, base.lastEye, "**基准必须停在上一次真正提交的位置** ✗");
    const later = trailSampleStep(tooSoon.lastEye, [0, 0, 800], 300, 200, tooSoon.lastAt);
    assert.equal(later.committed, true, "过了间隔 ⇒ 提交 ✓（位移相对上次提交算 ✓）");
  });

  it("停住时不追加重复点、半径非法不提交 ✓", () => {
    const still = trailSampleStep([0, 0, 300], [0, 0, 300], 300, 5000, 0);
    assert.equal(still.committed, false, "没动就不追加 ✓");
    const bad = trailSampleStep(null, [0, 0, 300], 0, 5000, 0);
    assert.equal(bad.committed, false, "半径非法 ⇒ 不提交 ✓");
  });
});

describe("接线：两张图、留白、生命周期、方向符号", () => {
  it("两张正交图（↑↓ / ↔）共享球心与比例尺；读数保留真实比例 ✓", () => {
    assert.ok(minimapSource.includes('type PanelAxis = "up" | "right"'), "要按两条侧轴出两张图 ✓");
    assert.ok(
      minimapSource.includes('const AXES_LABEL: Record<PanelAxis, string> = { up: "↑↓", right: "↔" }'),
      "要有纵轴记号",
    );
    assert.ok(
      minimapSource.includes('drawPanel("up")') && minimapSource.includes('drawPanel("right")'),
      "两张图都要画 ✓",
    );
    assert.ok(minimapSource.includes("minimapPlottedRatio"), "球外走压缩映射，不再硬夹 ✗");
    assert.ok(minimapSource.includes("rawRatio.toFixed(2)"), "读数给真实比例 ✓");
    assert.ok(minimapSource.includes('"↗ "'), "球外读数要有 ↗ 提示（图上半径经过压缩 ✓）");
  });

  it("留白自检：眼睛 / 提示圈 / **方向箭头 / 朝内朝外符号** 都要落在 viewBox 内 ✓", () => {
    /*
     * 复查指出的遗漏：旧模型只算 `max(眼睛半宽, 提示圈)` ✗，漏了箭头与符号，
     * 于是位置在球下方（2R）时符号延伸到 **62.85**、超出 62 的画布被裁 ✗。
     * 这里不只断言"有那段代码"，而是**从源码把常量解析出来重算四个方向** ✓，
     * 以后谁改了尺寸/图标/符号大小都会立刻失败 ✓。
     */
    assert.ok(minimapSource.includes("DECOR_EXTENT"), "装饰延伸要纳入同一个留白模型 ✓");
    assert.ok(minimapSource.includes("小地图留白不足"), "越界要直接抛错，而不是等截图才发现被裁 ✗");
    for (const name of ["ARROW_LENGTH", "OUTSIDE_RING", "EYE_HALF_WIDTH", "SYMBOL_GAP", "SYMBOL_RADIUS"]) {
      assert.ok(
        new RegExp(`^const ${name} = `, "m").test(minimapSource),
        `${name} 要作为命名常量参与留白计算（否则测试与实现会脱节 ✗）`,
      );
    }
    const num = (name) => Number(new RegExp(`^const ${name} = ([\\d.]+);`, "m").exec(minimapSource)[1]);
    const SIZE = num("SIZE");
    const CENTER = SIZE / 2;
    const BALL_RADIUS = num("BALL_RADIUS");
    const EYE_W = num("EYE_HALF_WIDTH");
    const EYE_H = num("EYE_HALF_HEIGHT");
    const RING = num("OUTSIDE_RING");
    const ARROW = num("ARROW_LENGTH");
    const SYMBOL_R = num("SYMBOL_RADIUS");
    const SYMBOL_GAP = num("SYMBOL_GAP");
    /* 最远的眼睛中心（球外压缩的渐近上限 ✓） */
    const reach = CENTER + (1 + MINIMAP_EXTERIOR_HEADROOM) * BALL_RADIUS;
    const extents = {
      右: reach + Math.max(EYE_W, RING, ARROW),
      左: reach + Math.max(EYE_W, RING, ARROW),
      上: reach + EYE_H,
      下: reach + Math.max(EYE_H, ARROW, EYE_H + SYMBOL_GAP + SYMBOL_R),
    };
    for (const [direction, extent] of Object.entries(extents)) {
      assert.ok(extent <= SIZE, `${direction}方向留白不足：${extent.toFixed(2)} > ${SIZE} ✗`);
    }
    /* 复算复查给的那组数：旧常量下"下方 + 符号"确实会越界（这就是被裁的那次 ✗） */
    const oldExtent = 31 + 1.156 * 17 + (4 + 5 + 3.2);
    assert.ok(oldExtent > 62, `旧常量下应当越界（复算 ${oldExtent.toFixed(2)} > 62 ✓）`);
  });

  it("参考轴只建立一次、不随朝向变；换库/换场景清空 ✓", () => {
    assert.ok(minimapSource.includes("if (axesRef.current === null)"), "参考轴只在建立时取一次 ✓");
    assert.ok(
      minimapSource.includes("minimapAxesFrom(detail.forward, detail.up, detail.right)"),
      "由事件里的姿态建立 ✓",
    );
    assert.ok(minimapSource.includes("}, [active, sceneKey]);"), "可见性与场景变化都要清空 ✓");
    assert.ok(panelSource.includes("sceneKey={sceneKey}"), "面板要把场景标识传下来 ✓");
    assert.ok(panelSource.includes("const sceneKey = useMemo("), "场景标识 = 库身份 + 节点集合 ✓");
    assert.ok(panelSource.includes("key={sceneKey}"), "三维场景与小地图用同一个 key ✓");
  });

  it("**声明顺序**：`sceneKey` 必须排在 `graph` 之后（否则 TDZ 报错、整块面板崩 ✗）", () => {
    /*
     * 真实事故：把 `sceneKey` 的 useMemo 放在组件前部（它读 `graph` ✗）⇒
     * `ReferenceError: Cannot access 'graph' before initialization` ⇒ 面板只显示"渲染出错" ✗。
     * 静态字符串测试抓不到这类错误，但"谁先声明"是能查的 ✓。
     */
    const graphAt = panelSource.indexOf("const graph = useMemo<GraphSnapshot | null>");
    const sceneKeyAt = panelSource.indexOf("const sceneKey = useMemo(");
    assert.ok(graphAt > 0, "应当能找到 graph 的声明");
    assert.ok(sceneKeyAt > 0, "应当能找到 sceneKey 的声明");
    assert.ok(
      sceneKeyAt > graphAt,
      `sceneKey（第 ${sceneKeyAt} 字符）必须排在 graph（第 ${graphAt} 字符）之后 ✗`,
    );
  });

  it("面板里**不许 useMemo / useCallback 先用后声明**（渲染期立即求值 ⇒ TDZ 会崩面板 ✗）", async () => {
    /*
     * 这条是给那类事故做的通用护栏：`useMemo(...)` / `useCallback(...)` 的**整个调用参数**
     * 都在渲染期求值 ✓（工厂体立即执行、**依赖数组也要读一遍** ✓），
     * 所以引用的组件变量必须先声明 ✗ —— 否则 `Cannot access 'X' before initialization`
     * ⇒ 整块面板只剩"渲染出错"（实机踩过三次：`props`、`graph`、`libraryKey` ✗）。
     *
     * 第三例正是 `useCallback(..., [libraryKey])` 的**依赖数组**：只查 useMemo 会漏判 ✗。
     *
     * 实现要点：**按括号配对**取整个调用参数，不要用"第一个 `, [`"猜依赖数组 ✗
     * （那样会把嵌套数组/后面的 `, [...]` 当成依赖 ⇒ 大量误报 ✗）。
     * 只查这两个 Hook：effect / 事件回调晚执行，引用后声明的变量是合法的 ✓。
     */
    const declarations = new Map();
    for (const match of panelSource.matchAll(/^ {0,2}const (\w+)[\s:=]/gm)) {
      if (!declarations.has(match[1])) declarations.set(match[1], match.index ?? 0);
    }
    /* 扫**所有客户端源码**（不只面板 ✗）：编辑器、小地图、卡片同样会踩这个坑 ✓ */
    const clientSources = await Promise.all(
      ["GraphPanel.tsx", "NodeDocumentEditor.tsx", "InteriorMinimap.tsx", "GraphContextMenu.tsx", "PlanReview.tsx"]
        .map(async (name) => [name, await readFile(path.join(HERE, "..", "src", "client", name), "utf8")]),
    );
    /**
     * 把注释与字符串**等长替换成空格** ✓：
     * 否则 `"save-failed"` 这种字面量会被当成对变量 `save` 的引用 ⇒ 误报 ✗。
     * 等长替换能保持字符偏移不变，括号配对也照旧 ✓。
     */
    const strip = (source) => {
      let out = "";
      let index = 0;
      while (index < source.length) {
        const two = source.slice(index, index + 2);
        if (two === "//") {
          const end = source.indexOf("\n", index);
          const stop = end < 0 ? source.length : end;
          out += " ".repeat(stop - index);
          index = stop;
          continue;
        }
        if (two === "/*") {
          const end = source.indexOf("*/", index + 2);
          const stop = end < 0 ? source.length : end + 2;
          out += " ".repeat(stop - index);
          index = stop;
          continue;
        }
        const char = source[index];
        if (char === '"' || char === "'" || char === "`") {
          let cursor = index + 1;
          while (cursor < source.length && source[cursor] !== char) {
            if (source[cursor] === "\\") cursor += 1;
            cursor += 1;
          }
          const stop = Math.min(cursor + 1, source.length);
          out += " ".repeat(stop - index);
          index = stop;
          continue;
        }
        out += char;
        index += 1;
      }
      return out;
    };
    /** 从开括号处按配对取到闭括号 ✓ */
    const callBody = (openParen) => {
      let depth = 0;
      for (let index = openParen; index < panelSource.length; index += 1) {
        const char = panelSource[index];
        if (char === "(") depth += 1;
        else if (char === ")") {
          depth -= 1;
          if (depth === 0) return panelSource.slice(openParen + 1, index);
        }
      }
      return null;
    };
    const offenders = [];
    let scanned = 0;
    /*
     * 扫**所有**客户端组件（不只面板 ✗）：编辑器、小地图、卡片里同样可能踩这个坑 ✓。
     */
    for (const [file, raw] of clientSources) {
      const source = strip(raw);
      const declared = new Map();
      for (const match of source.matchAll(/^ {0,2}const (\w+)[\s:=]/gm)) {
        if (!declared.has(match[1])) declared.set(match[1], match.index ?? 0);
      }
      for (const start of source.matchAll(/use(?:Memo|Callback)(?:<[^>]*>)?\(/g)) {
        const at = (start.index ?? 0) + start[0].length - 1;
        let depth = 0;
        let body = null;
        for (let index = at; index < source.length; index += 1) {
          const char = source[index];
          if (char === "(") depth += 1;
          else if (char === ")") {
            depth -= 1;
            if (depth === 0) { body = source.slice(at + 1, index); break; }
          }
        }
        if (body === null || body.length > 4000) continue;
        scanned += 1;
        for (const [name, declaredAt] of declared) {
          if (declaredAt <= at) continue;
          if (new RegExp(`\\b${name}\\b`).test(body)) {
            offenders.push(`${file}：第 ${at} 字符处的 ${start[0].replace("(", "")} 引用了第 ${declaredAt} 字符才声明的 ${name}`);
          }
        }
      }
    }
    assert.ok(scanned >= 8, `守卫要真的扫到 Hook（实际 ${scanned} 个）`);
    assert.deepEqual(offenders, [], `useMemo / useCallback 不许先用后声明：\n${offenders.join("\n")}`);
  });

  it("方向标记：有投影就画箭头；垂直于图平面时用朝内/朝外符号 ✓", () => {
    assert.ok(minimapSource.includes("perpendicular"), "要有退化判定 ✓");
    assert.ok(minimapSource.includes("kn-minimap-arrow"), "要有箭头 ✓");
    assert.ok(minimapSource.includes("kn-minimap-outward"), "要有朝内/朝外符号 ✓");
    assert.ok(minimapSource.includes("ARROW_MIN_LENGTH"), "阈值要显式 ✓");
    for (const cls of [
      "kn-minimap-row",
      "kn-minimap-glyph",
      "kn-minimap-arrow",
      "kn-minimap-outward",
      "kn-minimap-outward-dot",
      "kn-minimap-distance",
    ]) {
      assert.ok(css.includes(`.${cls}`), `${cls} 要有样式 ✓`);
    }
  });

  it("事件负载要带 right（否则第三轴又没了 ✗）", () => {
    assert.ok(controllerSource.includes("right: Vec3;"), "负载里要有相机右方向 ✓");
    assert.ok(controllerSource.includes("right: [...basis.right],"), "广播时要真的带上它 ✓");
  });
});
