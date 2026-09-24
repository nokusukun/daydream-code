/**
 * The board header's way into plan mode.
 *
 * A plain button while no plan is going. Once one is, it becomes a pull-down
 * listing them above "New plan…". The plan list used to live only under the
 * new-plan composer, which put the way back to a running plan behind a button
 * labelled for starting a different one; leaving a plan with "← Board" then
 * read as losing it.
 */
import { useRef, useState, type ReactNode } from "react";
import type { SessionRecord } from "@daydream-code/shared";
import type { BoardCard, BoardPlan } from "../api.js";
import { useDismiss } from "../overlay.js";
import { StatusGlyph } from "../ui.js";
import { openPlans, planStanding } from "./PlanView.js";

export function PlanMenu(props: {
  plans: readonly BoardPlan[];
  cards: readonly BoardCard[];
  sessions: ReadonlyMap<string, SessionRecord>;
  /** `"new"` for the composer, otherwise a plan id. */
  onOpen(planId: string): void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismiss(rootRef, open, () => setOpen(false));

  const planner = (plan: BoardPlan) => (plan.sessionId === null ? undefined : props.sessions.get(plan.sessionId));
  const going = openPlans(props.plans, props.cards, planner);

  if (going.length === 0) {
    return (
      <button
        type="button"
        className="btn"
        onClick={() => props.onOpen("new")}
        title="Break a large prompt into cards you review before they run"
      >
        Plan
      </button>
    );
  }

  const choose = (planId: string) => {
    setOpen(false);
    props.onOpen(planId);
  };

  return (
    <div className="plan-menu" ref={rootRef}>
      <button
        type="button"
        className="btn plan-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${going.length} ${going.length === 1 ? "plan" : "plans"} in progress`}
        onClick={() => setOpen((v) => !v)}
      >
        Plan
        <span className="plan-menu-count">{going.length}</span>
        <span className="caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="plan-pop pop" role="menu">
          <div className="pop-head">in progress</div>
          {going.map((plan) => {
            const standing = planStanding(plan, props.cards, planner(plan));
            return (
              <button
                key={plan.id}
                type="button"
                role="menuitem"
                className="pop-row"
                title={plan.title}
                onClick={() => choose(plan.id)}
              >
                <StatusGlyph status={standing.glyph} />
                <span className="pop-row-title">{plan.title}</span>
                <span className="pop-row-meta">{standing.meta}</span>
              </button>
            );
          })}
          <div className="pop-sep" role="presentation" />
          <button type="button" role="menuitem" className="pop-row" onClick={() => choose("new")}>
            <span className="pop-row-title">New plan…</span>
          </button>
        </div>
      )}
    </div>
  );
}
