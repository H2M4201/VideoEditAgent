import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type { execa } from 'execa';
import { z } from 'zod';
import type { AgentModel } from '../agent/model';
import type { Transcriber } from '../analysis';
import { fileResponse } from '../engines/builtin/server';
import { getEngine } from '../engines/registry';
import type { Engine } from '../engines/types';
import { ProjectError } from '../project/scan';
import { AppError, parseBody, toJobError } from './errors';
import type { JobQueue } from './jobs';
import { registerProjectRoutes } from './projectRoutes';
import { maskApiKey, type Settings, type SettingsStore } from './settings';

export type AppDeps = { settings: SettingsStore; queue: JobQueue; model: (s: Settings) => AgentModel; transcriber: (s: Settings) => Transcriber;
  engines?: (id: string) => Engine; ytDlpRun?: typeof execa };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const ENGINE_IDS = ['builtin', 'capcut'] as const;
const CAPCUT_PLACEHOLDER = { id: 'capcut', capabilities: null, available: false, reason: 'CapCut engine is not installed in this version.' };

const SettingsPatch = z.object({
  apiKey: z.string(), model: z.string().min(1), language: z.enum(['vi', 'en']), defaultEngine: z.enum(ENGINE_IDS),
  capcutDraftsDir: z.string(), whisperBinary: z.string().min(1), whisperModel: z.string(), ytDlpBinary: z.string().min(1),
  inputPricePerMTok: z.number().min(0), outputPricePerMTok: z.number().min(0),
}).partial(); // unknown keys (incl. projects, managed by /api/projects) are dropped

const sendError = (reply: FastifyReply, status: number, code: string, message: string) => reply.code(status).send({ error: { code, message } });
const publicSettings = (s: Settings) => ({ ...s, apiKey: maskApiKey(s.apiKey) });

/** Inside a project's .vea folder only renders and downloaded samples are served (not analysis, settings-like state). */
function servable(rel: string): boolean {
  const parts = rel.split(path.sep);
  return parts[0] !== '.vea' || (parts.length > 2 && (parts[1] === 'videos' || parts[1] === 'downloads'));
}

function hostnameOf(host: string): string {
  try { return new URL(`http://${host}`).hostname; } catch { return ''; }
}

/** The local API the web UI talks to. Listen on 127.0.0.1 only. */
export function buildApp(deps: AppDeps): FastifyInstance {
  const engines = deps.engines ?? getEngine;
  // forceCloseConnections: SSE streams never go idle, so close() must end them.
  const app = Fastify({ forceCloseConnections: true });

  // DNS-rebinding and cross-site guard: only our own host name, only same-origin browser requests.
  app.addHook('onRequest', async (req, reply) => {
    const host = (req.headers.host ?? '').toLowerCase();
    if (!LOCAL_HOSTS.has(hostnameOf(host))) return sendError(reply, 403, 'FORBIDDEN', 'Open the app at http://localhost or http://127.0.0.1');
    const origin = req.headers.origin?.toLowerCase();
    if (origin !== undefined && origin !== `http://${host}`) return sendError(reply, 403, 'FORBIDDEN', 'Cross-origin requests are not allowed');
    if (req.headers['sec-fetch-site'] === 'cross-site' && req.headers['sec-fetch-mode'] !== 'navigate') {
      return sendError(reply, 403, 'FORBIDDEN', 'Cross-site requests are not allowed');
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return sendError(reply, err.status, err.code, err.message);
    if (err instanceof ProjectError) return sendError(reply, 400, err.code, err.message);
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return sendError(reply, status, 'BAD_REQUEST', (err as Error).message);
    const e = toJobError(err);
    return sendError(reply, 500, e.code, e.message);
  });
  app.setNotFoundHandler((_req, reply) => sendError(reply, 404, 'NOT_FOUND', 'Not found'));

  app.get('/api/settings', async () => publicSettings(await deps.settings.get()));
  app.put('/api/settings', async req => {
    const patch = parseBody(SettingsPatch, req.body);
    const current = await deps.settings.get();
    // The UI sends back the masked key it was shown; that means "unchanged".
    if (patch.apiKey !== undefined && patch.apiKey === maskApiKey(current.apiKey)) delete patch.apiKey;
    return publicSettings(await deps.settings.update(patch));
  });

  app.get('/api/engines', async () => Promise.all(ENGINE_IDS.map(async id => {
    let engine: Engine;
    try { engine = engines(id); }
    catch (e) { return id === 'capcut' ? CAPCUT_PLACEHOLDER : { id, capabilities: null, available: false, reason: (e as Error).message }; }
    return { id, capabilities: engine.capabilities(), ...(await engine.availability()) };
  })));

  app.get('/api/jobs', async () => deps.queue.list());
  app.get('/api/jobs/stream', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const send = (j: unknown) => { res.write(`data: ${JSON.stringify(j)}\n\n`); };
    for (const j of deps.queue.list()) send(j);
    const unsubscribe = deps.queue.subscribe(send);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    res.on('close', () => { clearInterval(ping); unsubscribe(); });
  });

  app.get('/media/:projectId/*', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const project = (await deps.settings.get()).projects.find(p => p.id === projectId);
    if (!project) return sendError(reply, 404, 'PROJECT_NOT_FOUND', 'Unknown project');
    // Use the raw (still encoded) path so encoded traversal is judged after decoding, part by part.
    const urlPath = (req.raw.url ?? '').split('?')[0];
    const rest = urlPath.slice(urlPath.indexOf('/', '/media/'.length));
    // Served files share the API's origin: never let one run script (e.g. an SVG) or be sniffed into something that does.
    reply.header('Content-Security-Policy', "sandbox; default-src 'none'").header('X-Content-Type-Options', 'nosniff');
    const root = await fs.realpath(project.dir);
    const r = await fileResponse(root, rest, req.headers.range);
    if ('file' in r && !servable(path.relative(root, r.file))) return sendError(reply, 403, 'FORBIDDEN', 'Not a served file');
    if (!('file' in r)) {
      reply.headers(r.headers);
      return r.status === 403 ? sendError(reply, 403, 'FORBIDDEN', 'Outside the project folder')
        : r.status === 404 ? sendError(reply, 404, 'NOT_FOUND', 'No such file') : reply.code(416).send();
    }
    reply.code(r.status).headers(r.headers);
    if (path.extname(r.file).toLowerCase() === '.svg') reply.header('Content-Disposition', 'attachment');
    return r.empty ? reply.send('') : reply.send(createReadStream(r.file, { start: r.start, end: r.end }));
  });

  registerProjectRoutes(app, { ...deps, engines });
  return app;
}
