CREATE TABLE "edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"src" uuid,
	"dst" uuid,
	"relation" text NOT NULL,
	"fact" text,
	"embedding" jsonb,
	"t_valid" timestamp with time zone,
	"t_invalid" timestamp with time zone,
	"t_created" timestamp with time zone DEFAULT now() NOT NULL,
	"t_expired" timestamp with time zone,
	"source_episode" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"embedding" jsonb,
	"attrs" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "episodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"source" text NOT NULL,
	"repo_ref" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"scope" text NOT NULL,
	"content" text NOT NULL,
	"embedding" jsonb,
	"fts" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"t_valid" timestamp with time zone,
	"t_invalid" timestamp with time zone,
	"t_created" timestamp with time zone DEFAULT now() NOT NULL,
	"t_expired" timestamp with time zone,
	"source_episode" uuid,
	"repo_ref" jsonb,
	"anchors" jsonb,
	"supersedes" uuid,
	"use_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_src_entities_id_fk" FOREIGN KEY ("src") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_dst_entities_id_fk" FOREIGN KEY ("dst") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_source_episode_episodes_id_fk" FOREIGN KEY ("source_episode") REFERENCES "public"."episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_source_episode_episodes_id_fk" FOREIGN KEY ("source_episode") REFERENCES "public"."episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_supersedes_memories_id_fk" FOREIGN KEY ("supersedes") REFERENCES "public"."memories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "edges_scope_relation_active_idx" ON "edges" USING btree ("scope","relation") WHERE "edges"."t_expired" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "entities_scope_kind_name_idx" ON "entities" USING btree ("scope","kind","name");--> statement-breakpoint
CREATE INDEX "memories_fts_gin_idx" ON "memories" USING gin ("fts");--> statement-breakpoint
CREATE INDEX "memories_scope_status_idx" ON "memories" USING btree ("scope","status");