/** 通用面板容器：统一内边距、标题与圆角的最小组件。 */
import type { ReactNode } from "react";

export function Panel({
  title,
  kicker,
  action,
  children,
  className = "",
  dataBreak
}: {
  title: string;
  kicker: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  dataBreak?: boolean;
}) {
  return (
    <section className={`panel ${className}`} data-break={dataBreak ? "true" : undefined}>
      <header className="panel-header">
        <div>
          <span>{kicker}</span>
          <h2>{title}</h2>
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}
