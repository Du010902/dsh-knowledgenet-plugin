/**
 * 左侧栏的两处注册：
 * （旧模型下的字形与「添加知识库」按钮已退休：新模型里任何工作区都能用「知识库图谱」，）

 * 只需要给聊天划词挂一条浮动条（`ChatSelectionBar`）。
 *
 * 两者都不占可见格子；组件挂载在 `sidebar.footer.action`（root 作用域、始终挂载）。
 */
import { GRAPH_API_ROUTE } from "../shared/routes.ts";
import { createElement } from "react";

import { ChatSelectionBar } from "./ChatSelectionBar.tsx";
import { reportDiag } from "./diag.ts";




export { BADGES_ID, BADGES_ORDER, badgesOptions } from "./badges-options.ts";

interface SlotsFace {
  inject(key: string, callback: () => unknown): unknown;
  register(options: Record<string, unknown>, component: unknown): unknown;
}

/** 只取用到的方法，避免依赖 ui-workspace / workspace-controller 的类型声明 */
interface SidebarServices {
  get?(name: string): unknown;
  uiWorkspace?: { pickDirectory?(): Promise<string | null>; createDirectory?(path: string, name: string): Promise<string>; startSession?(workspaceId: string): void };
  workspaces?: { create?(input: { path: string }): Promise<{ workspaceId?: string }> };
}

function reportFailure(topic: string, error: unknown): void {
  try {
    console.error(`[KnowledgeNet] ${topic}：${error instanceof Error ? error.message : String(error)}`);
  } catch {
    // 没有 console 就算了
  }
}

/** 注册换字形注入器；失败返回 false 并说明原因 */
export function registerChatSelectionBar(
  ctx: { slots?: SlotsFace },
  copy: Parameters<typeof ChatSelectionBar>[0]["copy"],
): boolean {
  const slots = ctx.slots;
  if (slots === undefined) {
    void reportDiag("chat-selection", "no-slots", null);
    return false;
  }
  try {
    /*
     * 必须走 `slots.inject(slot, () => slots.register(...))` —— 只调 `register` 不会挂载
     * （另外两处注册就是这么写的；漏了 inject 的表现是"组件完全不存在、连一条上报都没有"，实测踩过）。
     */
    slots.inject("sidebar.footer.action", () => slots.register(
      { name: "sidebar.footer.action", id: "knowledgenet.chat-selection", order: 60 },
      /*
       * **必须把槽位给的标准 props 透传下去**：`useWorkspaces` / `sessionId` 都在里面。
       * 我先前写成了 `() => createElement(ChatSelectionBar, { copy })`，把 props 整个丢掉，
       * 于是门禁永远判不出"当前工作区是不是知识库"（实测 `allowed:false` 一路拒绝、浮条永不出现）。
       */
      (slotProps: Record<string, unknown>) => createElement(ChatSelectionBar, {
        ...slotProps,
        copy,
        report: (step: string, detail?: Record<string, unknown> | null) => { void reportDiag("chat-selection", step, detail ?? null); },
      } as never),
    ));
    void reportDiag("chat-selection", "registered", null);
    return true;
  } catch (error) {
    void reportDiag("chat-selection", "register-failed", { message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}