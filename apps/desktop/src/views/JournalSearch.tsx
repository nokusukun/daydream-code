/** Journal search: query box → GET /api/journal/search; hits link into sessions. */
import { useCallback, useState, type ReactNode } from "react";
import { useHarness } from "../harness.js";
import type { SearchHit } from "../api.js";
import { SessionLink, fmtDateTime } from "../ui.js";

export function JournalSearch(): ReactNode {
  const { api, navigate } = useHarness();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(() => {
    const q = query.trim();
    if (q.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    api
      .search(q, { limit: 100 })
      .then(setHits)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, [api, query, busy]);

  return (
    <div className="view view-search">
      <div className="view-toolbar">
        <h2>journal search</h2>
      </div>
      <div className="search-bar">
        <input
          type="text"
          value={query}
          placeholder="Search the append-only journal…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") run();
          }}
        />
        <button
          type="button"
          className="primary"
          disabled={busy || query.trim().length === 0}
          onClick={run}
        >
          {busy ? "searching…" : "search"}
        </button>
      </div>
      {error !== null && <div className="error-bar">{error}</div>}
      <div className="feed">
        {hits !== null && hits.length === 0 && (
          <div className="empty">No hits for that query.</div>
        )}
        {hits?.map((hit) => (
          <article key={hit.eventId} className="hit">
            <header className="entry-head">
              <span className="event-type">{hit.type}</span>
              <SessionLink
                id={hit.sessionId}
                onOpen={(id) => navigate({ name: "session", id })}
              />
              <span className="entry-time">{fmtDateTime(hit.ts)}</span>
              <span className="entry-seq">event {hit.eventId}</span>
            </header>
            <pre className="entry-body">{hit.snippet}</pre>
          </article>
        ))}
      </div>
    </div>
  );
}
