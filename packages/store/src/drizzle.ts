/**
 * Re-export of the drizzle operator surface from the store's own drizzle-orm
 * instance. Providers that consume `ctx.store.db` and the exported schema
 * tables must build predicates from THIS module, not their own "drizzle-orm"
 * import: pnpm may resolve a second drizzle-orm instance for them (peer-keyed
 * on @types/better-sqlite3), and mixing instances breaks both the types and
 * drizzle's instanceof-style entity checks.
 */
export {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lt,
  lte,
  ne,
  not,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
