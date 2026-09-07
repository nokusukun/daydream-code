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

export interface PanelCloseAction {
  label: string;
  onClick(): void;
}

const VIEWS: Array<{ value: PanelView; label: string; icon: ReactNode }> = [
  {
    value: "thread",
    label: "Thread",
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M2.5 3.25h11v7.5H7l-3.5 2.5v-2.5h-1z" />
        <path d="M5 6h6M5 8.25h4" />
      </svg>
    ),
  },
  {
    value: "changes",
    label: "Changes",
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M2.5 4.25h5M5 1.75v5M9.5 11.75h4" />
        <path d="M3 11.75h2.25c3.5 0 2.5-7.5 6-7.5H13" />
      </svg>
    ),
  },
  {
    value: "usage",
    label: "Usage",
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M2.25 11.75a6 6 0 0 1 11.5 0" />
        <path d="m8 11.75 3-3.25" />
      </svg>
    ),
  },
];

export function ViewTabs(): ReactNode {
  const { view, setView } = useHarness();
  return (
    <div className="segmented panel-view-tabs" role="tablist" aria-label="Panel view">
      {VIEWS.map(({ value, label, icon }) => (
        <button
          type="button"
          key={value}
          role="tab"
          aria-label={label}
          aria-selected={view === value}
          title={label}
          onClick={() => setView(value)}
        >
          {icon}
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
  close?: PanelCloseAction;
}): ReactNode {
  return (
    <header className="panel-bar">
      <h2 className="bar-title">{props.title}</h2>
      {props.sub !== undefined && <span className="bar-sub">{props.sub}</span>}
      <span className="bar-spacer" />
      {props.children}
      <ViewTabs />
      {props.close !== undefined && (
        <button
          type="button"
          className="panel-close"
          aria-label={props.close.label}
          title={props.close.label}
          onClick={props.close.onClick}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="m3 3 6 6M9 3l-6 6" />
          </svg>
        </button>
      )}
    </header>
  );
}
