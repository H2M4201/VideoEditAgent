import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { DEFAULT_SETTINGS, maskApiKey, SettingsStore } from '../../src/server/settings';

const tempFile = async () => path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'vea-settings-')), 'sub', 'settings.json');

test('defaults when the file does not exist', async () => {
  const s = await new SettingsStore(await tempFile()).get();
  expect(s).toEqual({
    apiKey: '', model: 'claude-opus-5-5', language: 'vi', defaultEngine: 'builtin', capcutDraftsDir: '',
    whisperBinary: 'whisper-cli', whisperModel: '', ytDlpBinary: 'yt-dlp', inputPricePerMTok: 0, outputPricePerMTok: 0, projects: [],
    keySource: 'none',
  });
  expect(s).toEqual(DEFAULT_SETTINGS);
});

test('update round-trips: the key goes to .env as AI_PROVIDER_KEY, never to settings.json', async () => {
  const file = await tempFile();
  const envFile = path.join(path.dirname(file), '.env');
  await new SettingsStore(file).update({ apiKey: 'sk-ant-secret-1234', language: 'en' });
  expect(await fs.readFile(envFile, 'utf8')).toBe('AI_PROVIDER_KEY=sk-ant-secret-1234\n');
  const json = await fs.readFile(file, 'utf8');
  expect(json).not.toContain('sk-ant');
  expect(json).not.toContain('apiKey');
  expect(json).not.toContain('keySource');
  const b = await new SettingsStore(file).get();
  expect(b).toMatchObject({ apiKey: 'sk-ant-secret-1234', keySource: 'env-file', language: 'en', model: 'claude-opus-5-5' });
  expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  expect((await fs.stat(envFile)).mode & 0o777).toBe(0o600);
});

test('concurrent updates do not lose writes', async () => {
  const store = new SettingsStore(await tempFile());
  await Promise.all([store.update({ language: 'en' }), store.update({ whisperModel: '/m.bin' }), store.update({ ytDlpBinary: '/y' })]);
  expect(await store.get()).toMatchObject({ language: 'en', whisperModel: '/m.bin', ytDlpBinary: '/y' });
});

test('maskApiKey keeps only the last 4 characters', () => {
  expect(maskApiKey('sk-ant-secret-1234')).toBe('••••1234');
  expect(maskApiKey('')).toBe('');
});

test('update with a function sees the latest settings, so concurrent read-modify-writes keep every change', async () => {
  const store = new SettingsStore(await tempFile());
  const add = (id: string) => store.update(s => ({ projects: [...s.projects, { id, dir: `/${id}`, name: id }] }));
  await Promise.all([add('a'), add('b'), add('c')]);
  expect((await store.get()).projects.map(p => p.id)).toEqual(['a', 'b', 'c']);
});

describe('the AI key in .env', () => {
  let file: string, envFile: string;
  beforeEach(async () => { file = await tempFile(); envFile = path.join(path.dirname(file), '.env'); await fs.mkdir(path.dirname(file), { recursive: true }); });

  test('other .env lines survive an update, in order', async () => {
    await fs.writeFile(envFile, '# keep\nOTHER=1\n');
    await new SettingsStore(file).update({ apiKey: 'k1' });
    expect(await fs.readFile(envFile, 'utf8')).toBe('# keep\nOTHER=1\nAI_PROVIDER_KEY=k1\n');
  });

  test('an empty key removes the line', async () => {
    const store = new SettingsStore(file);
    await store.update({ apiKey: 'k1' });
    const s = await store.update({ apiKey: '' });
    expect(s).toMatchObject({ apiKey: '', keySource: 'none' });
    expect(await fs.readFile(envFile, 'utf8')).toBe('');
  });

  test('hand edits to .env apply on the next read, without a new store', async () => {
    const store = new SettingsStore(file);
    await store.update({ apiKey: 'k1' });
    await fs.writeFile(envFile, 'AI_PROVIDER_KEY="edited by hand"\n');
    expect((await store.get()).apiKey).toBe('edited by hand');
  });

  test('.env wins over the environment; the environment is used when .env has none', async () => {
    await fs.writeFile(envFile, 'AI_PROVIDER_KEY=A\n');
    expect(await new SettingsStore(file, { env: { AI_PROVIDER_KEY: 'B' } }).get()).toMatchObject({ apiKey: 'A', keySource: 'env-file' });
    await fs.writeFile(envFile, 'OTHER=1\n');
    expect(await new SettingsStore(file, { env: { AI_PROVIDER_KEY: 'B' } }).get()).toMatchObject({ apiKey: 'B', keySource: 'environment' });
  });

  test('saving other settings while the key comes from the environment writes no .env', async () => {
    const store = new SettingsStore(file, { env: { AI_PROVIDER_KEY: 'B' } });
    await store.update({ language: 'en' });
    await expect(fs.stat(envFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('an explicit envFile option is honoured', async () => {
    const other = path.join(path.dirname(file), 'elsewhere', '.env');
    const store = new SettingsStore(file, { envFile: other });
    expect(store.envFile).toBe(other);
    await store.update({ apiKey: 'k2' });
    expect(await fs.readFile(other, 'utf8')).toBe('AI_PROVIDER_KEY=k2\n');
  });

  test('migrate moves an old key out of settings.json into .env', async () => {
    await fs.writeFile(file, JSON.stringify({ apiKey: 'old', language: 'en' }));
    const store = new SettingsStore(file);
    expect(await store.migrate()).toBe('moved');
    expect(await fs.readFile(envFile, 'utf8')).toBe('AI_PROVIDER_KEY=old\n');
    const json = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(json.apiKey).toBeUndefined();
    expect(json.language).toBe('en');
    expect(await store.migrate()).toBe('none');
  });

  test('migrate never overwrites a key already in .env; it only removes the old one', async () => {
    await fs.writeFile(file, JSON.stringify({ apiKey: 'old' }));
    await fs.writeFile(envFile, 'AI_PROVIDER_KEY=new\n');
    const store = new SettingsStore(file);
    expect(await store.migrate()).toBe('removed');
    expect((await store.get()).apiKey).toBe('new');
    expect(await fs.readFile(file, 'utf8')).not.toContain('old');
  });

  test('an old apiKey in settings.json is ignored on read', async () => {
    await fs.writeFile(file, JSON.stringify({ apiKey: 'old' }));
    expect(await new SettingsStore(file).get()).toMatchObject({ apiKey: '', keySource: 'none' });
  });
});
