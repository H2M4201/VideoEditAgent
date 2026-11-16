import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { DEFAULT_SETTINGS, maskApiKey, SettingsStore } from '../../src/server/settings';

const tempFile = async () => path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'vea-settings-')), 'sub', 'settings.json');

test('defaults when the file does not exist', async () => {
  const s = await new SettingsStore(await tempFile()).get();
  expect(s).toEqual({
    apiKey: '', model: 'claude-opus-5-5', language: 'vi', defaultEngine: 'builtin', capcutDraftsDir: '',
    whisperBinary: 'whisper-cli', whisperModel: '', ytDlpBinary: 'yt-dlp', inputPricePerMTok: 0, outputPricePerMTok: 0, projects: [],
  });
  expect(s).toEqual(DEFAULT_SETTINGS);
});

test('update round-trips through the file, which is private to the user', async () => {
  const file = await tempFile();
  const a = new SettingsStore(file);
  await a.update({ apiKey: 'sk-ant-secret-1234', language: 'en' });
  const b = await new SettingsStore(file).get();
  expect(b.apiKey).toBe('sk-ant-secret-1234');
  expect(b.language).toBe('en');
  expect(b.model).toBe('claude-opus-5-5');
  expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
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
