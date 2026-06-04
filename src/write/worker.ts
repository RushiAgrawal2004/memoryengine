import {
  claimNextProcessingJob,
  completeProcessingJob,
  failProcessingJob,
  ProcessingJob,
} from "../db/jobs.js";
import { processEpisodeById } from "./process.js";

export interface WorkerOptions {
  intervalMs?: number;
  batchSize?: number;
}

export interface ProcessingWorker {
  stop(): void;
  tick(): Promise<number>;
}

const DEFAULT_INTERVAL_MS = 750;
const DEFAULT_BATCH_SIZE = 5;

export async function processNextJob(): Promise<boolean> {
  const job = await claimNextProcessingJob();
  if (!job) {
    return false;
  }

  await runJob(job);
  return true;
}

export function startProcessingWorker(options: WorkerOptions = {}): ProcessingWorker {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  let running = false;

  const tick = async (): Promise<number> => {
    if (running) {
      return 0;
    }

    running = true;
    try {
      let processed = 0;
      for (let index = 0; index < batchSize; index += 1) {
        const didWork = await processNextJob();
        if (!didWork) {
          break;
        }
        processed += 1;
      }

      return processed;
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    tick().catch((error) => {
      console.warn(`[memory-engine] processing worker failed: ${String(error)}`);
    });
  }, intervalMs);
  timer.unref?.();
  void tick();

  return {
    stop() {
      clearInterval(timer);
    },
    tick,
  };
}

async function runJob(job: ProcessingJob): Promise<void> {
  try {
    if (!job.episodeId) {
      throw new Error(`job ${job.id} is missing episode_id`);
    }

    await processEpisodeById(job.episodeId);
    await completeProcessingJob(job.id);
  } catch (error) {
    await failProcessingJob(job, error);
  }
}
