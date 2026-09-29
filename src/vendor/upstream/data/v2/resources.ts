/**
 * 节点内的普通文件与 `resources.json`（可选增强信息）
 *
 * 两条 v2 语义（设计 §4.6）：
 * 1. 节点目录里除 `.meta/knowledgenet` 外的文件**默认就是用户资产**，
 *    不要求先「导入」才能存在——没有登记的文件不是垃圾文件；
 * 2. 若节点 A 中包含嵌套节点 B，则 B 文件夹下的内容归 B，
 *    不能递归算作 A 的资源（否则父节点的资料列表会莫名其妙多出一堆子节点文件）。
 *
 * 这里只做「看」与「登记」：真实文件的复制、系统打开、在资源管理器中显示
 * 都是桌面端命令（浏览器演示模式明确抛 `unsupported_in_demo`）。
 */
import { RepositoryError } from "../errors.ts";
import type { NodeFileEntry, NodeResource, ResourcePatch, ResourceType } from "../types.ts";
import { newUuid } from "../uuid.ts";
import {
  emptyResources,
  isoFromMs,
  parseIsoMs,
  parseResourcesFile,
  serializeJson,
  type V2ResourceEntry,
  type V2ResourcesFile,
} from "./schema.ts";
import { byteLengthOf, sha256Hex } from "./hash.ts";
import { writeTextAtomic, type Vfs } from "./fs.ts";
import { META_DIR, NODE_MARKER, baseName, isMetaRelative, joinRel, resourcesFile } from "./paths.ts";

/**
 * 列出节点目录里的普通文件（不含目录本身），按相对路径排序。
 *
 * 排除：节点内的 `.meta/**`、以及**嵌套节点子树**（子节点目录下的文件属于子节点）。
 * 返回值里的 `relativePath` 是相对**知识库根**的正斜杠路径，界面可以直接显示。
 */
export async function listPlainFiles(vfs: Vfs, nodeRel: string): Promise<NodeFileEntry[]> {
  const out: NodeFileEntry[] = [];
  const stack: string[] = [nodeRel];

  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = await vfs.list(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = joinRel(dir, entry.name);
      if (entry.kind === "file") {
        out.push({
          relativePath: rel,
          name: entry.name,
          byteLength: entry.byteLength,
          modifiedMs: entry.modifiedMs,
          isDir: false,
        });
        continue;
      }
      // 元数据命名空间不属于用户资产
      if (entry.name === META_DIR || isMetaRelative(rel)) continue;
      // 嵌套节点：整个子树归子节点
      if (await vfs.exists(joinRel(rel, NODE_MARKER))) continue;
      stack.push(rel);
    }
  }

  return out.sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );
}

/* ------------------------------ resources.json ------------------------------ */

function fileToResource(nodeId: string, entry: V2ResourceEntry): NodeResource {
  return {
    id: entry.id,
    nodeId,
    resourceType: entry.kind as ResourceType,
    relativePath: entry.relativePath,
    sourceUrl: entry.url,
    originalName: entry.originalName,
    displayName: entry.displayName,
    mimeType: entry.mimeType,
    byteLength: entry.byteLength,
    sha256: entry.sha256,
    description: entry.description,
    sortOrder: entry.sortOrder,
    createdAt: parseIsoMs(entry.createdAt),
    updatedAt: parseIsoMs(entry.updatedAt),
  };
}

export function resourceToFile(resource: NodeResource): V2ResourceEntry {
  return {
    id: resource.id,
    kind: resource.resourceType,
    relativePath: resource.relativePath,
    url: resource.sourceUrl,
    originalName: resource.originalName,
    displayName: resource.displayName,
    mimeType: resource.mimeType,
    byteLength: resource.byteLength,
    sha256: resource.sha256,
    description: resource.description,
    sortOrder: resource.sortOrder,
    createdAt: isoFromMs(resource.createdAt),
    updatedAt: isoFromMs(resource.updatedAt),
  };
}

/** 读 `resources.json`；缺失时返回空文件（不是错误：没有登记资料是常态） */
export async function readResourcesFile(
  vfs: Vfs,
  nodeRel: string,
  nodeId: string,
): Promise<{ file: V2ResourcesFile; sha256: string; text: string }> {
  const rel = resourcesFile(nodeRel);
  let text: string | null = null;
  try {
    text = await vfs.read(rel);
  } catch {
    text = null;
  }
  if (text === null) {
    const file = emptyResources(nodeId);
    const rendered = serializeJson(file);
    return { file, sha256: sha256Hex(rendered), text: rendered };
  }
  const file = parseResourcesFile(text, rel);
  return { file, sha256: sha256Hex(text), text };
}

export async function writeResourcesFile(
  vfs: Vfs,
  nodeRel: string,
  file: V2ResourcesFile,
): Promise<void> {
  await writeTextAtomic(vfs, resourcesFile(nodeRel), serializeJson(file));
}

export async function listResources(
  vfs: Vfs,
  nodeRel: string,
  nodeId: string,
): Promise<NodeResource[]> {
  const { file } = await readResourcesFile(vfs, nodeRel, nodeId);
  return file.entries
    .map((entry) => fileToResource(nodeId, entry))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt);
}

/** 内部：读改写一次 `resources.json`（revision 自增），返回写入后的文件 */
async function mutateResources(
  vfs: Vfs,
  nodeRel: string,
  nodeId: string,
  mutate: (file: V2ResourcesFile) => void,
): Promise<V2ResourcesFile> {
  const { file } = await readResourcesFile(vfs, nodeRel, nodeId);
  if (file.nodeId !== nodeId) file.nodeId = nodeId;
  mutate(file);
  file.revision += 1;
  await writeResourcesFile(vfs, nodeRel, file);
  return file;
}

export function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export async function addUrlResource(
  vfs: Vfs,
  nodeRel: string,
  nodeId: string,
  url: string,
  displayName?: string,
  description?: string,
): Promise<NodeResource> {
  if (!isHttpUrl(url)) {
    throw new RepositoryError("invalid_input", `只接受 http/https 链接：${url}`);
  }
  const now = Date.now();
  const entry: V2ResourceEntry = {
    id: newUuid(now),
    kind: "url",
    relativePath: null,
    url,
    originalName: url,
    displayName: displayName?.trim() || url,
    mimeType: "text/uri-list",
    byteLength: 0,
    sha256: "",
    description: description ?? "",
    sortOrder: now,
    createdAt: isoFromMs(now),
    updatedAt: isoFromMs(now),
  };
  const file = await mutateResources(vfs, nodeRel, nodeId, (draft) => {
    draft.entries.push(entry);
  });
  const saved = file.entries.find((item) => item.id === entry.id);
  if (!saved) throw new RepositoryError("internal", "写入 URL 资料失败");
  return fileToResource(nodeId, saved);
}

export async function updateResource(
  vfs: Vfs,
  nodeRel: string,
  nodeId: string,
  resourceId: string,
  patch: ResourcePatch,
): Promise<NodeResource> {
  const file = await mutateResources(vfs, nodeRel, nodeId, (draft) => {
    const entry = draft.entries.find((item) => item.id === resourceId);
    if (!entry) return;
    if (patch.displayName !== undefined) entry.displayName = patch.displayName;
    if (patch.description !== undefined) entry.description = patch.description;
    if (patch.sortOrder !== undefined) entry.sortOrder = patch.sortOrder;
    entry.updatedAt = isoFromMs(Date.now());
  });
  const saved = file.entries.find((item) => item.id === resourceId);
  if (!saved) throw new RepositoryError("not_found", `资料不存在：${resourceId}`);
  return fileToResource(nodeId, saved);
}

/**
 * 删除一条资料登记。
 *
 * `deleteFile` 为真时才删除节点目录里的实际文件——用户文件不是「数据库的附件」，
 * 默认只解除登记。
 */
export async function removeResource(
  vfs: Vfs,
  nodeRel: string,
  nodeId: string,
  resourceId: string,
  deleteFile = false,
): Promise<void> {
  const before = await readResourcesFile(vfs, nodeRel, nodeId);
  const entry = before.file.entries.find((item) => item.id === resourceId);
  if (!entry) throw new RepositoryError("not_found", `资料不存在：${resourceId}`);
  await mutateResources(vfs, nodeRel, nodeId, (draft) => {
    draft.entries = draft.entries.filter((item) => item.id !== resourceId);
  });
  if (deleteFile && entry.relativePath) {
    await vfs.remove(joinRel(nodeRel, entry.relativePath));
  }
}

/**
 * 把节点目录里已经存在的普通文件登记成资料（「加一句说明」）。
 *
 * 这是 v1「登记未登记文件」的正名：文件本来就在那里，登记只是补充展示名与说明。
 */
export async function annotateFile(
  vfs: Vfs,
  nodeRel: string,
  nodeId: string,
  relativePath: string,
): Promise<NodeResource> {
  const wanted = joinRel(nodeRel, relativePath);
  const plain = await listPlainFiles(vfs, nodeRel);
  const target =
    plain.find((entry) => entry.relativePath === wanted) ??
    plain.find((entry) => entry.name === relativePath);
  if (!target) {
    throw new RepositoryError("not_found", `节点目录里没有这个文件：${relativePath}`, {
      relativePath,
    });
  }
  const prefix = nodeRel === "" ? "" : `${nodeRel}/`;
  const inner = target.relativePath.startsWith(prefix)
    ? target.relativePath.slice(prefix.length)
    : target.name;

  let content = "";
  try {
    content = await vfs.read(target.relativePath);
  } catch {
    content = "";
  }

  const file = await mutateResources(vfs, nodeRel, nodeId, (draft) => {
    if (draft.entries.some((entry) => entry.relativePath === inner)) return;
    const now = Date.now();
    draft.entries.push({
      id: newUuid(now),
      kind: "file",
      relativePath: inner,
      url: null,
      originalName: target.name,
      displayName: target.name,
      mimeType: guessMimeType(target.name),
      byteLength: byteLengthOf(content),
      sha256: sha256Hex(content),
      description: "",
      sortOrder: now,
      createdAt: isoFromMs(now),
      updatedAt: isoFromMs(now),
    });
  });
  const saved = file.entries.find((entry) => entry.relativePath === inner);
  if (!saved) throw new RepositoryError("internal", "登记文件失败");
  return fileToResource(nodeId, saved);
}

/** 尽力而为的 MIME 猜测：只是给界面一个图标提示，不参与任何判断 */
export function guessMimeType(name: string): string {
  const ext = baseName(name).toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "md":
    case "markdown":
      return "text/markdown";
    case "txt":
      return "text/plain";
    case "json":
      return "application/json";
    case "pdf":
      return "application/pdf";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "csv":
      return "text/csv";
    case "html":
    case "htm":
      return "text/html";
    default:
      return "application/octet-stream";
  }
}

/** 计算节点内某个文件的哈希与大小（用于资料登记的已知哈希） */
export async function fileFingerprint(
  vfs: Vfs,
  nodeRel: string,
  relativePath: string,
): Promise<{ sha256: string; byteLength: number }> {
  const text = await vfs.read(joinRel(nodeRel, relativePath));
  return { sha256: sha256Hex(text), byteLength: byteLengthOf(text) };
}

/** 读取节点内某个文件的正文（资料预览用；二进制文件在桌面端走系统打开） */
export async function readPlainFile(
  vfs: Vfs,
  nodeRel: string,
  relativePath: string,
): Promise<string> {
  return vfs.read(joinRel(nodeRel, relativePath));
}

/** `resources.json` 是否存在（完整性检查用） */
export async function hasResourcesFile(vfs: Vfs, nodeRel: string): Promise<boolean> {
  return vfs.exists(resourcesFile(nodeRel));
}
