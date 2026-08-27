import {
  Component,
  Fragment,
  createContext,
  useContext,
  useSyncExternalStore,
  type ErrorInfo,
  type ReactNode,
} from "react";
import {
  DesktopModuleRuntime,
  type DesktopModuleSnapshot,
} from "./runtime.js";

const RuntimeContext = createContext<DesktopModuleRuntime<any> | null>(null);

export function DesktopModulesProvider(props: {
  runtime: DesktopModuleRuntime<any>;
  children: ReactNode;
}): ReactNode {
  return (
    <RuntimeContext.Provider value={props.runtime}>
      {props.children}
    </RuntimeContext.Provider>
  );
}

export function useDesktopModules<Host = unknown>(): DesktopModuleSnapshot<Host> {
  const runtime = useContext(RuntimeContext) as
    | DesktopModuleRuntime<Host>
    | null;
  if (runtime === null) {
    throw new Error("useDesktopModules outside <DesktopModulesProvider>");
  }
  return useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
    runtime.getSnapshot,
  );
}

export function useDesktopModuleRuntime<
  Host = unknown,
>(): DesktopModuleRuntime<Host> {
  const runtime = useContext(RuntimeContext) as
    | DesktopModuleRuntime<Host>
    | null;
  if (runtime === null) {
    throw new Error("useDesktopModuleRuntime outside <DesktopModulesProvider>");
  }
  return runtime;
}

interface BoundaryProps {
  moduleId: string;
  surface: "panel" | "sidebar" | "toolbar" | "overlay" | "root";
  onDismiss?: () => void;
  children: ReactNode;
}

interface BoundaryState {
  error: Error | null;
  revision: number;
}

/** A separate fault domain for every contribution a module renders. */
export class ModuleBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null, revision: 0 };

  static getDerivedStateFromError(error: Error): Partial<BoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      `[desktop-module:${this.props.moduleId}] ${this.props.surface} crashed`,
      error,
      info.componentStack,
    );
  }

  retry = (): void => {
    this.setState(({ revision }) => ({ error: null, revision: revision + 1 }));
  };

  render(): ReactNode {
    const { error, revision } = this.state;
    if (error === null) {
      return <Fragment key={revision}>{this.props.children}</Fragment>;
    }

    const content = (
      <div
        className={`module-failure module-failure-${this.props.surface}`}
        role="alert"
      >
        <span>
          <strong>{this.props.moduleId}</strong> failed: {error.message}
        </span>
        <button type="button" className="btn" onClick={this.retry}>
          retry
        </button>
        {this.props.onDismiss !== undefined && (
          <button
            type="button"
            className="btn"
            onClick={this.props.onDismiss}
          >
            close
          </button>
        )}
      </div>
    );

    return this.props.surface === "overlay" ? (
      <div className="scrim" role="presentation">
        <div className="sheet glass-strong" role="dialog" aria-modal="true">
          {content}
        </div>
      </div>
    ) : content;
  }
}
