import type { Timeline } from '../core/timeline';
import type { NotFollowed } from '../agent/plan';
import type { RoleAssignment } from '../project/roles';
import type { ProjectScan } from '../project/scan';
import type { describeVideo, FixJobResult, Output, PrepareResult } from '../server/pipeline';
import type { Job } from '../server/jobs';
import type { ProjectEntry, Settings } from '../server/settings';

export type { Job, NotFollowed, Output, PrepareResult, ProjectEntry, ProjectScan, RoleAssignment, Settings, Timeline, FixJobResult };
export type Starter = 'real-estate' | 'vlog' | 'trend';
export type EngineInfo = { id: string; capabilities: unknown; available: boolean; reason?: string };
export type VideoDetail = NonNullable<Awaited<ReturnType<typeof describeVideo>>>;
export type VideoSummary = { videoId: string; prompt: string; engine: string; createdAt: string; latestVersion: number | null; output: Output | null };
export type GenerateResult = { videoId: string; version: number; notFollowed: NotFollowed[]; output: Output };
export type GenerateRequest = { prompt: string; roles: RoleAssignment[]; engine: string };

/** An error body `{ error: { code, message } }` from the server, or a network failure (code NETWORK). */
export class ApiError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'ApiError'; }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) { throw new ApiError('NETWORK', (e as Error).message); }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(err?.code ?? 'INTERNAL', err?.message ?? res.statusText);
  }
  return data as T;
}

const p = (id: string) => `/api/projects/${encodeURIComponent(id)}`;
const v = (id: string, vid: string) => `${p(id)}/videos/${encodeURIComponent(vid)}`;

/** Every call the UI makes. Job-starting calls return `{ job }`; wait for it with `useJobs().waitFor`. */
export const api = {
  settings: () => call<Settings>('GET', '/api/settings'),
  saveSettings: (patch: Partial<Settings>) => call<Settings>('PUT', '/api/settings', patch),
  engines: () => call<EngineInfo[]>('GET', '/api/engines'),
  projects: () => call<ProjectEntry[]>('GET', '/api/projects'),
  addProject: (dir: string) => call<{ project: ProjectEntry; scan: ProjectScan }>('POST', '/api/projects', { dir }),
  createGuideline: (id: string, starter: Starter, lang: 'vi' | 'en') => call<{ ok: true }>('POST', `${p(id)}/guideline`, { starter, lang }),
  prepare: (id: string, prompt: string) => call<{ job: Job }>('POST', `${p(id)}/prepare`, { prompt }),
  generate: (id: string, body: GenerateRequest) => call<{ job: Job }>('POST', `${p(id)}/videos`, body),
  videos: (id: string) => call<VideoSummary[]>('GET', `${p(id)}/videos`),
  video: (id: string, vid: string) => call<VideoDetail>('GET', v(id, vid)),
  approve: (id: string, vid: string, itemId: string, approved: boolean) => call<{ version: number }>('POST', `${v(id, vid)}/approve`, { id: itemId, approved }),
  fix: (id: string, vid: string, body: { feedback: string; unlock: boolean }) => call<{ job: Job }>('POST', `${v(id, vid)}/fix`, body),
  revert: (id: string, vid: string, version: number) => call<{ job: Job }>('POST', `${v(id, vid)}/revert`, { version }),
};
