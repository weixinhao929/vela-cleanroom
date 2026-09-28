import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { logCrash, toCrashFields } from "../lib/crash-log";
import { t } from "../i18n-lite";

/** 边界属性：实例 id 与组件类型（用于崩溃日志定位）。 */
interface Props {
  instanceId: string;
  type: string;
  children: ReactNode;
  /** 自定义崩溃占位；传 `null` 表示崩溃后什么都不渲染（外壳类容器用：灵动岛、
      沉浸遮罩——它们不是"卡片"，默认占位卡放在那里既错位又误导）。 */
  fallback?: ReactNode;
  /** 捕获到错误后的回调（如把展开态收起，免得遮罩空转、Esc 也没人接）。 */
  onError?: (error: Error) => void;
}

interface State {
  error: Error | null;
  /** 每次「重试」递增，作为 key 强制子树完全重建（清掉损坏的内部状态）。 */
  attempt: number;
}

/**
 * 单个小组件的错误边界（隔离模式）：一个组件崩溃只显示占位卡片 +
 * 重试按钮，桌面层其余组件与应用本体不受影响。错误连同组件栈写入
 * 崩溃日志，供设置页诊断区查看；重试通过 attempt 重建子树。
 *
 * @example
 * ```tsx
 * <WidgetErrorBoundary instanceId={id} type="clock"><ClockWidget …/></WidgetErrorBoundary>
 * ```
 */
export class WidgetErrorBoundary extends Component<Props, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const fields = toCrashFields(error);
    logCrash({
      source: `widget:${this.props.instanceId}`,
      detail: this.props.type,
      message: fields.message,
      stack: `${fields.stack ?? ""}\n--- componentStack ---\n${info.componentStack ?? ""}`
    });
    try {
      this.props.onError?.(error);
    } catch {
      // 回调异常不得再次抛入边界
    }
  }

  private reset = () => this.setState((s) => ({ error: null, attempt: s.attempt + 1 }));

  render() {
    if (this.state.error) {
      if (this.props.fallback !== undefined) return this.props.fallback;
      return (
        <div className="widget-error" role="alert">
          <AlertTriangle size={16} />
          <span className="widget-error-text">{t("此小组件出现问题")}</span>
          <button className="widget-error-retry" onClick={this.reset} title={t("重试")}>
            <RotateCcw size={13} />
          </button>
        </div>
      );
    }
    // 外壳模式（提供了 fallback）不套 .widget-error-host：那是个 100%×100% 的块级
    // div，包在画布直接子级上会盖住整个画布截获指针事件。带 key 的 Fragment
    // 同样能在「重试」时强制重建子树。
    if (this.props.fallback !== undefined) return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
    return (
      <div key={this.state.attempt} className="widget-error-host">
        {this.props.children}
      </div>
    );
  }
}
