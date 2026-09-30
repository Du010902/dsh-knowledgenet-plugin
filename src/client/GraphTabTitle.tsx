/**
 * 标签芯片里的标题：**图谱图标 + 短名「图谱」**（用户要求 2026-10）。
 *
 * 两个关键点，都是踩出来的：
 *
 * 1. **必须自己注册这个组件**（座位 `sidebar.right.pane.tab.title`）。宿主渲染芯片时优先用它；
 *    没注册就只显示"打开标签时记下的那串纯文字"（`SidebarRight.tsx:246` 的 `titlesFor`）——
 *    所以改 `definition.icon` 是**看不到效果的** ✗（用户反馈"这里没变啊"就是这个）。
 *    写法照抄 shipped 的 `ui-sidebar-files/src/client/FilesTitle.tsx` ✓。
 *
 * 2. **文字不读标签记录（`tab.title`），而是固定短名**。原因：宿主把打开那一刻的文字
 *    **快照进 layout 记录**并持久化（`persistence.ts:20` 只存 `title`），
 *    已经开着的标签在记录里还是旧的长名字 ⇒ 读记录的话，改成短名也要关掉重开才生效 ✗。
 *    固定短名是实时渲染的，刷新页面就生效 ✓（宿主的「文件」芯片也是这个短名做法）✓。
 *
 * 短名本身走宿主词典（`tabShort`），所以中英切换照样跟随 ✓；拿不到 `t` 时回落到字面文案。
 */
import { useMemo, type ReactNode } from "react";

import { makeTranslator } from "./card-model.ts";
import { GraphPanelIcon } from "./PanelIcon.tsx";

/** 芯片上的短名（与「开始」页卡片的全名分开，理由见 `tab-definition.ts`） */
const LITERAL: Record<string, string> = { tabShort: "图谱" };

/**
 * 芯片标题：先画图谱图标，再跟上短名。
 * @param props.t - 宿主注入的翻译函数（注册时带了 `locale` 就会被注入）。
 * @returns 图标 + 短名。
 */
export function GraphTabTitle({ t }: { t?: unknown }): ReactNode {
  /* 与其它组件同一套：宿主 `t` 优先，缺席时用 LITERAL；`useMemo` 固化引用避免重复渲染 ✓ */
  const translate = useMemo(() => makeTranslator(t, LITERAL), [t]);
  return (
    <>
      {/* 与文件/浏览器那两个芯片一致：16px、跟随 currentColor（选中/未选中自动变色）✓ */}
      <GraphPanelIcon size={16} />
      {translate("tabShort")}
    </>
  );
}
