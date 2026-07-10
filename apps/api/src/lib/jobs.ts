import { and, eq } from "drizzle-orm";
import { db, aiJobs } from "@cadmus/db";

export type JobType = "design-page" | "apply-stitch-screen" | "generate-image" | "import-html";

export interface JobRunnerContext {
  jobId: string;
  siteId: string;
}

export type JobRunner<T> = (ctx: JobRunnerContext) => Promise<T>;

// Inserts a job row, returns the id immediately, and kicks off the work as a
// fire-and-forget promise. Cloud Run runs the API with --no-cpu-throttling so
// the runtime keeps executing after the HTTP response returns.
export async function enqueueJob<T>(opts: {
  siteId: string;
  type: JobType;
  payload: Record<string, unknown>;
  createdBy?: string | null;
  runner: JobRunner<T>;
}): Promise<{ jobId: string }> {
  const [row] = await db
    .insert(aiJobs)
    .values({
      siteId: opts.siteId,
      type: opts.type,
      status: "pending",
      requestPayload: opts.payload,
      createdBy: opts.createdBy ?? null,
    })
    .returning({ id: aiJobs.id });

  const jobId = row.id;
  void runJob(jobId, opts.siteId, opts.runner);
  return { jobId };
}

async function runJob<T>(
  jobId: string,
  siteId: string,
  runner: JobRunner<T>,
): Promise<void> {
  try {
    await db
      .update(aiJobs)
      .set({ status: "processing", startedAt: new Date() })
      .where(eq(aiJobs.id, jobId));

    const result = await runner({ jobId, siteId });

    await db
      .update(aiJobs)
      .set({
        status: "completed",
        result: (result ?? null) as Record<string, unknown> | null,
        completedAt: new Date(),
      })
      .where(eq(aiJobs.id, jobId));
  } catch (err) {
    console.error(`Job ${jobId} failed:`, err);
    await db
      .update(aiJobs)
      .set({
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        completedAt: new Date(),
      })
      .where(eq(aiJobs.id, jobId));
  }
}

export async function getJob(jobId: string, siteId: string) {
  const [row] = await db
    .select()
    .from(aiJobs)
    .where(and(eq(aiJobs.id, jobId), eq(aiJobs.siteId, siteId)));
  return row ?? null;
}
