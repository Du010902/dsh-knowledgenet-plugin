/**
 * **笔记图片存哪 / 怎么显示** ✓
 * （用户实测："我不知道图片插入到了当前PC中的什么位置"✗；
 * 要求"默认插入到 `.dsh_knowledge/image` 文件夹下，并且用户可以自己修改该路径"✓）。
 *
 * 这一组测试盯三件事 ✓：
 * ① 目录默认值与"可配置"的解析（含穿越守卫 ✓）；
 * ② 文件名清洗（防穿越 + 防怪字符 ✓）；
 * ③ 库内相对路径 ⇄ 显示 URL、以及 `data:` URL 解析 ✓。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
    assert.ok(editor.includes('attributeFilter: ["src"]'), "要有针对 `src` 的 MutationObserver ✓");
    assert.ok(
      /record\.target as Element\)\.tagName === "IMG"/.test(editor),
      "只处理 `<img>` 的 `src` 变化 ✓（别为别的属性白跑 ✓）",
    );
    assert.ok(editor.includes("imageObserver?.disconnect()"), "卸载要断开 ✓");
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
