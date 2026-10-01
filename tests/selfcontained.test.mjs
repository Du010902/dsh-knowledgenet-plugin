/**
 * 自包含与产物形态检查。
 *
 * 这些断言是「不改项目源码 + 插件代码全在插件目录下」的机器化表达：
 * 产物里不许出现插件目录之外的文件引用，客户端产物必须是宿主模块加载器认识的工厂形态，
 * 且只请求宿主基线模块表里的模块。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, "..");

/** 宿主模块表提供的基线模块（packages/client/web/src/platform.ts:8-14） */
const CLIENT_BASELINE = new Set([
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-store",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-dockkit",
]);

const manifest = JSON.parse(await readFile(path.join(PLUGIN, "package.json"), "utf8"));
const host = await readFile(path.join(PLUGIN, "index.js"), "utf8");
const client = await readFile(path.join(PLUGIN, "client.js"), "utf8");

describe("插件清单", () => {
  it("声明了 bundle patch 与客户端半", () => {
    assert.equal(manifest.dsh?.bundle?.patch, "./cordis.patch.yml");
    assert.equal(manifest.dsh?.client?.platform, "web");
    assert.equal(manifest.exports["./client"], "./client.js");
    assert.equal(manifest.exports["."], "./index.js");
  });

  it("没有运行时依赖（一切内联，profile 安装不需要执行任何脚本）", () => {
    assert.deepEqual(Object.keys(manifest.dependencies ?? {}), []);
    assert.equal(manifest.scripts?.postinstall, undefined);
  });

  it("patch 里关闭了官方会话日志上传（产品隐私承诺）", async () => {
    const patch = await readFile(path.join(PLUGIN, "cordis.patch.yml"), "utf8");
    assert.match(patch, /id: knowledgenet/);
    assert.match(patch, /name: '@local\/dsh-knowledgenet'/);
    assert.match(patch, /session-log-deepseek/);
    assert.match(patch, /enabled: false/);
  });
});

describe("Client 半产物形态", () => {
  it("是宿主模块加载器的注册调用，且工厂形态与仓内预设一致", () => {
    assert.ok(client.startsWith("window.__ModuleLoader__.load({"), "开头必须是加载器注册");
    assert.match(client, /factory: \(require\) => \{/);
    assert.match(client, /var module = \{ exports: \{\} \};\s*var exports = module\.exports;/);
    assert.ok(client.trimEnd().endsWith("});"), "结尾必须是注册调用的收尾");
    assert.match(client.trimEnd(), /return module\.exports;\s*\}\s*\}\);$/, "结尾必须返回模块导出");
    assert.match(client, /id: "@local\/dsh-knowledgenet"/);
  });

  it("只请求宿主基线模块表中的模块", () => {
    const requests = [...client.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]);
    assert.ok(requests.length > 0, "客户端半应当引用 React");
    for (const request of new Set(requests)) {
      assert.ok(CLIENT_BASELINE.has(request), `客户端半请求了非基线模块：${request}`);
    }
  });

  it("内联了面板样式（Shadow Root 里要用）", () => {
    assert.match(client, /\.kn-root/);
    assert.match(client, /\.graph-scroll/);
  });
});

describe("Host 半产物形态", () => {
  it("只 import Node 内建与宿主包", () => {
    const imports = [...host.matchAll(/^import[^"']*["']([^"']+)["']/gm)].map((match) => match[1]);
    assert.ok(imports.length > 0, "Host 半应当 import Node 内建");
    for (const specifier of new Set(imports)) {
      assert.ok(
        specifier.startsWith("node:") || specifier.startsWith("@deepseek-ai/"),
        `Host 半 import 了意外模块：${specifier}`,
      );
    }
  });

  it("导出了插件契约（apply / inject / name）", () => {
    assert.match(host, /export\s*\{[^}]*\bapply\b/);
    assert.match(host, /name\s*[:=]\s*"knowledgenet"/);
  });

  it("没有把插件目录之外的路径当成依赖写进产物", () => {
    // 注意：第三方 npm 包（three / d3-force-3d）是**允许**的——它们被内联进产物，
    // 运行时不依赖 node_modules。所以这里检查的是「依赖说明符」，不是产物里的注释文本。
    for (const [label, code] of [["index.js", host], ["client.js", client]]) {
      const specifiers = [
        ...[...code.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]),
        ...[...code.matchAll(/^\s*import[^"']*["']([^"']+)["']/gm)].map((match) => match[1]),
      ];
      for (const specifier of specifiers) {
        assert.ok(!specifier.includes("../src") && !specifier.includes("..\\src"), `${label} 依赖了项目源码：${specifier}`);
        assert.ok(!specifier.includes(".pnpm"), `${label} 依赖了 pnpm 存储路径：${specifier}`);
      }
      // 产物正文里也不该出现指向上游源码的相对路径
      assert.ok(!/from\s*["'][^"']*\.\.\/src/.test(code), `${label} 正文里出现了 ../src 引用`);
    }
  });

  it("内联了布局 Worker 源码（Blob Worker 用，不能是空串）", () => {
    assert.match(client, /createKnLayoutWorker/);
    assert.match(client, /KN_LAYOUT_WORKER_SOURCE/);
    // Worker 源码里必然带着布局内核的一句可识别代码
    assert.match(client, /postMessage/);
  });

  it("空间视图用内部导航（固定球心 + 抓取点投影约束），旧轨道补丁已清掉", () => {
    /*
     * 模型已按 `design/knowledgenet-interior-navigation.md` 换成：
     * 固定球心 C + 相机位置 P + 视角 Q + 图谱旋转 S；滚轮只推相机、拖动只转图谱。
     * 于是"绕 target 环绕 + 欧拉角/四元数姿态补丁"那套整体退场 ✓——
     * 上游 `navigation.ts` 已无人引用（被 tree-shake），连带 `trackballStep` 也不在产物里 ✓。
     */
    assert.ok(!client.includes("clampPitch"), "限位不该留在产物里");
    assert.ok(!client.includes("this.camera.angle -= dx"), "欧拉角拖拽应已退场");
    assert.ok(!/zoomToCursor|zoomFloor|reanchorToCursor/.test(client), "旧的「朝光标缩放 / 重设轴心」补丁必须清掉");
    for (const needle of ["dragAnchorTo", "effectiveBasis", "wheelTravel", "knInterior"]) {
      assert.ok(client.includes(needle), `内部导航实现应在产物里：${needle}`);
    }
    for (const needle of ["freeBasis", "quatFromAxisAngle", "rotateVec"]) {
      assert.ok(client.includes(needle), `自由姿态数学应在产物里：${needle}`);
    }
  });

  it("图谱挂在会话右侧栏标签页上（不是左侧栏图标 + 中央面板，也不是对话卡片）", () => {
    assert.match(client, /sidebarRightTabs/, "应当注册右侧栏 tab type");
    assert.match(client, /sidebar\.right\.pane\.tab/, "应当注册标签页本体");
    /*
     * 新模型（用户设计）：入口对**所有工作区**可见，所以**不再自绘入口卡片**——
     * 交给宿主的「开始」页标准卡片渲染（更统一、也不需要按工作区隐藏）。
     */
    assert.ok(!/sidebar\.right\.tab\.guide\.entry/.test(client), "不该再自绘入口卡片（交给宿主标准卡片）");
    // 断言注册形状而不是裸字符串：源码注释里出现这些词是允许的
    assert.ok(!/name:\s*"sidebar\.panellist"/.test(client), "不该再占左侧栏图标位");
    assert.ok(!/name:\s*"main"/.test(client), "不该再占中央面板位");
    assert.ok(!/key:\s*"kn_list_graph"/.test(client), "图谱不应再输出成对话卡片");
  });
});
