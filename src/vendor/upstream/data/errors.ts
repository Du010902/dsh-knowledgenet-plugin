/**
 * 数据层错误
 *
 * Rust 命令统一返回 `{ code, message, detail }`：前端必须能按 `code` 分支处理，
 * 尤其是「修订冲突」「笔记冲突」「外部改动冲突」——这些都不是「保存失败」，
 * 而是「有人先改了，请你决定怎么办」，绝不能退化成一句提示就结束。
 *
 * Tauri 的 `invoke` 会用结构化错误 reject，浏览器演示端抛的是 Error，
 * 因此这里统一归一化，调用方只需要判断 `code`。
 *
 * v2 新增的错误码见契约 §2：元数据坏/版本不支持、重复 ID、外部改动、
 * 节点缺失、路径逃出知识库、嵌套知识库边界、扫描不完整。
 */

export type RepositoryErrorCode =
  | "not_open"
  | "read_only"
  | "revision_conflict"
  | "note_conflict"
  | "not_found"
  | "invalid_input"
  | "cycle"
  | "io"
  | "locked"
  | "already_open"
  | "conflict"
  | "unsupported_version"
  | "internal"
  /* ------------------------------ v2 新增（契约 §2） ------------------------------ */
  /** node.json 等 JSON 解析失败或必填字段类型错 */
  | "metadata_invalid"
  /** `format` / `formatVersion` 不是当前支持的版本 */
  | "metadata_unsupported"
  /** 同一知识库内出现相同 node id */
  | "duplicate_node_id"
  /** 磁盘文件已被外部修改（修订号或哈希不符） */
  | "external_change_conflict"
  /** 索引里的节点目录已不存在，且受限重定位也找不到 */
  | "node_missing"
  /** 解析出的规范化路径逃出知识库根目录 */
  | "node_outside_library"
  /** 触碰嵌套知识库边界 */
  | "nested_library_boundary"
  /** 扫描提前中止，报告不完整 */
  | "scan_incomplete"
  /** 浏览器演示模式不支持的能力 */
  | "unsupported_in_demo"
  /** 会话已经关闭（切库或关库之后到达的旧请求） */
  | "session_closed"
  | "unknown";

export class RepositoryError extends Error {
  readonly code: RepositoryErrorCode;
  readonly detail: unknown;

  constructor(code: RepositoryErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = "RepositoryError";
    this.code = code;
    this.detail = detail;
  }

  /** 修订号过期：需要重新载入知识图再重试 */
  get isRevisionConflict(): boolean {
    return this.code === "revision_conflict";
  }

  /** 只读知识库：所有写入口都应当被禁用，而不是等报错 */
  get isReadOnly(): boolean {
    return this.code === "read_only";
  }

  /** 磁盘上那份文件已经被别人改过：默认绝不覆盖，让用户先看清差异 */
  get isExternalChangeConflict(): boolean {
    return this.code === "external_change_conflict";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const KNOWN_CODES: ReadonlySet<string> = new Set<RepositoryErrorCode>([
  "not_open",
  "read_only",
  "revision_conflict",
  "note_conflict",
  "not_found",
  "invalid_input",
  "cycle",
  "io",
  "locked",
  "already_open",
  "conflict",
  "unsupported_version",
  "internal",
  "metadata_invalid",
  "metadata_unsupported",
  "duplicate_node_id",
  "external_change_conflict",
  "node_missing",
  "node_outside_library",
  "nested_library_boundary",
  "scan_incomplete",
  "unsupported_in_demo",
  "session_closed",
]);

/**
 * 把任意抛出物归一化成 RepositoryError。
 * Rust 抛的是 `{ code, message, detail }`；也可能被序列化成字符串。
 */
export function toRepositoryError(error: unknown): RepositoryError {
  if (error instanceof RepositoryError) return error;

  if (isRecord(error)) {
    const rawCode = typeof error.code === "string" ? error.code : "";
    const message =
      typeof error.message === "string" && error.message.length > 0
        ? error.message
        : "数据操作失败";
    const code = KNOWN_CODES.has(rawCode)
      ? (rawCode as RepositoryErrorCode)
      : ("unknown" as RepositoryErrorCode);
    return new RepositoryError(code, message, error.detail);
  }

  if (error instanceof Error) {
    return new RepositoryError("unknown", error.message);
  }

  return new RepositoryError("unknown", String(error));
}

/** 会话已经关闭：旧库的响应晚到时用它拒绝写入状态 */
export function sessionClosedError(): RepositoryError {
  return new RepositoryError("session_closed", "知识库会话已经关闭，请重新打开知识库");
}

/**
 * 磁盘文件被外部改动（修订号或哈希不符）。
 *
 * `detail` 必须带上相对路径、期望/实际修订号与哈希，界面才能给出
 * 「重新载入 / 查看差异 / 覆盖」三个明确选项，而不是只说一句「保存失败」。
 */
export function externalChangeConflict(input: {
  relativePath: string;
  expectedRevision: number;
  actualRevision: number;
  expectedHash?: string | null;
  actualHash: string;
  message?: string;
}): RepositoryError {
  return new RepositoryError(
    "external_change_conflict",
    input.message ?? `磁盘上的文件已被外部修改：${input.relativePath}`,
    {
      relativePath: input.relativePath,
      expectedRevision: input.expectedRevision,
      actualRevision: input.actualRevision,
      expectedHash: input.expectedHash ?? null,
      actualHash: input.actualHash,
    },
  );
}

/** 判断一个错误是不是「外部改动冲突」——界面据此弹出三选一，而不是覆盖 */
export function isExternalChangeConflict(error: unknown): boolean {
  return toRepositoryError(error).code === "external_change_conflict";
}
