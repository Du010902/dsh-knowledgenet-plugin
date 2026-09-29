/**
 * 领域模型（Domain Model）
 *
 * 约定：边 A → B 表示「为了理解 A，需要先理解 B」，即 A 依赖 B（B 是 A 的前置知识）。
 * 因此：入边（incoming / prerequisites）= 前置知识；出边（outgoing / dependents）= 用到它的地方。
 *
 * v2（节点文件夹化，见 `design/节点文件夹化与学习工作台重构方案.md` §4）的核心变化：
 * - 节点 = 普通文件夹 + `.meta/knowledgenet/node.json`，**位置是扫描结果而不是身份**：
 *   因此 `KnowledgeNode` 多了只读的 `relativePath` / `folderName` / `health` / `revision`；
 * - 节点是**轻量元数据**：正文在节点目录的 `primaryDocument`（通常是 `note.md`），
 *   按需通过 `readNote` / `writeNote` 读写，绝不随图快照一起载入；
 * - `StorageState`（目录状态机）随 SQLite 主库一起删除：文件夹在不在由扫描如实报告，
 *   不存在「数据库说有、磁盘上没有」这种中间态；
 * - 所有 ID 都是 UUIDv7 字符串，前端只当作不透明标识。
 */
import type { ChatThread } from "./chatTypes.ts";

/** 学习状态：未开始 / 学习中 / 已理解 */
export type LearnStatus = "todo" | "learning" | "done";

export const STATUS_LABEL: Record<LearnStatus, string> = {
  todo: "未开始",
  learning: "学习中",
  done: "已理解",
};

export const STATUS_ORDER: LearnStatus[] = ["todo", "learning", "done"];

/**
 * 节点元数据的健康状态（扫描结果）。
 *
 * - `ok`：`node.json` 合法；
 * - `metadata_invalid`：JSON 坏了或必填字段类型错（保留最后一次有效快照用于只读显示）；
 * - `metadata_unsupported`：`format` / `formatVersion` 不是本应用支持的版本；
 * - `duplicate_id`：同一知识库内出现了相同 node id，相关写操作要暂停等用户决定。
 */
export type NodeHealth = "ok" | "metadata_invalid" | "metadata_unsupported" | "duplicate_id";

/** 知识节点：只有元数据 + 扫描得到的只读位置信息，没有正文 */
export interface KnowledgeNode {
  id: string;
  title: string;
  /** 别名/同义写法，用于搜索与复用命中 */
  aliases: string[];
  status: LearnStatus;
  createdAt: number;
  updatedAt: number;
  /** 只读扫描结果：节点目录相对知识库根的正斜杠路径 */
  relativePath: string;
  /** 只读扫描结果：节点目录的文件夹名（标题与文件夹名彻底分离） */
  folderName: string;
  health: NodeHealth;
  /** `node.json` 的修订号，写入时作为乐观并发依据 */
  revision: number;
  /** 本地刚改过、还没被重新扫描确认（界面可以据此提示「待同步」） */
  localMutation: boolean;
}

/** 依赖关系。from 依赖 to（to 是 from 的前置知识） */
export interface DependencyEdge {
  id: string;
  fromId: string;
  toId: string;
  /** 「为什么 from 需要 to」——回来后用于恢复上下文，而不是只看到一个箭头 */
  relation: string;
  /** 关系类型；第一版只有 prerequisite */
  relationType: string;
  createdAt: number;
  updatedAt: number;
  /**
   * 扫描结果：目标节点当前不在知识库里。
   *
   * 关系**保留**（不自动删除），图谱上显示为缺失占位，用户可以稍后修好目标文件夹。
   * 该字段只读，写入时忽略。
   */
  dangling?: boolean;
}

/** 学习目标：一个入口节点 */
export interface Goal {
  id: string;
  title: string;
  rootNodeId: string;
  createdAt: number;
}

/**
 * 上次的学习位置。只记「最后在看哪个节点」，用于重启应用后回到原位。
 *
 * 这是**设备交互状态**：v2 里由 `save_session` / `enter_node` 写进设备侧，
 * 不进入节点文件夹，也不随知识库复制。
 */
export interface LearnSession {
  id: string;
  goalId: string;
  /** 最后选中的节点；null 表示没有 */
  currentNodeId: string | null;
  updatedAt: number;
}

/**
 * 轻量图快照：不含任何笔记正文与附件内容。
 *
 * `revision` 现在是「最近一次扫描代次」：每次写操作或显式重扫之后递增，
 * 前端提交时携带期望值，不匹配就整批拒绝，避免旧快照覆盖新数据。
 */
export interface GraphSnapshot {
  revision: number;
  nodes: KnowledgeNode[];
  edges: DependencyEdge[];
  goals: Goal[];
  session: LearnSession | null;
}

export interface NewNodeInput {
  title: string;
  aliases?: string[];
  status?: LearnStatus;
  /** 创建时写入的初始正文；不传表示创建空的 note.md */
  note?: string;
  /** 建在哪个相对目录下；不传用 `library.json.defaults.newNodeParent` */
  parentRelativePath?: string;
}

export interface NodePatch {
  title?: string;
  aliases?: string[];
  status?: LearnStatus;
  /** 主文档相对路径；显式传 null 表示清空 */
  primaryDocument?: string | null;
}

/** 结果类型：把「循环依赖」这类可预期情况作为数据返回，而不是抛异常 */
export type AddResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "cycle"; cycle: string[] };

/** 批量新增前置知识的结果，附带受影响的实体，方便界面提示「新建了几个、复用了几个」 */
export interface AddPrerequisitesPayload {
  parentId: string;
  created: KnowledgeNode[];
  reused: KnowledgeNode[];
  edges: DependencyEdge[];
}

/** 被丢弃的关系，以及它改挂到的那条边（自环没有替代边） */
export interface DroppedEdgeRef {
  droppedEdgeId: string;
  /** 去重时保留的那条边；`null` 表示自环，没有任何边接手它的来源 */
  replacementEdgeId: string | null;
}

/** 合并重复节点的结果 */
export interface MergePayload {
  target: KnowledgeNode;
  removedNodeId: string;
  /** 被改接到 target 的关系 */
  movedEdges: DependencyEdge[];
  /** 因重复或自环而丢弃的关系，附带改挂目标 */
  droppedEdges: DroppedEdgeRef[];
  goalsRepointed: Goal[];
  movedResources: number;
  movedThreads: number;
}

/* ------------------------------- 扫描与问题 ------------------------------- */

/**
 * 扫描问题。
 *
 * `code` 用契约 §2 的错误码（`metadata_invalid` / `duplicate_node_id` /
 * `nested_library_boundary` / `dangling_relation` / `scan_incomplete` …），
 * 因此界面可以把「问题列表」和「错误提示」用同一套文案。
 */
export interface ScanIssue {
  code: string;
  severity: "error" | "warning" | "info";
  relativePath: string | null;
  nodeId: string | null;
  detail: string;
  /** JSON 解析失败时的位置信息，界面可以直接指到出错的地方 */
  parsePosition: string | null;
}

/** 同一 node id 出现在多个目录（用户复制文件夹导致） */
export interface DuplicateIdGroup {
  nodeId: string;
  relativePaths: string[];
}

/** 一次扫描的完整报告：节点、边、线程头、问题、重复 ID */
export interface ScanReport {
  full: boolean;
  durationMs: number;
  scannedDirs: number;
  nodes: KnowledgeNode[];
  edges: DependencyEdge[];
  goals: Goal[];
  threads: ChatThread[];
  issues: ScanIssue[];
  duplicateIds: DuplicateIdGroup[];
  /** 知识库根目录本身也是节点 */
  rootIsNode: boolean;
  /** 扫描提前中止（例如目录读不动），报告不完整 */
  truncated: boolean;
}

/** 被移除身份的节点（元数据进回收站，用户文件原位保留） */
export interface RemovedIdentity {
  nodeId: string;
  title: string;
  /** 元数据被移除时所在的相对路径 */
  relativePath: string;
  /** `.knowledgenet/trash/node-metadata/<id>/<deletedAt>` 相对于知识库根 */
  trashedRelative: string;
  deletedAt: number;
}

/* ------------------------- 彻底删除与删除前备份 ------------------------- */

/**
 * 一个节点文件夹在磁盘上占了多少。
 *
 * `fileCount` 数的是**文件夹里的一切**（含 `.meta/knowledgenet` 的元数据），
 * 因为「彻底删除」会带走的就是这些；`resourceCount` 另外给一份「用户自己的东西」，
 * 因为「备份」按钮的意义主要在那儿。
 */
export interface NodeFolderUsage {
  relativePath: string;
  fileCount: number;
  byteSize: number;
  resourceCount: number;
  resourceBytes: number;
  directoryCount: number;
  /** 文件夹里还嵌着几个下级知识点：删父文件夹会把它们一起带走，必须提醒 */
  nestedNodeCount: number;
}

/** 删除前备份到 `.knowledgenet/backups/` 的结果 */
export interface NodeBackup {
  nodeId: string;
  title: string;
  relativePath: string;
  /** 库内相对路径（`.knowledgenet/backups/<时间戳>-<名字>`） */
  backupRelativePath: string;
  /** 绝对路径：界面上要能整段复制出来 */
  backupPath: string;
  fileCount: number;
  byteSize: number;
  createdAt: number;
}

/** 「彻底删除」的结果：文件夹连同里面的文件一起从磁盘上消失了 */
export interface NodeErasure {
  nodeId: string;
  title: string;
  relativePath: string;
  deletedFiles: number;
  deletedBytes: number;
  /** 顺带清掉的回收站元数据归档数 */
  purgedArchives: number;
}

/* ------------------------------- 迁移报告 ------------------------------- */

export interface MigrationCounts {
  nodes: number;
  edges: number;
  goals: number;
  threads: number;
  messages: number;
  discoveries: number;
  bookmarks: number;
  resources: number;
  notes: number;
}

export interface MigrationReport {
  fromVersion: number;
  toVersion: number;
  /** 迁移前建立的恢复点（相对于知识库根） */
  recoveryRelative: string;
  before: MigrationCounts;
  after: MigrationCounts;
  warnings: string[];
  /** 重扫比对通过 */
  verified: boolean;
  /** `library.json.formatVersion` 已经原子更新为 2：此后 v2 文件是唯一权威来源 */
  published: boolean;
}

/* ------------------------------- 知识库生命周期 ------------------------------- */

/** `format: knowledgenet-library` 的目录容器版本 */
export const LIBRARY_FORMAT = "knowledgenet-library";
export const LIBRARY_FORMAT_VERSION = 2;

/** 打开中的知识库摘要 */
export interface LibraryInfo {
  libraryId: string;
  title: string;
  /** 人类可读的根目录绝对路径，只用于显示 */
  rootPath: string;
  readOnly: boolean;
  formatVersion: number;
  nodeCount: number;
  edgeCount: number;
  goalCount: number;
  threadCount: number;
  /** 最近一次扫描发现的问题数 */
  issueCount: number;
  createdAt: string;
  /** 最近一次扫描耗时 */
  scanDurationMs: number;
  /** 知识库根目录本身是节点 */
  rootIsNode: boolean;
}

export interface RecentLibrary {
  path: string;
  title: string;
  libraryId: string;
  lastOpenedAt: number;
  /** 记录时路径是否还能读到 library.json */
  missing: boolean;
}

/**
 * 复制知识库的两种语义。
 *
 * `snapshot`：备份快照，保留原 libraryId（这就是「回到那一刻」的备份）；
 * `independent`：另存为独立知识库，必须生成新 libraryId，否则两份独立积累的库
 * 会长期共享身份，以后再也分不清谁是谁。
 */
export type CopyMode = "snapshot" | "independent";

export interface CopyResult {
  libraryId: string;
  title: string;
  rootPath: string;
  mode: CopyMode;
  fileCount: number;
  byteLength: number;
}

/* ---------------------------------- 笔记 ---------------------------------- */

/**
 * 主文档的当前状态（权威版本在磁盘上）。
 *
 * `documentRevision` 是文档自己的修订号（不是 `node.json` 的修订号）：
 * 保存时必须带上手上那份，不匹配就返回冲突，让用户决定怎么办。
 */
export interface NodeNote {
  nodeId: string;
  /** 文档相对节点目录的路径（通常是 note.md） */
  relativePath: string;
  content: string;
  documentRevision: number;
  sha256: string;
  byteLength: number;
  modifiedAt: number;
}

export interface NoteConflict {
  /** 磁盘当前版本 */
  disk: NodeNote;
  expectedRevision: number;
  reason: "revision_mismatch" | "hash_mismatch" | "disk_missing";
  detail: string;
}

/**
 * 保存笔记的结果。
 *
 * 冲突是**正常返回**而不是异常：界面要拿到磁盘版本，让用户在
 * 「重新加载 / 覆盖保存 / 另存冲突副本」之间选择，绝不能静默覆盖。
 */
export type WriteNoteOutcome =
  | {
      status: "saved";
      note: NodeNote;
      revision: number;
      /** 「覆盖保存」时磁盘旧版本被另存的位置（相对知识库根），界面要显示出来 */
      conflictCopy: string | null;
    }
  | { status: "conflict"; conflict: NoteConflict; conflictCopy: string | null };

/** 磁盘上的主文档与登记指纹是否一致（外部编辑器改过正文） */
export interface NoteDiskState {
  nodeId: string;
  exists: boolean;
  sha256: string;
  byteLength: number;
  modifiedAt: number;
  documentRevision: number;
  changedOnDisk: boolean;
}

/* ---------------------------------- 资料 ---------------------------------- */

/** `file`：节点目录里的普通文件；`url`：外部链接；`citation`：仅文字引用 */
export type ResourceType = "file" | "url" | "citation";

/**
 * 节点资料（`resources.json` 里的一条）。
 *
 * v2 里普通文件**不需要登记就已经是用户资产**：`resources.json` 只保存
 * 展示名、说明、排序与最近一次已知哈希这些可选增强信息。
 * 因此这里没有 v1 的 `state` / `missing`：文件在不在，扫描 `listPlainFiles` 就知道。
 */
export interface NodeResource {
  id: string;
  nodeId: string;
  resourceType: ResourceType;
  /** 节点目录内的相对路径（`file` 类） */
  relativePath: string | null;
  sourceUrl: string | null;
  originalName: string;
  displayName: string;
  mimeType: string;
  byteLength: number;
  sha256: string;
  description: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface ResourcePatch {
  displayName?: string;
  description?: string;
  sortOrder?: number;
}

/** 节点目录里的一个普通文件（排除 `.meta/**` 与嵌套节点子树） */
export interface NodeFileEntry {
  /** 相对知识库根的正斜杠路径 */
  relativePath: string;
  name: string;
  byteLength: number;
  modifiedMs: number;
  isDir: boolean;
}

/* --------------------------------- 来源 --------------------------------- */

/**
 * 一条依赖关系是「怎么被发现的」。
 *
 * v2 里它写在**边所在的** `relations.json` 的 `evidence` 数组里，
 * 随源节点一起移动，不再单独存表。
 */
export interface Evidence {
  id: string;
  threadId: string | null;
  messageId: string | null;
  /** 选中文字的快照：即使原消息被删，也能解释当初为什么建这条依赖 */
  snippet: string;
  question: string;
  createdAt: number;
}

export interface EvidenceInput {
  threadId?: string | null;
  messageId?: string | null;
  snippet: string;
  question?: string;
}

/* ------------------------------- 完整性检查 ------------------------------- */

export interface IntegrityIssue {
  /** 稳定标识：修复时回传它，而不是回传路径 */
  id: string;
  /** `metadata_invalid` | `duplicate_node_id` | `dangling_relation` | `missing_note` … */
  kind: string;
  severity: "error" | "warning" | "info";
  entityType: "node" | "resource" | "library" | "file" | "edge" | "chat";
  entityId: string;
  path: string | null;
  detail: string;
  repairable: boolean;
}

export interface IntegrityCounts {
  nodes: number;
  edges: number;
  goals: number;
  resources: number;
  threads: number;
  messages: number;
  filesChecked: number;
  bytesChecked: number;
  plainFiles: number;
  issues: number;
}

export interface IntegrityReport {
  deep: boolean;
  checkedAt: number;
  revision: number;
  issues: IntegrityIssue[];
  counts: IntegrityCounts;
  /** 没有 error 级问题时为 true */
  ok: boolean;
  /** 扫描提前中止（例如文件被占用）时为 true，报告不完整 */
  truncated: boolean;
  warnings: string[];
}

/** 一项修复动作。只自动执行「意图唯一、无数据损失」的修复。 */
export interface RepairAction {
  action:
    | "create_empty_note"
    | "reassign_duplicate_id"
    | "mark_node_missing"
    | "drop_dangling_edge"
    | "drop_dangling_goal"
    | "rebuild_index";
  entityId: string;
  argument?: string | null;
}

export interface RepairOutcome {
  action: string;
  entityId: string;
  ok: boolean;
  detail: string;
}

export interface RepairReport {
  applied: RepairOutcome[];
  report: IntegrityReport;
}

/* ---------------------------------- 工具 ---------------------------------- */

export function emptySnapshot(): GraphSnapshot {
  return { revision: 0, nodes: [], edges: [], goals: [], session: null };
}

export function normalizeTitle(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/** 搜索归一化：保留中文、英文、缩写与数学符号，只做大小写与空白折叠，避免过度规范化造成错误匹配 */
export function searchKey(raw: string): string {
  return normalizeTitle(raw).toLowerCase();
}

/** ID 形状检查（UUIDv7 也是 UUID）。只做形状判断，不解释内容。 */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
