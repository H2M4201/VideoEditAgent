import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STARTERS = ['real-estate', 'vlog', 'trend'] as const;

const startersDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'starters');

/** Text of `<projectDir>/guideline.md`, or null when it is missing or blank. */
export async function loadGuideline(projectDir: string): Promise<string | null> {
  const text = await fs.readFile(path.join(projectDir, 'guideline.md'), 'utf8').catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  return text === null || text.trim() === '' ? null : text;
}

export async function createFromStarter(projectDir: string, starter: typeof STARTERS[number], lang: 'vi' | 'en'): Promise<void> {
  if (!STARTERS.includes(starter)) throw new Error(`unknown starter: ${starter}`);
  const content = await fs.readFile(path.join(startersDir, `${starter}.${lang}.md`), 'utf8');
  try { await fs.writeFile(path.join(projectDir, 'guideline.md'), content, { flag: 'wx' }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('guideline exists'); throw e; }
}
