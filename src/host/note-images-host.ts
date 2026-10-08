/**
 * **图片目录的落盘位置**（宿主侧 ✓）—— 与 `src/shared/note-images.ts` 的纯字符串逻辑配套。
 *
 * 单独的模块是为了能**直接单测** ✓（只 import `node:path` 与那个共享文件 ✓，
 * 没有 Node 参数属性 ⇒ `node --test` 能 import ✓）。
 *
 * 安全口径（这是本文件唯一的重点 ✓）：
 * 用户可以通过插件配置 `imageDir` 指定目录 ✓ —— 但**取图**那条路（GET 带 `path=` ✓）
 * 的输入来自 URL ✓ ⇒ 必须保证最终解析出来的文件**落在图片目录里** ✗，
 * 绝不能靠 `..` 走出去 ✓（所以这里做"前缀 + 分隔符"判断 ✓，
 * 而不是只看 `startsWith(base)` ✗ —— 那样 `image-evil/` 也会被放行 ✓）。
 */
import { isAbsolute, resolve, sep } from "node:path";

import { normalizeImageDir, sanitizeImageName } from "../shared/note-images.ts";

/**
 * 图片目录的**绝对路径** ✓：相对目录按库根解析 ✓，绝对目录原样用 ✓。
 *
 * @param root - 库根（绝对路径 ✓）。
 * @param imageDir - 配置里的 `imageDir`（可空 ⇒ 默认 `image` ✓）。
 * @returns 绝对目录 ✓。
 */
export function imageDirAbsolute(root: string, imageDir: unknown): string {
  const dir = normalizeImageDir(imageDir);
  return isAbsolute(dir) ? resolve(dir) : resolve(root, dir);
}

/**
 * 把**库内相对路径**解析成绝对文件路径 ✓，并保证它在图片目录内 ✗。
 *
 * @param root - 库根 ✓。
 * @param imageDir - 配置里的 `imageDir` ✓。
 * @param relativePath - 例如 `image/xxx.png` ✓（可以带子目录 ✓）。
 * @returns 绝对路径 ✓；越界 / 空 / 含 `..` ⇒ `null` ✓。
 */
export function resolveImageTarget(root: string, imageDir: unknown, relativePath: unknown): string | null {
  if (typeof relativePath !== "string") return null;
  const cleaned = relativePath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (cleaned === "") return null;
  const parts = cleaned.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  const base = imageDirAbsolute(root, imageDir);
  /* 逐段过一遍文件名清洗 ✓（防止 URL 编码里的怪字符 ✓），再拼绝对路径 ✓ */
  const safeParts = parts.map((part, index) => (index === parts.length - 1 ? sanitizeImageName(part) : sanitizeImageName(part, "dir").replace(/\.[a-z0-9]{1,8}$/i, "")));
  /*
   * ⚠️ **两种写法都要认** ✓（这正是"磁盘上有图、界面 404"的原因 ✗）：
   * ① Markdown 里存的是**库根相对**路径 ✓（`image/xxx.png` ✓，已经含目录名 ✓）；
   * ② 但调用方也可能只给**文件名** ✓（保存时就是 ✓）。
   * 先按 ① 解析 ✓ —— 若结果落在图片目录里就用它 ✓；否则退回 ②（相对图片目录 ✓）。
   * 之前只做 ② ✗ ⇒ `image/xxx.png` 被拼成 `<库>/image/image/xxx.png` ✗ ⇒ 文件不存在 ⇒ 404 ✓（实测 ✓）。
   * 两种都**必须落在图片目录内** ✓，越界一律 `null` ✗。
   */
  const asLibraryRelative = resolve(root, ...safeParts);
  if (asLibraryRelative === base || asLibraryRelative.startsWith(base + sep)) return asLibraryRelative;
  const asImageDirRelative = resolve(base, ...safeParts);
  if (asImageDirRelative === base || asImageDirRelative.startsWith(base + sep)) return asImageDirRelative;
  return null;
}

/**
 * 重名时给个短后缀 ✓（`a.png` → `a-3f2c.png` ✓）。
 *
 * @param name - 已经清洗过的文件名 ✓。
 * @param suffix - 4 位左右的随机串 ✓。
 * @returns 带后缀的文件名 ✓（扩展名留在最后 ✓）。
 */
export function withNameSuffix(name: string, suffix: string): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const clean = suffix.replace(/[^0-9a-z]/gi, "").slice(0, 8) || "copy";
  return `${stem}-${clean}${ext}`;
}
