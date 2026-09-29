/**
 * 上游 `src/store.ts` 的替身（**不是副本**，因此不在 vendor 清单里）。
 *
 * 插件只用到 `STATUS_DISPLAY` 这一个纯常量；直接复制上游文件会把 zustand 的
 * `create()`（上游 src/store.ts:303）在插件包里实例化一遍，而插件**不允许**
 * 建立自己的全局状态容器。
 *
 * 三条取值必须与上游 src/store.ts:75 保持一致。改动上游时，scripts/vendor-drift
 * 测试不会发现这里，所以这是一处需要人工留意的已知重复。
 */
import { STATUS_LABEL, type LearnStatus } from "./data/types.ts";

export const STATUS_DISPLAY: Record<LearnStatus, { label: string; cls: string }> = {
  todo: { label: STATUS_LABEL.todo, cls: "is-todo" },
  learning: { label: STATUS_LABEL.learning, cls: "is-learning" },
  done: { label: STATUS_LABEL.done, cls: "is-done" },
};
