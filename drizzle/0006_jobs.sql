create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  status text not null default 'pending',
  scope text,
  episode_id uuid references episodes(id),
  payload jsonb not null default '{}'::jsonb,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  run_after timestamp with time zone not null default now(),
  locked_at timestamp with time zone,
  last_error text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create unique index if not exists jobs_type_episode_id_idx
  on jobs (type, episode_id);

create index if not exists jobs_status_run_after_idx
  on jobs (status, run_after);

create index if not exists jobs_scope_created_at_idx
  on jobs (scope, created_at desc);
