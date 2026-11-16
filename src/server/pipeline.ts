import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { estimateCost } from '../agent/cost';
import { fixTimeline } from '../agent/fix';
import { AgentError, type AgentModel } from '../agent/model';
import { planTimeline, type NotFollowed } from '../agent/plan';
import { authorityPrompt, timelineFormat } from '../agent/prompt';
import { assignRoles } from '../agent/roles';
import { analyseProject, type FileAnalysis, type Transcriber } from '../analysis';
import { carryApprovals, setApproved } from '../core/patch';
import type { Timeline } from '../core/timeline';
import { VersionStore } from '../core/versions';
import type { Engine } from '../engines/types';
import { loadGuideline } from '../project/guideline';
import { downloadLinks, type LinkResult } from '../project/links';
import { probeMedia } from '../project/probe';
import { guessRoles, pickTimingDriver, type RoleAssignment, type TimingDriver } from '../project/roles';
import { scanProject, type ProjectScan } from '../project/scan';
import { AppError, FFMPEG_MISSING_MESSAGE, renderFailure } from './errors';
import type { Report } from './jobs';
import type { ProjectEntry, Settings } from './settings';

/** What a job body needs; `settings` are read when the job starts. */
export type JobDeps = { settings: Settings; model: (s: Settings) => AgentModel; transcriber: (s: Settings) => Transcriber;
  engines: (id: string) => Engine; ytDlpRun?: typeof execa };
export type Output = { url: string | null; path: string };
type Project = Pick<ProjectEntry, 'id' | 'dir'>;

// ---- checks ----

let ffmpegChecked: Promise<void> | null = null;

/** Fails with FFMPEG_MISSING when ffprobe or ffmpeg cannot be started (checked once per process while it succeeds). */
export function ensureFfmpeg(): Promise<void> {
  ffmpegChecked ??= (async () => {
    for (const tool of ['ffprobe', 'ffmpeg']) {
      try { await execa(tool, ['-version']); }
      catch (e) { if ((e as { code?: string }).code === 'ENOENT') throw new AppError('FFMPEG_MISSING', FFMPEG_MISSING_MESSAGE, 500); throw e; }
    }
  })().catch((e: unknown) => { ffmpegChecked = null; throw e; });
  return ffmpegChecked;
}

function requireApiKey(s: Settings): void {
  if (!s.apiKey) throw new AgentError('NO_API_KEY', 'No Anthropic API key is set. Add it in Settings.');
}

/** Turns any transcriber failure into TRANSCRIBE_FAILED, naming the settings that point at Whisper. */
function guardedTranscriber(s: Settings, t: Transcriber): Transcriber {
  return {
    async transcribe(absPath) {
      try { return await t.transcribe(absPath); }
      catch (e) {
        const why = ((e as Error).message ?? String(e)).split('\n')[0];
        throw new AppError('TRANSCRIBE_FAILED', `Transcription failed (${why}). Check the Whisper binary path setting `
          + `(whisperBinary, now "${s.whisperBinary}") and the Whisper model setting (whisperModel).`, 500);
      }
    },
  };
}

// ---- per-video lock ----

const videoLocks = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` after every earlier locked call for the same video has finished. Every read-latest -> save sequence
 * (approve, generate, fix, revert) goes through here, so no two writers base a version on the same latest.
 */
export function withVideoLock<T>(p: Project, videoId: string, fn: () => Promise<T>): Promise<T> {
  const key = `${p.id}/${videoId}`;
  const run = (videoLocks.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  videoLocks.set(key, tail);
  void tail.then(() => { if (videoLocks.get(key) === tail) videoLocks.delete(key); });
  return run;
}

// ---- files ----

const posix = (p: string) => p.split(path.sep).join('/');
const vea = (dir: string, ...rest: string[]) => path.join(dir, '.vea', ...rest);
export const videoDir = (dir: string, videoId: string) => vea(dir, 'videos', videoId);

type VideoMeta = { engine: string; prompt: string; roles: RoleAssignment[]; createdAt: string;
  /** prompt instructions the plan did not follow (absent in videos made before it was stored) */ notFollowed?: NotFollowed[];
  /** version number -> absolute path of the render that version shows */ outputs: Record<string, string> };

export async function readVideoMeta(dir: string, videoId: string): Promise<VideoMeta | null> {
  const text = await fs.readFile(path.join(videoDir(dir, videoId), 'video.json'), 'utf8').catch(() => null);
  return text === null ? null : (JSON.parse(text) as VideoMeta);
}

async function writeVideoMeta(dir: string, videoId: string, meta: VideoMeta): Promise<void> {
  await fs.mkdir(videoDir(dir, videoId), { recursive: true });
  await fs.writeFile(path.join(videoDir(dir, videoId), 'video.json'), JSON.stringify(meta, null, 2));
}

async function setOutput(dir: string, videoId: string, n: number, file: string | undefined): Promise<void> {
  if (!file) return;
  const meta = (await readVideoMeta(dir, videoId))!;
  meta.outputs[n] = file;
  await writeVideoMeta(dir, videoId, meta);
}

/** The file plus the /media URL the UI loads it from (null when the engine wrote outside the project folder). */
export function outputOf(p: Project, file: string): Output {
  const rel = path.relative(p.dir, file);
  const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  return { url: inside ? `/media/${p.id}/${posix(rel).split('/').map(encodeURIComponent).join('/')}` : null, path: file };
}

/** Role paths offered by the last prepare: the only paths a generate request may assign roles to. */
export async function preparedPaths(dir: string): Promise<string[] | null> {
  const text = await fs.readFile(vea(dir, 'prepare.json'), 'utf8').catch(() => null);
  return text === null ? null : (JSON.parse(text) as { roles: RoleAssignment[] }).roles.map(r => r.path);
}

// ---- ingest ----

type Ingested = { scan: ProjectScan; analysis: Record<string, FileAnalysis> };

/**
 * Scan (unless given), probe the downloaded references and add them to `references.media` (R7), then analyse
 * everything (cached per file). Analysis progress is reported between `from` and `to`.
 */
async function ingest(p: Project, deps: JobDeps, downloads: string[], report: Report, from: number, to: number,
  scanned?: ProjectScan): Promise<Ingested> {
  const scan = scanned ?? await scanProject(p.dir);
  for (const rel of downloads) {
    try { scan.references.media.push(await probeMedia(p.dir, rel)); }
    catch (e) { scan.warnings.push(`Cannot read ${rel}: ${(e as Error).message.split('\n')[0]}`); }
  }
  const transcriber = guardedTranscriber(deps.settings, deps.transcriber(deps.settings));
  report(from, 'Analysing footage');
  const analysis = await analyseProject(p.dir, scan, {
    transcriber, onProgress: (done, total) => report(from + ((to - from) * done) / total, `Analysing footage (${done}/${total})`),
  });
  return { scan, analysis };
}

const downloadsIn = (roles: RoleAssignment[]) => roles.map(r => r.path).filter(x => x.startsWith('.vea/downloads/'));
const rawAnalysis = ({ scan, analysis }: Ingested) => scan.raw.map(m => analysis[m.path]).filter((a): a is FileAnalysis => !!a);

/** Rough size of the generate request (system rules, prompt, guideline, transcripts, scripts) and its frames. */
function generateCost(s: Settings, prompt: string, guideline: string | null, roles: RoleAssignment[], ing: Ingested) {
  const used = [...ing.scan.raw.map(m => m.path), ...roles.filter(r => r.role !== 'ignore').map(r => r.path)];
  let frames = 0;
  let textChars = authorityPrompt(guideline).length + timelineFormat().length + prompt.length;
  for (const p of used) {
    const a = ing.analysis[p];
    const role = roles.find(r => r.path === p)?.role;
    if (a && (role === undefined || role === 'style')) frames += a.shots.length;
    if (a?.transcript && (role === undefined || role === 'narration')) textChars += a.transcript.text.length + a.transcript.words.length * 25;
  }
  for (const sc of ing.scan.references.scripts) if (roles.some(r => r.path === sc.path && r.role === 'script')) textChars += sc.text.length;
  return estimateCost({ frames, textChars, inputPricePerMTok: s.inputPricePerMTok, outputPricePerMTok: s.outputPricePerMTok });
}

// ---- jobs ----

export type PrepareResult = { roles: RoleAssignment[]; driver: TimingDriver; cost: ReturnType<typeof estimateCost>;
  linkFailures: { url: string; error: string }[]; warnings: string[] };

/** scan -> download links -> analyse -> guessRoles -> assignRoles. Saves the roles so generate can check edited ones. */
export async function runPrepare(p: Project, prompt: string, deps: JobDeps, report: Report): Promise<PrepareResult> {
  const s = deps.settings;
  requireApiKey(s);
  await ensureFfmpeg();
  report(0.02, 'Scanning the project folder');
  const scanned = await scanProject(p.dir);
  report(0.05, 'Downloading reference links');
  const links = await downloadLinks(p.dir, scanned.references.links, { ytDlp: s.ytDlpBinary, run: deps.ytDlpRun });
  const downloaded = links.flatMap(l => (l.ok ? [l.path] : []));
  const ing = await ingest(p, deps, downloaded, report, 0.15, 0.85, scanned);

  report(0.9, 'Choosing reference roles');
  const guideline = await loadGuideline(p.dir);
  // Downloads get their own default ("downloaded sample video") from the link results, so leave them out of the media list here.
  const local = { ...ing.scan, references: { ...ing.scan.references, media: ing.scan.references.media.filter(m => !downloaded.includes(m.path)) } };
  const defaults = guessRoles(local, ing.analysis, links);
  const roles = await assignRoles({ prompt, guideline, defaults }, deps.model(s));
  await fs.mkdir(vea(p.dir), { recursive: true });
  await fs.writeFile(vea(p.dir, 'prepare.json'), JSON.stringify({ roles }, null, 2));

  return {
    roles,
    driver: pickTimingDriver(roles, rawAnalysis(ing)),
    cost: generateCost(s, prompt, guideline, roles, ing),
    linkFailures: links.flatMap((l: LinkResult) => (l.ok ? [] : [{ url: l.url, error: l.error }])),
    warnings: ing.scan.warnings,
  };
}

async function render(p: Project, videoId: string, n: number, timeline: Timeline, engine: Engine, report: Report, from: number): Promise<Output> {
  report(from, 'Rendering');
  const r = await engine.render({ projectDir: p.dir, timeline, outDir: videoDir(p.dir, videoId), name: `v${n}`,
    onProgress: x => report(from + (1 - from) * x, 'Rendering') }).catch((e: unknown) => { throw renderFailure(e); });
  await setOutput(p.dir, videoId, n, r.path);
  return outputOf(p, r.path);
}

export type GenerateRequest = { videoId: string; prompt: string; roles: RoleAssignment[]; engine: string };

/** planTimeline -> save v1 -> render. */
export function runGenerate(p: Project, req: GenerateRequest, deps: JobDeps, report: Report):
  Promise<{ videoId: string; version: number; notFollowed: NotFollowed[]; output: Output }> {
  return withVideoLock(p, req.videoId, () => generate(p, req, deps, report));
}

async function generate(p: Project, req: GenerateRequest, deps: JobDeps, report: Report):
  Promise<{ videoId: string; version: number; notFollowed: NotFollowed[]; output: Output }> {
  requireApiKey(deps.settings);
  await ensureFfmpeg();
  const engine = deps.engines(req.engine);
  const ing = await ingest(p, deps, downloadsIn(req.roles), report, 0.02, 0.2);
  report(0.25, 'Planning the edit');
  const { timeline, notFollowed } = await planTimeline({ prompt: req.prompt, guideline: await loadGuideline(p.dir), scan: ing.scan,
    analysis: ing.analysis, roles: req.roles, driver: pickTimingDriver(req.roles, rawAnalysis(ing)), capabilities: engine.capabilities() },
  deps.model(deps.settings));
  await writeVideoMeta(p.dir, req.videoId, { engine: req.engine, prompt: req.prompt, roles: req.roles, createdAt: new Date().toISOString(),
    notFollowed, outputs: {} });
  const version = await new VersionStore(videoDir(p.dir, req.videoId)).save(timeline, 'generated');
  const output = await render(p, req.videoId, version, timeline, engine, report, 0.5);
  return { videoId: req.videoId, version, notFollowed, output };
}

export type FixJobResult = { status: 'refused'; reason: string; needsUnlock: boolean }
  | { status: 'applied'; version: number; targets: string[]; summary: string; output: Output };

/** fixTimeline on the latest version; on 'applied' save a new version and render it. A refusal is a result, not a failure. */
export function runFix(p: Project, videoId: string, req: { feedback: string; unlock: boolean }, deps: JobDeps, report: Report): Promise<FixJobResult> {
  return withVideoLock(p, videoId, () => fix(p, videoId, req, deps, report));
}

async function fix(p: Project, videoId: string, req: { feedback: string; unlock: boolean }, deps: JobDeps, report: Report): Promise<FixJobResult> {
  requireApiKey(deps.settings);
  await ensureFfmpeg();
  const meta = (await readVideoMeta(p.dir, videoId))!;
  const store = new VersionStore(videoDir(p.dir, videoId));
  const latest = (await store.latest())!;
  const engine = deps.engines(meta.engine);
  const ing = await ingest(p, deps, downloadsIn(meta.roles), report, 0.02, 0.2);
  report(0.25, 'Working out the fix');
  const r = await fixTimeline({ feedback: req.feedback, current: latest.timeline, guideline: await loadGuideline(p.dir), scan: ing.scan,
    analysis: ing.analysis, capabilities: engine.capabilities(), unlock: req.unlock }, deps.model(deps.settings));
  if (r.status === 'refused') return { status: 'refused', reason: r.reason, needsUnlock: r.needsUnlock };
  const version = await store.save(r.timeline, `fix: ${r.summary}`);
  const output = await render(p, videoId, version, r.timeline, engine, report, 0.5);
  return { status: 'applied', version, targets: r.targets, summary: r.summary, output };
}

export type RevertJobResult = { status: 'applied'; version: number; output: Output }
  | { status: 'refused'; code: 'APPROVED_CONFLICT'; ids: string[] };

/**
 * Saves version `n`'s content with the latest version's approvals as the newest version and renders it. Refused (nothing
 * saved) when an item approved in the latest version is missing or different in version `n`: approved items never change.
 */
export function runRevert(p: Project, videoId: string, n: number, deps: JobDeps, report: Report): Promise<RevertJobResult> {
  return withVideoLock(p, videoId, () => revert(p, videoId, n, deps, report));
}

async function revert(p: Project, videoId: string, n: number, deps: JobDeps, report: Report): Promise<RevertJobResult> {
  const meta = (await readVideoMeta(p.dir, videoId))!;
  const store = new VersionStore(videoDir(p.dir, videoId));
  const latest = (await store.latest())!;
  const r = carryApprovals(await store.load(n), latest.timeline);
  if (!r.ok) return { status: 'refused', code: 'APPROVED_CONFLICT', ids: r.conflicts };
  const version = await store.save(r.timeline, `reverted to v${n}`);
  const output = await render(p, videoId, version, r.timeline, deps.engines(meta.engine), report, 0.05);
  return { status: 'applied', version, output };
}

/** True when the latest version of the video has a render. */
export async function latestRendered(p: Project, videoId: string): Promise<boolean> {
  const latest = await new VersionStore(videoDir(p.dir, videoId)).latest();
  return !!latest && !!(await readVideoMeta(p.dir, videoId))?.outputs[latest.n];
}

/** Renders the latest version when it has no video yet (a failed render); no new version. ALREADY_RENDERED (409) when it has one. */
export function runRender(p: Project, videoId: string, deps: JobDeps, report: Report): Promise<{ version: number; output: Output }> {
  return withVideoLock(p, videoId, async () => {
    if (await latestRendered(p, videoId)) throw new AppError('ALREADY_RENDERED', 'The latest version already has a video', 409);
    const meta = (await readVideoMeta(p.dir, videoId))!;
    const latest = (await new VersionStore(videoDir(p.dir, videoId)).latest())!;
    const output = await render(p, videoId, latest.n, latest.timeline, deps.engines(meta.engine), report, 0.05);
    return { version: latest.n, output };
  });
}

/** Sets an approval on the latest timeline and saves it as a new version that shows the previous render (no re-render). */
export function approveItem(p: Project, videoId: string, id: string, approved: boolean): Promise<{ version: number }> {
  return withVideoLock(p, videoId, () => approve(p, videoId, id, approved));
}

async function approve(p: Project, videoId: string, id: string, approved: boolean): Promise<{ version: number }> {
  const store = new VersionStore(videoDir(p.dir, videoId));
  const latest = (await store.latest())!;
  if (![...latest.timeline.segments, ...latest.timeline.captions].some(i => i.id === id)) {
    throw new AppError('UNKNOWN_ITEM', `There is no segment or caption with id ${id}`);
  }
  const version = await store.save(setApproved(latest.timeline, id, approved), `${approved ? 'approved' : 'unapproved'} ${id}`);
  await setOutput(p.dir, videoId, version, (await readVideoMeta(p.dir, videoId))!.outputs[latest.n]);
  return { version };
}

/** Versions with the render each shows, plus the latest timeline. */
export async function describeVideo(p: Project, videoId: string) {
  const meta = await readVideoMeta(p.dir, videoId);
  if (!meta) return null;
  const store = new VersionStore(videoDir(p.dir, videoId));
  const versions = (await store.list()).map(v => ({ ...v, output: meta.outputs[v.n] ? outputOf(p, meta.outputs[v.n]) : null }));
  return { videoId, engine: meta.engine, prompt: meta.prompt, roles: meta.roles, notFollowed: meta.notFollowed ?? [], versions,
    latest: await store.latest() };
}

/** The project's videos, newest first, each with its latest version and the render that version shows. */
export async function listVideos(p: Project) {
  const ids = await fs.readdir(vea(p.dir, 'videos')).catch(() => [] as string[]);
  const out = [];
  for (const videoId of ids) {
    const meta = await readVideoMeta(p.dir, videoId);
    if (!meta) continue;
    const versions = await new VersionStore(videoDir(p.dir, videoId)).list();
    const latestVersion = versions.at(-1)?.n ?? null;
    const file = latestVersion === null ? undefined : meta.outputs[latestVersion];
    out.push({ videoId, prompt: meta.prompt, engine: meta.engine, createdAt: meta.createdAt, latestVersion, notFollowed: meta.notFollowed ?? [],
      output: file ? outputOf(p, file) : null });
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.videoId < b.videoId ? 1 : -1));
}
