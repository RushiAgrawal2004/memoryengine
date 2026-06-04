create table if not exists traces (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  scope text,
  query text,
  payload jsonb not null,
  latency_ms real,
  created_at timestamp with time zone not null default now()
);

create index if not exists traces_created_at_idx on traces (created_at desc);
create index if not exists traces_kind_created_at_idx on traces (kind, created_at desc);
create index if not exists traces_scope_created_at_idx on traces (scope, created_at desc);
