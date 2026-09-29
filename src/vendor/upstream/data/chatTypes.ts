/**
 * 对话与来源的领域模型
 *
 * 与知识图分开：对话数据量增长快、写入频繁，不应该和图的快照混在一起，
 * 否则每次流式生成都会触发整张图重新加载。
 */

/** 消息生成状态。失败、停止、被截断或未正常结束的回答不能当成完整回答。 */
export type MessageStatus =
  | "streaming"
  | "complete"
  /** 用户主动停止，保留已生成的部分 */
  | "cancelled"
  | "failed"
  /** 上游连接中断，没有收到正常结束标记：内容是半截的，但不能算失败 */
  | "incomplete";

export type ChatRole = "system" | "user" | "assistant";

/** 一条可引用的检索来源（与 `WebSearchSource` 同形，这里只做类型引用避免耦合） */
export interface ProcessSource {
  url: string;
  title?: string | null;
  snippet?: string | null;
  publishedAt?: string | null;
}

/**
 * 过程记录的一步。
 *
 * 存在的理由：一次回答不只是「一段思考 + 一段正文」。模型可能先想一轮、调用检索、
 * 拿到结果再想一轮，最后才回答——这些步骤的顺序本身就是信息（哪一步改变了结论）。
 * 把它们压成一段文字，用户就只能看到一整块推理，看不出「中间查了什么」。
 *
 * 顺序即数组顺序；`kind` 是可辨识联合的判别键，前端按它渲染不同的条目。
 */
export type ProcessStep =
  | { kind: "reasoning"; text: string }
  | {
      kind: "search";
      /** 工具调用 id，用来把 running 的步骤和后来的结果对上 */
      id: string;
      query: string;
      /** running 只存在于界面上；落盘时一定是 done 或 failed */
      status: "running" | "done" | "failed";
      sources: ProcessSource[];
      truncated: boolean;
      elapsedMs?: number | null;
      error?: string | null;
    };

/** 一个对话固定属于一个知识节点；同一节点可以有多个对话。 */
export interface ChatThread {
  id: string;
  nodeId: string;
  title: string;
  /** 长对话的压缩摘要；原始消息始终留在本地 */
  summary: string;
  createdAt: number;
  updatedAt: number;
  /**
   * 只读扫描结果：该线程有多少条消息文件。
   *
   * 扫描只读 `thread.json` 与消息目录的文件名，**不读正文**——一万条消息的库
   * 打开时不该把正文全读进来。只有真正进入某个对话才加载消息。
   */
  messageCount?: number;
  /** 只读扫描结果：所属节点目录的相对路径 */
  nodeRelativePath?: string;
  /**
   * 磁盘上 `thread.json` 的修订号（乐观并发用）。
   *
   * 保存时必须把它带回去：Rust 侧会拿它与磁盘比对，不一致就判定为「外部改动」
   * 并拒绝写入。**不要**用 0 当默认值——新建的 `thread.json` 就是 revision 1，
   * 拿 0 去比会把每一次正常保存（改标题、刷新更新时间）都判成冲突。
   */
  revision?: number;
}

export interface ChatMessage {
  id: string;
  threadId: string;
  role: ChatRole;
  content: string;
  status: MessageStatus;
  /**
   * 停止原因。`length` 表示达到 max_tokens 被截断——
   * 这种情况必须告诉使用者，否则半截回答会被当成完整内容。
   */
  finishReason?: string | null;
  /** 生成这条消息的请求 ID，用于避免流式回答写到错误的对话 */
  requestId?: string | null;
  /** API 实际返回的用量（JSON 原文） */
  usage?: string | null;
  /** 生成这条消息的模型名（写进消息文件，便于以后解释「当时是什么答的」） */
  model?: string | null;
  /**
   * 过程记录：按发生顺序记下这次回答里的思考与工具调用。
   *
   * 它随消息落盘、可在界面上回看（「当时查了什么、查到了什么」），但**不回传给模型**：
   * 官方规则只要求工具调用轮回传 `reasoning_content`，其余轮次会被忽略；
   * 推理往往比回答还长，回传只会持续放大 token 消耗。
   */
  steps?: ProcessStep[] | null;
  /**
   * 上一版留下的纯文本思考过程，**只用于读旧消息**。
   *
   * 新消息一律写 `steps`；读的时候 `steps` 为空而它有值，就把它当成一条推理步骤显示，
   * 这样上一版存下的对话不会突然看不见思考过程。
   */
  reasoning?: string | null;
  createdAt: number;
  /** 最后一次写入时间；缺省时与 `createdAt` 相同 */
  updatedAt?: number;
}

/**
 * 一条依赖关系是「怎么被发现的」。
 *
 * 同一个前置知识可能被多个节点依赖，两处卡住的原因未必相同，
 * 所以来源必须挂在依赖边上，而不是只写进目标节点的笔记。
 */
export interface Discovery {
  id: string;
  edgeId?: string | null;
  fromNodeId: string;
  toNodeId: string;
  threadId?: string | null;
  messageId?: string | null;
  /** 选中文字的快照：即使原消息被删，也能解释当初为什么建这条依赖 */
  snippet: string;
  question: string;
  createdAt: number;
}

/** 学习书签：记录「从哪来、卡在哪」，用于深入学习后返回原处。 */
export interface Bookmark {
  id: string;
  nodeId: string;
  threadId?: string | null;
  messageId?: string | null;
  scrollOffset: number;
  question: string;
  returnNodeId?: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 一次载入的对话数据 */
export interface ChatData {
  threads: ChatThread[];
  messages: ChatMessage[];
  discoveries: Discovery[];
  bookmarks: Bookmark[];
}

export function emptyChatData(): ChatData {
  return { threads: [], messages: [], discoveries: [], bookmarks: [] };
}

/**
 * 载入时归一消息状态。
 *
 * 存储里不可能真的有「正在生成」的消息：进程重启后没有任何请求在跑。
 * 生成中途崩溃、关窗或断电会留下 `streaming` 的行，若原样载入，
 * 界面上会永远显示一个转圈的光标，而且没有重试入口。这里回落成「未完成」。
 */
export function normalizeLoadedMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) =>
    m.status === "streaming" ? { ...m, status: "incomplete" as const } : m,
  );
}

/** 把选中的文字整理成节点标题：取第一行，去掉尾部标点，过长的截断 */
export function selectionToTitle(raw: string, maxLength = 40): string {
  const firstLine = raw
    .split(/\n+/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return "";
  // 以中文句末标点或英文句点断句，取第一个完整短句
  const sentence = firstLine.split(/(?<=[。！？；.!?;])/)[0] ?? firstLine;
  const cleaned = sentence
    .replace(/^[\s\-*•·>「『"'（(【\[]+/, "")
    .replace(/[\s，,。.；;：:、）)】\]"'」』]+$/, "")
    .trim();
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.slice(0, maxLength).trim();
}

/**
 * 把选中的文字作为**引用块**追加进草稿（「引用并追问」）。
 *
 * 规则只有三条，每一条都对应一种会让人恼火的坏行为：
 * - 逐行加 `> `：多行选区直接拼进去会变成一段普通的问答，看不出哪句是引用；
 * - **追加而不是覆盖**：草稿里可能已经写了半句问题，引一段话就把它吞掉是最糟的；
 *   已有内容时用空行隔开，两块互不粘连；
 * - 结尾留一个空行：光标落在那里，接着打字就是自己的追问。
 */
export function quoteForComposer(selection: string, draft = ""): string {
  const quoted = selection
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => (line.trim() === "" ? ">" : `> ${line}`))
    .join("\n");
  const block = `${quoted}\n\n`;
  const existing = draft.replace(/\s+$/, "");
  return existing ? `${existing}\n\n${block}` : block;
}
