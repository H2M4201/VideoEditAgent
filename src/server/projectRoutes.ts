import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { VersionStore } from '../core/versions';
import type { Engine } from '../engines/types';
import { createFromStarter, STARTERS } from '../project/guideline';
import type { Role } from '../project/roles';
import { scanProject } from '../project/scan';
import type { AppDeps } from './app';
import { AppError, parseBody } from './errors';
import type { Job, JobMeta, Report } from './jobs';
import { approveItem, describeVideo, ensureFfmpeg, preparedPaths, readVideoMeta, runFix, runGenerate, runPrepare, runRevert,
  videoDir, type JobDeps } from './pipeline';
import type { ProjectEntry } from './settings';

const ROLES: [Role, ...Role[]] = ['narration', 'music', 'style', 'script', 'ignore'];
const VIDEO_ID = /^[a-z0-9]{1,40}$/;

const RegisterBody = z.object({ dir: z.string().refine(d => path.isAbsolute(d), 'must be an absolute folder path') });
const GuidelineBody = z.object({ starter: z.enum(STARTERS), lang: z.enum(['vi', 'en']) });
const PrepareBody = z.object({ prompt: z.string() });
const RoleBody = z.object({ path: z.string(), role: z.enum(ROLES), useAudio: z.boolean(), decidedBy: z.enum(['guideline', 'prompt', 'guess']), reason: z.string() });
const VideosBody = z.object({ prompt: z.string(), roles: z.array(RoleBody), engine: z.string().optional() });
const ApproveBody = z.object({ id: z.string(), approved: z.boolean() });
const FixBody = z.object({ feedback: z.string().min(1), unlock: z.boolean().default(false) });
const RevertBody = z.object({ version: z.number().int().min(1) });

/** Stable id of a project folder: hash of its absolute (real) path. */
const projectId = (dir: string) => createHash('sha256').update(dir).digest('hex').slice(0, 16);
const newVideoId = () => `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;

export function registerProjectRoutes(app: FastifyInstance, deps: AppDeps & { engines: (id: string) => Engine }): void {
  async function project(id: string): Promise<ProjectEntry> {
    const p = (await deps.settings.get()).projects.find(x => x.id === id);
    if (!p) throw new AppError('PROJECT_NOT_FOUND', 'Unknown project', 404);
    return p;
  }
  async function video(p: ProjectEntry, vid: string): Promise<string> {
    if (!VIDEO_ID.test(vid) || !(await readVideoMeta(p.dir, vid))) throw new AppError('VIDEO_NOT_FOUND', 'Unknown video', 404);
    return vid;
  }
  /** Queues a job body; settings are read when the job starts, so it sees the latest ones. */
  function enqueue(reply: FastifyReply, kind: Job['kind'], meta: JobMeta, run: (d: JobDeps, report: Report) => Promise<unknown>) {
    const job = deps.queue.add(kind, meta, async report => run({ settings: await deps.settings.get(), model: deps.model,
      transcriber: deps.transcriber, engines: deps.engines, ytDlpRun: deps.ytDlpRun }, report));
    return reply.code(202).send({ job });
  }
  type P = { id: string; vid: string };

  app.post('/api/projects', async req => {
    const { dir } = parseBody(RegisterBody, req.body);
    await ensureFfmpeg();
    const real = await fs.realpath(dir).catch(() => path.resolve(dir));
    const scan = await scanProject(real);
    const id = projectId(real);
    const { projects } = await deps.settings.get();
    let entry = projects.find(x => x.id === id);
    if (!entry) {
      entry = { id, dir: real, name: path.basename(real) };
      await deps.settings.update({ projects: [...projects, entry] });
    }
    return { project: entry, scan };
  });

  app.get('/api/projects', async () => (await deps.settings.get()).projects);

  app.post('/api/projects/:id/guideline', async req => {
    const p = await project((req.params as P).id);
    const { starter, lang } = parseBody(GuidelineBody, req.body);
    try { await createFromStarter(p.dir, starter, lang); }
    catch (e) { if ((e as Error).message === 'guideline exists') throw new AppError('GUIDELINE_EXISTS', 'This project already has a guideline.md', 409); throw e; }
    return { ok: true };
  });

  app.post('/api/projects/:id/prepare', async (req, reply) => {
    const p = await project((req.params as P).id);
    const { prompt } = parseBody(PrepareBody, req.body);
    return enqueue(reply, 'prepare', { projectId: p.id }, (d, report) => runPrepare(p, prompt, d, report));
  });

  app.post('/api/projects/:id/videos', async (req, reply) => {
    const p = await project((req.params as P).id);
    const body = parseBody(VideosBody, req.body);
    const known = await preparedPaths(p.dir);
    if (!known) throw new AppError('NOT_PREPARED', 'Prepare the project first');
    const seen = new Set<string>();
    for (const r of body.roles) {
      if (!known.includes(r.path)) throw new AppError('BAD_ROLES', `${r.path} is not a reference file of this project`);
      if (seen.has(r.path)) throw new AppError('BAD_ROLES', `${r.path} is listed twice`);
      seen.add(r.path);
    }
    const roles = body.roles.map(r => ({ ...r, useAudio: r.role === 'style' && r.useAudio }));
    const engineId = body.engine ?? (await deps.settings.get()).defaultEngine;
    let engine: Engine;
    try { engine = deps.engines(engineId); } catch { throw new AppError('ENGINE_UNAVAILABLE', `Engine ${engineId} is not available`); }
    const avail = await engine.availability();
    if (!avail.available) throw new AppError('ENGINE_UNAVAILABLE', avail.reason ?? `Engine ${engineId} is not available`);
    const videoId = newVideoId();
    return enqueue(reply, 'generate', { projectId: p.id, videoId },
      (d, report) => runGenerate(p, { videoId, prompt: body.prompt, roles, engine: engineId }, d, report));
  });

  app.get('/api/projects/:id/videos/:vid', async req => {
    const p = await project((req.params as P).id);
    return describeVideo(p, await video(p, (req.params as P).vid));
  });

  app.post('/api/projects/:id/videos/:vid/approve', async req => {
    const p = await project((req.params as P).id);
    const vid = await video(p, (req.params as P).vid);
    const { id, approved } = parseBody(ApproveBody, req.body);
    // A queued fix or revert works from the latest version; approving under it would be lost or race it.
    if (deps.queue.list().some(j => j.projectId === p.id && j.videoId === vid && (j.status === 'queued' || j.status === 'running'))) {
      throw new AppError('BUSY', 'This video has a job in progress; approve after it finishes', 409);
    }
    return approveItem(p, vid, id, approved);
  });

  app.post('/api/projects/:id/videos/:vid/fix', async (req, reply) => {
    const p = await project((req.params as P).id);
    const vid = await video(p, (req.params as P).vid);
    const body = parseBody(FixBody, req.body);
    return enqueue(reply, 'fix', { projectId: p.id, videoId: vid }, (d, report) => runFix(p, vid, body, d, report));
  });

  app.post('/api/projects/:id/videos/:vid/revert', async (req, reply) => {
    const p = await project((req.params as P).id);
    const vid = await video(p, (req.params as P).vid);
    const { version } = parseBody(RevertBody, req.body);
    if (!(await new VersionStore(videoDir(p.dir, vid)).list()).some(v => v.n === version)) {
      throw new AppError('UNKNOWN_VERSION', `Version ${version} does not exist`);
    }
    return enqueue(reply, 'render', { projectId: p.id, videoId: vid }, (d, report) => runRevert(p, vid, version, d, report));
  });
}
