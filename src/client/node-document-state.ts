/**
 * 节点笔记编辑器的**纯状态与文案**（不含 JSX，可直接单测 ✓）。
 *
 * 这里集中处理 `design/node-document-editor-review.md` 指出的草稿保护问题：
 * 1. **载入不覆盖脏草稿**（父组件重渲染 / 显式重载都不许丢输入 ✗）；
 * 2. 「查看最新正文」**只展开比较区**，绝不替换草稿 ✗；替换必须走显式的"放弃草稿" ✓；
 * 3. 冲突时可以"**已合并，基于最新版本保存**"（保留 draft、换基线再保存 ✓）；
 * 4. **载入失败**与**保存失败**分开：已载入的草稿始终在、可继续编辑、可重试保存 ✓；
 * 5. 没有指纹的文档**不可编辑**（保存会拒绝 ✗）；
 * 6. 草稿按"库身份 + nodeId"缓存，面板卸载/切目标后可恢复，且不串库 ✓。
 */
import type { NodeDocument } from "./node-document-client.ts";

/** 编辑器文案（宿主 locale 缺席时的回落；正式文案在中英词典里 ✓） */
export const EDITOR_LITERAL: Record<string, string> = {
  notePanelTitle: "节点笔记",
  closeEditor: "关闭编辑区",
  details: "详情",
  detailPath: "路径",
  detailRevision: "修订",
  detailShortcut: "快捷键",
  tabRich: "正文",
  richLoading: "正在准备正文编辑器…",
  richFailed: "正文编辑器初始化失败：请切到「源码」继续编辑或复制内容（此时不会保存 ✗）",
  unsupportedNotice: "这份正文含有正文编辑器无法原样保留的语法，已停在「源码」模式（原文一字不动 ✓）",
  /* 换行标签 <br> 是支持写法 ✓（实测可逐字往返 ✓），不进这条提示 ✓ */
  unsupportedRisk: "在「正文」模式下编辑并保存，可能会改写上面这些语法 ✗",
  openRichAnyway: "仍要用正文模式打开",
  tabSource: "源码",
  tabEdit: "编辑",
  tabPreview: "预览",
  editorHint: "支持 Markdown · 正文直接保存到这个节点的文档",
  previewSimplified: "简化预览：只把 `## ` 行显示为小标题，其余按纯文本显示",
  statusSaved: "已保存",
  statusDirty: "有未保存修改",
  statusConflict: "草稿未保存 · 文件有更新",
  statusSaving: "正在保存…",
  statusSaveFailed: "保存失败 · 草稿仍在",
  saveNote: "保存笔记",
  saveShortcut: "Ctrl / ⌘ + S 保存",
  conflictNotice: "文件在外部发生了变化，你的草稿仍保留。请先比较最新正文，再决定如何合并。",
  compareLatest: "查看最新正文",
  hideLatest: "收起最新正文",
  latestText: "最新正文",
  adoptLatest: "放弃草稿，使用最新正文",
  adoptLatestConfirmTitle: "放弃草稿？",
  adoptLatestConfirmMessage: "将用磁盘上的最新正文替换你未保存的草稿，此操作不可撤销。",
  mergeAndSave: "已合并，基于最新版本保存",
  refreshBaseline: "刷新冲突基线",
  mergeFailed: "刷新最新正文失败，草稿仍在",
  loadingDocument: "正在读取正文…",
  loadFailed: "读取正文失败",
  retryLoad: "重试读取",
  saveFailed: "保存失败",
  retrySave: "重试保存",
  saveDone: "笔记已保存",
  copyDraft: "复制草稿",
  copied: "草稿已复制到剪贴板",
  copyFailed: "复制失败，请手动选中内容复制",
  refreshingLatest: "正在读取最新正文…",
  mergeNeedsReview: "已读到最新正文，请先查看再点「已合并，基于最新版本保存」",
  copied: "草稿已复制到剪贴板",
  nodeMissing: "这个节点已经不在库里了（草稿保留，可复制走）",
  tooLarge: "正文太大，面板编辑器不处理这么大的文档",
  unsupportedFormat: "这个知识库是旧格式（只读兼容），面板里不能编辑正文",
  libraryUnavailable: "找不到知识库",
  missingFingerprint: "这份文档没有可用的版本指纹，出于安全不能编辑",
  leaveTitle: "有尚未保存的笔记",
  leaveMessage: "先保存当前内容，再继续查看其他节点。",
  leaveStay: "继续编辑",
  leaveDiscard: "放弃修改",
  leaveSave: "保存并继续",
  emptyDocument: "（这个节点还没有正文，直接写就行）",
};

/** 编辑器状态 */
export interface EditorState {
  /** `loading` 首次读取中；`ready` 可编辑；`loadError` 读不到（草稿仍在 ✓） */
  phase: "loading" | "ready" | "loadError";
  /** 当前文档身份（保存时若被"采用"成新 ULID，会在这里更新 ✓） */
  nodeId: string;
  /** 手上这份草稿 */
  draft: string;
  /** 基线：磁盘上那份的正文 ✓ */
  base: string;
  /** 基线对应的**整文件指纹**（保存时必带 ✓） */
  hash: string;
  revision: number;
  path: string;
  title: string;
  /** 磁盘被外部改过（等用户决定 ✓） */
  conflicted: boolean;
  /** 冲突时宿主带回的最新正文 ✓ */
  latest: NodeDocument | null;
  /** 比较区是否展开（"查看最新正文"只动它 ✓） */
  comparing: boolean;
  saving: boolean;
  /** 保存期间的输入被冻结（避免"保存并继续"时新字随卸载丢失 ✓） */
  frozen: boolean;
  /** 保存失败原因（与载入失败分开 ✓；**保留具体 code** ⇒ 界面显示具体原因而不是笼统"保存失败" ✓） */
  saveErrorKey: string | null;
  /** 载入失败原因 */
  loadErrorKey: string | null;
  /** 正在重新读取「最新正文」（冲突比较用 ✓）：期间禁止重复刷新与依赖它的操作 ✓ */
  refreshing: boolean;
}

/** 初始状态（首次载入中 ✓） */
export function initialEditorState(nodeId = ""): EditorState {
  return {
    phase: "loading",
    nodeId,
    draft: "",
    base: "",
    hash: "",
    revision: 0,
    path: "",
    title: "",
    conflicted: false,
    latest: null,
    comparing: false,
    saving: false,
    frozen: false,
    saveErrorKey: null,
    loadErrorKey: null,
    refreshing: false,
  };
}

/** 编辑器动作 */
export type EditorAction =
  | { type: "load-start" }
  | { type: "load-ok"; document: NodeDocument }
  | { type: "load-failed"; key: string }
  /** 载入前先塞一份**恢复的草稿**（面板卸载后重开 ✓） */
  | { type: "restore-draft"; draft: string; base: string; hash: string }
  | { type: "edit"; text: string }
  | { type: "save-start" }
  /** `submitted` = 这次提交上去的文本（把宿主规范化后的正文同步回草稿要用 ✓） */
  | { type: "save-ok"; document: NodeDocument; submitted: string }
  | { type: "save-conflict"; latest: NodeDocument | null }
  | { type: "save-failed"; key: string }
  /** 冲突比较用的重新读取：开始 / 成功 / 失败 ✓ */
  | { type: "conflict-refresh-start" }
  | { type: "conflict-refresh-ok"; latest: NodeDocument }
  | { type: "conflict-refresh-failed"; key: string }
  | { type: "toggle-compare" }
  | { type: "adopt-latest" }
  | { type: "merge-and-save" };

/** 有未保存修改？ */
export function isDirty(state: EditorState): boolean {
  return state.draft !== state.base;
}

/**
 * 能保存？（复查要求：**载入完成 + 有指纹 + 不冲突 + 不在保存中** ✓）
 *
 * 少了"载入完成"这一条，重新读取的窗口里会拿旧基线提交 ✗；
 * 少了"有指纹"这一条，会发出一条宿主必然拒绝的请求 ✗。
 */
export function canSave(state: EditorState): boolean {
  return state.phase === "ready"
    && state.hash !== ""
    && isDirty(state)
    && !state.conflicted
    && !state.saving
    && state.saveErrorKey === null;
}

/** 状态文字（对应设计稿底部那行 ✓） */
export function statusText(state: EditorState, t: (key: string) => string): string {
  if (state.saving) return t("statusSaving");
  if (state.conflicted) return t("statusConflict");
  if (state.saveErrorKey !== null) return t("statusSaveFailed");
  return isDirty(state) ? t("statusDirty") : t("statusSaved");
}

/** 失败 code → 文案 key（宿主给的稳定 code ✓） */
export function failureKey(code: string): string {
  if (code === "node_missing") return "nodeMissing";
  if (code === "too_large") return "tooLarge";
  if (code === "unsupported_format") return "unsupportedFormat";
  if (code === "library_unavailable") return "libraryUnavailable";
  if (code === "bad_body") return "missingFingerprint";
  return "loadFailed";
}

/**
 * 正文的安全预览：**只按纯文本切段**，`## ` 起小标题 ✓。
 * 不解析 HTML、不注入脚本、不渲染链接标记 ✗（设计稿要求的"安全渲染" ✓）。
 */
export function previewBlocks(text: string): Array<{ heading: boolean; text: string }> {
  if (text === "") return [{ heading: false, text: EDITOR_LITERAL.emptyDocument }];
  return text.split("\n").map((line) => {
    const heading = line.startsWith("## ");
    return { heading, text: heading ? line.slice(3) : line };
  });
}

/** 一份文档能不能拿来编辑（**必须有指纹** ✗：没指纹就保护不了外部修改 ✓） */
export function documentEditable(document: NodeDocument): boolean {
  return document.hash !== "";
}

/**
 * 状态机。
 *
 * 最要紧的两条不变量：
 * - **载入永远不覆盖脏草稿** ✗：dirty 时载入成功只更新"比较基线+最新正文"，把状态标成冲突 ✓；
 * - **只有显式的 `adopt-latest` 才能替换草稿** ✗（"查看"只 `toggle-compare` ✓）。
 */
export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "load-start":
      return { ...state, phase: "loading", loadErrorKey: null };
    case "restore-draft":
      /*
       * 恢复草稿时必须**连基线一起恢复** ✗（复查 P2-2）：
       * 只恢复文字的话，重开时无法区分"磁盘没变（继续编辑）"与"磁盘变了（真冲突）" ✓。
       */
      return { ...state, draft: action.draft, base: action.base, hash: action.hash };
    case "load-ok": {
      const document = action.document;
      if (!documentEditable(document)) {
        /* 没指纹 ⇒ 明确不可编辑（不假装能存 ✓）；草稿若在也不动 ✗ */
        return { ...state, phase: "loadError", loadErrorKey: "missingFingerprint" };
      }
      const common = {
        phase: "ready" as const,
        nodeId: document.nodeId,
        revision: document.revision,
        path: document.path,
        title: document.title,
        loadErrorKey: null,
      };
      /* 手上还有没保存的内容 ⇒ **不覆盖** ✗（复查 P2-2：先分清三种情况，别一律判冲突 ✓） */
      if (state.draft !== state.base || state.conflicted) {
        /* ① 磁盘没变（指纹还是手上这份）⇒ 只是继续编辑，不是冲突 ✓ */
        if (state.hash !== "" && state.hash === document.hash) {
          return { ...state, ...common, conflicted: false, latest: null, comparing: false };
        }
        /* ② 草稿与磁盘其实一样 ⇒ 已经干净了，不该要求合并 ✓ */
        if (state.draft === document.text) {
          return {
            ...state,
            ...common,
            base: document.text,
            hash: document.hash,
            conflicted: false,
            latest: null,
            comparing: false,
          };
        }
        /* ③ 磁盘真的变了 ⇒ 冲突（草稿保留 ✓，把最新正文摊出来 ✓） */
        return {
          ...state,
          ...common,
          latest: document,
          conflicted: true,
          comparing: true,
        };
      }
      return {
        ...state,
        ...common,
        draft: document.text,
        base: document.text,
        hash: document.hash,
        conflicted: false,
        latest: null,
        comparing: false,
      };
    }
    case "load-failed":
      return { ...state, phase: "loadError", loadErrorKey: action.key };
    case "edit":
      /* 保存中 / 冻结时忽略输入 ✓（否则"保存并继续"会丢掉这几个字 ✗） */
      if (state.frozen || state.saving) return state;
      return { ...state, draft: action.text, saveErrorKey: null };
    case "save-start":
      /*
       * 保存**接管**在飞的「最新正文」读取 ✓：那个读取的编号已被作废（响应不会再改状态 ✓），
       * 这里同时把 `refreshing` 清掉 ✗ —— 否则它会一直停在 true（复查 P2-1 ✓）：
       * 合并按钮永远禁用、状态机也不自洽 ✓。
       */
      return { ...state, saving: true, frozen: true, refreshing: false, saveErrorKey: null };
    case "save-ok": {
      const document = action.document;
      /*
       * 宿主会把正文**规范化**（去掉前导空行与尾部空白 ✓）之后再落盘，
       * 并且把那份规范化正文回带给我们 ✓ ⇒ 如果草稿自提交之后没再变过，
       * 就把 **draft 也同步成规范化正文** ✓ —— 否则草稿与基线永远不相等，
       * 界面会一直显示"有未保存修改"，而且再点保存也消不掉 ✗（复查 P2-5）。
       * 若用户在保存期间又敲了字（正常被冻结 ✓），那些字一律保留 ✓。
       */
      const draft = state.draft === action.submitted ? document.text : state.draft;
      return {
        ...state,
        draft,
        saving: false,
        frozen: false,
        /* 成功分支也要明确清掉 ✓（复查 P2-1：只作废异步响应、留着"进行中"标记是不完整的 ✓） */
        refreshing: false,
        nodeId: document.nodeId,
        base: document.text,
        hash: document.hash,
        revision: document.revision,
        path: document.path,
        title: document.title,
        conflicted: false,
        latest: null,
        comparing: false,
        saveErrorKey: null,
      };
    }
    case "save-conflict":
      return {
        ...state,
        saving: false,
        frozen: false,
        refreshing: false,
        conflicted: true,
        comparing: true,
        latest: action.latest,
      };
    case "save-failed":
      /* 保存失败：草稿必须还在、还能改、还能重试 ✓；错误 key 保留具体 code ✓ */
      return { ...state, saving: false, frozen: false, refreshing: false, saveErrorKey: action.key };
    case "conflict-refresh-start":
      return { ...state, refreshing: true, saveErrorKey: null };
    case "conflict-refresh-ok":
      /*
       * 只更新"最新正文"与比较区 ✓ —— **绝不**在这里动草稿、也不是"可以覆盖了"的许可 ✗
       * （复查 P1-1：取得 latest 之后必须由用户再独立确认一次才允许写入 ✓）。
       */
      return {
        ...state,
        refreshing: false,
        conflicted: true,
        comparing: true,
        latest: action.latest,
        saveErrorKey: null,
      };
    case "conflict-refresh-failed":
      /* 读不到最新正文：草稿保持、不许写文件 ✓；给一个可见的失败提示 ✓ */
      return { ...state, refreshing: false, saveErrorKey: action.key };
    case "toggle-compare":
      return { ...state, comparing: !state.comparing };
    case "adopt-latest": {
      /* 只有这里（用户在确认框里点过 ✓）才允许替换草稿 ✗ */
      if (state.latest === null) return state;
      return {
        ...state,
        draft: state.latest.text,
        base: state.latest.text,
        hash: state.latest.hash,
        revision: state.latest.revision,
        conflicted: false,
        comparing: false,
      };
    }
    case "merge-and-save": {
      /*
       * 用户说"我合并好了" ⇒ 换基线（**已经看过的那份**最新正文与指纹 ✓），保留 draft ✓，
       * 随即由组件发起保存 ✓。
       * `latest === null` 时**什么都不做** ✗ —— 组件必须先刷新、让用户看过、再独立确认 ✓
       * （复查 P1-1：不能拿"刚从磁盘读到但用户没看过"的版本当基线覆盖 ✗）。
       */
      if (state.latest === null) return state;
      return {
        ...state,
        base: state.latest.text,
        hash: state.latest.hash,
        revision: state.latest.revision,
        conflicted: false,
        comparing: false,
      };
    }
    default:
      return state;
  }
}

/* --------------------- 不支持语法：默认留在源码模式 --------------------- */

/**
 * 富编辑器（Milkdown/Crepe 的 commonmark + GFM + LaTeX）**不能完整往返**的语法特征 ✓。
 *
 * 复查 P1-4：随便把任意 Markdown 送进富编辑器，只要用户动一个普通段落，
 * 整篇就会由 `getMarkdown()` 重新序列化 ⇒ 原始 HTML、自定义指令、脚注、注释这些
 * 可能被规范化甚至丢掉 ✗。所以进富模式之前先**嗅探**，命中就默认停在源码模式 ✓
 * （源码模式是同一份草稿的另一种编辑方式 ✓，原文一字不动 ✓）。
 *
 * 只做**保守**判断：宁可多留在源码模式，也不要有损改写 ✗。
 *
 * ## 实测（Crepe 7.22.2 + 本插件同一套内联 CSS，真实浏览器探针 ✓）
 *
 * | 样本 | 无操作往返 | 编辑别的段落后 |
 * | --- | --- | --- |
 * | 表格 + 行内/独立公式 + 代码块 | 列表标记 `-`→`*`、表头分隔 `---`→`-`（**语义不变** ✓） | 关键片段都在 ✓ |
 * | 块级 HTML `<div …>` | 完全一致 ✓ | 原样保留 ✓ |
 * | `:::note` 指令 | 完全一致 ✓ | 原样保留 ✓ |
 * | 脚注 `[^1]:` | 完全一致 ✓ | 原样保留 ✓ |
 * | **引用式链接定义** | **被改写** ✗（定义行内联进正文 ✓） | 链接地址仍在，**原文形式变了** ✗ |
 * | HTML 注释 | 完全一致 ✓ | 原样保留 ✓ |
 * | `$100` 货币 | 完全一致 ✓ | 未受影响 ✓ |
 *
 * ⇒ 结论：这一版 Crepe 对 HTML / 指令 / 脚注其实能原样保留 ✓，
 * 但**引用式链接定义会被规范化** ✗、列表与表格分隔行也会被改写 ✓；
 * 而这些"能保留"是**实现现状**、不是库的契约 ✗ ⇒ 仍然按保守口径处理：
 * 命中就默认停在源码模式 ✓，并给一个"仍要用正文模式打开"的明确出口 ✓
 * （用户自己承担改写风险，比我们替他决定安全 ✗）。
 */
export interface UnsupportedScan {
  /** 命中的特征（用于给用户一句可读的说明 ✓） */
  reasons: string[];
}

/**
 * 扫描一份 Markdown 里"富编辑器可能无法原样保留"的语法。
 * @param markdown - 节点正文。
 * @returns 命中的特征清单（空 = 可以安全进富模式 ✓）。
 */
export function scanUnsupportedSyntax(markdown: string): UnsupportedScan {
  /*
   * **先把代码与公式挖掉再扫** ✗（第二次复查 P2-3）：正则会（错误地）把
   * 围栏/行内代码里的 HTML、公式里的花括号当成"文档扩展" ⇒ 无理由地把文档锁在源码模式 ✗。
   * 只对**普通 Markdown 上下文**做判断 ✓。
   */
  const stripped = markdown
    .replace(/```[\s\S]*?```/g, "\n")
    .replace(/~~~[\s\S]*?~~~/g, "\n")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/(?<!\\)\$[^$\n]*\$/g, " ");
  const reasons: string[] = [];
  /*
   * **```latex 围栏会被渲染成公式** ✗（`design/math-editor-ui-design.md` 的"数据语义必须区分" ✓）：
   * Crepe 的 latex 特性扩展的是 **codeBlockSchema** ✓ ⇒ language=latex 的代码块
   * 会被序列化成数学节点 ✓ ⇒ 用户真想记录一段 LaTeX 源码示例时会被当成公式 ✗。
   * 这个判断必须在**挖掉代码块之前**做 ✓（下面 `stripped` 已经把围栏删了 ✓）。
   */
  if (/^\s*```+\s*latex\b/im.test(markdown)) {
    reasons.push("LaTeX 围栏代码（会被渲染成公式）");
  }
  const test = (pattern: RegExp, reason: string): void => {
    if (pattern.test(stripped) && !reasons.includes(reason)) reasons.push(reason);
  };
  /*
   * **安全换行标签先摘掉，再判 HTML** ✓。
   *
   * 为什么可以放行 ✗ —— 实测（Crepe 7.22.2 + 本插件同一套内联 CSS，真实浏览器往返探针 ✓）：
   * 行内 `<br />`、`<br>`、`<br/>`、`<BR />`、连续多个、独立成行、引用里、表格单元格里、
   * 代码块/行内代码里的**字面量**、以及与其他 HTML 混排 ——
   * **无操作打开**与**编辑别的段落后**都**逐字保留** ✓（只有表格单元格会顺带做对齐填充 ✓）。
   * ⇒ 它们是可保真的常用写法 ✓，不该让整篇退回源码 ✗（截图里正是被它触发的 ✗）。
   *
   * 这正是文档要求的顺序 ✓：**先验证往返、再放宽规则** ✓；
   * 不放行任意 HTML ✗，也不对正文做全局字符串替换 ✗（编辑器自己原样保留 ✓）。
   */
  const textWithoutBreaks = stripped.replace(/<br\s*\/?>/gi, " ");
  /* HTML 注释与"非 br"的标签 ✗ */
  if (/<!--[\s\S]*?-->/.test(textWithoutBreaks) || /<\/?[A-Za-z][A-Za-z0-9-]*(\s[^>\n]*)?\/?>/.test(textWithoutBreaks)) {
    reasons.push("原始 HTML 标签");
  }
  /* 指令 / MDX 容器：`:::note`、`::youtube`、MDX 注释写法之类 ✗ */
  test(/^\s*:::{1,3}/m, "自定义指令（:::）");
  test(/^\s*\{/m, "模板 / MDX 语法");
  /* 脚注定义与引用 ✗ */
  test(/^\[\^[^\]]+\]:/m, "脚注定义");
  test(/\[\^[^\]]+\](?!:)/, "脚注引用");
  /* 引用式链接定义（往返形式会变 ✗） */
  test(/^\s*\[[^\]]+\]:\s+\S+/m, "引用式链接定义");
  /* LaTeX 宏定义：KaTeX 子集之外，序列化未必保留 ✗ */
  test(/^\s*\\newcommand/m, "LaTeX 宏定义");
  /*
   * **刻意不判 `---`** ✗（第三次复查 P2-2）：正文里的 `---` 是标准**水平分隔线** ✓
   * （也可以是 Setext 标题的下划线 ✓），而 front-matter 早被宿主分离走了 ✓ ——
   * 把它当"额外元数据"会让普通文档被无理由锁进源码模式 ✗，
   * 用户编辑时插入一条分隔线更会被突然踢出正文界面 ✗。
   */
  return { reasons };
}

/** 这份文档能不能安全进富模式？ */
export function canOpenRich(markdown: string): boolean {
  return scanUnsupportedSyntax(markdown).reasons.length === 0;
}

/* ------------------------------ 草稿缓存 ------------------------------ */

/** 一条草稿记录：**必须连基线一起存** ✗，否则重开时分不清"磁盘没变/磁盘变了/其实干净" ✓ */
export interface DraftRecord {
  draft: string;
  base: string;
  hash: string;
}

/**
 * **已挂载之外的**草稿缓存：面板卸载、切会话、切到别的节点后仍在 ✓。
 *
 * 键是"库身份 + nodeId"⇒ 不同库里的同名节点不会串 ✗（复查 P1-6 ✓）。
 * 只保存在内存里，进程结束即消失（首版口径 ✓）；有上限，避免无限增长 ✓。
 *
 * ⚠️ **空正文也是有效草稿** ✗：`draft === ""` 表示"用户把正文删光了"，
 * 与"没有记录"是两件事 —— 所以这里存的是**记录对象**，
 * 而不是"空字符串就删表"（那会把删除操作弄丢 ✗，复查 P1-1）。
 */
const drafts = new Map<string, DraftRecord>();
const DRAFT_LIMIT = 40;

/** 拼草稿键（库身份用面板给的稳定 key ✓） */
export function draftKey(libraryKey: string, nodeId: string): string {
  return `${libraryKey}::${nodeId}`;
}

/** 记一份草稿（**只在真有未保存内容时调用** ✓；空正文同样要记 ✓） */
export function rememberDraft(key: string, record: DraftRecord): void {
  drafts.delete(key);
  drafts.set(key, { draft: record.draft, base: record.base, hash: record.hash });
  while (drafts.size > DRAFT_LIMIT) {
    const oldest = drafts.keys().next();
    if (oldest.done === true) break;
    drafts.delete(oldest.value);
  }
}

/** 取回草稿记录（没有 ⇒ undefined ✓） */
export function recallDraft(key: string): DraftRecord | undefined {
  const record = drafts.get(key);
  return record === undefined ? undefined : { ...record };
}

/** 忘掉草稿（关闭编辑器并选择放弃、或保存成功、或身份被采用时迁移 ✓） */
export function forgetDraft(key: string): void {
  drafts.delete(key);
}

/**
 * 身份被"采用"（adopted-* → 正式 ULID）后把草稿搬到新键，并**删掉旧键** ✓
 * （复查 P2-4：不要"复制后保留"，否则旧身份下次又冒出来 ✗）。
 * @returns 是否搬过 ✓。
 */
export function migrateDraft(libraryKey: string, fromNodeId: string, toNodeId: string): boolean {
  if (fromNodeId === toNodeId) return false;
  const from = draftKey(libraryKey, fromNodeId);
  const record = drafts.get(from);
  if (record === undefined) return false;
  drafts.delete(from);
  rememberDraft(draftKey(libraryKey, toNodeId), record);
  return true;
}

/** 清空缓存（测试用 ✓） */
export function clearDraftCache(): void {
  drafts.clear();
}

/* ------------------------------ 保存互斥 ------------------------------ */

/**
 * **同步的**保存互斥门（复查 P2-6）。
 *
 * 为什么不能用 abort 代替互斥 ✗：`AbortController` 只取消**客户端**这一个请求，
 * 宿主可能已经在写盘了 ⇒ 重复点击会发出多次写入，第二次还可能收到第一次造成的冲突 ✗。
 * 所以在"发请求之前"用同步标志挡住 ✓；这个门不涉及 React 状态，闭包/并发下都可靠 ✓。
 */
export interface SaveGate {
  /** 尝试进入；已经在保存中 ⇒ false（调用方直接返回，不发请求 ✓） */
  tryEnter(): boolean;
  /** 结束（成功、冲突、失败、异常都要调 ✓） */
  exit(): void;
  /** 当前是否在保存中 */
  readonly busy: boolean;
}

/** 造一个保存互斥门 ✓ */
export function createSaveGate(): SaveGate {
  let busy = false;
  return {
    tryEnter(): boolean {
      if (busy) return false;
      busy = true;
      return true;
    },
    exit(): void {
      busy = false;
    },
    get busy(): boolean {
      return busy;
    },
  };
}

/**
 * **「最新正文」读取的守卫**（复查 P2-3）。
 *
 * 冲突比较可能连续读好几次（刷新、合并前刷新、放弃前刷新 ✓）。它们各自延迟不同，
 * 晚到的旧响应**不许**覆盖较新的 `latest`，也不许在保存成功之后又把界面拉回冲突态 ✗。
 * 用法：每次读取前 `const token = guard.next()` ✓，回来时 `guard.isCurrent(token)` 才允许写状态 ✓；
 * 保存开始/成功时 `guard.invalidate()` ✓ 让在飞的比较读取作废 ✓。
 */
export interface LatestGuard {
  /** 开始一次读取：返回本次的编号，并使之前所有读取作废 ✓ */
  next(): number;
  /** 这次读取还是最新的吗？ */
  isCurrent(token: number): boolean;
  /** 作废所有在飞的读取 ✓（保存开始/成功、组件卸载时调用 ✓） */
  invalidate(): void;
}

/** 造一个「最新正文」读取守卫 ✓ */
export function createLatestGuard(): LatestGuard {
  let current = 0;
  return {
    next(): number {
      current += 1;
      return current;
    },
    isCurrent(token: number): boolean {
      return token === current;
    },
    invalidate(): void {
      current += 1;
    },
  };
}
