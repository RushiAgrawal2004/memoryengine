import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  foreignKey,
} from "drizzle-orm/pg-core";
import { customType } from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
};

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export interface RepoRef {
  repo?: string;
  commit?: string;
  branch?: string;
}

export interface Anchor {
  path: string;
  symbol?: string;
  commit?: string;
}

export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: text("scope").notNull(),
    title: text("title"),
    task: text("task"),
    agent: text("agent"),
    status: text("status").notNull().default("active"),
    repoRef: jsonb("repo_ref").$type<RepoRef>(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("chat_sessions_scope_started_idx").on(table.scope, table.startedAt),
  ],
);

export const episodes = pgTable("episodes", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").references(() => chatSessions.id),
  scope: text("scope").notNull(),
  kind: text("kind").notNull(),
  content: text("content").notNull(),
  source: text("source").notNull(),
  repoRef: jsonb("repo_ref").$type<RepoRef>(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  ...timestamps,
});

export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    scope: text("scope").notNull(),
    content: text("content").notNull(),
    embedding: jsonb("embedding").$type<number[]>(),
    fts: tsvector("fts").generatedAlwaysAs(sql`to_tsvector('english', content)`),
    confidence: real("confidence").notNull().default(0.5),
    status: text("status").notNull().default("active"),
    tValid: timestamp("t_valid", { withTimezone: true }),
    tInvalid: timestamp("t_invalid", { withTimezone: true }),
    tCreated: timestamp("t_created", { withTimezone: true }).notNull().defaultNow(),
    tExpired: timestamp("t_expired", { withTimezone: true }),
    sourceEpisode: uuid("source_episode").references(() => episodes.id),
    sourceSession: uuid("source_session").references(() => chatSessions.id),
    repoRef: jsonb("repo_ref").$type<RepoRef>(),
    anchors: jsonb("anchors").$type<Anchor[]>(),
    attrs: jsonb("attrs").$type<Record<string, unknown>>(),
    supersedes: uuid("supersedes"),
    useCount: integer("use_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "memories_supersedes_memories_id_fk",
      columns: [table.supersedes],
      foreignColumns: [table.id],
    }),
    index("memories_fts_gin_idx").using("gin", table.fts),
    index("memories_scope_status_idx").on(table.scope, table.status),
  ],
);

export const entities = pgTable(
  "entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: text("scope").notNull(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    embedding: jsonb("embedding").$type<number[]>(),
    attrs: jsonb("attrs").$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("entities_scope_kind_name_idx").on(table.scope, table.kind, table.name),
  ],
);

export const edges = pgTable(
  "edges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: text("scope").notNull(),
    src: uuid("src").references(() => entities.id),
    dst: uuid("dst").references(() => entities.id),
    relation: text("relation").notNull(),
    fact: text("fact"),
    embedding: jsonb("embedding").$type<number[]>(),
    tValid: timestamp("t_valid", { withTimezone: true }),
    tInvalid: timestamp("t_invalid", { withTimezone: true }),
    tCreated: timestamp("t_created", { withTimezone: true }).notNull().defaultNow(),
    tExpired: timestamp("t_expired", { withTimezone: true }),
    sourceEpisode: uuid("source_episode").references(() => episodes.id),
    ...timestamps,
  },
  (table) => [
    index("edges_scope_relation_active_idx")
      .on(table.scope, table.relation)
      .where(sql`${table.tExpired} is null`),
  ],
);
