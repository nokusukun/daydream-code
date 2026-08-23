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
    title: text("title"),
    task: text("task").notNull(),
    driver: text("driver").notNull(),
    modelId: text("model_id"),
    status: text("status", {
      enum: ["running", "completed", "failed", "killed"],
    }).notNull(),
    lastSeenMasterSeq: integer("last_seen_master_seq").notNull().default(0),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    summary: text("summary"),
    tldr: text("tldr"),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
  },
  (t) => [index("sessions_project_started").on(t.projectId, t.startedAt)],
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
