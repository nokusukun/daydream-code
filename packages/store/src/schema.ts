import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  rootPath: text("root_path").notNull(),
  configJson: text("config_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const threads = sqliteTable(
  "threads",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    kind: text("kind", { enum: ["master", "session"] }).notNull(),
    forkedFromThread: text("forked_from_thread"),
    forkedAtSeq: integer("forked_at_seq"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("threads_project").on(t.projectId, t.kind)],
);

export const threadEntries = sqliteTable(
  "thread_entries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    threadId: text("thread_id").notNull(),
    seq: integer("seq").notNull(),
    kind: text("kind", {
      enum: [
        "message",
        "compaction",
        "session_dispatch",
        "session_turn_end",
        "session_summary",
        "session_message",
        "note",
      ],
    }).notNull(),
    sessionId: text("session_id"),
    toSessionId: text("to_session_id"),
    supersedesThroughSeq: integer("supersedes_through_seq"),
    messageJson: text("message_json").notNull(),
    tokenEstimate: integer("token_estimate").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("thread_entries_thread_seq").on(t.threadId, t.seq)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    threadId: text("thread_id").notNull(),
    name: text("name").notNull(),
    title: text("title").notNull(),
    task: text("task").notNull(),
    driver: text("driver").notNull(),
    modelId: text("model_id"),
    effort: text("effort"),
    fastMode: integer("fast_mode", { mode: "boolean" })
      .notNull()
      .default(false),
    // No migration accompanies `waiting`: the column is a bare `TEXT NOT NULL`
    // in every shipped migration, so this enum is a compile-time narrowing
    // only and widening it needs no DDL.
    status: text("status", {
      enum: ["running", "waiting", "completed", "failed", "killed"],
    }).notNull(),
    lastSeenMasterSeq: integer("last_seen_master_seq").notNull().default(0),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    summary: text("summary"),
    tldr: text("tldr"),
    archivedAt: text("archived_at"),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
  },
  (t) => [
    index("sessions_project_started").on(t.projectId, t.startedAt),
    uniqueIndex("sessions_project_name").on(t.projectId, t.name),
    index("sessions_project_archived").on(t.projectId, t.archivedAt),
  ],
);

export const journalEvents = sqliteTable(
  "journal_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: text("session_id").notNull(),
    ts: text("ts").notNull(),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull(),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    costUsd: real("cost_usd"),
  },
  (t) => [
    index("journal_events_session").on(t.sessionId, t.id),
    index("journal_events_type_ts").on(t.type, t.ts),
  ],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Quick actions: shell lines the desktop toolbar runs at the project root.
 * Authored by the person or by a session (`source`), which is why they live
 * here rather than in the renderer's own storage. See migration v5.
 */
export const quickActions = sqliteTable(
  "quick_actions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    label: text("label").notNull(),
    command: text("command").notNull(),
    source: text("source").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("quick_actions_project").on(t.projectId, t.createdAt),
    uniqueIndex("quick_actions_project_command").on(t.projectId, t.command),
  ],
);

/**
 * Kanban cards. A card is a unit of work that may or may not have a session
 * yet: Drafts and Queued cards have none, which is why `sessionId` is nullable
 * and why the board cannot be a column on `sessions`. See migration v8.
 */
export const boardCards = sqliteTable(
  "board_cards",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    column: text("lane", {
      enum: ["draft", "queued", "evaluating", "blocked", "working", "attention", "done"],
    }).notNull(),
    position: real("position").notNull(),
    title: text("title").notNull(),
    task: text("task").notNull(),
    requestJson: text("request_json").notNull(),
    sessionId: text("session_id"),
    evaluatorSessionId: text("evaluator_session_id"),
    attentionReason: text("attention_reason"),
    verdictJson: text("verdict_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("board_cards_project_column").on(t.projectId, t.column, t.position),
    uniqueIndex("board_cards_session").on(t.sessionId),
  ],
);

/**
 * "Card X is blocked by session Y." Keyed on the blocker's *session* because
 * a blocker is by definition Working and therefore has one, and `session/ended`
 * carries the record — the release path needs no join.
 */
export const boardBlocks = sqliteTable(
  "board_blocks",
  {
    cardId: text("card_id").notNull(),
    blockerSessionId: text("blocker_session_id").notNull(),
    source: text("source", { enum: ["evaluator", "user"] }).notNull(),
    reason: text("reason"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("board_blocks_pk").on(t.cardId, t.blockerSessionId),
    index("board_blocks_blocker").on(t.blockerSessionId),
  ],
);
