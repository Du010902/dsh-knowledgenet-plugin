/**
 * **笔记图片存哪 / 怎么显示 / 怎么放大看** ✓
 * （用户实测："我不知道图片插入到了当前PC中的什么位置"✗；
 * 要求"默认插入到 `.dsh_knowledge/image` 文件夹下，并且用户可以自己修改该路径"✓；
 * 又实测"插入图片会变得很糊"✓）。
 *
 * 这一组测试盯四件事 ✓：
 * ① 目录默认值与"可配置"的解析（含穿越守卫 ✓）；
 * ② 文件名清洗（防穿越 + 防怪字符 ✓）；
 * ③ 库内相对路径 ⇄ 显示 URL、以及 `data:` URL 解析 ✓；
 * ④ **点图片看原图**（用户实测"很糊"✗ —— 文件没坏 ✓，是正文栏把它压到 ~24% ✓；
 *    最终**直接用宿主共享的 `ImageLightbox`** ✓ —— 见 `design/note-images-storage.md` 第九轮 ✓）。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/** 读源码做接线断言时用 ✓ */
const HERE = path.dirname(fileURLToPath(import.meta.url));

import {
  DEFAULT_IMAGE_DIR,
  MAX_IMAGE_BYTES,
  contentTypeForImage,
  extensionFromMime,
  imageDisplayUrl,
  imageRelativePath,
  isLibraryRelativeImageSrc,
  normalizeImageDir,
  parseDataUrl,
  sanitizeImageName,
  withExplicitImageTitles,
} from "../src/shared/note-images.ts";
import { imageDirAbsolute, resolveImageTarget, withNameSuffix } from "../src/host/note-images-host.ts";

describe("图片目录：默认 + 可配置 + 穿越守卫 ✓", () => {
  it("默认就是用户要的 `image`（即 `<库根>/image/` ✓ = `.dsh_knowledge/image/` ✓）", () => {
    assert.equal(DEFAULT_IMAGE_DIR, "image");
    assert.equal(normalizeImageDir(undefined), "image");
    assert.equal(normalizeImageDir(""), "image");
    assert.equal(normalizeImageDir("  "), "image");
  });

  it("配置可以改成别的库内目录 ✓（用户要求「可以自己修改该路径」✓）", () => {
    assert.equal(normalizeImageDir("assets"), "assets");
    assert.equal(normalizeImageDir(" assets/img "), "assets/img");
    assert.equal(normalizeImageDir("assets\\img"), "assets/img", "反斜杠也认 ✓");
    assert.equal(normalizeImageDir("/images/"), "images", "首尾斜杠去掉 ✓");
    /* 含 `..` 的一律回默认 ✗（绝不接受"往上跳"的目录 ✓） */
    assert.equal(normalizeImageDir("../outside"), "image");
    assert.equal(normalizeImageDir("assets/../../etc"), "image");
    assert.equal(normalizeImageDir("a//b"), "image", "空段也算不合法 ✓");
  });

  it("相对目录按库根解析 ✓；绝对目录原样用 ✓", () => {
    assert.equal(imageDirAbsolute("D:/lib", "image"), "D:\\lib\\image".replace(/\//g, "\\"));
    assert.equal(imageDirAbsolute("D:/lib", "assets/img"), "D:\\lib\\assets\\img".replace(/\//g, "\\"));
    const absolute = imageDirAbsolute("D:/lib", "D:/pics");
    assert.ok(/pics$/i.test(absolute), `绝对目录要原样 ✓（实际 ${absolute}）`);
  });

  it("**两种路径写法都要认** ✓（Markdown 存的是「库根相对」⇒ `image/x.png` ✓）", () => {
    /*
     * 实测：磁盘上确实有 `<库>/image/image-89fd.png` ✓，界面却 404 ✓ ——
     * 因为解析时把 `image/image-89fd.png` **又拼了一次图片目录** ✗
     * ⇒ `<库>/image/image/image-89fd.png` ✗ ⇒ 文件不存在 ✓。
     */
    const root = "D:/lib";
    const byLibraryRelative = resolveImageTarget(root, "image", "image/a.png");
    assert.equal(
      byLibraryRelative,
      imageDirAbsolute(root, "image") + "\\a.png",
      "`image/a.png` 要按**库根相对**解析 ✓（不能再拼一次 image ✗）",
    );
    const byImageDirRelative = resolveImageTarget(root, "image", "a.png");
    assert.equal(
      byImageDirRelative,
      imageDirAbsolute(root, "image") + "\\a.png",
      "只给文件名时按**图片目录相对**解析 ✓（保存时就是这条路 ✓）",
    );
    /* 换了目录名也一样 ✓ */
    assert.equal(
      resolveImageTarget(root, "assets/img", "assets/img/b.png"),
      imageDirAbsolute(root, "assets/img") + "\\b.png",
      "自定义目录同样按库根相对认 ✓",
    );
  });
  it("**取图时不许走出图片目录** ✗（`..` / 越界一律 null ✓）", () => {
    const root = "D:/lib";
    assert.notEqual(resolveImageTarget(root, "image", "image/a.png"), null, "正常路径要放行 ✓");
    assert.equal(resolveImageTarget(root, "image", "../secret.txt"), null, "`..` 一律拒 ✗");
    assert.equal(resolveImageTarget(root, "image", "image/../../secret.txt"), null, "绕两下也不行 ✗");
    assert.equal(resolveImageTarget(root, "image", ""), null, "空路径拒 ✓");
    const absoluteLike = resolveImageTarget(root, "image", "/etc/passwd");
    assert.notEqual(absoluteLike, null, "绝对路径会被当成「库内相对段」处理 ✓");
    assert.ok(
      absoluteLike?.startsWith(imageDirAbsolute(root, "image")) === true,
      `但落点仍然必须在图片目录里 ✓（实际 ${absoluteLike}）`,
    );
    /*
     * 任何"库内相对段"都会被**解析到图片目录里面** ✓ —— 关键是"落点一定在目录内" ✓，
     * 而不是"字符串长得像不像" ✗（前缀陷阱的检查在函数内部做 ✓）。
     */
    const sneaky = resolveImageTarget(root, "image", "image-evil/x.png");
    assert.ok(
      sneaky?.startsWith(imageDirAbsolute(root, "image")) === true,
      `子目录也要落在图片目录内 ✓（实际 ${sneaky}）`,
    );
  });
});

describe("文件名清洗与重名 ✓", () => {
  it("怪文件名一律安全化 ✓（穿越、引号、空格、超长 ✓）", () => {
    assert.equal(sanitizeImageName("shot.png"), "shot.png");
    assert.equal(sanitizeImageName("屏幕截图 2026-10-07.png"), "屏幕截图-2026-10-07.png");
    assert.equal(sanitizeImageName("../../evil.png"), "evil.png", "路径部分被剥掉 ✓");
    assert.equal(sanitizeImageName('a"b<c>.png'), "a-b-c.png", "标点被换成 `-`、首尾的 `-` 去掉 ✓");
    assert.equal(sanitizeImageName("no-extension"), "no-extension.png", "没扩展名 ⇒ 补一个 ✓");
    assert.equal(sanitizeImageName(""), "image.png", "空名 ⇒ 给个默认 ✓");
    assert.ok(sanitizeImageName("x".repeat(200) + ".png").length <= 68, "超长名要截断 ✓");
    /* 扩展名按 mime 推 ✓ */
    assert.equal(sanitizeImageName("a", extensionFromMime("image/jpeg")), "a.jpg");
    assert.equal(sanitizeImageName("a", extensionFromMime("image/svg+xml")), "a.svg");
  });

  it("重名加短后缀、**不覆盖** ✓", () => {
    assert.equal(withNameSuffix("a.png", "3f2c"), "a-3f2c.png");
    assert.equal(withNameSuffix("noext", "3f2c"), "noext-3f2c");
    assert.ok(/^a-[0-9a-z]{1,8}\.png$/.test(withNameSuffix("a.png", "!!@@")), "非法后缀也要换成合法串 ✓");
  });
});

describe("Markdown 里存相对路径、显示时换成同源 URL ✓", () => {
  it("相对路径才改写 ✓（http / data / blob / 绝对路径一律不碰 ✗）", () => {
    assert.equal(isLibraryRelativeImageSrc("image/a.png"), true);
    assert.equal(isLibraryRelativeImageSrc("./image/a.png"), true);
    for (const src of ["https://x/a.png", "http://x/a.png", "data:image/png;base64,AA", "blob:http://x/y", "file:///c:/a.png", "/abs/a.png", "//host/a.png", "", "  "]) {
      assert.equal(isLibraryRelativeImageSrc(src), false, `不该改写：${src}`);
    }
    assert.equal(isLibraryRelativeImageSrc(undefined), false);
    assert.equal(isLibraryRelativeImageSrc(123), false);
  });

  it("库内相对路径 ⇒ 同源取图 URL ✓（编码过的 query ✓）", () => {
    assert.equal(
      imageDisplayUrl("/api/knowledgenet.graph", "image/屏幕 截图.png"),
      "/api/knowledgenet.graph?kind=image&path=image%2F%E5%B1%8F%E5%B9%95+%E6%88%AA%E5%9B%BE.png",
    );
    /*
     * **必须带上库目标** ✗（用户实测：插入后图裂 ✓）：
     * `<img>` 那次 GET 没有会话上下文 ✓ ⇒ 不带 root/sessionId 时宿主只能靠"最近的库"兜底 ✓ ⇒ 常常 404 ✓。
     */
    const withRoot = imageDisplayUrl("/api/graph", "image/a.png", { root: "D:/lib" });
    assert.ok(withRoot.includes("root=D%3A%2Flib"), `要带 root ✓（实际 ${withRoot}）`);
    const withSession = imageDisplayUrl("/api/graph", "image/a.png", { sessionId: "s-1" });
    assert.ok(withSession.includes("sessionId=s-1"), `要带 sessionId ✓（实际 ${withSession}）`);
    const both = imageDisplayUrl("/api/graph", "image/a.png", { root: "D:/lib", sessionId: "s-1" });
    assert.ok(both.includes("root=") && !both.includes("sessionId="), "两个都有时优先 root ✓（与其它请求口径一致 ✓）");
    assert.ok(!imageDisplayUrl("/api/graph", "image/a.png", {}).includes("root="), "没有目标就不带 ✓");
    assert.equal(imageRelativePath("image", "a.png"), "image/a.png");
    assert.equal(imageRelativePath("../x", "a.png"), "image/a.png", "目录不合法 ⇒ 回默认 ✓");
  });
});

describe("**允许图注为空** ✓（用户追问：为什么不能为空 ✓）", () => {
  const editor = readFileSync(path.join(HERE, "..", "src", "client", "MarkdownRichEditor.tsx"), "utf8");

  it("**不是「不许为空」，是上游往返丢了 title** ✗ ⇒ 明确写出空标题 ✓", () => {
    /*
     * 上游：`caption` 取自 Markdown 的 **title** ✓，且校验必须是 `string` ✗；
     * 图注为空时序列化成 `![](url)`（没有 title ✗）⇒ 再解析 `caption = undefined` ✗ ⇒ 抛 RangeError ✗。
     * ⇒ 正确修法是让 Markdown **显式写出空标题** ✓（`![](... "")` ✓）：图注照样为空 ✓、解析安全 ✓。
     */
    assert.equal(withExplicitImageTitles("![](image/a.png)"), '![](image/a.png "")');
    assert.equal(withExplicitImageTitles("![1.00](image/a.png)"), '![1.00](image/a.png "")');
    /* 幂等 ✓：已经有 title 的一律不动 ✓ */
    const titled = '![](image/a.png "caption")';
    assert.equal(withExplicitImageTitles(titled), titled);
    assert.equal(withExplicitImageTitles(withExplicitImageTitles(titled)), titled);
    /* 夹在正文里、带缩进、带前导文字的都只处理"整行一张图"✓ */
    assert.equal(
      withExplicitImageTitles("前面一句\n  ![](image/a.png)  \n后面一句"),
      '前面一句\n  ![](image/a.png "")  \n后面一句',
    );
    assert.equal(withExplicitImageTitles("文字 ![](image/a.png) 文字"), "文字 ![](image/a.png) 文字", "不是整行 ⇒ 不动 ✓");
    /* **代码围栏里的示例不许动** ✗ */
    const fenced = "```md\n![](image/a.png)\n```\n";
    assert.equal(withExplicitImageTitles(fenced), fenced, "围栏里的示例文本不能改 ✓");
    assert.equal(withExplicitImageTitles(""), "");
  });

  it("接线：**进来与出去都要过一遍** ✓（磁盘与编辑器同形状 ✓）", () => {
    assert.ok(editor.includes("withExplicitImageTitles(initialRef.current)"), "初始正文要补 ✓");
    assert.ok(editor.includes("replaceAll(withExplicitImageTitles(markdown))"), "外部替换要补 ✓");
    assert.ok(editor.includes("return withExplicitImageTitles(crepe.getMarkdown());"), "flush（保存）要补 ✓");
    assert.ok(
      editor.includes("onBaselineRef.current?.(ingested, withExplicitImageTitles(crepe.getMarkdown()));"),
      "报基线也要用同一形状 ✓（否则会被当成「又有未保存改动」✗）",
    );
    /* 上一版"给图注编个名字"的做法必须撤掉 ✗（用户明确质疑 ✓） */
    assert.ok(!editor.includes("normalizeImageCaptions"), "不许再自动给图注起名字 ✗");
    assert.ok(!editor.includes("defaultImageCaption"), "同上 ✓");
  });
});
describe("图片显示的接线 ✓（用户实测：插入后图裂 ✗）", () => {
  const editor = readFileSync(path.join(HERE, "..", "src", "client", "MarkdownRichEditor.tsx"), "utf8");

  it("**用 `fetch` 取字节再给 `<img>` blob URL** ✓（`<img>` 带不了认证 ✗）", () => {
    /*
     * 第三轮的真正原因 ✓：宿主取图路由和别的接口一样要过 DSH 连接鉴权 ✓ ——
     * 我们自己的 `fetch` 过得去 ✓，而浏览器为 `<img>` 发的裸 GET **拿不到凭据** ✗ ⇒ 401 ⇒ 图裂 ✓
     * （手工 curl 同一个 401 ✓，同因 ✓）。
     * ⇒ 改成：`fetch(取图URL)` → `blob()` → `URL.createObjectURL` → 交给 `<img>` ✓；
     *   Markdown 里仍然是库内相对路径 ✓（可移植 ✓），同一条只取一次 ✓。
     */
    assert.ok(editor.includes("function ensureImageDisplay("), "要有这条取图路径 ✓");
    assert.ok(/void fetch\(wanted\)/.test(editor), "要用自己的 `fetch` 取字节 ✓（它过得了鉴权 ✓）");
    assert.ok(editor.includes("URL.createObjectURL(blob)"), "再交给 `<img>` blob URL ✓");
    assert.ok(editor.includes('if (image.isConnected) image.setAttribute("src", url);'), "取回来才写 `src` ✓");
    assert.ok(editor.includes("URL.revokeObjectURL(url)"), "卸载要 revoke ✓（别漏内存 ✓）");
    assert.ok(editor.includes("imageInflightRef"), "并发去重要有 ✓（同一张别取两次 ✓）");
    /* 诊断：成功与失败都留痕 ✓（下一轮出问题能一眼看出卡在哪一步 ✓） */
    assert.ok(editor.includes('"image-src-ready"'), "取到要上报 ✓");
    assert.ok(editor.includes('"image-load-failed"'), "取不到要上报（带 url ✓）");
    assert.ok(editor.includes('"image-load-error"'), "Crepe 的 onImageLoadError 也接上 ✓");
  });

  it("**盯着 `src` 变化再断言** ✓（Vue 会把 `src` 写回相对路径 ✗）", () => {
    assert.ok(
      /attributeFilter: \["src"(?:, "style")?\]/.test(editor),
      "要有针对 `src` 的 MutationObserver ✓（`style` 一起看也行 ✓）",
    );
    assert.ok(
      /record\.target as Element\)\.tagName === "IMG"/.test(editor),
      "只处理 `<img>` 的 `src` 变化 ✓（别为别的属性白跑 ✓）",
    );
    assert.ok(editor.includes("imageObserver?.disconnect()"), "卸载要断开 ✓");
  });

  it("**开笔记不再报 `dsh-app://app/image/… 404`** ✓（用户实测：控制台里两条 404 ✗）", () => {
    /*
     * Markdown 里是**库内相对路径** ✓，Crepe 建 DOM 时原样写进 `src` ✗ ⇒
     * 浏览器拿文档基址去请求 ⇒ 必然 404 ✗（图最后仍能显示 ✓，因为随后换成了 blob ✓，
     * 但那两条报错刺眼 ✓，还会闪一下裂图 ✗）。
     * ⇒ 节点一插进来就在**同一个微任务**里换成透明占位 ✓，让那次请求根本不发出 ✓。
     */
    assert.ok(editor.includes("IMAGE_PLACEHOLDER_SRC"), "要有透明占位 ✓");
    assert.ok(editor.includes("function holdNoteImagePlaceholder("), "要有「先占位」这一步 ✓");
    assert.ok(editor.includes('report?.("image-src-hold"'), "掐掉时要留痕 ✓（下一轮能看出是不是这条在起作用 ✓）");
    /* 节点是**新插进来**的 ⇒ 观察器必须也盯 childList ✓，否则我们到得太晚 ✗ */
    assert.ok(
      /imageObserver\?\.observe\(root, \{[^}]*childList: true/.test(editor),
      "要盯 `childList` ✓（只盯属性 ⇒ 到得太晚，请求已经发出去了 ✗）",
    );
    assert.ok(editor.includes("const hasImage = (node: Node)"), "新插入的节点里要能认出 `<img>` ✓");
    /* 别把已经显示出来的图打回占位 ✗（Crepe 每次重渲染都会写回相对路径 ✓） */
    assert.ok(
      /if \(current === IMAGE_PLACEHOLDER_SRC \|\| current\.startsWith\("blob:"\) \|\| current\.startsWith\("data:"\)\) return;/.test(editor),
      "已经是 blob / 占位 / data 的 `src` 不许再动 ✗",
    );
    /* 占位是 1×1 ⇒ 绝不能拿它量尺寸 ✗（否则真图被压成一条、还纠正不回来 ✗） */
    assert.ok(
      /if \(\(image\.getAttribute\("src"\) \?\? ""\) === IMAGE_PLACEHOLDER_SRC\) return;/.test(editor),
      "`fitNoteImage` 要跳过占位 ✓",
    );
  });

  it("**两套配置键名都写** ✓（块级图片读的是 `block*` 那套 ✗）", () => {
    for (const key of [
      "onUpload", "uploadButton", "uploadPlaceholderText", "captionPlaceholderText", "confirmButton",
      "blockOnUpload", "blockUploadButton", "blockUploadPlaceholderText", "blockCaptionPlaceholderText", "blockConfirmButton",
    ]) {
      assert.ok(editor.includes(`${key}:`), `图片块配置要写 ${key} ✓（只写一套会掉回 Crepe 默认值 ✗）`);
    }
    assert.ok(editor.includes('blockOnUpload: (file: File) => uploadNoteImage('), "块级上传也要走我们的落盘 ✓");
  });

  it("取图 URL 带上库目标 ✓", () => {
    assert.ok(
      editor.includes("imageDisplayUrl(GRAPH_API_ROUTE, raw, target)"),
      "改写时要把当前库 target 传进去 ✓（否则宿主解析不到库 ⇒ 404 ⇒ 图裂 ✓）",
    );
    assert.ok(editor.includes("target?: unknown;"), "富编辑器要接收当前库目标 ✓");
    assert.ok(
      /target=\{props\.target\}/.test(readFileSync(path.join(HERE, "..", "src", "client", "NodeDocumentEditor.tsx"), "utf8")),
      "笔记编辑器要把目标透传下去 ✓（图片与笔记落在同一个库 ✓）",
    );
  });
});
describe("`data:` URL 解析 ✓", () => {
  it("base64 图片解析成字节 ✓", () => {
    /* "hi" ⇒ aGk= ✓ */
    const parsed = parseDataUrl("data:image/png;base64,aGk=");
    assert.notEqual(parsed, null);
    assert.equal(parsed?.mime, "image/png");
    assert.deepEqual(Array.from(parsed?.bytes ?? []), [104, 105]);
    assert.equal(new TextDecoder().decode(parsed?.bytes), "hi");
  });

  it("坏输入一律 null ✓（不是 data URL / 坏 base64 / 空 / 超限 ✓）", () => {
    assert.equal(parseDataUrl("not-a-data-url"), null);
    assert.equal(parseDataUrl("data:image/png;base64,!!!"), null);
    assert.equal(parseDataUrl("data:image/png;base64,"), null, "空字节不算图片 ✓");
    assert.equal(parseDataUrl(undefined), null);
    const huge = "A".repeat(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 64);
    assert.equal(parseDataUrl(`data:image/png;base64,${huge}`), null, "超限要拒 ✗（别把库塞爆 ✓）");
  });

  it("`content-type` 按扩展名兜底 ✓", () => {
    assert.equal(contentTypeForImage("image/webp", "a.webp"), "image/webp");
    assert.equal(contentTypeForImage("", "a.svg"), "image/svg+xml");
    assert.equal(contentTypeForImage("", "a.jpg"), "image/jpeg");
    assert.equal(contentTypeForImage("", "a.bin"), "application/octet-stream");
  });
});


/*
 * ============================================================================
 * **图片显示得很糊**（用户实测 2026-10-20 ✓）—— 以及为什么最后**直接用宿主的组件** ✓
 * ============================================================================
 *
 * 第一轮定位：用户原话"在当前笔记中插入图片，会变得很糊"✓ —— 先钉死**不是文件被压坏了** ✗：
 * 那张 `右旋圆极化示意图.png` 3200×1920 / 783375 字节，插进笔记后磁盘上那份
 * 与原文件 **SHA256 一致** ✓，取图也是原字节 ✓。糊的是**显示**：
 * 笔记正文栏最宽 860px ✓、面板里实际 ~770px ✓ ⇒ 3200px 的图只剩 **24%** ✓，
 * 图里的小字**没有足够的像素** ✓ —— 不是过滤器/编码问题 ✗，是物理尺寸问题 ✓。
 *
 * 第二轮（用户实测截图 ✓）：第一版是**自绘**一个铺满视口的 `<dialog>` + 工具栏 ✓ ——
 * 结果**右上角的按钮被 Windows 原生标题栏（窗口控制按钮）压住** ✗。
 * 用户一句话点破："DSH 自己的这种图片查看方式就很好，为什么不直接用它的"✓。
 *
 * ⇒ 第九轮改成**直接复用宿主共享的 `ImageLightbox`** ✓：
 * - 它就在基线模块 `@deepseek-ai/dsh-client-ui-primitives` 里 ✓
 *   （`packages/client/ui-primitives/src/ImageLightbox.tsx` ✓；DSH 的聊天图片、文档图片点开就是它 ✓）；
 * - 舞台是 `inset: var(--dsh-frame-chrome-top, 0px) 0 0` ✓ ⇒ **主动避开 Windows 标题栏** ✓
 *   （这个 CSS 变量由宿主 AppFrame 设置 ✓）；关闭按钮在舞台里 ⇒ 不会再被窗口按钮压住 ✓；
 * - Esc / 点遮罩 / × / 焦点还原 / portal 到 body 全是它自己的事 ✓ —— 插件这边只给
 *   `src` + `alt` + 两条 labels + `onClose` ✓；
 * - 代价（如实记 ✓）：宿主这个预览是**按窗口等比缩放**（`max-width: min(100%, 1600px)` ✓），
 *   **没有 1:1 缩放** ✗ —— 3200px 的图在 1920 窗口里约 **48%** ✓，仍然是正文 24% 的两倍 ✓。
 *
 * 所以这组测试钉三件事：**不再自绘** ✗ / 打开与关闭的接线 ✓ / 文案与提示 ✓。
 */
describe("原图预览：直接用宿主自带的 ImageLightbox ✓（不再自绘 ✗）", () => {
  const CLIENT_DIR = path.join(HERE, "..", "src", "client");
  const editor = readFileSync(path.join(CLIENT_DIR, "MarkdownRichEditor.tsx"), "utf8");

  it("从**基线模块**取宿主组件 ✓（`@deepseek-ai/dsh-client-ui-primitives` ✓，由宿主模块表提供 ✓）", () => {
    assert.ok(
      editor.includes('import { ImageLightbox } from "@deepseek-ai/dsh-client-ui-primitives";'),
      "要用宿主共享的 `ImageLightbox` ✓（别自己画遮罩 ✗）",
    );
    assert.match(
      editor,
      /<ImageLightbox\s+src=\{lightbox\.src\}\s+alt=\{lightbox\.alt\}\s+labels=\{\{ dialog: t\("imageViewerTitle"\), close: t\("imageViewerClose"\) \}\}\s+onClose=\{closeLightbox\}/,
      "要把 `src` / `alt` / 两条 labels / `onClose` 都交给宿主组件 ✓",
    );
  });

  it("**自绘的那一套已经删干净** ✓（它的遮罩会被 Windows 标题栏压住 ✗）", () => {
    assert.equal(existsSync(path.join(CLIENT_DIR, "note-image-viewer.ts")), false, "自绘查看器模块必须删掉 ✗");
    for (const file of readdirSync(CLIENT_DIR)) {
      if (!/\.(tsx?)$/.test(file)) continue;
      const code = readFileSync(path.join(CLIENT_DIR, file), "utf8");
      assert.ok(!code.includes("showModal("), `${file} 里还有自绘 modal ✗`);
      assert.ok(!code.includes("knowledgenet-image-viewer-style"), `${file} 里还在注入自绘样式 ✗`);
    }
  });

  it("产物里只剩**基线 external** ✓（宿主模块表解析 ✓，不是把宿主组件抄进来 ✗）", () => {
    const bundle = readFileSync(path.join(HERE, "..", "client.js"), "utf8");
    assert.ok(
      bundle.includes('require("@deepseek-ai/dsh-client-ui-primitives")'),
      "`client.js` 应当 require 这块基线模块 ✓（`selfcontained.test.mjs` 会校验它在宿主基线表里 ✓）",
    );
    assert.ok(!bundle.includes("knowledgenet-image-viewer-style"), "自绘查看器的样式字符串不该再进产物 ✗");
  });

  it("**关闭回调必须稳定** ✓（宿主把它当 effect 依赖 ✗，每次渲染换新函数会反复还原焦点 ✗）", () => {
    assert.match(
      editor,
      /const closeLightbox = useCallback\(\(\): void => \{ setLightbox\(null\); \}, \[\]\);/,
      "`closeLightbox` 要用 `useCallback(…, [])` ✓",
    );
    assert.match(editor, /const \[lightbox, setLightbox\] = useState<\{ src: string; alt: string \} \| null>\(null\)/, "预览状态只有 src/alt 两项 ✓");
  });
});

describe("编辑器接线：点图片看原图 ✓（用户实测：插入的图片很糊 ✗）", () => {
  const editor = readFileSync(path.join(HERE, "..", "src", "client", "MarkdownRichEditor.tsx"), "utf8");
  const overrides = readFileSync(path.join(HERE, "..", "src", "client", "editor-overrides.css"), "utf8");

  it("点图片才打开：**图注输入框 / 操作按钮 / 拖拽手柄都不算** ✓", () => {
    assert.ok(editor.includes("setLightbox({ src, alt })"), "要真的打开预览 ✓");
    assert.ok(
      editor.includes('if (target.closest("input, button, .caption-input, .operation, .image-edit, .image-resize-handle") !== null) return;'),
      "这些控件在图片块里，但不该触发预览 ✓（否则改图注/拖高度就弹窗 ✗）",
    );
    assert.ok(editor.includes('root.addEventListener("click", onImageClick, true)'), "用事件委托（Crepe 会重渲染节点 ✗）");
  });

  it("**选中态下点到的不是 `<img>`** ✗ ⇒ 必须从图片块里再找那张图 ✓（实测踩到 ✓）", () => {
    assert.ok(
      editor.includes('block.querySelector<HTMLImageElement>("img")'),
      "`.selected > .image-wrapper::before`（没有 pointer-events:none ✗）会挡住 img ⇒ 从块里取图 ✓",
    );
    assert.ok(editor.includes('const block = target.closest<HTMLElement>(".milkdown-image-block")'), "限定在图片块里 ✓");
  });

  it("不抢 ProseMirror 的点击（选中/删除图片照旧 ✓）", () => {
    const start = editor.indexOf("const onImageClick = (event: Event): void => {");
    assert.notEqual(start, -1, "找不到 onImageClick");
    const body = editor.slice(start, editor.indexOf("root.addEventListener(\"click\", onImageClick, true);") + 1);
    assert.ok(!body.includes("preventDefault"), "不许 preventDefault ✗（否则图片选不中、删不掉 ✓）");
    assert.ok(!body.includes("stopPropagation"), "不许 stopPropagation ✗（理由同上 ✓）");
  });

  it("复用**已经解码好**的那张图 ✓（不再下载 / 不再编码 ✓）", () => {
    assert.ok(editor.includes("image.currentSrc"), "用 `currentSrc` ✓（就是我们 fetch 回来的 blob: ✓）");
    assert.ok(editor.includes("naturalWidth"), "要自然尺寸 ✓（占位 / 未解码好的图不打开 ✓）");
    assert.ok(editor.includes("captionInput?.value ?? image.alt"), "`alt` 取图注 ✓");
    assert.ok(editor.includes('reportRef.current?.("image-viewer-open"'), "打开要留痕 ✓（下次说糊，能一眼看出正文里是 24% ✓）");
  });

  it("卸载时移除监听 ✓（预览本身是 React 组件，跟着卸载一起走 ✓）", () => {
    assert.ok(editor.includes('root.removeEventListener("click", onImageClick, true)'), "监听要成对移除 ✓");
  });

  it("光标形状 + 悬停提示 ✓（**不往 node view 里塞外来按钮** ✗ —— 表入口那条口径 ✓）", () => {
    assert.ok(editor.includes("imageViewerOpenHint"), "悬停要有一句「点击查看大图」✓（`title` 上 ✓）");
    assert.ok(
      /if \(zoomHint !== undefined && image\.title !== zoomHint\) image\.title = zoomHint;/.test(editor),
      "`title` 只在值不同时写 ✓（避免每帧白写 ✗），而且不在观察器的 `src`/`style` 过滤里 ✓",
    );
    assert.ok(
      /\.kn-root \.kn-editor-rich \.milkdown \.milkdown-image-block img \{ cursor: zoom-in; \}/.test(overrides),
      "图片上要 `cursor: zoom-in` ✓",
    );
    assert.ok(!editor.includes("kn-image-zoom"), "不许往 Crepe 的图片块里塞按钮 ✗");
  });

  it("**中英词典都补上** ✓（英文界面不许漏中文 ✗）", () => {
    const dict = readFileSync(path.join(HERE, "..", "src", "client", "index.ts"), "utf8");
    const zh = dict.slice(dict.indexOf("const DICT_ZH"), dict.indexOf("const DICT_EN"));
    const en = dict.slice(dict.indexOf("const DICT_EN"));
    for (const key of ["imageViewerTitle", "imageViewerClose", "imageViewerOpenHint"]) {
      assert.ok(new RegExp(`const IMAGE_VIEWER_LITERAL[^=]*=\\s*\\{[^}]*${key}:`, "m").test(editor) || editor.includes(`${key}: "`), `字面兜底里缺 ${key} ✗`);
      assert.match(zh, new RegExp(`^\\s{2}${key}:`, "m"), `中文字典缺 ${key} ✗`);
      assert.match(en, new RegExp(`^\\s{2}${key}:`, "m"), `英文字典缺 ${key} ✗（英文界面会漏出中文 ✓）`);
    }
    /* 自绘那版用不到的键必须清掉 ✗（留着就是死文案 ✓） */
    for (const dead of ["imageViewerZoomIn", "imageViewerZoomOut", "imageViewerFit", "imageViewerActual", "imageViewerHint"]) {
      assert.ok(!dict.includes(dead), `死文案 ${dead} 应当随自绘查看器一起删掉 ✗`);
    }
  });
});
