/**
 * The bar over the main panel: what you are looking at, and the three ways to
 * look at it.
 *
 * Thread / Changes / Usage are the same three questions about any thread —
 * what happened, what it left behind, what it cost — so the tabs are shared
 * rather than reimplemented per panel, and switching threads keeps you on the
 * transcript because the other two are answers about the thread you left.
 */
import type { ReactNode } from "react";
import { useHarness, type PanelView } from "../harness.js";

const VIEWS: Array<[PanelView, string]> = [
  ["thread", "Thread"],
  ["changes", "Changes"],
  ["usage", "Usage"],
];

export function ViewTabs(): ReactNode {
  const { view, setView } = useHarness();
  return (
    <div className="segmented" role="tablist" aria-label="Panel view">
      {VIEWS.map(([value, label]) => (
        <button
          type="button"
          key={value}
          role="tab"
          aria-selected={view === value}
          onClick={() => setView(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function PanelHead(props: {
  title: ReactNode;
  sub?: ReactNode;
  /** Controls between the subtitle and the tabs — a stop button, a toggle. */
  children?: ReactNode;
}): ReactNode {
  return (
    <header className="panel-bar">
      <h2 className="bar-title">{props.title}</h2>
      {props.sub !== undefined && <span className="bar-sub">{props.sub}</span>}
      <span className="bar-spacer" />
      {props.children}
      <ViewTabs />
    </header>
  );
}
