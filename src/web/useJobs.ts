import { useSyncExternalStore } from 'react';
import type { Job } from './api';

// One EventSource for the whole page, opened on first use. The server replays every job on connect.
let source: EventSource | null = null;
let jobs: Job[] = [];
const listeners = new Set<() => void>();

function ensureSource(): void {
  if (source || typeof EventSource === 'undefined') return;
  source = new EventSource('/api/jobs/stream');
  source.onmessage = e => {
    const job = JSON.parse(e.data as string) as Job;
    jobs = jobs.some(j => j.id === job.id) ? jobs.map(j => (j.id === job.id ? job : j)) : [...jobs, job];
    listeners.forEach(fn => fn());
  };
}

function subscribe(fn: () => void): () => void {
  ensureSource();
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Resolves with the job once it is done or failed (never rejects; check `status`). */
function waitFor(id: string): Promise<Job> {
  ensureSource();
  return new Promise(resolve => {
    const check = () => {
      const j = jobs.find(x => x.id === id);
      if (j && (j.status === 'done' || j.status === 'failed')) { listeners.delete(check); resolve(j); }
    };
    listeners.add(check);
    check();
  });
}

/** Live list of jobs from the server's event stream, plus `waitFor(id)` to await one. */
export function useJobs(): { jobs: Job[]; waitFor: (id: string) => Promise<Job> } {
  return { jobs: useSyncExternalStore(subscribe, () => jobs), waitFor };
}
