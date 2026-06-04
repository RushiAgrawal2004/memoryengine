import { getSqlClient } from "./client.js";

export type JobStatus = "pending" | "processing" | "done" | "failed";

export interface ProcessingJob {
  id: string;
  type: "process_episode";
  status: JobStatus;
  scope: string | null;
  episodeId: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  runAfter: Date;
  lockedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const PROCESS_EPISODE = "process_episode";
const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

export async function enqueueEpisodeProcessingJob(input: {
  episodeId: string;
  scope: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
}): Promise<ProcessingJob> {
  const sql = getSqlClient();
  const [job] = await sql<ProcessingJob[]>`
    insert into jobs (
      type,
      status,
      scope,
      episode_id,
      payload,
      max_attempts,
      run_after
    )
    values (
      ${PROCESS_EPISODE},
      'pending',
      ${input.scope},
      ${input.episodeId},
      ${sql.json((input.payload ?? {}) as never)},
      ${input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS},
      now()
    )
    on conflict (type, episode_id) do update
    set
      scope = excluded.scope,
      payload = jobs.payload || excluded.payload,
      updated_at = now()
    returning
      id,
      type,
      status,
      scope,
      episode_id as "episodeId",
      payload,
      attempts,
      max_attempts as "maxAttempts",
      run_after as "runAfter",
      locked_at as "lockedAt",
      last_error as "lastError",
      created_at as "createdAt",
      updated_at as "updatedAt"
  `;

  return job;
}

export async function claimNextProcessingJob(): Promise<ProcessingJob | undefined> {
  const sql = getSqlClient();

  return sql.begin(async (tx) => {
    const [candidate] = await tx<Array<{ id: string }>>`
      select id
      from jobs
      where type = ${PROCESS_EPISODE}
        and status in ('pending', 'failed')
        and attempts < max_attempts
        and run_after <= now()
      order by run_after asc, created_at asc
      limit 1
      for update skip locked
    `;

    if (!candidate) {
      return undefined;
    }

    const [job] = await tx<ProcessingJob[]>`
      update jobs
      set
        status = 'processing',
        attempts = attempts + 1,
        locked_at = now(),
        last_error = null,
        updated_at = now()
      where id = ${candidate.id}
      returning
        id,
        type,
        status,
        scope,
        episode_id as "episodeId",
        payload,
        attempts,
        max_attempts as "maxAttempts",
        run_after as "runAfter",
        locked_at as "lockedAt",
        last_error as "lastError",
        created_at as "createdAt",
        updated_at as "updatedAt"
    `;

    return job;
  });
}

export async function completeProcessingJob(jobId: string): Promise<void> {
  const sql = getSqlClient();
  await sql`
    update jobs
    set
      status = 'done',
      locked_at = null,
      last_error = null,
      updated_at = now()
    where id = ${jobId}
  `;
}

export async function failProcessingJob(
  job: Pick<ProcessingJob, "id" | "attempts" | "maxAttempts">,
  error: unknown,
): Promise<void> {
  const sql = getSqlClient();
  const message = error instanceof Error ? error.message : String(error);
  const retryDelayMs = backoffMs(job.attempts);

  await sql`
    update jobs
    set
      status = 'failed',
      locked_at = null,
      last_error = ${message.slice(0, 4000)},
      run_after = case
        when ${job.attempts} >= ${job.maxAttempts} then run_after
        else now() + (${retryDelayMs} * interval '1 millisecond')
      end,
      updated_at = now()
    where id = ${job.id}
  `;
}

export async function getProcessingJob(jobId: string): Promise<ProcessingJob | undefined> {
  const sql = getSqlClient();
  const [job] = await sql<ProcessingJob[]>`
    select
      id,
      type,
      status,
      scope,
      episode_id as "episodeId",
      payload,
      attempts,
      max_attempts as "maxAttempts",
      run_after as "runAfter",
      locked_at as "lockedAt",
      last_error as "lastError",
      created_at as "createdAt",
      updated_at as "updatedAt"
    from jobs
    where id = ${jobId}
  `;

  return job;
}

function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(attempts - 1, 0), MAX_BACKOFF_MS);
}
