/**
 * 笔记标题栏的「在资源管理器中显示」按钮（用户 2026-10-29 要求 ✓）。
 *
 * 行为与边界（2026-10-29 复查后定稿）：
 * - **节点已知就渲染**（编辑器本来就是按节点打开的 ✓）：不做"先探测宿主能力再决定显不显示" ✗
 *   —— 探测失败/挂起时用户只会看到"什么都没有"（本次实测就卡在这里 ✓）。
 * - 点击发一条同源请求给插件宿主（`reveal-note` ✓），由宿主：
 *   ① 按 nodeId 解析**当前 md 的实际路径** ✓；② 交给 DSH 的
 *   `sessionController.openWorkspacePath({ action: "reveal" })` 在原生文件管理器中定位 ✓
 *   （Windows `explorer /select,` 选中文件、macOS `open -R`、Linux 打开所在目录 ✓）。
 * - 失败给一句本地化提示（`role="alert"` ✓），宿主原因进 `title` ✓；不静默失败 ✗。
 * - 成功/失败都上报插件诊断（`kn_status` 的 `clientDiag`，`area: "reveal"` ✓）。
 * - 只**定位**，不打开/不修改文档 ✗。
 *
 * 为什么客户端不直接调 Session Remote ✗：编译型插件的客户端半拿不到 `ctx.remote`
 * （实机诊断 `reason: "no-remote"` ✓），所以这条能力必须由宿主半代转 ✓（见 `reveal-note.ts` 顶部）。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FolderOpenIcon } from "./PanelIcon.tsx";
import { makeTranslator } from "./card-model.ts";
import type { DocumentTarget, FetchLike } from "./node-document-client.ts";
import { reportRevealDiag, revealNoteInFileManager } from "./reveal-note.ts";

/**
 * 本地化兜底 ✓（宿主 t / 插件绑定都拿不到时用它 ✓；中英词典里也有同样的键 ✓）。
 * 文案与 DSH 自带的「显示文件位置」同一语义，但用户原话是"在资源管理器中查看"，这里说得更直白 ✓。
 */
const LITERAL: Record<string, string> = {
  revealInExplorer: "在资源管理器中显示",
  revealFailed: "无法在资源管理器中显示",
};

/** 真实运行用同源 fetch；测试/E2E 注入 `fetcher` 替身 ✓ */
function sameOriginFetcher(input: string, init?: RequestInit): Promise<{ json(): Promise<unknown> }> {
  return fetch(input, init);
}

/**
 * 「在资源管理器中显示当前笔记」按钮。
 * @param props.nodeId - 当前节点 id ✓（宿主据此解析实际 md 路径 ✓）。
 * @param props.target - 库目标（root 或 sessionId ✓）。
 * @param props.t - 宿主 / 插件翻译函数（可选 ✓）。
 * @param props.fetcher - fetch 注入点（编辑器把测试替身透下来 ✓）。
 * @returns 按钮（节点 id 为空时返回 null ✓）。
 */
export function RevealInFileManager(props: {
  nodeId: string;
  target?: DocumentTarget | undefined;
  t?: unknown;
  fetcher?: FetchLike | undefined;
}): ReactNode {
  const t = useMemo(() => makeTranslator(props.t, LITERAL), [props.t]);
  const identity = `${props.nodeId}\u0000${props.target?.root ?? ""}\u0000${props.target?.sessionId ?? ""}`;
  const current = useRef(identity);
  current.current = identity;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** 失败原因（宿主原文）只给 `title` ✓：界面上显示本地化的一句话就够了 ✓ */
  const [detail, setDetail] = useState("");

  /* 换节点/换库时清掉上一条错误 ✓ */
  useEffect(() => { setError(""); setDetail(""); setBusy(false); }, [identity]);

  const run = async (): Promise<void> => {
    if (busy) return;
    setBusy(true); setError(""); setDetail("");
    try {
      const outcome = await revealNoteInFileManager({
        fetcher: props.fetcher ?? sameOriginFetcher,
        nodeId: props.nodeId,
        target: props.target,
      });
      /* 迟到的结果不许落到另一份文档的提示上 ✓ */
      if (current.current !== identity) return;
      if (outcome.ok) {
        reportRevealDiag({ outcome: "revealed" });
        return;
      }
      setError(t("revealFailed"));
      setDetail(outcome.message);
      reportRevealDiag({ outcome: "failed", code: outcome.code, message: outcome.message.slice(0, 180) });
    } finally {
      setBusy(false);
    }
  };

  if (props.nodeId.trim() === "") return null;
  return (
    <span className="kn-reveal-control">
      <button
        type="button"
        className="kn-editor-reveal"
        aria-label={t("revealInExplorer")}
        title={t("revealInExplorer")}
        disabled={busy}
        onClick={() => { void run(); }}
      >
        <FolderOpenIcon size={15} />
      </button>
      {error === "" ? null : <span role="alert" className="kn-editor-error" title={detail === "" ? undefined : detail}>{error}</span>}
    </span>
  );
}
