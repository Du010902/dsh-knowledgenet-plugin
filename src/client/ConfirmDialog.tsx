/**
 * 自己的确认弹窗。
 *
 * 为什么不用 `window.confirm`：桌面端渲染环境会**静默忽略**它（直接返回 false，只在控制台留
 * 一句 warning），于是"没问就拒绝"——用户只看到按钮闪一下，看起来就是"点了没反应"（实测过）。
 * 所以这里渲染一个真正的模态层，portal 到 `document.body`：
 * - `position: fixed` 不受侧栏祖先的 `transform` 影响；
 * - 样式由 `confirmDialogCss()` 注入到 head（弹窗在 light DOM 里，Shadow DOM 的样式管不到它）；
 * - Esc = 取消，Enter = 确认，背景点击 = 取消，打开时焦点落在"确认"上。
 */
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  /**
   * 可选的**第三个**按钮（放在取消与确认之间 ✓）。
   *
   * 为什么需要：节点笔记的"未保存"提示是三选一 ——
   * 继续编辑 / **放弃修改** / 保存并继续 ✓（只有两个按钮就表达不了"放弃" ✓）。
   */
  extraLabel?: string | undefined;
  onExtra?: (() => void) | undefined;
  /**
   * **写请求正在进行**（例如"保存并继续"正在落盘 ✓）：三个按钮与 Esc/回车、点背景一律失效 ——
   * 不能出现"嘴上说放弃了、磁盘上却正在写"的状态 ✗（复查 P2-2 ✓）。
   *
   * 注意：它**只**表示"正在写"，不表示"这次保存不可能成功" ✗ ——
   * 把"不可保存"也塞进 busy 会把用户**困在弹窗里**（连继续编辑、放弃、Esc 都没了，
   * 而被挡住的编辑器里正好是要处理的错误 ✗，复查 P1-5）。后者用 `confirmDisabled` ✓。
   */
  busy?: boolean | undefined;
  /**
   * **确认动作当前不可用**（例如文档没有指纹 / 载入失败 ⇒ 保存必然失败 ✓）。
   *
   * 只禁用"确认"这一个按钮与 Enter ✓；**继续编辑、放弃修改、Esc、点背景照常可用** ✓ ——
   * 用户必须能回到编辑器处理问题，或明确放弃 ✓。
   */
  confirmDisabled?: boolean | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 弹窗键盘意图（实现与测试都在 `dialog-keyboard.ts` ✓ —— `.tsx` 没法被 Node 直接单测 ✗） */
import { dialogKeyboardIntent } from "./dialog-keyboard.ts";
export { dialogKeyboardIntent, type DialogKeyboardIntent } from "./dialog-keyboard.ts";

/**
 * 渲染一个确认弹窗。
 * @param props - 文案与回调。
 * @returns portal 到 body 的模态层。
 */
export function ConfirmDialog(props: ConfirmDialogProps): ReactNode {
  const { onConfirm, onCancel } = props;
  const busy = props.busy === true;
  const confirmDisabled = props.confirmDisabled === true || busy;

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const intent = dialogKeyboardIntent(event.key, { busy, confirmDisabled });
      if (intent === "ignore") return;
      event.preventDefault();
      if (intent === "cancel") onCancel();
      else onConfirm();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel, onConfirm, busy, confirmDisabled]);

  if (typeof document === "undefined") return null;
  return createPortal(
    /* 进行中时点背景也不关（背景点击 = 取消 ⇒ 同样是"放弃"语义 ✗） */
    <div className="kn-modal-backdrop" role="presentation" onClick={busy ? undefined : onCancel}>
      <div
        className="kn-modal"
        role="dialog"
        aria-modal="true"
        aria-busy={busy ? "true" : undefined}
        aria-label={props.title}
        onClick={(event) => { event.stopPropagation(); }}
      >
        <div className="kn-modal-title">{props.title}</div>
        <div className="kn-modal-body">{props.message}</div>
        <div className="kn-modal-actions">
          {/* 「继续编辑」与「放弃修改」只在**正在写盘**时禁用 ✓；"当前存不了"不该把人困住 ✗ */}
          <button type="button" className="kn-modal-btn" disabled={busy} onClick={onCancel}>{props.cancelLabel}</button>
          {props.extraLabel !== undefined && props.onExtra !== undefined ? (
            <button type="button" className="kn-modal-btn" disabled={busy} onClick={props.onExtra}>{props.extraLabel}</button>
          ) : null}
          <button
            type="button"
            className="kn-modal-btn kn-modal-primary"
            autoFocus
            disabled={confirmDisabled}
            title={confirmDisabled && !busy ? props.message : undefined}
            onClick={onConfirm}
          >
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
