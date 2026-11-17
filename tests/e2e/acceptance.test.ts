import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Transcriber } from '../../src/analysis';
import type { Timeline } from '../../src/core/timeline';
import { VersionStore } from '../../src/core/versions';
import { probeMedia } from '../../src/project/probe';
import type { RoleAssignment } from '../../src/project/roles';
import { buildApp } from '../../src/server/app';
import { JobQueue, type Job } from '../../src/server/jobs';
import { SettingsStore } from '../../src/server/settings';
import { makeProject } from '../fixtures/make';
import { FakeModel, turn } from '../helpers/fakeModel';
import { makeTimeline } from '../helpers/timeline';

// Spec section 6: generate a video, fix one segment, confirm nothing else changed.
// Real scan, real analysis (fake transcriber), real built-in engine; only the AI is scripted.
const TIMEOUT = 300_000;

let proj: string;
let app: FastifyInstance;
let model = new FakeModel([]);
let projectId: string;
let videoId: string;
let store: VersionStore;
let v1: Timeline;

const fakeTranscriber: Transcriber = {
  async transcribe() {
    return { words: [{ text: 'xin', startSec: 0, endSec: 2 }, { text: 'chào', startSec: 2, endSec: 4 }], text: 'xin chào', language: 'vi' };
  },
};

/** Three 3 s segments (a 0-3, b 0-3, a 1-4), a caption each, the music track. 0:03 falls in s2. */
function plan(): Timeline {
  const t = makeTimeline(3, 90);
  const src: [string, number][] = [['raw/a.mp4', 0], ['raw/b.mp4', 0], ['raw/a.mp4', 1]];
  t.segments = t.segments.map((s, i) => ({ ...s, source: src[i][0], sourceIn: src[i][1], sourceOut: src[i][1] + 3 }));
  t.captions = t.captions.map((c, i) => ({ ...c, text: `Cảnh số ${i + 1}` }));
  t.audio = [{ id: 'm1', kind: 'music', source: 'reference/track.mp3', startFrame: 0, sourceIn: 0, gain: 0.3 }];
  return t;
}

const get = (url: string) => app.inject({ method: 'GET', url });
const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as object });

/** Polls GET /api/jobs until the job has finished. */
async function waitJob(id: string): Promise<Job> {
  for (;;) {
    const j = ((await get('/api/jobs')).json() as Job[]).find(x => x.id === id)!;
    if (j.status === 'done' || j.status === 'failed') return j;
    await new Promise(r => setTimeout(r, 100));
  }
}

async function runJob(url: string, payload: unknown): Promise<Job> {
  const res = await post(url, payload);
  expect(res.statusCode, res.body).toBe(202);
  const j = await waitJob(res.json().job.id);
  expect(j.status, JSON.stringify(j.error)).toBe('done');
  return j;
}

const videoUrl = () => `/api/projects/${projectId}/videos/${videoId}`;
const exists = (f: string) => fs.stat(f).then(() => true, () => false);

beforeAll(async () => {
  proj = await fs.realpath(await makeProject({ music: true }));
  const settings = new SettingsStore(path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'vea-e2e-')), 'settings.json'));
  await settings.update({ apiKey: 'sk-ant-e2e-0000' });
  app = buildApp({ settings, queue: new JobQueue(), model: () => model, transcriber: () => fakeTranscriber });
  await app.ready();
  projectId = (await post('/api/projects', { dir: proj })).json().project.id;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await fs.rm(proj, { recursive: true, force: true });
});

describe('acceptance (spec section 6)', () => {
  test('generate, fix one segment, everything else identical', async () => {
    // prepare: the roles answer marks the reference track as music, decided by the prompt
    model = new FakeModel([turn('submit_roles', { roles: [
      { path: 'reference/track.mp3', role: 'music', useAudio: false, decidedBy: 'prompt', reason: 'The prompt says to cut to the music' },
    ] })]);
    const prep = await runJob(`/api/projects/${projectId}/prepare`, { prompt: '9s clip, cut to the music' });
    const roles = (prep.result as { roles: RoleAssignment[] }).roles;
    expect(roles).toEqual([expect.objectContaining({ path: 'reference/track.mp3', role: 'music', decidedBy: 'prompt' })]);

    // generate with the real built-in engine
    model = new FakeModel([turn('submit_timeline', { timeline: plan(), notFollowed: [] })]);
    const gen = await runJob(`/api/projects/${projectId}/videos`, { prompt: '9s clip, cut to the music', roles, engine: 'builtin' });
    const g = gen.result as { videoId: string; version: number; output: { path: string } };
    videoId = g.videoId;
    expect(g.version).toBe(1);
    const dir = path.join(proj, '.vea', 'videos', videoId);
    store = new VersionStore(dir);
    expect(g.output.path).toBe(path.join(dir, 'v1.mp4'));
    const m1 = await probeMedia(dir, 'v1.mp4');
    expect([m1.width, m1.height]).toEqual([1080, 1920]);
    v1 = (await store.load(1));
    expect(v1.durationFrames).toBe(270);

    // fix the shot at 0:03 (segment s2)
    model = new FakeModel([turn('submit_patch', { targets: ['s2'], summary: 'Swapped the shot.',
      ops: [{ op: 'swapSource', segmentId: 's2', source: 'raw/a.mp4', sourceIn: 1, sourceOut: 4, speed: 1 }] })]);
    const fix = await runJob(`${videoUrl()}/fix`, { feedback: 'swap the shot at 0:03', unlock: false });
    expect(fix.result).toMatchObject({ status: 'applied', version: 2, targets: ['s2'] });

    const v2 = await store.load(2);
    expect(v2.segments[1].source).toBe('raw/a.mp4');
    expect(v2.durationFrames).toBe(v1.durationFrames);
    expect(v2.segments.filter(s => s.id !== 's2')).toEqual(v1.segments.filter(s => s.id !== 's2'));
    expect(v2.captions).toEqual(v1.captions);
    expect(v2.audio).toEqual(v1.audio);

    expect(await exists(path.join(dir, 'v1.mp4'))).toBe(true);
    const m2 = await probeMedia(dir, 'v2.mp4');
    expect([m2.width, m2.height]).toEqual([1080, 1920]);
    expect(Math.abs(m2.durationSec - m1.durationSec)).toBeLessThanOrEqual(0.1);
  }, TIMEOUT);

  test('an approved segment is not touched by a second fix', async () => {
    const r = await post(`${videoUrl()}/approve`, { id: 's2', approved: true });
    expect(r.statusCode, r.body).toBe(200);
    const before = (await store.latest())!;
    // The caption c2 still covers 0:03, so the model is asked; it keeps aiming at the approved s2 and every try is rejected.
    const swap = () => turn('submit_patch', { targets: ['s2'], summary: 'Swapped again.',
      ops: [{ op: 'swapSource', segmentId: 's2', source: 'raw/b.mp4', sourceIn: 2, sourceOut: 5, speed: 1 }] });
    model = new FakeModel([swap(), swap(), swap()]);
    const fix = await runJob(`${videoUrl()}/fix`, { feedback: 'swap the shot at 0:03 again', unlock: false });
    expect(fix.result).toMatchObject({ status: 'refused', needsUnlock: false });
    expect((await store.latest())!.n).toBe(before.n);
    expect((await store.latest())!.timeline).toEqual(before.timeline);
  }, TIMEOUT);

  test('revert never changes an approved item: refused while s2 is approved, applied after un-approving it', async () => {
    const lastBefore = (await store.latest())!.n;
    const refused = await runJob(`${videoUrl()}/revert`, { version: 1 });
    expect(refused.result).toEqual({ status: 'refused', code: 'APPROVED_CONFLICT', ids: ['s2'] });
    expect((await store.latest())!.n).toBe(lastBefore);

    expect((await post(`${videoUrl()}/approve`, { id: 's2', approved: false })).statusCode).toBe(200);
    const rev = await runJob(`${videoUrl()}/revert`, { version: 1 });
    const { version } = rev.result as { version: number };
    expect(version).toBe(lastBefore + 2);
    const v3 = await store.load(version);
    expect(v3.segments).toEqual(v1.segments);
    expect(await exists(path.join(proj, '.vea', 'videos', videoId, `v${version}.mp4`))).toBe(true);
  }, TIMEOUT);
});
