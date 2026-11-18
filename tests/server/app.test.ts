import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { ModelTurn } from '../../src/agent/model';
import type { Transcriber } from '../../src/analysis';
import type { Timeline } from '../../src/core/timeline';
import type { Engine, EngineCapabilities } from '../../src/engines/types';
import type { RoleAssignment } from '../../src/project/roles';
import { buildApp } from '../../src/server/app';
import { JobQueue, type Job } from '../../src/server/jobs';
import { SettingsStore } from '../../src/server/settings';
import { makeProject } from '../fixtures/make';
import { FakeModel, turn } from '../helpers/fakeModel';
import { makeTimeline } from '../helpers/timeline';

const KEY = 'sk-ant-test-secret-9876';
const CAPS: EngineCapabilities = { transitions: ['cut', 'fade'], effects: ['pushIn'], captionAnimations: ['line', 'word'] };

let proj: string;
let settings: SettingsStore;
let queue: JobQueue;
let app: FastifyInstance;
let model = new FakeModel([]);
let transcribeError: Error | null = null;
let renderError: Error | null = null;
const renders: string[] = [];

const fakeTranscriber: Transcriber = {
  async transcribe() {
    if (transcribeError) throw transcribeError;
    return { words: [{ text: 'xin', startSec: 0, endSec: 2 }, { text: 'chào', startSec: 2, endSec: 4 }], text: 'xin chào', language: 'vi' };
  },
};

const stubEngine: Engine = {
  id: 'builtin',
  capabilities: () => structuredClone(CAPS),
  availability: async () => ({ available: true }),
  async render(o) {
    if (renderError) throw renderError;
    const file = path.join(o.outDir, `${o.name}.mp4`);
    await fs.mkdir(o.outDir, { recursive: true });
    await fs.writeFile(file, `render of ${o.name}`);
    o.onProgress?.(1);
    renders.push(o.name);
    return { kind: 'mp4', path: file };
  },
};

/** Stands in for yt-dlp: "downloads" by copying a raw clip to the -o path. */
const ytDlpRun = (async (_bin: string, args: string[]) => {
  await fs.copyFile(path.join(proj, 'raw', 'b.mp4'), args[args.indexOf('-o') + 1]);
  return { stdout: '' };
}) as never;

/** A valid timeline over the fixture: three 1 s segments of raw/b.mp4, captions c1..c3, narration from reference/vo.mp3. */
function planned(): Timeline {
  const t = makeTimeline(3, 30);
  t.segments = t.segments.map((s, i) => ({ ...s, source: 'raw/b.mp4', sourceIn: i, sourceOut: i + 1 }));
  t.audio = [{ id: 'a1', kind: 'narration', source: 'reference/vo.mp3', startFrame: 0, sourceIn: 0, gain: 1 }];
  return t;
}

async function waitJob(id: string): Promise<Job> {
  for (;;) {
    const j = queue.get(id)!;
    if (j.status === 'done' || j.status === 'failed') return j;
    await new Promise(r => setTimeout(r, 20));
  }
}

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers });
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url, payload: payload as object, headers });
/** Posts a job route and waits for the job to finish. */
async function runJob(url: string, payload: unknown): Promise<Job> {
  const res = await post(url, payload);
  expect(res.statusCode, res.body).toBe(202);
  return waitJob(res.json().job.id);
}

beforeAll(async () => {
  proj = await makeProject({ rawNames: ['cảnh 1.mp4', 'b.mp4'], narration: true });
  await fs.writeFile(path.join(proj, 'reference', 'links.txt'), 'https://example.com/clip\nhttps://www.youtube.com/watch?v=abc\n');
  settings = new SettingsStore(path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'vea-app-')), 'settings.json'));
  await settings.update({ apiKey: KEY });
  queue = new JobQueue();
  app = buildApp({
    settings, queue, model: () => model, transcriber: () => fakeTranscriber, ytDlpRun,
    engines: id => { if (id === 'builtin') return stubEngine; throw new Error(`unknown engine ${id}`); },
  });
  await app.ready();
}, 60_000);

afterAll(async () => { await app.close(); });

/** Port of the app listening on 127.0.0.1 (started on first use). Real HTTP keeps raw paths that inject would normalise. */
async function listeningPort(): Promise<number> {
  if (!app.server.listening) await app.listen({ port: 0, host: '127.0.0.1' });
  return (app.server.address() as AddressInfo).port;
}

/** GET over a real socket with the path sent byte for byte. */
async function rawGet(rawPath: string): Promise<number> {
  const port = await listeningPort();
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: rawPath, headers: { host: `localhost:${port}` } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
  });
}

describe('settings and engines', () => {
  test('GET /api/settings masks the key; PUT keeps it when the mask comes back', async () => {
    const s = (await get('/api/settings')).json();
    expect(s.apiKey).toBe('••••9876');
    expect(JSON.stringify(s)).not.toContain(KEY);
    const put = await app.inject({ method: 'PUT', url: '/api/settings', payload: { ...s, language: 'en' } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ apiKey: '••••9876', language: 'en' });
    expect((await settings.get()).apiKey).toBe(KEY);
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { language: 'vi' } });
  });

  test('settings report where the key comes from; keySource in a PUT is ignored; the mask leaves .env untouched', async () => {
    const s = (await get('/api/settings')).json();
    expect(s.keySource).toBe('env-file');
    expect(s.apiKey).not.toBe(KEY);
    const before = await fs.readFile(settings.envFile, 'utf8');
    const r = await app.inject({ method: 'PUT', url: '/api/settings', payload: { ...s, keySource: 'environment' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().keySource).toBe('env-file');
    expect(await fs.readFile(settings.envFile, 'utf8')).toBe(before);
  });

  test('PUT /api/settings rejects bad values and ignores projects', async () => {
    const bad = await app.inject({ method: 'PUT', url: '/api/settings', payload: { language: 'fr' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('BAD_REQUEST');
    const before = (await settings.get()).projects;
    const r = await app.inject({ method: 'PUT', url: '/api/settings', payload: { projects: [{ id: 'x', dir: '/', name: 'x' }] } });
    expect(r.statusCode).toBe(200);
    expect((await settings.get()).projects).toEqual(before);
  });

  test('GET /api/engines lists builtin and a disabled capcut placeholder', async () => {
    expect((await get('/api/engines')).json()).toEqual([
      { id: 'builtin', capabilities: CAPS, available: true },
      { id: 'capcut', capabilities: null, available: false, reason: 'CapCut engine is not installed in this version.' },
    ]);
  });
});

describe('security', () => {
  test('requests for another host name are refused (DNS rebinding)', async () => {
    const r = await get('/api/settings', { host: 'evil.example:4317' });
    expect(r.statusCode).toBe(403);
    expect((await get('/api/settings', { host: '127.0.0.1:4317' })).statusCode).toBe(200);
  });

  test('cross-origin browser requests are refused; same-origin ones pass', async () => {
    expect((await get('/api/settings', { host: 'localhost:4317', origin: 'http://evil.example' })).statusCode).toBe(403);
    expect((await get('/api/settings', { host: 'localhost:4317', origin: 'http://localhost:9999' })).statusCode).toBe(403);
    expect((await get('/api/settings', { host: 'localhost:4317', origin: 'http://localhost:4317' })).statusCode).toBe(200);
  });
});

let projectId: string;

describe('projects', () => {
  test('POST /api/projects registers a folder once; GET lists it', async () => {
    const r = await post('/api/projects', { dir: proj });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    projectId = body.project.id;
    expect(body.project).toEqual({ id: projectId, dir: await fs.realpath(proj), name: path.basename(proj) });
    expect(body.scan.raw.map((m: { path: string }) => m.path)).toEqual(['raw/b.mp4', 'raw/cảnh 1.mp4']);
    const again = await post('/api/projects', { dir: proj + '/' });
    expect(again.json().project.id).toBe(projectId);
    expect((await get('/api/projects')).json()).toEqual([body.project]);
    expect(again.json().project).toEqual(body.project);
  });

  test('two folders registered at the same moment are both kept', async () => {
    const [a, b] = await Promise.all([makeProject({ rawNames: ['a.mp4'] }), makeProject({ rawNames: ['a.mp4'] })]);
    const res = await Promise.all([post('/api/projects', { dir: a }), post('/api/projects', { dir: b })]);
    expect(res.map(r => r.statusCode)).toEqual([200, 200]);
    const ids = (await settings.get()).projects.map(p => p.id);
    for (const r of res) expect(ids).toContain(r.json().project.id);
    expect(ids).toContain(projectId);
  }, 60_000);

  test('the filesystem root, the home folder and folders around the settings file cannot be projects', async () => {
    const settingsDir = path.dirname(settings.file);
    for (const dir of ['/', os.homedir(), settingsDir, path.dirname(settingsDir)]) {
      const r = await post('/api/projects', { dir });
      expect([r.statusCode, r.json().error.code], dir).toEqual([400, 'UNSAFE_FOLDER']);
    }
  });

  test('a folder holding the app .env (wherever it is) cannot be a project, and .env files are never served', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vea-appdir-'));
    const appDir = path.join(root, 'app');
    await fs.mkdir(appDir, { recursive: true });
    const store = new SettingsStore(path.join(root, 'home', 'settings.json'), { envFile: path.join(appDir, '.env') });
    await store.update({ apiKey: 'sk-ant-secret-9999' });
    const other = buildApp({ settings: store, queue: new JobQueue(), model: () => model, transcriber: () => fakeTranscriber, ytDlpRun });
    for (const dir of [appDir, root]) {
      const r = await other.inject({ method: 'POST', url: '/api/projects', headers: { host: 'localhost:4317' }, payload: { dir } });
      expect([r.statusCode, r.json().error.code], dir).toEqual([400, 'UNSAFE_FOLDER']);
    }
    await other.close();
    await fs.writeFile(path.join(proj, '.env'), 'AI_PROVIDER_KEY=leak\n');
    await fs.writeFile(path.join(proj, 'raw', '.env.local'), 'X=1\n');
    for (const f of ['.env', 'raw/.env.local']) expect((await get(`/media/${projectId}/${f}`)).statusCode, f).toBe(403);
  });

  test('a key with a line break is rejected; surrounding spaces are trimmed', async () => {
    const bad = await app.inject({ method: 'PUT', url: '/api/settings', headers: { host: 'localhost:4317' }, payload: { apiKey: 'abc\nOTHER=evil' } });
    expect(bad.statusCode).toBe(400);
    expect(await fs.readFile(settings.envFile, 'utf8')).not.toContain('OTHER');
    const ok = await app.inject({ method: 'PUT', url: '/api/settings', headers: { host: 'localhost:4317' }, payload: { apiKey: '  sk-trimmed-5678 ' } });
    expect(ok.statusCode).toBe(200);
    expect((await settings.get()).apiKey).toBe('sk-trimmed-5678');
  });

  test('bad folders are rejected with the project error code', async () => {
    expect((await post('/api/projects', { dir: 'relative/dir' })).statusCode).toBe(400);
    const missing = await post('/api/projects', { dir: path.join(proj, 'nope') });
    expect([missing.statusCode, missing.json().error.code]).toEqual([400, 'NOT_A_FOLDER']);
  });

  test('POST guideline creates it from a starter once', async () => {
    const r = await post(`/api/projects/${projectId}/guideline`, { starter: 'vlog', lang: 'vi' });
    expect(r.statusCode, r.body).toBe(200);
    expect((await fs.readFile(path.join(proj, 'guideline.md'), 'utf8')).length).toBeGreaterThan(0);
    const again = await post(`/api/projects/${projectId}/guideline`, { starter: 'vlog', lang: 'vi' });
    expect([again.statusCode, again.json().error.code]).toEqual([409, 'GUIDELINE_EXISTS']);
    expect((await post(`/api/projects/${projectId}/guideline`, { starter: 'nope', lang: 'vi' })).statusCode).toBe(400);
  });

  test('unknown project is 404', async () => {
    expect((await post('/api/projects/ffffffff/prepare', { prompt: 'x' })).statusCode).toBe(404);
  });
});

let roles: RoleAssignment[];
let downloadPath: string;

describe('prepare', () => {
  test('a transcriber failure fails the job with TRANSCRIBE_FAILED naming the binary setting', async () => {
    transcribeError = new Error('spawn whisper-cli ENOENT');
    try {
      const j = await runJob(`/api/projects/${projectId}/prepare`, { prompt: 'x' });
      expect(j.status).toBe('failed');
      expect(j.error).toMatchObject({ code: 'TRANSCRIBE_FAILED' });
      expect((j.error as { message: string }).message).toContain('whisperBinary');
    } finally { transcribeError = null; }
  }, 60_000);

  test('an empty API key fails the job with NO_API_KEY', async () => {
    await settings.update({ apiKey: '' });
    try {
      const j = await runJob(`/api/projects/${projectId}/prepare`, { prompt: 'x' });
      expect([j.status, (j.error as { code: string }).code]).toEqual(['failed', 'NO_API_KEY']);
    } finally { await settings.update({ apiKey: KEY }); }
  });

  test('returns roles with decidedBy, a cost, link failures and warnings', async () => {
    model = new FakeModel([turn('submit_roles', { roles: [] })]);
    const j = await runJob(`/api/projects/${projectId}/prepare`, { prompt: '45s tour, calm' });
    expect(j.status, JSON.stringify(j.error)).toBe('done');
    const r = j.result as { roles: RoleAssignment[]; driver: string; cost: { usd: number; inputTokens: number }; linkFailures: { url: string; error: string }[]; warnings: string[] };
    roles = r.roles;
    expect(r.linkFailures).toEqual([{ url: 'https://example.com/clip', error: 'unsupported site' }]);
    expect(r.warnings).toEqual([]);
    expect(r.driver).toBe('narration');
    expect(r.cost.inputTokens).toBeGreaterThan(0);
    expect(typeof r.cost.usd).toBe('number');
    expect(roles.every(x => x.decidedBy === 'guess')).toBe(true);
    expect(roles.find(x => x.path === 'reference/vo.mp3')?.role).toBe('narration');
    const dl = roles.filter(x => x.path.startsWith('.vea/downloads/'));
    expect(dl).toHaveLength(1);
    expect(dl[0].role).toBe('style');
    downloadPath = dl[0].path;
    expect(new Set(roles.map(x => x.path)).size).toBe(roles.length);
  }, 60_000);
});

let videoId: string;
const vurl = () => `/api/projects/${projectId}/videos/${videoId}`;
const video = async () => (await get(vurl())).json();

describe('videos', () => {
  test('GET videos is [] for a project with no videos', async () => {
    expect((await get(`/api/projects/${projectId}/videos`)).json()).toEqual([]);
  });

  test('rejects roles that name unknown files or roles', async () => {
    const bad1 = await post(`/api/projects/${projectId}/videos`, { prompt: 'x', roles: [...roles, { ...roles[0], path: '../etc/passwd' }], engine: 'builtin' });
    expect([bad1.statusCode, bad1.json().error.code]).toEqual([400, 'BAD_ROLES']);
    const bad2 = await post(`/api/projects/${projectId}/videos`, { prompt: 'x', roles: [{ ...roles[0], role: 'boss' }], engine: 'builtin' });
    expect(bad2.statusCode).toBe(400);
    const bad3 = await post(`/api/projects/${projectId}/videos`, { prompt: 'x', roles, engine: 'capcut' });
    expect([bad3.statusCode, bad3.json().error.code]).toEqual([400, 'ENGINE_UNAVAILABLE']);
  });

  test('generates version 1 and renders it; downloaded samples carry their duration (R7)', async () => {
    model = new FakeModel([turn('submit_timeline', { timeline: planned(), notFollowed: [] })]);
    const j = await runJob(`/api/projects/${projectId}/videos`, { prompt: '45s tour', roles, engine: 'builtin' });
    expect(j.status, JSON.stringify(j.error)).toBe('done');
    const r = j.result as { videoId: string; version: number; notFollowed: unknown[]; output: { url: string; path: string } };
    videoId = r.videoId;
    expect(j.videoId).toBe(videoId);
    expect([r.version, r.notFollowed]).toEqual([1, []]);
    expect(r.output.url).toBe(`/media/${projectId}/.vea/videos/${videoId}/v1.mp4`);
    expect(r.output.path).toBe(path.join(await fs.realpath(proj), '.vea', 'videos', videoId, 'v1.mp4'));
    expect((await get(r.output.url)).body).toBe('render of v1');
    const sent = JSON.stringify(model.calls[0].messages);
    expect(sent).toContain(`## ${downloadPath} (style)\\nduration 5`);
  }, 60_000);

  test('GET video shows versions, latest timeline and outputs', async () => {
    const v = await video();
    expect(v.versions).toEqual([expect.objectContaining({ n: 1, note: 'generated', output: { url: `/media/${projectId}/.vea/videos/${videoId}/v1.mp4`, path: expect.any(String) } })]);
    expect(v.latest.n).toBe(1);
    expect(v.latest.timeline).toEqual(planned());
    expect([v.engine, v.prompt, v.notFollowed]).toEqual(['builtin', '45s tour', []]);
    expect((await get(`/api/projects/${projectId}/videos/nope`)).statusCode).toBe(404);
  });

  test('a refused fix is not a failure and leaves the latest version at 1', async () => {
    model = new FakeModel([turn('refuse', { reason: 'Cannot make it shorter without unlock.', needsUnlock: true })]);
    const j = await runJob(`${vurl()}/fix`, { feedback: 'make 0:01 shorter', unlock: false });
    expect(j.status).toBe('done');
    expect(j.result).toEqual({ status: 'refused', code: 'MODEL_REFUSED', reason: 'Cannot make it shorter without unlock.', needsUnlock: true });
    expect((await video()).latest.n).toBe(1);
  }, 30_000);

  test('an applied fix saves version 2 that differs from v1 only in the target', async () => {
    const before = renders.length;
    model = new FakeModel([turn('submit_patch', { targets: ['s2'], summary: 'Swapped the shot.',
      ops: [{ op: 'swapSource', segmentId: 's2', source: 'raw/cảnh 1.mp4', sourceIn: 2, sourceOut: 3, speed: 1 }] })]);
    const j = await runJob(`${vurl()}/fix`, { feedback: 'swap the shot at 0:01', unlock: false });
    expect(j.status, JSON.stringify(j.error)).toBe('done');
    expect(j.result).toMatchObject({ status: 'applied', version: 2, targets: ['s2'], changed: ['s2'], output: { url: expect.stringMatching(/\/v2\.mp4$/) } });
    expect(renders.length).toBe(before + 1);
    const v = await video();
    const v1 = planned();
    const v2 = v.latest.timeline as Timeline;
    expect(v2.segments.filter(s => s.id !== 's2')).toEqual(v1.segments.filter(s => s.id !== 's2'));
    expect(v2.segments[1].source).toBe('raw/cảnh 1.mp4');
    expect({ ...v2, segments: [] }).toEqual({ ...v1, segments: [] });
  }, 30_000);

  test('approve saves a new version without re-rendering; a fix aimed at approved items is refused', async () => {
    const before = renders.length;
    for (const id of ['s2', 'c2']) {
      const r = await post(`${vurl()}/approve`, { id, approved: true });
      expect(r.statusCode, r.body).toBe(200);
    }
    expect(renders.length).toBe(before);
    const v = await video();
    expect(v.versions.map((x: { n: number; note: string }) => [x.n, x.note])).toEqual([[1, 'generated'], [2, 'fix: Swapped the shot. (changed: s2)'], [3, 'approved s2'], [4, 'approved c2']]);
    expect(v.versions[3].output.url).toMatch(/\/v2\.mp4$/);
    expect(v.latest.timeline.segments[1].approved).toBe(true);
    expect((await post(`${vurl()}/approve`, { id: 'zz', approved: true })).statusCode).toBe(400);

    model = new FakeModel([]);
    const j = await runJob(`${vurl()}/fix`, { feedback: 'swap the shot at 0:01', unlock: false });
    expect(j.result).toMatchObject({ status: 'refused', code: 'APPROVED', needsUnlock: false });
    expect((await video()).latest.n).toBe(4);
  }, 30_000);

  test('unapprove is recorded with its own note', async () => {
    await post(`${vurl()}/approve`, { id: 'c2', approved: false });
    const v = await video();
    expect(v.versions.at(-1).note).toBe('unapproved c2');
    expect(v.latest.timeline.captions[1].approved).toBe(false);
  });

  test('revert is refused while an item approved now differs in that version; nothing is saved', async () => {
    const before = renders.length;
    const j = await runJob(`${vurl()}/revert`, { version: 1 });
    expect(j.status, JSON.stringify(j.error)).toBe('done');
    expect(j.result).toEqual({ status: 'refused', code: 'APPROVED_CONFLICT', ids: ['s2'] });
    expect(renders.length).toBe(before);
    expect((await video()).latest.n).toBe(5);
  }, 30_000);

  test('revert saves the old content with the latest approvals as the newest version and renders it', async () => {
    await post(`${vurl()}/approve`, { id: 's1', approved: true }); // v6: s1 is the same in v1
    await post(`${vurl()}/approve`, { id: 's2', approved: false }); // v7
    const before = renders.length;
    const j = await runJob(`${vurl()}/revert`, { version: 1 });
    expect(j.status, JSON.stringify(j.error)).toBe('done');
    expect(j.result).toMatchObject({ status: 'applied', version: 8, output: { url: expect.stringMatching(/\/v8\.mp4$/) } });
    expect(renders.length).toBe(before + 1);
    const v = await video();
    expect(v.versions.at(-1).note).toBe('reverted to v1');
    const expected = planned();
    expected.segments[0].approved = true;
    expect(v.latest.timeline).toEqual(expected);
    expect((await post(`${vurl()}/revert`, { version: 99 })).statusCode).toBe(400);
  }, 30_000);

  test('concurrent approvals of different items on one video all persist', async () => {
    const ids = ['s1', 's3', 'c1', 'c3', 's2'];
    const res = await Promise.all(ids.map(id => post(`${vurl()}/approve`, { id, approved: true })));
    expect(res.map(r => r.statusCode)).toEqual(ids.map(() => 200));
    expect(res.map(r => r.json().version).sort((a: number, b: number) => a - b)).toEqual([9, 10, 11, 12, 13]);
    const v = await video();
    expect(v.versions.map((x: { n: number }) => x.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    const t = v.latest.timeline as Timeline;
    for (const id of ids) expect([...t.segments, ...t.captions].find(i => i.id === id)?.approved, id).toBe(true);
    expect(v.versions[12].output.url).toMatch(/\/v8\.mp4$/);
  });

  test('approve is refused while a job for that video is waiting', async () => {
    let release!: () => void;
    const blocker = queue.add('render', { projectId, videoId }, () => new Promise(r => { release = () => r(null); }));
    try {
      const r = await post(`${vurl()}/approve`, { id: 's1', approved: true });
      expect([r.statusCode, r.json().error.code]).toEqual([409, 'BUSY']);
    } finally {
      await vi.waitFor(() => expect(release).toBeDefined());
      release();
      await waitJob(blocker.id);
    }
  });
});

describe('video list', () => {
  test('GET videos lists videos newest first with their latest version and output', async () => {
    const nf = [{ instruction: 'use a red logo', source: 'prompt', reason: 'The guideline asks for a white logo.' }];
    model = new FakeModel([turn('submit_timeline', { timeline: planned(), notFollowed: nf })]);
    const j = await runJob(`/api/projects/${projectId}/videos`, { prompt: 'second take', roles, engine: 'builtin' });
    const second = (j.result as { videoId: string }).videoId;
    const list = (await get(`/api/projects/${projectId}/videos`)).json();
    expect(list.map((x: { videoId: string }) => x.videoId)).toEqual([second, videoId]);
    expect(list[0]).toEqual({ videoId: second, prompt: 'second take', engine: 'builtin', createdAt: expect.any(String), latestVersion: 1, notFollowed: nf,
      output: { url: `/media/${projectId}/.vea/videos/${second}/v1.mp4`, path: expect.any(String) } });
    expect(list[1]).toMatchObject({ videoId, prompt: '45s tour', latestVersion: 13, output: { url: expect.stringMatching(/\/v8\.mp4$/) } });
    expect(list[1].notFollowed).toEqual([]);
    expect((await get(`/api/projects/${projectId}/videos/${second}`)).json().notFollowed).toEqual(nf);
    expect((await get('/api/projects/ffffffff/videos')).statusCode).toBe(404);
  }, 30_000);
});

describe('render again', () => {
  test('a render that cannot launch the browser fails with BROWSER_UNAVAILABLE; POST render renders the latest version once', async () => {
    model = new FakeModel([turn('submit_timeline', { timeline: planned(), notFollowed: [] })]);
    renderError = new Error('Failed to launch the browser process!\n/usr/bin/chrome: not found');
    let j: Job;
    try { j = await runJob(`/api/projects/${projectId}/videos`, { prompt: 'third take', roles, engine: 'builtin' }); }
    finally { renderError = null; }
    expect([j.status, j.error?.code]).toEqual(['failed', 'BROWSER_UNAVAILABLE']);
    expect(j.error?.message).toMatch(/internet/i);
    const url = `/api/projects/${projectId}/videos/${j.videoId}`;
    const before = (await get(url)).json();
    expect([before.latest.n, before.versions[0].output]).toEqual([1, null]);

    const again = await runJob(`${url}/render`, {});
    expect(again.status, JSON.stringify(again.error)).toBe('done');
    expect(again.result).toMatchObject({ version: 1, output: { url: expect.stringMatching(/\/v1\.mp4$/) } });
    const after = (await get(url)).json();
    expect(after.versions.map((v: { n: number }) => v.n)).toEqual([1]);
    expect(after.versions[0].output.url).toMatch(/\/v1\.mp4$/);

    const twice = await post(`${url}/render`, {});
    expect([twice.statusCode, twice.json().error.code]).toEqual([409, 'ALREADY_RENDERED']);
  }, 30_000);

  test('other render failures keep their own error', async () => {
    const { toJobError } = await import('../../src/server/errors');
    const { renderFailure } = await import('../../src/server/errors');
    expect(toJobError(renderFailure(new Error('disk full'))).code).toBe('INTERNAL');
    for (const m of ["VEA_BROWSER is set to '/x' but that file does not exist", 'Could not download the browser: getaddrinfo ENOTFOUND',
      'Failed to launch the browser process', 'Error while downloading Chrome Headless Shell']) {
      expect(toJobError(renderFailure(new Error(m))).code, m).toBe('BROWSER_UNAVAILABLE');
    }
  });
});

describe('jobs', () => {
  test('GET /api/jobs lists jobs', async () => {
    const jobs = (await get('/api/jobs')).json() as Job[];
    expect(jobs.length).toBeGreaterThan(3);
    expect(jobs.every(j => typeof j.id === 'string' && typeof j.status === 'string')).toBe(true);
  });

  test('GET /api/jobs/stream sends job updates and unsubscribes on disconnect', async () => {
    const unsubscribed = vi.fn();
    const original = queue.subscribe.bind(queue);
    const spy = vi.spyOn(queue, 'subscribe').mockImplementation(fn => { const off = original(fn); return () => { unsubscribed(); off(); }; });
    const port = await listeningPort();
    try {
      const lines: string[] = [];
      const req = http.get({ host: '127.0.0.1', port, path: '/api/jobs/stream', headers: { host: `localhost:${port}` } });
      const res = await new Promise<http.IncomingMessage>(r => req.on('response', r));
      expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => lines.push(...chunk.split('\n').filter(l => l.startsWith('data: '))));
      await vi.waitFor(() => expect(spy).toHaveBeenCalled());
      const j = queue.add('render', { projectId }, async () => 'streamed');
      await vi.waitFor(() => {
        const mine = lines.map(l => JSON.parse(l.slice(6)) as Job).filter(x => x.id === j.id);
        expect(mine.map(x => x.status)).toEqual(['queued', 'running', 'done']);
      });
      req.destroy();
      await vi.waitFor(() => expect(unsubscribed).toHaveBeenCalledTimes(1));
    } finally { spy.mockRestore(); }
  });
});

describe('media', () => {
  test('serves project files, including Vietnamese names, with Range', async () => {
    const r = await get(`/media/${projectId}/raw/c%E1%BA%A3nh%201.mp4`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('video/mp4');
    const part = await get(`/media/${projectId}/raw/c%E1%BA%A3nh%201.mp4`, { range: 'bytes=0-9' });
    expect([part.statusCode, part.rawPayload.length]).toEqual([206, 10]);
    expect(part.headers['content-range']).toMatch(/^bytes 0-9\//);
  });

  test('serves a file stored under a decomposed (NFD) name at its NFC URL', async () => {
    await fs.writeFile(path.join(proj, 'reference', 'phòng.txt'.normalize('NFD')), 'NFD');
    const r = await get(`/media/${projectId}/reference/${encodeURIComponent('phòng.txt'.normalize('NFC'))}`);
    expect([r.statusCode, r.body]).toEqual([200, 'NFD']);
  });

  test('every /media response is sandboxed; SVG is a download', async () => {
    await fs.writeFile(path.join(proj, 'reference', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    for (const url of [`/media/${projectId}/raw/b.mp4`, `/media/${projectId}/reference/logo.svg`, `/media/${projectId}/raw/missing.mp4`]) {
      const r = await get(url);
      expect(r.headers['content-security-policy'], url).toBe("sandbox; default-src 'none'");
      expect(r.headers['x-content-type-options'], url).toBe('nosniff');
    }
    expect((await get(`/media/${projectId}/reference/logo.svg`)).headers['content-disposition']).toBe('attachment');
    expect((await get(`/media/${projectId}/raw/b.mp4`)).headers['content-disposition']).toBeUndefined();
  });

  test('inside .vea only videos/ and downloads/ are served', async () => {
    const analysisFiles = await fs.readdir(path.join(proj, '.vea', 'analysis'));
    expect(analysisFiles.length).toBeGreaterThan(0);
    expect((await get(`/media/${projectId}/.vea/analysis/${encodeURIComponent(analysisFiles[0])}`)).statusCode).toBe(403);
    expect((await get(`/media/${projectId}/.vea/prepare.json`)).statusCode).toBe(403);
    expect((await get(`/media/${projectId}/.vea/videos/${videoId}/v1.mp4`)).statusCode).toBe(200);
    expect((await get(`/media/${projectId}/${downloadPath}`)).statusCode).toBe(200);
  });

  test('refuses anything outside the project folder with 403', async () => {
    await fs.symlink('/etc', path.join(proj, 'escape'));
    for (const p of ['..%2F..%2F..%2Fetc%2Fpasswd', '%2e%2e/%2e%2e/%2e%2e/etc/passwd', '../../../etc/passwd', 'escape/passwd', 'escape/no-such-file', 'raw/..%5C..%5Cetc']) {
      expect(await rawGet(`/media/${projectId}/${p}`), p).toBe(403);
    }
    expect((await get(`/media/${projectId}/raw/missing.mp4`)).statusCode).toBe(404);
    expect((await get('/media/ffffffff/raw/b.mp4')).statusCode).toBe(404);
  });
});
