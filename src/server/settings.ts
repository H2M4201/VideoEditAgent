import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MODEL } from '../agent/model';
import { KEY_VAR, parseEnv, readEnvFile, setEnvValue, writeEnvFile } from './envfile';

export type ProjectEntry = { id: string; dir: string; name: string };
/** Where the AI key came from: the app's .env file, the process environment, or nowhere. */
export type KeySource = 'env-file' | 'environment' | 'none';
export type Settings = { apiKey: string; keySource: KeySource; model: string; language: 'vi' | 'en'; defaultEngine: 'builtin' | 'capcut';
  capcutDraftsDir: string; whisperBinary: string; whisperModel: string; ytDlpBinary: string;
  inputPricePerMTok: number; outputPricePerMTok: number; projects: ProjectEntry[] };

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  keySource: 'none',
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
/** The app folder's .env (next to package.json). It holds only the AI key, as AI_PROVIDER_KEY. */
export const APP_ENV_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env');

/** Fields that live only in memory: never written to settings.json. */
type Stored = Omit<Settings, 'apiKey' | 'keySource'>;
const { apiKey: _a, keySource: _b, ...DEFAULT_STORED } = DEFAULT_SETTINGS;

/** The key as the UI sees it: only its last 4 characters. */
export function maskApiKey(key: string): string {
  return key ? `••••${key.slice(-4)}` : '';
}

/**
 * Settings in a JSON file (mode 0600), except the AI key, which lives in `.env` as AI_PROVIDER_KEY.
 * Precedence for the key: `.env` > the process environment > none. `.env` is read on every get(), so
 * hand edits apply without a restart. Updates are serialised, so concurrent updates never lose a write.
 */
export class SettingsStore {
  private chain: Promise<unknown> = Promise.resolve();
  readonly envFile: string;
  private readonly env: NodeJS.ProcessEnv;

  /** Without a settings file, the real locations and environment are used; with one (tests), `.env` sits next to it and the environment is empty. */
  constructor(readonly file: string = DEFAULT_SETTINGS_FILE, opts: { envFile?: string; env?: NodeJS.ProcessEnv } = {}) {
    const custom = file !== DEFAULT_SETTINGS_FILE;
    this.envFile = opts.envFile ?? (custom ? path.join(path.dirname(file), '.env') : APP_ENV_FILE);
    this.env = opts.env ?? (custom ? {} : process.env);
  }

  async get(): Promise<Settings> {
    const { apiKey: _old, keySource: _src, ...stored } = await this.readJson();
    return { ...structuredClone(DEFAULT_SETTINGS), ...stored, ...(await this.readKey()) };
  }

  /** Merges `p` into the stored settings; an `apiKey` in the change goes to `.env` (empty removes it). Pass a function to compute the change from the latest settings inside the lock. */
  update(p: Partial<Settings> | ((current: Settings) => Partial<Settings>)): Promise<Settings> {
    const next = this.chain.then(async () => {
      const current = await this.get();
      const { apiKey, keySource: _ignored, ...rest } = typeof p === 'function' ? p(current) : p;
      if (apiKey !== undefined) await this.writeKey(apiKey);
      const { apiKey: _k, keySource: _s, ...stored } = { ...current, ...rest };
      await this.writeJson(stored);
      return this.get();
    });
    this.chain = next.catch(() => {});
    return next;
  }

  /** Moves a key left in settings.json by an older version into `.env` (unless `.env` already has one), then removes it from the JSON. */
  migrate(): Promise<'moved' | 'removed' | 'none'> {
    const next = this.chain.then(async () => {
      const raw = await this.readJson();
      if (!('apiKey' in raw)) return 'none' as const;
      const { apiKey: old, keySource: _s, ...stored } = raw;
      const hasKey = Boolean(parseEnv(await readEnvFile(this.envFile))[KEY_VAR]);
      const moved = Boolean(old) && !hasKey;
      if (moved) await this.writeKey(String(old));
      await this.writeJson({ ...structuredClone(DEFAULT_STORED), ...stored });
      return moved ? 'moved' as const : 'removed' as const;
    });
    this.chain = next.catch(() => {});
    return next;
  }

  private async readKey(): Promise<{ apiKey: string; keySource: KeySource }> {
    const fromFile = parseEnv(await readEnvFile(this.envFile))[KEY_VAR];
    if (fromFile) return { apiKey: fromFile, keySource: 'env-file' };
    const fromEnv = this.env[KEY_VAR];
    if (fromEnv) return { apiKey: fromEnv, keySource: 'environment' };
    return { apiKey: '', keySource: 'none' };
  }

  private async writeKey(key: string): Promise<void> {
    const text = await readEnvFile(this.envFile);
    const next = setEnvValue(text, KEY_VAR, key || null);
    if (next !== text || key) await writeEnvFile(this.envFile, next);
  }

  private async readJson(): Promise<Partial<Settings>> {
    let text: string;
    try { text = await fs.readFile(this.file, 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw e; }
    try { return JSON.parse(text) as Partial<Settings>; }
    catch { throw new Error(`Settings file ${this.file} is not valid JSON; fix or delete it`); }
  }

  private async writeJson(s: Partial<Stored>): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, this.file);
  }
}
