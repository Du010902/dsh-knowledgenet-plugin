/**
 * 节点 markdown 的 **front-matter**（v3 存储的核心约定）。
 *
 * v3 的目标：**一个节点 = 一个 markdown**，且**身份与标题/文件名解耦**。
 * 所以每个文件的头部写一小段元数据，其中 `id` 是唯一标识（ULID），永不随标题或文件名变化：
 *
 * ```md
 * ---
 * id: 01J9ZQ8F2M7K3N5P6R7S8T9V0W
 * title: 注意力机制
 * status: learning
 * aliases: [Attention, 注意机制]
 * createdAt: 2026-09-29T10:00:00.000Z
 * updatedAt: 2026-09-29T10:05:00.000Z
 * rev: 3
 * ---
 * 正文（就是笔记本身）
 * ```
 *
 * 为什么自己写解析（不引 yaml 依赖）：插件零运行时依赖 ⇒ 只支持这一小组"键: 标量 / 内联数组"，
 * 写出来稳定、可读、可手改（用户拿编辑器直接改这一小段也不会坏）✓。
 */
import { createHash } from "node:crypto";

/** front-matter 里允许出现的字段（其它键原样保留在 `extra`，手写注释之类不会丢） */
export interface FrontMatter {
  id: string;
  title: string;
  status: string;
  aliases: string[];
  createdAt: string;
  updatedAt: string;
  rev: number;
  /** 解析时遇到的其它键（保持原样写回，避免手改内容被抹掉） */
  extra: Record<string, string>;
}

export interface ParsedDocument {
  /** 是否有 front-matter 块 */
  hasFrontMatter: boolean;
  meta: FrontMatter;
  /** front-matter 之后的正文（原样，含首尾空行） */
  body: string;
}

const FENCE = "---";

/** 生成一个空元数据（新建文件时用） */
export function emptyMeta(now: string, id: string, title: string): FrontMatter {
  return {
    id,
    title,
    status: "todo",
    aliases: [],
    createdAt: now,
    updatedAt: now,
    rev: 1,
    extra: {},
  };
}

/** 把一行 `key: value` 拆开；不是这种形状返回 undefined */
function splitLine(line: string): { key: string; value: string } | undefined {
  const at = line.indexOf(":");
  if (at <= 0) return undefined;
  return { key: line.slice(0, at).trim(), value: line.slice(at + 1).trim() };
}

/** 解析内联数组 `[a, b]` / 空 `[]`；不是数组就返回 undefined */
function parseInlineArray(value: string): string[] | undefined {
  if (!value.startsWith("[") || !value.endsWith("]")) return undefined;
  const inner = value.slice(1, -1).trim();
  if (inner === "") return [];
  return inner
    .split(",")
    .map((piece) => piece.trim().replace(/^["']|["']$/g, ""))
    .filter((piece) => piece !== "");
}

/**
 * 解析一个 markdown 文档。
 *
 * 没有 front-matter 时**不报错**：按"无元数据"返回（调用方决定是否补写 ✓）——
 * 这样用户手动新建/粘贴一个 md 进来，也不会让整个库读不出来 ✓。
 *
 * @param text - 文件全文。
 * @returns 解析结果。
 */
export function parseDocument(text: string): ParsedDocument {
  const normalized = text.replace(/^\uFEFF/, "");
  const meta = emptyMeta("", "", "");
  if (!normalized.startsWith(`${FENCE}\n`) && !normalized.startsWith(`${FENCE}\r\n`)) {
    return { hasFrontMatter: false, meta, body: normalized };
  }
  const lines = normalized.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === FENCE) {
      end = i;
      break;
    }
  }
  if (end === -1) return { hasFrontMatter: false, meta, body: normalized };

  const header = lines.slice(1, end);
  for (const line of header) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const pair = splitLine(line);
    if (pair === undefined) continue;
    const { key, value } = pair;
    switch (key) {
      case "id":
        meta.id = value;
        break;
      case "title":
        meta.title = value;
        break;
      case "status":
        meta.status = value;
        break;
      case "aliases": {
        const list = parseInlineArray(value);
        meta.aliases = list ?? (value === "" ? [] : [value]);
        break;
      }
      case "createdAt":
        meta.createdAt = value;
        break;
      case "updatedAt":
        meta.updatedAt = value;
        break;
      case "rev":
        meta.rev = Number.parseInt(value, 10) || 0;
        break;
      default:
        meta.extra[key] = value;
        break;
    }
  }
  const body = lines.slice(end + 1).join("\n");
  return { hasFrontMatter: true, meta, body };
}

/** 序列化 front-matter（**键序固定** ⇒ 同样的元数据永远产出同样的头部，便于 diff/比对） */
export function serializeFrontMatter(meta: FrontMatter): string {
  const lines = [FENCE];
  lines.push(`id: ${meta.id}`);
  lines.push(`title: ${meta.title}`);
  lines.push(`status: ${meta.status === "" ? "todo" : meta.status}`);
  lines.push(`aliases: [${meta.aliases.join(", ")}]`);
  if (meta.createdAt !== "") lines.push(`createdAt: ${meta.createdAt}`);
  if (meta.updatedAt !== "") lines.push(`updatedAt: ${meta.updatedAt}`);
  lines.push(`rev: ${meta.rev}`);
  for (const [key, value] of Object.entries(meta.extra)) lines.push(`${key}: ${value}`);
  lines.push(FENCE);
  return lines.join("\n");
}

/** 把元数据 + 正文组装成文件全文（正文前后各留一个空行，读起来舒服） */
export function composeDocument(meta: FrontMatter, body: string): string {
  const trimmed = body.replace(/^\n+/, "").replace(/\s+$/, "");
  return `${serializeFrontMatter(meta)}\n\n${trimmed}${trimmed === "" ? "" : "\n"}`;
}

/**
 * 内容指纹：用来做**冲突守卫**（写之前比对，避免覆盖别人刚改的内容 ✓）。
 * @param text - 文件全文。
 * @returns 短的十六进制指纹。
 */
export function contentHash(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex").slice(0, 12);
}

/**
 * 给标题找一个可作为文件名的形式（去掉非法字符、压掉多余空格）。
 *
 * 文件名**不承担身份** ✓（身份在 front-matter 的 id），所以这里只求"可读 + 合法"。
 * @param title - 节点标题。
 * @returns 文件名主体（不含扩展名）；标题全非法时返回 `node`。
 */
export function fileNameFromTitle(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "")
    .slice(0, 80)
    .trim();
  return cleaned === "" ? "node" : cleaned;
}
