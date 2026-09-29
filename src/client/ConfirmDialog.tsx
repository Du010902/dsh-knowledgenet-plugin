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
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 渲染一个确认弹窗。
 * @param props - 文案与两个回调。
 * @returns portal 到 body 的模态层。
 */
export function ConfirmDialog(props: ConfirmDialogProps): ReactNode {
  const { onConfirm, onCancel } = props;

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      } else if (event.key === "Enter") {
        event.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel, onConfirm]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="kn-modal-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="kn-modal"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onClick={(event) => { event.stopPropagation(); }}
      >
        <div className="kn-modal-title">{props.title}</div>
        <div className="kn-modal-body">{props.message}</div>
        <div className="kn-modal-actions">
          <button type="button" className="kn-modal-btn" onClick={onCancel}>{props.cancelLabel}</button>
          <button type="button" className="kn-modal-btn kn-modal-primary" autoFocus onClick={onConfirm}>
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
