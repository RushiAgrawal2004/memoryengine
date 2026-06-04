CREATE TABLE IF NOT EXISTS "chat_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "scope" text NOT NULL,
  "title" text,
  "task" text,
  "agent" text,
  "status" text DEFAULT 'active' NOT NULL,
  "repo_ref" jsonb,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ended_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "chat_sessions_scope_started_idx"
  ON "chat_sessions" ("scope", "started_at");

ALTER TABLE "episodes" ADD COLUMN IF NOT EXISTS "session_id" uuid;
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "source_session" uuid;

DO $$
BEGIN
  ALTER TABLE "episodes"
    ADD CONSTRAINT "episodes_session_id_chat_sessions_id_fk"
    FOREIGN KEY ("session_id") REFERENCES "chat_sessions"("id");
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  ALTER TABLE "memories"
    ADD CONSTRAINT "memories_source_session_chat_sessions_id_fk"
    FOREIGN KEY ("source_session") REFERENCES "chat_sessions"("id");
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;
