import { promises as fs } from 'node:fs';
import path from 'node:path';
import { probeMedia, type MediaInfo } from './probe';

export type { MediaInfo };
export type ProjectScan = { raw: MediaInfo[];
  references: { media: MediaInfo[]; scripts: { path: string; text: string }[]; links: string[]; /** for logo overlays */ images: string[] };
  guidelinePath: string | null; warnings: string[] };

export class ProjectError extends Error {
  constructor(public code: 'NO_RAW_FOLDER' | 'NO_RAW_FOOTAGE' | 'NOT_A_FOLDER', message: string) { super(message); this.name = 'ProjectError'; }
}

const MEDIA_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.mp3', '.wav', '.m4a', '.aac']);
const SCRIPT_EXT = new Set(['.txt', '.md', '.srt']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const isDir = async (p: string) => (await fs.stat(p).catch(() => null))?.isDirectory() ?? false;

/** Regular files directly inside `<projectDir>/<dir>`, as NFC-normalised POSIX relative paths (real name kept for IO). */
async function listFiles(projectDir: string, dir: string): Promise<{ rel: string; real: string; abs: string }[]> {
  const entries = await fs.readdir(path.join(projectDir, dir), { withFileTypes: true }).catch(() => []);
  return entries.filter(e => e.isFile()).map(e => ({ rel: `${dir}/${e.name}`.normalize('NFC'), real: `${dir}/${e.name}`, abs: path.join(projectDir, dir, e.name) }));
}

async function probeAll(projectDir: string, files: { rel: string; real: string; abs: string }[], warnings: string[]): Promise<MediaInfo[]> {
  const results = await Promise.all(files.map(async f => {
    try { return { ...(await probeMedia(projectDir, f.real)), path: f.rel }; }
    catch (e) { warnings.push(`Cannot read ${f.rel}: ${(e as Error).message.split('\n')[0]}`); return null; }
  }));
  return results.filter((m): m is MediaInfo => m !== null).sort(byPath);
}

export async function scanProject(projectDir: string): Promise<ProjectScan> {
  if (!(await isDir(projectDir))) throw new ProjectError('NOT_A_FOLDER', `${projectDir} is not a folder`);
  if (!(await isDir(path.join(projectDir, 'raw')))) throw new ProjectError('NO_RAW_FOLDER', 'Project has no raw/ folder');
  const warnings: string[] = [];
  const ext = (f: { rel: string }) => path.extname(f.rel).toLowerCase();

  const rawFiles = (await listFiles(projectDir, 'raw')).filter(f => MEDIA_EXT.has(ext(f)));
  if (rawFiles.length === 0) throw new ProjectError('NO_RAW_FOOTAGE', 'raw/ folder has no footage');
  const raw = await probeAll(projectDir, rawFiles, warnings);
  if (raw.length === 0) throw new ProjectError('NO_RAW_FOOTAGE', `No file in raw/ could be read: ${[...warnings].sort().join('; ')}`);

  const refFiles = await listFiles(projectDir, 'reference');
  const media = await probeAll(projectDir, refFiles.filter(f => MEDIA_EXT.has(ext(f))), warnings);
  const scriptFiles = refFiles.filter(f => SCRIPT_EXT.has(ext(f)) && path.basename(f.rel).toLowerCase() !== 'links.txt');
  const scripts = (await Promise.all(scriptFiles.map(async f => ({ path: f.rel, text: await fs.readFile(f.abs, 'utf8') })))).sort(byPath);
  const images = refFiles.filter(f => IMAGE_EXT.has(ext(f))).map(f => f.rel).sort();
  const linksFile = refFiles.find(f => path.basename(f.rel).toLowerCase() === 'links.txt');
  const links = linksFile
    ? (await fs.readFile(linksFile.abs, 'utf8')).split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('http'))
    : [];

  const hasGuideline = await fs.stat(path.join(projectDir, 'guideline.md')).then(s => s.isFile(), () => false);
  warnings.sort();
  return { raw, references: { media, scripts, links, images }, guidelinePath: hasGuideline ? 'guideline.md' : null, warnings };
}
