import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_MODEL } from '../agent/model';

export type ProjectEntry = { id: string; dir: string; name: string };
export type Settings = { apiKey: string; model: string; language: 'vi' | 'en'; defaultEngine: 'builtin' | 'capcut';
  capcutDraftsDir: string; whisperBinary: string; whisperModel: string; ytDlpBinary: string;
  inputPricePerMTok: number; outputPricePerMTok: number; projects: ProjectEntry[] };

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  model: DEFAULT_MODEL,
  language: 'vi',
  defaultEngine: 'builtin',
  capcutDraftsDir: '',
  whisperBinary: 'whisper-cli',
  whisperModel: '',
  ytDlpBinary: 'yt-dlp',
  // While both prices are 0 the UI shows token counts only, not dollars (real defaults to be set later).
  inputPricePerMTok: 0,
  outputPricePerMTok: 0,
  projects: [],
};

export const DEFAULT_SETTINGS_FILE = path.join(os.homedir(), '.vea', 'settings.json');

/** The key as the UI sees it: only its last 4 characters. */
export function maskApiKey(key: string): string {
  return key ? `••••${key.slice(-4)}` : '';
}

/** Settings in a JSON file (mode 0600). Updates are serialised, so concurrent updates never lose a write. */
export class SettingsStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly file: string = DEFAULT_SETTINGS_FILE) {}

  async get(): Promise<Settings> {
    let text: string;
    try { text = await fs.readFile(this.file, 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(DEFAULT_SETTINGS); throw e; }
    let stored: Partial<Settings>;
    try { stored = JSON.parse(text) as Partial<Settings>; }
    catch { throw new Error(`Settings file ${this.file} is not valid JSON; fix or delete it`); }
    return { ...structuredClone(DEFAULT_SETTINGS), ...stored };
  }

  /** Merges `p` into the stored settings. Pass a function to compute the change from the latest settings inside the lock. */
  update(p: Partial<Settings> | ((current: Settings) => Partial<Settings>)): Promise<Settings> {
    const next = this.chain.then(async () => {
      const current = await this.get();
      const merged: Settings = { ...current, ...(typeof p === 'function' ? p(current) : p) };
      await this.write(merged);
      return merged;
    });
    this.chain = next.catch(() => {});
    return next;
  }

  private async write(s: Settings): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, this.file);
  }
}
