/**
 * 换字形注入器的注册选项（纯数据，便于单测）。
 *
 * 组件本身不画东西（只向 `<head>` 注入样式），挂载点选 `sidebar.footer.action`：
 * root 作用域、始终挂载，且它的标准 props 里就有 `useWorkspaces`。
 * 注意该槽位的注册目录里 **`id` 是必填**（漏掉会抛错，而抛错只会表现成"标志不出现"）。
 */

/** 注册 id：用自己的 id = 与 shipped 条目并排，不替换它们 */
export const BADGES_ID = "knowledgenet.badges";
/** 位置：排在 shipped 条目之后 */
export const BADGES_ORDER = 40;

export interface BadgesOptionsInput {
  locale?: string | undefined;
}

/** 组装 `slots.register` 的选项（组件不需要注入面：判定所需都在标准 props 里） */
export function badgesOptions(input: BadgesOptionsInput = {}): Record<string, unknown> {
  return {
    name: "sidebar.footer.action",
    id: BADGES_ID,
    order: BADGES_ORDER,
    ...(input.locale === undefined ? {} : { locale: input.locale }),
  };
}
