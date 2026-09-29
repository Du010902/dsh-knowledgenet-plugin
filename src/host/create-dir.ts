/**
 * 在指定位置下新建一个文件夹（「创建知识库」的第一步）。
 *
 * 为什么不让客户端直接调 `uiWorkspace.createDirectory`：那条路失败时异常信息拿不回来，
 * 界面上只能显示"新建文件夹失败"，用户和排查都得不到原因（实测）。这里自己做，理由有两条：
 * 1. 宿主侧本来就有 fs 权限，逻辑最简单可控（`mkdir` 不带 recursive：**已存在就报错**，语义清楚）；
 * 2. 能把**具体原因**（名字非法 / 已存在 / 父目录不存在 / 权限）原样带回界面。
 *
 * 安全边界：只新建一层目录；名字里不允许路径分隔符与 Windows 保留字符；父目录必须已存在。
 */
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** 结果 */
export interface CreateDirectoryResult {
  ok: boolean;
  /** 新建出来的绝对路径 */
  path?: string;
  error?: { code: string; message: string };
}

/** Windows 保留字符 + 路径分隔符都不允许出现在新目录名里 */
const INVALID_NAME = /[\\/:*?"<>|]/;

/**
 * 新建子目录。
 * @param input.parent - 父目录（必须已存在）。
 * @param input.name - 新目录名。
 * @returns 成功时给出新路径；失败给出可读原因。
 */
export async function createSubdirectory(input: { parent: string; name: string }): Promise<CreateDirectoryResult> {
  const parent = typeof input.parent === "string" ? input.parent.trim() : "";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (parent === "") return { ok: false, error: { code: "parent_required", message: "请先选择位置" } };
  if (name === "") return { ok: false, error: { code: "name_required", message: "请填写知识库名称" } };
  if (INVALID_NAME.test(name)) {
    return { ok: false, error: { code: "name_invalid", message: "名字里不能包含 \\ / : * ? \" < > |" } };
  }
  const parentOk = await stat(parent).then((info) => info.isDirectory()).catch(() => false);
  if (!parentOk) return { ok: false, error: { code: "parent_missing", message: `位置不存在或不是文件夹：${parent}` } };

  const target = join(parent, name);
  const exists = await stat(target).then(() => true).catch(() => false);
  if (exists) return { ok: false, error: { code: "exists", message: `已经有同名文件夹了：${target}` } };

  try {
    await mkdir(target);
    return { ok: true, path: target };
  } catch (error) {
    return {
      ok: false,
      error: { code: "mkdir_failed", message: error instanceof Error ? error.message : String(error) },
    };
  }
}
