/**
 * The Usage tab: what this thread cost, and what its context is made of.
 *
 * Every number here is one the harness already records. There is no estimate
 * and no projection — a cost readout that guesses is worse than no cost
 * readout, because it is the one number a user will act on.
 */
import { useMemo, type ReactNode } from "react";
import type { JournalEvent, SessionRecord, ThreadEntry } from "@daydream-code/shared";
import { useHarness } from "../harness.js";
import { elapsedMs, fmtElapsed } from "../sessions.js";
import { compact } from "./ThreadRail.js";

interface ModelRow {
  key: string;
  driver: string;
  label: string;
  runs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

/**
 * Sessions folded by the model they actually ran on. A project that switched
 * default model halfway through has two rows, which is exactly the thing the
 * table exists to make visible.
 */
function byModel(
  sessions: readonly SessionRecord[],
  label: (driver: string, modelId: string | null) => { label: string },
): ModelRow[] {
  const rows = new Map<string, ModelRow>();
  for (const session of sessions) {
    const key = `${session.driver}/${session.modelId ?? ""}`;
    const row = rows.get(key) ?? {
      key,
      driver: session.driver,
      label: label(session.driver, session.modelId).label,
      runs: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    };
    row.runs += 1;
    row.tokensIn += session.usage.tokensIn;
    row.tokensOut += session.usage.tokensOut;
    row.costUsd += session.usage.costUsd;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.costUsd - a.costUsd);
}

/** Entry kinds, in the order they read as a story rather than alphabetically. */
const KIND_ORDER = [
  "message",
  "session_dispatch",
  "session_message",
  "session_summary",
  "session_turn_end",
  "compaction",
  "note",
];

export function UsageView(props: {
  sessions: readonly SessionRecord[];
  /** Journal of the one run in view; drives the per-run ledger. */
  events?: readonly JournalEvent[] | undefined;
  /** Live master-thread entries; drives the context composition bar. */
  entries?: readonly ThreadEntry[] | undefined;
}): ReactNode {
  const { modelLabel } = useHarness();
  const models = useMemo(
    () => byModel(props.sessions, modelLabel),
    [props.sessions, modelLabel],
  );

  const totals = useMemo(
    () =>
      props.sessions.reduce(
        (sum, s) => ({
          tokensIn: sum.tokensIn + s.usage.tokensIn,
          tokensOut: sum.tokensOut + s.usage.tokensOut,
          costUsd: sum.costUsd + s.usage.costUsd,
        }),
        { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      ),
    [props.sessions],
  );

  const bands = useMemo(() => {
    if (props.entries === undefined) return null;
    const sums = new Map<string, number>();
    for (const entry of props.entries) {
      sums.set(entry.kind, (sums.get(entry.kind) ?? 0) + entry.tokenEstimate);
    }
    const total = [...sums.values()].reduce((a, b) => a + b, 0);
    if (total === 0) return null;
    const order = (kind: string): number => {
      const at = KIND_ORDER.indexOf(kind);
      return at === -1 ? KIND_ORDER.length : at;
    };
    return {
      total,
      rows: [...sums.entries()]
        .sort((a, b) => order(a[0]) - order(b[0]))
        .map(([kind, tokens]) => ({
          kind,
          tokens,
          pct: (tokens / total) * 100,
        })),
    };
  }, [props.entries]);

  const ledger = useMemo(
    () => buildLedger(props.sessions, props.events),
    [props.sessions, props.events],
  );

  if (props.sessions.length === 0) {
    return (
      <div className="empty">
        <p className="empty-title">Nothing spent yet</p>
        <p className="empty-body">
          Token counts and cost land here as each turn is journaled.
        </p>
      </div>
    );
  }

  return (
    <div className="usage">
      <div className="usage-table">
        <div className="usage-head">
          <span className="usage-model">Model</span>
          <span className="usage-num">In</span>
          <span className="usage-num">Out</span>
          <span className="usage-num">Cost</span>
        </div>
        {models.map((row) => (
          <div className="usage-row" key={row.key}>
            <span className="usage-model">
              <span className={`usage-dot driver-${row.driver}`} aria-hidden="true" />
              {row.label}
              {props.sessions.length > 1 && (
                <i className="usage-runs">
                  {row.runs} run{row.runs === 1 ? "" : "s"}
                </i>
              )}
            </span>
            <span className="usage-num">{compact(row.tokensIn)}</span>
            <span className="usage-num">{compact(row.tokensOut)}</span>
            <span className="usage-num usage-cost">${row.costUsd.toFixed(2)}</span>
          </div>
        ))}
        {models.length > 1 && (
          <div className="usage-row usage-total">
            <span className="usage-model">Total</span>
            <span className="usage-num">{compact(totals.tokensIn)}</span>
            <span className="usage-num">{compact(totals.tokensOut)}</span>
            <span className="usage-num usage-cost">${totals.costUsd.toFixed(2)}</span>
          </div>
        )}
      </div>

      {bands !== null && (
        <div className="ctx-card">
          <div className="card-label">
            live context · ~{compact(bands.total)} tokens
          </div>
          {/* The estimate the compactor itself budgets against, split by what
              is taking up the room. No denominator: the budget is a plugin's
              config, and inventing a ceiling here would be a number nobody
              set. */}
          <div className="ctx-bar">
            {bands.rows.map((band) => (
              <span
                key={band.kind}
                className={`ctx-band band-${band.kind}`}
                style={{ width: `${band.pct}%` }}
              />
            ))}
          </div>
          <div className="ctx-legend">
            {bands.rows.map((band) => (
              <span className="ctx-key" key={band.kind}>
                <span
                  className={`ctx-swatch band-${band.kind}`}
                  aria-hidden="true"
                />
                {band.kind.replace(/^session_/, "").replace(/_/g, " ")}
                <i>{compact(band.tokens)}</i>
              </span>
            ))}
          </div>
        </div>
      )}

      <dl className="ledger">
        {ledger.map(([key, value]) => (
          <div className="ledger-row" key={key}>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function buildLedger(
  sessions: readonly SessionRecord[],
  events: readonly JournalEvent[] | undefined,
): Array<[string, string]> {
  const cost = sessions.reduce((sum, s) => sum + s.usage.costUsd, 0);

  if (events !== undefined && sessions.length === 1) {
    const session = sessions[0]!;
    const turns = events.filter((e) => e.type === "turn_end").length;
    const calls = events.filter((e) => e.type === "tool_call").length;
    const failed = events.filter((e) => e.type === "tool_error").length;
    return [
      ["Turns", String(turns)],
      ["Tool calls", failed > 0 ? `${calls} · ${failed} failed` : String(calls)],
      ["Wall clock", fmtElapsed(elapsedMs(session))],
      ["Cost", `$${cost.toFixed(4)}`],
      ...(turns > 0
        ? ([["Cost / turn", `$${(cost / turns).toFixed(4)}`]] as Array<[string, string]>)
        : []),
    ];
  }

  const live = sessions.filter(
    (s) => s.status === "running" || s.status === "waiting",
  ).length;
  const failedRuns = sessions.filter((s) => s.status === "failed").length;
  const busiest = sessions.reduce(
    (worst, s) => Math.max(worst, elapsedMs(s)),
    0,
  );
  return [
    ["Runs", live > 0 ? `${sessions.length} · ${live} live` : String(sessions.length)],
    ...(failedRuns > 0
      ? ([["Failed", String(failedRuns)]] as Array<[string, string]>)
      : []),
    ["Longest run", fmtElapsed(busiest)],
    ["Cost", `$${cost.toFixed(4)}`],
    ["Cost / run", `$${(cost / Math.max(1, sessions.length)).toFixed(4)}`],
  ];
}
