import { toJobError } from './errors';

export type JobError = { code: string; message: string };
export type Job = { id: string; kind: 'prepare' | 'generate' | 'fix' | 'render'; projectId: string; videoId?: string;
  status: 'queued' | 'running' | 'done' | 'failed'; progress: number; message: string; result?: unknown; error?: JobError };
export type JobMeta = { projectId: string; videoId?: string };
export type Report = (p: number, msg: string) => void;

/** Runs jobs one at a time in the order added; a failing job does not stop the ones after it. */
export class JobQueue {
  private jobs: Job[] = [];
  private subs = new Set<(j: Job) => void>();
  private tail: Promise<void> = Promise.resolve();
  private seq = 0;
  private toError: (e: unknown) => JobError;

  constructor(o: { toError?: (e: unknown) => JobError } = {}) {
    this.toError = o.toError ?? toJobError;
  }

  add(kind: Job['kind'], meta: JobMeta, run: (report: Report) => Promise<unknown>): Job {
    const job: Job = { id: `job-${Date.now().toString(36)}-${++this.seq}`, kind, projectId: meta.projectId,
      ...(meta.videoId ? { videoId: meta.videoId } : {}), status: 'queued', progress: 0, message: '' };
    this.jobs.push(job);
    this.emit(job);
    this.tail = this.tail.then(() => this.execute(job, run));
    return { ...job };
  }

  get(id: string): Job | undefined {
    const j = this.jobs.find(x => x.id === id);
    return j && { ...j };
  }

  list(): Job[] {
    return this.jobs.map(j => ({ ...j }));
  }

  /** Calls `fn` with a snapshot on every change of any job. Returns the unsubscribe function. */
  subscribe(fn: (j: Job) => void): () => void {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  }

  private async execute(job: Job, run: (report: Report) => Promise<unknown>): Promise<void> {
    job.status = 'running';
    this.emit(job);
    const report: Report = (p, msg) => {
      if (job.status !== 'running') return;
      job.progress = Math.min(1, Math.max(0, p));
      job.message = msg;
      this.emit(job);
    };
    try {
      job.result = await run(report);
      job.progress = 1;
      job.status = 'done';
    } catch (e) {
      job.error = this.toError(e);
      job.status = 'failed';
    }
    this.emit(job);
  }

  private emit(job: Job): void {
    const snapshot = { ...job };
    for (const fn of [...this.subs]) {
      try { fn(snapshot); } catch { /* a broken subscriber must not break the queue */ }
    }
  }
}
