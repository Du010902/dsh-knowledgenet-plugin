/**
 * **笔记里的图片存哪、怎么显示** ✓
 * （用户实测："我不知道图片插入到了当前PC中的什么位置"✗；
 * 要求"默认插入到 `.dsh_knowledge/image` 文件夹下，并且用户可以自己修改该路径"✓）。
 *
 * ## 为什么之前"看不到图片存在哪"
 *
 * Crepe 的 image-block 默认钩子是
 * `onUpload: (file) => Promise.resolve(URL.createObjectURL(file))` ✓ ——
 * 它给的是**内存里的 blob: URL** ✗：当时能看见 ✓，刷新/重开笔记就没了 ✓，
 * 磁盘上**什么都没写** ✓（所以"找不到在哪"✓）。
 *
 * ## 这里的口径
 *
 * ① Markdown 里写的是**库内相对路径** ✓（`image/xxx.png` ✓）——
 *    这样笔记挪到别的编辑器（Typora / VS Code ✓）里也读得懂 ✓，
 *    不会写进"只有本机这个 DSH 实例认得"的 URL ✗；
 * ② 显示时由编辑器把它换成宿主路由 URL ✓（`api/knowledgenet.graph?kind=image&path=…` ✓），
 *    于是浏览器能按同源取到字节 ✓；
 * ③ 目录默认 `image`（即库根下的 `<library>/image/` ✓ = 用户说的 `.dsh_knowledge/image/` ✓），
 *    可以在插件配置 `imageDir` 里改 ✓ —— 支持**库内相对目录** ✓，
 *    写成绝对路径则按绝对路径处理 ✓（守卫见宿主侧 `resolveImageTarget` ✓）。
 *
 * 本文件只有**纯字符串/字节逻辑** ✓（不 import Node 内建 ✓）⇒ 客户端与宿主都能用、也能单测 ✓。
 */

/** 默认图片目录（相对库根 ✓）：用户要的就是 `<library>/image/` ✓ */
export const DEFAULT_IMAGE_DIR = "image";

/** 单张图片的字节上限（12 MiB ✓）：base64 之后再大就拒 ✗（别把库塞爆 ✓） */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/** 认得出的图片扩展名 ✓（其余一律当 `bin` ✗，但仍然允许存 ✓） */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "ico"]);

/**
 * 规范化**图片目录** ✓（`imageDir` 配置 / 默认值都过这里 ✓）。
 *
 * - 空 / 非字符串 ⇒ 默认 `image` ✓；
 * - 去掉首尾空白与斜杠 ✓、把 `\` 统一成 `/` ✓；
 * - 含 `..` 的段 ⇒ 判为不可用 ⇒ 回默认 ✓（穿越守卫的第一道 ✓）。
 *
 * @param value - 配置里的 `imageDir` ✓。
 * @returns 可以安全拼接的目录（相对或绝对 ✓，`/` 分隔 ✓）。
 */
export function normalizeImageDir(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_IMAGE_DIR;
  const cleaned = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (cleaned === "") return DEFAULT_IMAGE_DIR;
  if (cleaned.split("/").some((part) => part === ".." || part === "")) return DEFAULT_IMAGE_DIR;
  return cleaned;
}

/**
 * 规范化**文件名** ✓：只保留"字母/数字/`-` `_` `.`/中文"✓，
 * 其余（空格、引号、斜杠、`..` ✓）一律换成 `-` ✓ —— 既防穿越 ✓，也防 HTML/Markdown 注入 ✓。
 *
 * @param value - 原始文件名（例如 `屏幕截图 2026-10-07.png` ✓）。
 * @param fallbackExt - 没有扩展名时补的扩展名（例如从 mime 推出来的 `png` ✓）。
 * @returns 安全文件名 ✓（一定非空 ✓）。
 */
export function sanitizeImageName(value: unknown, fallbackExt = "png"): string {
  const raw = typeof value === "string" ? value : "";
  const base = raw.replace(/\\/g, "/").split("/").pop() ?? "";
  const dotted = base.includes(".") ? base : `${base === "" ? "image" : base}.${fallbackExt}`;
  const lastDot = dotted.lastIndexOf(".");
  const stem = dotted.slice(0, lastDot);
  const ext = dotted.slice(lastDot + 1).toLowerCase();
  const safeStem = stem
    .replace(/[^0-9A-Za-z\u4e00-\u9fa5._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 60);
  const safeExt = /^[a-z0-9]{1,8}$/.test(ext) ? ext : "png";
  const finalStem = safeStem === "" ? "image" : safeStem;
  return `${finalStem}.${IMAGE_EXTENSIONS.has(safeExt) ? safeExt : safeExt === "jpeg" ? "jpg" : safeExt}`;
}

/** mime ⇒ 扩展名 ✓（`parseDataUrl` 拿不到文件名时用它 ✓） */
export function extensionFromMime(mime: unknown): string {
  if (typeof mime !== "string") return "png";
  const value = mime.toLowerCase();
  if (value.includes("jpeg") || value.includes("jpg")) return "jpg";
  if (value.includes("svg")) return "svg";
  if (value.includes("webp")) return "webp";
  if (value.includes("gif")) return "gif";
  if (value.includes("avif")) return "avif";
  if (value.includes("bmp")) return "bmp";
  if (value.includes("ico")) return "ico";
  return "png";
}

/**
 * 拼出**库内相对路径** ✓（Markdown 里就写这个 ✓）。
 *
 * @param dir - 图片目录（会过 `normalizeImageDir` ✓）。
 * @param name - 文件名（会过 `sanitizeImageName` ✓）。
 * @returns `image/xxx.png` 这样的相对路径 ✓（一律 `/` 分隔 ✓）。
 */
export function imageRelativePath(dir: unknown, name: unknown): string {
  return `${normalizeImageDir(dir)}/${sanitizeImageName(name)}`;
}

/**
 * 这个 `src` 是不是"库内相对路径" ✓（决定要不要换成宿主路由来显示 ✓）。
 *
 * 排除：`http(s):` / `data:` / `blob:` / `file:` / `//host` / 以 `/` 开头的绝对路径 ✓
 * —— 那些交给浏览器自己处理 ✗（我们不猜别人的 URL ✓）。
 *
 * @param src - `<img src>` 的原值 ✓。
 * @returns 需要改写 ⇒ `true` ✓。
 */
export function isLibraryRelativeImageSrc(src: unknown): boolean {
  if (typeof src !== "string") return false;
  const value = src.trim();
  if (value === "") return false;
  if (value.startsWith("/") || value.startsWith("//")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  return true;
}

/**
 * 库内相对路径 ⇒ **宿主路由 URL** ✓（只用于显示 ✓，不进 Markdown ✗）。
 *
 * @param route - 宿主路由（`GRAPH_API_ROUTE` ✓）。
 * @param relativePath - 库内相对路径 ✓。
 * @returns 同源 URL ✓（浏览器/Electron IPC 桥都能取 ✓）。
 */
export function imageDisplayUrl(route: string, relativePath: string, target?: Record<string, unknown> | undefined): string {
  /*
   * **要把库目标带上** ✗（用户实测：插入后图片显示不出来 ✓）。
   * `<img>` 是浏览器发的一次**普通 GET** ✓，宿主那边没有会话上下文 ✓：
   * 不带 `root`/`sessionId` 时它只能靠"最近装载过的库"兜底 ✓ —— 于是常常解析不到 ⇒ 404 ⇒ 图裂 ✓。
   * 带上目标 ⇒ 宿主按同一个库解析 ✓（与笔记读写完全一致 ✓）。
   */
  const params = new URLSearchParams({ kind: "image", path: relativePath });
  const root = target?.root;
  const sessionId = target?.sessionId;
  if (typeof root === "string" && root.trim() !== "") params.set("root", root.trim());
  else if (typeof sessionId === "string" && sessionId.trim() !== "") params.set("sessionId", sessionId.trim());
  return `${route}?${params.toString()}`;
}

/** `data:` URL 解析结果 ✓ */
export interface ParsedDataUrl {
  /** mime（小写 ✓；认不出给 `image/png` ✓） */
  mime: string;
  /** 字节 ✓ */
  bytes: Uint8Array;
}

/**
 * 解析 `data:` URL ✓（客户端把 `File` 读成 data URL 后传过来 ✓）。
 *
 * @param value - `data:image/png;base64,AAAA…` ✓。
 * @returns mime + 字节 ✓；不是 data URL / 超限 / base64 坏掉 ⇒ `null` ✓。
 */
export function parseDataUrl(value: unknown): ParsedDataUrl | null {
  if (typeof value !== "string") return null;
  const match = /^data:([^;,]*)(;[^,]*)?,(.*)$/s.exec(value);
  if (match === null) return null;
  const mime = (match[1] ?? "").trim().toLowerCase() || "image/png";
  const meta = match[2] ?? "";
  const payload = match[3] ?? "";
  if (payload.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 16) return null;
  if (!meta.includes("base64")) {
    /* 非 base64 的 data URL（少见 ✓）：按 URL 解码 ✓ */
    try {
      const text = decodeURIComponent(payload);
      const bytes = new TextEncoder().encode(text);
      if (bytes.byteLength > MAX_IMAGE_BYTES) return null;
      return { mime, bytes };
    } catch {
      return null;
    }
  }
  let bytes: Uint8Array;
  try {
    const binary = atob(payload.replace(/\s+/g, ""));
    bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  } catch {
    return null;
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return null;
  return { mime, bytes };
}

/** mime ⇒ 响应用 `content-type` ✓（只允许图片类 ✓，别的当二进制流 ✓） */
export function contentTypeForImage(mime: string, name: string): string {
  const lower = typeof mime === "string" ? mime.toLowerCase() : "";
  if (lower.startsWith("image/")) return lower;
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  if (ext === "svg") return "image/svg+xml";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (IMAGE_EXTENSIONS.has(ext)) return `image/${ext}`;
  return "application/octet-stream";
}

/**
 * **图片默认图注** ✓ —— 存在的唯一理由是：**空图注会让 Crepe 的 image-block 在重开笔记时抛错** ✗。
 *
 * 实测（产物里 image-block 的 Markdown 映射 ✓）：
 * ```
 * parseMarkdown: runner(state, node) { const src = node.url; const caption = node.title; … }
 * attrs: { src: string, caption: { default: "", validate: "string" }, ratio: number }
 * ```
 * ⇒ **`alt` 是宽高比、`title` 才是图注** ✓；而 `![](...)`（没有 title ✓）解析回来 `caption` 是 `undefined` ✗
 * ⇒ `Attribute.validate` 抛 `RangeError: Expected value of type string for attribute caption … got null` ✗
 * ⇒ 那个图片块当场报废 ✓（用户实测："重开笔记后图片不见了"✓，控制台就是这条错 ✓）。
 *
 * @param src - 图片地址（通常是库内相对路径 ✓）。
 * @returns 非空图注：取文件名主干 ✓（`image/foo.png` ⇒ `foo` ✓）；实在取不到 ⇒ `image` ✓。
 */
export function defaultImageCaption(src: unknown): string {
  const value = typeof src === "string" ? src.trim() : "";
  const base = value.split(/[?#]/)[0]?.split("/").pop() ?? "";
  const stem = base.replace(/\.[A-Za-z0-9]{1,8}$/, "").trim();
  return stem === "" ? "image" : stem.slice(0, 80);
}

/**
 * **给图片补一个"显式的空标题"** ✓ —— 让"图注为空"成为一件**合法且可往返**的事 ✓
 * （用户追问："为什么不能允许图注为空"✓ —— 确实应该允许 ✓，问题不在"空" ✗，在**往返** ✓）。
 *
 * 上游的毛病（产物里读到的 ✓）：`image-block` 的
 * ```
 * attrs: { caption: { default: "", validate: "string" } }        // 必须是字符串 ✗
 * parseMarkdown: runner(state, node) { const caption = node.title; … }   // 图注取自 title ✓
 * ```
 * ⇒ 图注为空时序列化出来是 `![](url)`（**没有 title** ✗）⇒ 再解析回来 `caption` 是 `undefined` ✗
 * ⇒ 校验抛 `RangeError` ✗ ⇒ 图片块报废 ✓（"保存重开后图片消失"✓）。
 *
 * ⇒ 修法不是"给图注编个名字" ✗，而是**让 Markdown 明确写出空标题** ✓：
 * ```
 * ![](image/foo.png)      ⇒      ![](image/foo.png "")
 * ```
 * 这样 `title` 是**空字符串**而不是 `undefined` ✓ ⇒ 解析安全 ✓、图注仍然是空的 ✓✓。
 *
 * 两个方向都过一遍这个函数 ✓（进编辑器时 ✓ + 出编辑器保存时 ✓）⇒ 磁盘上与编辑器里**同一形状** ✓、
 * 幂等 ✓（已经有 title 的一律不动 ✓）。
 *
 * ⚠️ 只认**整行就是一张图片**的那种写法 ✓；**代码围栏里的示例一律不动** ✗
 * （文档里写 `![](a.png)` 的教学文本不该被改 ✓）。
 *
 * @param markdown - 原始 Markdown ✓。
 * @returns 补过空标题的 Markdown ✓。
 */
export function withExplicitImageTitles(markdown: string): string {
  if (typeof markdown !== "string" || markdown === "") return markdown;
  const lines = markdown.split("\n");
  let fenced = false;
  let changed = false;
  const out = lines.map((line) => {
    const trimmed = line.trimStart();
    if (/^(```|~~~)/.test(trimmed)) {
      fenced = !fenced;
      return line;
    }
    if (fenced) return line;
    /* 整行一张图片 ✓（前面只允许空白 ✓）；已经有 title 的（`"…"` / `'…'` / `(…)`）不动 ✓ */
    const match = /^(\s*!\[[^\]]*\]\(\s*[^\s)]+)(\s*\)\s*)$/.exec(line);
    if (match === null) return line;
    changed = true;
    return `${match[1]} ""${match[2]}`;
  });
  return changed ? out.join("\n") : markdown;
}
