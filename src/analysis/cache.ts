import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FileAnalysis } from './index';

export const analysisDir = (projectDir: string) => path.join(projectDir, '.vea', 'analysis');
export const framesDir = (projectDir: string) => path.join(analysisDir(projectDir), 'frames');

/** sha1 of relative path + size + mtime. */
export async function cacheKey(projectDir: string, relPath: string): Promise<string> {
  const st = await fs.stat(path.join(projectDir, ...relPath.split('/')));
  return createHash('sha1').update(`${relPath}\0${st.size}\0${st.mtimeMs}`).digest('hex');
}

/** Cached analysis, or null on miss, corrupt JSON or missing frame files. */
export async function readCache(projectDir: string, key: string): Promise<FileAnalysis | null> {
  try {
    const a = JSON.parse(await fs.readFile(path.join(analysisDir(projectDir), `${key}.json`), 'utf8')) as FileAnalysis;
    for (const s of a.shots) await fs.access(s.framePath);
    return a;
  } catch { return null; }
}

export async function writeCache(projectDir: string, key: string, a: FileAnalysis): Promise<void> {
  await fs.mkdir(analysisDir(projectDir), { recursive: true });
  await fs.writeFile(path.join(analysisDir(projectDir), `${key}.json`), JSON.stringify(a));
}
