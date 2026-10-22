/**
 * **块插入：右键菜单的数据来源 + 把"光标位置"准备成"可以执行块命令的空段落"**
 * （`design/editor-block-menu-redesign.md` ✓）。
 *
 * 这里只有**纯逻辑**（DOM 之外的菜单数据整理、ProseMirror 事务）✓ ——
 * 右键事件、宿主 Menu 的弹出位置、焦点恢复留在 `MarkdownRichEditor` / `BlockInsertMenu` ✓，
 * 所以这些函数可以直接用 Node 单测（不需要浏览器 ✓）。
 *
 * 菜单条目**不是我们手写的** ✓：Crepe 的 `buildMenu` 是官方扩展点 ✓，
 * `MarkdownRichEditor` 把 `GroupBuilder` 快照交进来 ✓，这里只取 label / icon / onRun ✓ ——
 * 命令行为与原来的斜杠菜单**完全同源** ✓（表格 3×3、公式用 `language: "LaTeX"`、
 * 任务列表 attrs 等都是 Crepe 自己那套 ✓），升级 Crepe 时也不会分叉 ✗。
 */
import { Fragment } from "@milkdown/kit/prose/model";
import type { Node as ProseMirrorNode } from "@milkdown/kit/prose/model";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";

/** Crepe 块菜单里的一项（只保留我们渲染/执行需要的字段 ✓） */
export interface BlockMenuItemData {
  /** Crepe 的稳定 key（`text` / `h1` / `code` / `table` … ✓） */
  key: string;
  /** Crepe 自带的英文标签（插件词典兜底用 ✓） */
  label: string;
  /** Crepe 的 SVG 字符串（图标 ✓） */
  icon: string;
  /** 在 milkdown ctx 上执行的命令 ✓ */
  onRun?: (ctx: unknown) => void;
}

/** Crepe 的一个菜单分组（Text / List / Advanced ✓） */
export interface BlockMenuGroupData {
  key: string;
  label: string;
  items: BlockMenuItemData[];
}

/**
 * 菜单分组的**展示顺序**：右键菜单是"插入块"入口 ✓ ⇒ 把高级块（代码 / 公式 / 表格 / 图片）放最前 ✓，
 * 文本与列表随后 ✓（与旧斜杠菜单的组内顺序一致 ✓，只调整组顺序 ✓）。
 */
export const BLOCK_MENU_GROUP_ORDER: readonly string[] = ["inline", "advanced", "text", "list"];

/**
 * 插件词典里的**条目文案 key** ✓（`index.ts` 的中英两份字典都按这些 key 补齐 ✓）。
 * `null` = Crepe 新加了条目而我们还没翻译 ✓ ⇒ 调用方用 Crepe 英文 label 兜底 ✓（不崩 ✓）。
 */
const BLOCK_MENU_TEXT_KEYS: Record<string, string> = {
  "inline-bold": "inlineBold",
  "inline-italic": "inlineItalic",
  "inline-strike": "inlineStrike",
  "inline-code": "inlineCode",
  "inline-math": "inlineMath",
  "inline-link": "inlineLink",
  "inline-clear": "inlineClear",
  text: "blockMenuText",
  h1: "blockMenuH1",
  h2: "blockMenuH2",
  h3: "blockMenuH3",
  h4: "blockMenuH4",
  h5: "blockMenuH5",
  h6: "blockMenuH6",
  quote: "blockMenuQuote",
  divider: "blockMenuDivider",
  "bullet-list": "blockMenuBulletList",
  "ordered-list": "blockMenuOrderedList",
  "task-list": "blockMenuTaskList",
  image: "blockMenuImage",
  code: "blockMenuCode",
  table: "blockMenuTable",
  math: "blockMenuMath",
};

/** 分组文案 key ✓（分组 label 也走插件词典 ✓） */
const BLOCK_MENU_GROUP_KEYS: Record<string, string> = {
  inline: "inlineFormat",
  advanced: "blockMenuGroupInsert",
  text: "blockMenuGroupText",
  list: "blockMenuGroupList",
};

/** 菜单标题（无障碍名称 ✓） */
export const BLOCK_MENU_LABEL_KEY = "blockMenuLabel";

/**
 * 组件内**字面兜底字典** ✓（`tests/plugin-locale.test.mjs` 会核对：每个 key 在中英两份词典里都有 ✓）。
 * 宿主 `t` 与插件 `bind` 都拿不到时，界面不能空着 ✓（仓库既有口径 ✓）。
 */
export const BLOCK_MENU_LITERAL: Record<string, string> = {
  inlineFormat: "行内格式",
  inlineBold: "加粗",
  inlineItalic: "斜体",
  inlineStrike: "删除线",
  inlineCode: "行内代码",
  inlineMath: "行内公式",
  inlineLink: "链接",
  inlineClear: "清除文字格式",
  blockMenuLabel: "插入内容",
  blockMenuGroupInsert: "插入",
  blockMenuGroupText: "文本",
  blockMenuGroupList: "列表",
  blockMenuText: "正文",
  blockMenuH1: "标题 1",
  blockMenuH2: "标题 2",
  blockMenuH3: "标题 3",
  blockMenuH4: "标题 4",
  blockMenuH5: "标题 5",
  blockMenuH6: "标题 6",
  blockMenuQuote: "引用",
  blockMenuDivider: "分隔线",
  blockMenuBulletList: "无序列表",
  blockMenuOrderedList: "有序列表",
  blockMenuTaskList: "任务列表",
  blockMenuImage: "图片",
  blockMenuCode: "代码块",
  blockMenuTable: "表格",
  blockMenuMath: "公式块",
};

/**
 * Crepe 条目 key ⇒ 插件词典 key ✓。
 * @param key - Crepe 的 item key ✓。
 * @returns 词典 key；未收录（Crepe 新版本新增条目 ✓）返回 `null` ✓。
 */
export function blockMenuTextKey(key: string): string | null {
  return BLOCK_MENU_TEXT_KEYS[key] ?? null;
}

/**
 * Crepe 分组 key ⇒ 插件词典 key ✓。
 * @param key - Crepe 的 group key（`text` / `list` / `advanced` ✓）。
 * @returns 词典 key；未收录返回 `null` ✓。
 */
export function blockMenuGroupTextKey(key: string): string | null {
  return BLOCK_MENU_GROUP_KEYS[key] ?? null;
}

/**
 * 把 Crepe 的 `GroupBuilder` **快照**读成纯数据 ✓。
 *
 * 为什么读快照而不是自己写一份 16 个条目的命令 ✗：手写等于把 Crepe 的命令行为抄一遍 ✓，
 * 上游一改就分叉 ✗；读快照则图标 / 文案 / 命令全部同源 ✓（见文件头注释 ✓）。
 * 形状不合法（升级后改成类、拿不到 `build()` 等 ✓）⇒ 返回 `[]` ✓ ——
 * 调用方据此**不接管右键**、保留原生菜单 ✓，不会点开一个空菜单 ✗。
 *
 * @param builder - `buildMenu` 回调拿到的那个 builder ✓。
 * @returns 规范化后的分组（跳过空组 / 没有 key 的垃圾项 ✓）。
 */
export function readBlockMenuGroups(builder: unknown): BlockMenuGroupData[] {
  if (builder === null || typeof builder !== "object") return [];
  const build = (builder as { build?: unknown }).build;
  if (typeof build !== "function") return [];
  let groups: unknown;
  try {
    groups = (build as () => unknown).call(builder);
  } catch {
    return [];
  }
  if (!Array.isArray(groups)) return [];
  const result: BlockMenuGroupData[] = [];
  for (const group of groups) {
    if (group === null || typeof group !== "object") continue;
    const record = group as Record<string, unknown>;
    const itemsSource = Array.isArray(record.items) ? record.items : [];
    const items: BlockMenuItemData[] = [];
    for (const item of itemsSource) {
      if (item === null || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      const key = typeof entry.key === "string" ? entry.key : "";
      if (key === "") continue;
      items.push({
        key,
        label: typeof entry.label === "string" ? entry.label : key,
        icon: typeof entry.icon === "string" ? entry.icon : "",
        onRun: typeof entry.onRun === "function" ? entry.onRun as (ctx: unknown) => void : undefined,
      });
    }
    if (items.length === 0) continue;
    const groupKey = typeof record.key === "string" ? record.key : "";
    result.push({
      key: groupKey,
      label: typeof record.label === "string" ? record.label : groupKey,
      items,
    });
  }
  return result;
}

/**
 * 给 Crepe 的图标 SVG 补上 `fill="currentColor"` ✓。
 *
 * 为什么需要 ✗：Crepe 的图标里有些 `<path>` 没写 `fill` ✓，SVG 默认黑色 ⇒ 暗色主题下看不见 ✗；
 * 而宿主的菜单图标颜色来自 `.itemIcon` 的 `color`（宿主 token `--dsw-alias-menu-icon` ✓），
 * `fill="currentColor"` 让图标跟着主题色走 ✓（不额外注入样式表 ✓）。
 * 根 `<svg>` 已经有 `fill` 的原样返回 ✓（不重复加 ✓）。
 *
 * @param icon - Crepe 的 SVG 字符串 ✓。
 * @returns 可直接 `dangerouslySetInnerHTML` 的字符串 ✓；空输入返回 `""` ✓。
 */
export function themeBlockMenuIcon(icon: string): string {
  if (icon === "") return "";
  if (/<svg\b[^>]*\bfill\s*=/i.test(icon)) return icon;
  return icon.replace(/<svg\b/i, '<svg fill="currentColor"');
}

/**
 * 把 `anchor` 处的当前文本块**拆成 前文 / 空段落 / 后文** ✓（原斜杠菜单的安全插入 ✓，行为不变）。
 * 选择项执行命令前调用：命令只作用于中间那个空段落 ✓，两边原文和列表/引用结构都保留 ✓。
 *
 * @param view - 编辑器视图 ✓。
 * @param anchor - 拆分点（命中段落内文字位置 ✓）。
 * @returns 是否成功（结构不允许替换时 `false` ✓，调用方不要执行命令 ✓）。
 */
export function prepareBlockInsertion(view: EditorView, anchor: number): boolean {
  const { selection, doc, schema } = view.state;
  if (!(selection instanceof TextSelection) || !selection.empty || anchor < 0 || anchor > selection.from) return false;
  if (doc.resolve(anchor).parent !== selection.$from.parent) return false;
  const tr = view.state.tr.delete(anchor, selection.from);
  const caret = tr.doc.resolve(anchor);
  if (caret.parent.content.size === 0 && caret.parent.type.name === "paragraph") { view.dispatch(tr); return true; }
  const before = caret.parent.cut(0, caret.parentOffset);
  const after = caret.parent.cut(caret.parentOffset);
  const empty = schema.nodes.paragraph!.create();
  const nodes = [...(before.content.size ? [before] : []), empty, ...(after.content.size ? [after] : [])];
  const parent = caret.node(caret.depth - 1);
  if (!parent.canReplace(caret.index(caret.depth - 1), caret.index(caret.depth - 1) + 1, Fragment.fromArray(nodes))) return false;
  const from = caret.before();
  tr.replaceWith(from, caret.after(), nodes);
  tr.setSelection(TextSelection.create(tr.doc, from + (before.content.size ? before.nodeSize : 0) + 1));
  view.dispatch(tr);
  return true;
}

/** 文档里是否有表格祖先（表格单元格内不拆段落 ✓ —— 单元格只允许 paragraph，块命令会失败 ✗） */
function insideTable($pos: { depth: number; node: (depth: number) => ProseMirrorNode }): boolean {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if (["table", "table_cell", "table_header"].includes($pos.node(depth).type.name)) return true;
  }
  return false;
}

/**
 * 在 `pos` 所在**顶层块之后**插入一个空段落，并把光标放进去 ✓。
 * 用于：＋ 手柄（"在悬停的这一块后面插"✓）、正文下方空白（"追加到末尾"✓）、
 * 以及代码块 / 图片 / 表格这类**不能拆**的块（"在这一块后面插"✓）。
 *
 * @param view - 编辑器视图 ✓。
 * @param pos - 任何落在该顶层块里的文档位置 ✓（`depth === 0` 时按文档边界插入 ✓）。
 * @returns 是否成功 ✓。
 */
export function prepareAfterBlockInsertion(view: EditorView, pos: number): boolean {
  const { state } = view;
  const { doc } = state;
  const clamped = Math.min(Math.max(pos, 0), doc.content.size);
  const $pos = doc.resolve(clamped);
  const insertPos = $pos.depth >= 1 ? $pos.after(1) : clamped;
  const paragraph = state.schema.nodes.paragraph?.createAndFill();
  if (paragraph === null || paragraph === undefined) return false;
  const tr = state.tr.insert(insertPos, paragraph);
  tr.setSelection(TextSelection.create(tr.doc, insertPos + 1));
  view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * **右键位置 ⇒ 一个可以接收块命令的空段落** ✓。
 *
 * 规则（`design/editor-block-menu-redesign.md` ✓）：
 * - 落在正文/标题段落里（含列表项、引用里的段落 ✓）⇒ 在点击处拆分，命令只改中间的空段落 ✓
 *   （两边文字与列表/引用结构保留 ✓ —— 与旧斜杠菜单同一套 `prepareBlockInsertion` ✓）；
 * - 落在表格单元格里 ⇒ 不拆单元格（schema 只允许 paragraph ✗）⇒ 在**整张表格之后**插空段落 ✓；
 * - 落在代码块 / 图片块 / 其他非文本块里 ⇒ 在**这一顶层块之后**插空段落 ✓；
 * - `pos` 在文档边界（含正文下方空白 ✓）⇒ 按边界插入 / 追加 ✓。
 *
 * @param view - 编辑器视图 ✓。
 * @param pos - 右键落点换算出的文档位置 ✓。
 * @returns 是否成功 ✓（失败时调用方不要执行命令 ✓）。
 */
export function prepareContextInsertion(view: EditorView, pos: number): boolean {
  const { state } = view;
  const { doc } = state;
  const clamped = Math.min(Math.max(pos, 0), doc.content.size);
  const $pos = doc.resolve(clamped);
  if (insideTable($pos)) return prepareAfterBlockInsertion(view, clamped);
  /*
   * 只拆 **paragraph / heading** ✓：`code_block` 在 ProseMirror 里也算 textblock ✗，
   * 拆它没有意义（也无法把命令落进去 ✓）⇒ 交给"在这一块之后插入"✓。
   */
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (node.type.name !== "paragraph" && node.type.name !== "heading") continue;
    const anchor = Math.min(Math.max(clamped, $pos.start(depth)), $pos.end(depth));
    view.dispatch(state.tr.setSelection(TextSelection.create(doc, anchor)));
    return prepareBlockInsertion(view, anchor);
  }
  return prepareAfterBlockInsertion(view, clamped);
}
