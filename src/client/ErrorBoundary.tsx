/**
 * 卡片与面板的错误边界。
 *
 * 3D 视图要碰 WebGL、Worker、Blob URL 这些宿主环境相关的东西，一旦它在渲染期抛错，
 * DSH 的槽位会把整个条目摘掉——用户看到的是"面板消失"，而不是一条错误。
 * 所以任何「可能抛」的子树都套一层边界：出错就退回到调用方给的兜底内容。
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** 出错时渲染什么（通常是「退回二维视图」的提示） */
  fallback: ReactNode;
  /** 出错回调（面板据此把模式切回二维） */
  onError?(error: Error, info: ErrorInfo): void;
}

interface ErrorBoundaryState {
  failed: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
