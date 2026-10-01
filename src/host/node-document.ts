/**
 * 面板用的**节点正文读写**（对应 `design/node-note-editor-plan.md` 的「API 与文件安全」）。
 *
 * 设计要点（逐条落地 ✓）：
 * - 只读写**正文**：front-matter 的身份 / 标题 / 状态 / 修订号全部由存储层维护，
 *   客户端拿不到、也改不了 ✗（避免用户误改节点身份）；
 * - 读返回**实际相对路径**（节点被重命名后是新的那个 ✓）与**整文件指纹**
 *   （`contentHash(整个文件)` ⇒ 外部改了正文或 front-matter 都会被发现 ✓）；
 * - 保存是**比较交换**：带上读取时的指纹，磁盘对不上就拒绝并回带**最新正文**，
 *   让界面能比较 / 手动合并，绝不默认覆盖 ✗；
 * - 大文档有明确上限：超过就**拒绝**（读与写都拒），绝不静默截断后允许保存 ✗；
 * - 只认库内相对路径 ⇒ 由存储层按 `nodeId` 自己解析路径 ✗（不接受客户端给的绝对路径 ✓）。
 */
import { readLibrary, writeNote, type V3Node } from "./v3/store.ts";

/**
 * 正文大小上限（UTF-8 字节）。
 *
 * 512KB 远超正常笔记（几万字），但足以挡住"误把大文件塞进来"的情形 ✓。
 */
export const MAX_DOCUMENT_BYTES = 512 * 1024;

/** 一份可编辑的节点文档 */
export interface NodeDocument {
  /** 稳定身份：重命名也追得住 ✓ */
  nodeId: string;
  title: string;
  /** 实际相对路径（库根之下 ✓；只用于展示 ✓） */
  path: string;
  /** 正文（不含 front-matter ✓） */
  text: string;
  /** 读取时的**整文件**指纹（保存时原样带回做比较交换 ✓） */
  hash: string;
  /** 修订号（存储层维护，只读展示 ✓） */
  revision: number;
}

/** 读写结果：失败时带上稳定 code（客户端据此出文案 ✓） */
export type DocumentResult =
  | { ok: true; document: NodeDocument }
  | {
    ok: false;
    code: "not_library" | "unsupported_format" | "node_missing" | "too_large" | "conflict" | "write_failed" | "bad_body";
    message: string;
    /** 冲突时回带磁盘上的**最新正文**（供比较 / 合并 ✓） */
    latest?: NodeDocument;
  };

/**
 * **正文口径**：读、写、返回三处必须完全一致 ✓。
 *
 * 磁盘上的正文与 front-matter 之间有一个分隔换行，`composeDocument` 也会去掉正文的
 * 前导空行与尾部空白 ⇒ 读回来的 `note` 若原样带着那个换行，
 * 编辑器打开时顶部就多一个空行、而且**保存后基线与草稿不相等**（会被判成"还有未保存修改" ✗）。
 */
function normalizeBody(text: string): string {
  return text.replace(/^\n+/, "").replace(/\s+$/, "");
}

function docOf(node: V3Node): NodeDocument {
  return {
    nodeId: node.id,
    title: node.title,
    path: node.relativePath,
    text: normalizeBody(typeof node.note === "string" ? node.note : ""),
    hash: node.hash,
    revision: node.rev,
  };
}

function utf8Bytes(text: string): number {
  /* 客户端浏览器与宿主 Node 都要能算：不用 Buffer，避免把 Node 类型带进共享代码 ✓ */
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * 读一个节点的正文文档。
 * @param root - 库根（**由宿主解析**，不接受客户端绝对路径 ✓）。
 * @param nodeId - 稳定节点 id。
 * @returns 文档，或带 code 的失败 ✓。
 */
export async function readNodeDocument(root: string, nodeId: string): Promise<DocumentResult> {
  const id = typeof nodeId === "string" ? nodeId.trim() : "";
  if (id === "") return { ok: false, code: "node_missing", message: "缺少 nodeId" };
  const library = await readLibrary(root, { withNotes: true });
  if (library === undefined) {
    return { ok: false, code: "not_library", message: `这里还不是 v3 知识库：${root}` };
  }
  const node = library.nodes.find((item) => item.id === id);
  if (node === undefined) return { ok: false, code: "node_missing", message: "没有找到这个知识点" };
  const document = docOf(node);
  if (utf8Bytes(document.text) > MAX_DOCUMENT_BYTES) {
    return {
      ok: false,
      code: "too_large",
      message: `正文超过 ${Math.round(MAX_DOCUMENT_BYTES / 1024)}KB，面板编辑器不处理这么大的文档`,
    };
  }
  return { ok: true, document };
}

/**
 * 保存正文（整体替换），带**比较交换**守卫。
 *
 * **指纹是必填的** ✗（复查 P1-4）：面板这条保存接口的存在意义就是"不覆盖外部修改" ✓，
 * 缺指纹/空白/类型不对一律 `bad_body` 且**不写文件** ✗ ——
 * 其它工具若需要"无指纹写入"，那是它们自己的语义（在 store 层 ✓），面板不继承 ✓。
 *
 * @param root - 库根（宿主解析 ✓）。
 * @param input - `nodeId`、完整正文、读取时的**整文件指纹**（必填 ✓）。
 * @param now - 时间戳（测试注入 ✓）。
 * @returns 新文档（含新指纹与**规范化后的正文** ✓）；指纹对不上 ⇒ `conflict` 并回带最新正文 ✓。
 */
export async function saveNodeDocument(
  root: string,
  input: { nodeId: string; text: string; hash?: unknown },
  now: number = Date.now(),
): Promise<DocumentResult> {
  const id = typeof input.nodeId === "string" ? input.nodeId.trim() : "";
  if (id === "") return { ok: false, code: "node_missing", message: "缺少 nodeId" };
  const hash = typeof input.hash === "string" ? input.hash.trim() : "";
  if (hash === "") {
    return {
      ok: false,
      code: "bad_body",
      message: "保存必须带上读取时的整文件指纹（否则无法保证不覆盖外部修改）",
    };
  }
  const text = typeof input.text === "string" ? input.text : "";
  if (utf8Bytes(text) > MAX_DOCUMENT_BYTES) {
    return {
      ok: false,
      code: "too_large",
      message: `正文超过 ${Math.round(MAX_DOCUMENT_BYTES / 1024)}KB，已拒绝保存（不截断 ✓）`,
    };
  }
  const result = await writeNote(root, { id, text, expectedHash: hash }, now);
  if (result.ok === true) return { ok: true, document: docOf(result.node) };
  if (result.code === "conflict") {
    /* 冲突：把磁盘上的**最新**正文一起带回去，界面可以直接比较 / 手动合并 ✓ */
    const latest = await readNodeDocument(root, id);
    return {
      ok: false,
      code: "conflict",
      message: result.message,
      ...(latest.ok === true ? { latest: latest.document } : {}),
    };
  }
  if (result.code === "not_library") {
    return { ok: false, code: "not_library", message: result.message };
  }
  if (result.code === "node_missing") {
    return { ok: false, code: "node_missing", message: result.message };
  }
  return { ok: false, code: "write_failed", message: result.message };
}
