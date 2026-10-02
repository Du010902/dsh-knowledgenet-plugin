/**
 * **代码块的复制 / 粘贴语义** ✓
 * （`design/code-block-copy-paste-analysis.md` ✓）。
 *
 * 复查确认的问题：Crepe 的代码块"复制"按钮只调 `navigator.clipboard.writeText(text)` ✗
 * ⇒ 剪贴板里**只有裸代码字符** ✓，没有"这是一个 C++ 代码块"的信息 ✓；
 * 粘回正文时 milkdown 的剪贴板插件把纯文本当 **Markdown** 解析 ✗
 * ⇒ 四空格缩进变成缩进代码块、空行分段、`<iostream>` 触发原始 HTML 检测 ✓
 * —— 一份代码被拆成段落 + 一个显示 `Text` 的块 ✓（用户截图 ✓）。
 *
 * 这里不去动"复制裸代码"这条路 ✗（粘到终端 / IDE 就该是裸代码 ✓），
 * 而是**同时**写入一份结构化载荷 ✓：
 *
 * | 剪贴板格式 | 内容 | 谁用 |
 * | --- | --- | --- |
 * | `text/plain` | 裸代码 ✓ | 终端 / IDE / 其它应用 ✓（与原来一样 ✓） |
 * | `text/html` | 转义后的 `<pre><code class="language-…">` ✓ | 富文本编辑器 / 文档 ✓ |
 * | `web application/x-dsh-kn-codeblock+json` | 本插件自己的载荷（语言 + 代码 + 版本 ✓） | **本插件正文里粘贴** ✓ |
 *
 * 为什么自定义格式带 `web ` 前缀 ✗：Chrome 只允许 `web ` 开头的自定义剪贴板类型 ✓，
 * 否则 `ClipboardItem` 直接抛 `NotAllowedError` ✓。
 * 自定义格式**不是唯一方案** ✗：不支持多格式时退回"纯文本 + HTML"，再不行退回纯文本 ✓。
 *
 * 本文件只有**纯逻辑** ✓（不碰 DOM / React / 编辑器 ✓）⇒ 可以离线单测 ✓。
 */

/** 本插件代码块载荷的剪贴板 MIME ✓（必须 `web ` 前缀 ✓） */
export const KN_CODE_BLOCK_MIME = "web application/x-dsh-kn-codeblock+json";
/** 载荷里的版本号 ✓（将来要改结构时用它兼容 ✓） */
export const KN_CODE_BLOCK_VERSION = 1;
/** 载荷大小上限（字符数 ✓）：防止把超大剪贴板内容整段塞进文档 ✓ */
export const KN_CODE_BLOCK_MAX_CHARS = 256 * 1024;

/** 一份代码块载荷 ✓ */
export interface CodeBlockPayload {
  /** 语言标识（可为空串 ✓ —— 空就是没有语言 ✓） */
  language: string;
  /** 代码原文（**一字不改** ✓：缩进、空行、尖括号都保持 ✓） */
  code: string;
}

/**
 * 语言标识要不要丢掉 ✓：只接受"字母 / 数字 / `+` `#` `-` `_` `.`"这些常见字符 ✓，
 * 其余（含引号、尖括号、换行 ✓）一律当成"没有语言" ✗ ——
 * 载荷会被写进 HTML 的 `class` 属性 ✓，不校验就等于给了注入点 ✗。
 *
 * @param value - 原始语言字符串 ✓。
 * @returns 安全的语言标识；不安全或为空 ⇒ `""` ✓。
 */
export function safeLanguage(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > 32) return "";
  return /^[A-Za-z0-9+#._-]+$/.test(trimmed) ? trimmed : "";
}

/** HTML 文本转义 ✓（`<iostream>` 这类内容必须原样显示、不能被当标签 ✗） */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 生成 `text/html` 那份剪贴板内容 ✓：`<pre><code class="language-…">` ✓，
 * 代码与语言都**转义** ✓（不直接插入执行 ✓，复查要求 ✓）。
 *
 * @param payload - 语言 + 代码 ✓。
 * @returns 转义后的 HTML 片段 ✓。
 */
export function codeBlockHtml(payload: CodeBlockPayload): string {
  const language = safeLanguage(payload.language);
  const cls = language === "" ? "" : ` class="language-${escapeHtml(language)}"`;
  return `<pre><code${cls}>${escapeHtml(payload.code)}</code></pre>`;
}

/** 把载荷序列化成剪贴板字符串 ✓ */
export function encodeCodeBlockPayload(payload: CodeBlockPayload): string {
  return JSON.stringify({
    v: KN_CODE_BLOCK_VERSION,
    kind: "kn-code-block",
    language: safeLanguage(payload.language),
    code: payload.code,
  });
}

/**
 * 解析剪贴板里的本插件载荷 ✓（**校验 + 限长** ✓，复查要求 ✓）。
 *
 * 失败一律返回 `null` ✓ ⇒ 调用方**放行**给原有的 Markdown 粘贴 ✗
 * （宁可当普通文本，也不要拿一段不认识的 JSON 去改文档 ✓）。
 *
 * @param raw - 剪贴板里那种格式的字符串 ✓。
 * @returns 语言 + 代码；不是本插件载荷 / 版本不认识 / 超长 ⇒ `null` ✓。
 */
export function parseCodeBlockPayload(raw: unknown): CodeBlockPayload | null {
  if (typeof raw !== "string" || raw === "") return null;
  if (raw.length > KN_CODE_BLOCK_MAX_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as { v?: unknown; kind?: unknown; language?: unknown; code?: unknown };
  if (record.kind !== "kn-code-block") return null;
  if (record.v !== KN_CODE_BLOCK_VERSION) return null;
  if (typeof record.code !== "string" || record.code.length > KN_CODE_BLOCK_MAX_CHARS) return null;
  return { language: safeLanguage(record.language), code: record.code };
}

/**
 * 光标是不是在**代码块里面** ✓。
 *
 * 用途：粘进已有代码块时只插字符 ✗（不许嵌套新代码块 ✓，复查验收要求 ✓）。
 *
 * @param nodeName - 选区所在"最内层块节点"的类型名 ✓（由调用方从编辑器状态里取 ✓）。
 * @returns 在代码块里 ⇒ `true` ✓。
 */
export function insideCodeBlock(nodeName: string | undefined): boolean {
  return nodeName === "code_block";
}

/** 反转义 HTML 实体 ✓（`text/html` 那份是我们自己转义的 ✓，还原时一一对应 ✓） */
export function unescapeHtml(text: string): string {
  return text
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

/**
 * 从 `text/html` 那份里**认出"这本来就是一个代码块"** ✓
 * （`design/code-block-copy-paste-analysis.md` ✓）。
 *
 * 为什么需要它 ✗：自定义剪贴板格式**不是所有环境都让写** ✓
 * （Chrome 会拒绝没带 `web ` 前缀的类型、有的宿主还会整体拒绝多格式 ✓）——
 * 那时我们写进去的就是"纯文本 + HTML" ✓，粘贴时只有 HTML 能说明语言 ✓。
 * 所以这里把 HTML 也当成一条**可恢复**的线索 ✓（复查方案里正是这么写的 ✓）。
 *
 * **只在"整段就是一个 `<pre><code>`"时才认** ✗：别把从浏览器 / 文档里复制的富 HTML
 * 误判成代码块 ✓（那种情况继续交给 milkdown 原有粘贴 ✓）。
 *
 * @param html - 剪贴板里的 `text/html` ✓。
 * @returns 语言 + 代码；认不出 ⇒ `null` ✓。
 */
export function codeBlockFromClipboardHtml(html: unknown): CodeBlockPayload | null {
  if (typeof html !== "string" || html.trim() === "") return null;
  const trimmed = html.trim();
  if (trimmed.length > KN_CODE_BLOCK_MAX_CHARS) return null;
  /*
   * 允许外层有 `<meta charset>` / 换行 / 空白 ✓（Chrome 会把 HTML 片段包一层 ✓），
   * 但**中间不允许再有别的标签** ✗ —— 用"去掉外围包装后必须以 pre 开头、以 /pre 结尾"判定 ✓。
   */
  const match = /^\s*(?:<meta[^>]*>\s*)*<pre[^>]*>\s*<code([^>]*)>([\s\S]*)<\/code>\s*<\/pre>\s*$/i.exec(trimmed);
  if (match === null) return null;
  const attrs = match[1] ?? "";
  const body = match[2] ?? "";
  if (body.includes("<")) return null; /* 里面还有标签 ⇒ 不是"纯代码块"✗（宁可放行 ✓） */
  const languageMatch = /class\s*=\s*(["'])[^"']*language-([A-Za-z0-9+#._-]+)[^"']*\1/i.exec(attrs);
  const code = unescapeHtml(body).replace(/\r\n/g, "\n");
  if (code.length > KN_CODE_BLOCK_MAX_CHARS) return null;
  return { language: safeLanguage(languageMatch?.[2] ?? ""), code };
}
