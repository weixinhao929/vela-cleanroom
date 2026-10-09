/**
 * 应用根错误边界：捕获渲染期异常显示全屏错误页并写崩溃日志，
 * 防止单点异常白屏；小组件级隔离由 WidgetErrorBoundary 负责。
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { asAppError } from "../domain/errors";
import { logCrash, toCrashFields } from "../lib/crash-log";
import { t } from "../i18n-lite";

interface Props {
  children: ReactNode;
  /** 「重试」按下时先回调这里——调用方丢弃缓存的 rejected import
      （make-resettable-lazy 的 reset），重试才是真的重新拉 chunk；
      不接线的窗口形态仍有「重新加载窗口」兜底。 */
  onRetry?: () => void;
}

interface State {
  error: { kind: string; code: string; message: string } | null;
}

/**
 * Global error boundary. On an unexpected render error it shows a typed,
 * recoverable surface instead of a blank window.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(err: unknown): State {
    const appErr = asAppError(err);
    return { error: { kind: appErr.kind, code: appErr.code, message: appErr.message } };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("[Vela] render error", error, info.componentStack);
    // 被边界捕获的渲染错误不会再冒到 window.error，main.tsx 的全局钩子收不到；
    // 这里必须自己写崩溃日志，否则文件头承诺的"写崩溃日志"是空话。
    const fields = toCrashFields(error);
    logCrash({
      source: `boundary:${typeof window !== "undefined" ? window.location.hash || "/" : "/"}`,
      detail: info.componentStack?.trim().split("\n")[0]?.trim(),
      ...fields
    });
  }

  private reset = () => {
    // 先丢弃缓存的 rejected import 再清错误态——否则重渲染的仍是同一
    // 个 lazy 实例，重试只是重放已缓存的失败。
    try {
      this.props.onRetry?.();
    } catch {
      // 回调异常不得再次抛入边界
    }
    this.setState({ error: null });
  };

  /** 确定性错误下「重试」会立刻再抛；给一条真正能跳出去的路。 */
  private reload = () => window.location.reload();

  render() {
    if (this.state.error) {
      return (
        <div className="error-boundary" role="alert">
          <strong>{t("应用遇到问题")}</strong>
          <span>{this.state.error.message}</span>
          <code>
            {this.state.error.kind}:{this.state.error.code}
          </code>
          <div className="error-boundary-actions">
            <button onClick={this.reset} className="primary-button">
              {t("重试")}
            </button>
            <button onClick={this.reload} className="primary-button">
              {t("重新加载窗口")}
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
