import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import { KEY_VAR, parseEnv, readEnvFile, setEnvValue, writeEnvFile } from '../../src/server/envfile';

let tmp: string;
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vea-env-')); });

test('parses plain, export, spaced, quoted and commented lines', () => {
  expect(parseEnv('A=1\nexport B = two \nC="x # y"\nD=v # note\n# E=no\n\nF=\'q\'')).toEqual({ A: '1', B: 'two', C: 'x # y', D: 'v', F: 'q' });
});

test('CRLF files read without a trailing \\r and keep CRLF on save', () => {
  const t = 'A=1\r\nAI_PROVIDER_KEY=old\r\n';
  expect(parseEnv(t).AI_PROVIDER_KEY).toBe('old');
  expect(setEnvValue(t, KEY_VAR, 'new')).toBe('A=1\r\nAI_PROVIDER_KEY=new\r\n');
});

test('set keeps other lines and order; replaces in place', () => {
  expect(setEnvValue('# c\nA=1\nAI_PROVIDER_KEY=x\nB=2\n', KEY_VAR, 'y')).toBe('# c\nA=1\nAI_PROVIDER_KEY=y\nB=2\n');
});

test('set appends when missing, with a newline first if needed', () => {
  expect(setEnvValue('A=1', KEY_VAR, 'k')).toBe('A=1\nAI_PROVIDER_KEY=k\n');
  expect(setEnvValue('', KEY_VAR, 'k')).toBe('AI_PROVIDER_KEY=k\n');
});

test('empty or null removes the line (and duplicates)', () => {
  expect(setEnvValue('A=1\nAI_PROVIDER_KEY=x\nAI_PROVIDER_KEY=z\n', KEY_VAR, '')).toBe('A=1\n');
  expect(setEnvValue('A=1\nexport AI_PROVIDER_KEY = x\n', KEY_VAR, null)).toBe('A=1\n');
});

test('duplicates after the first are dropped when setting', () => {
  expect(setEnvValue('AI_PROVIDER_KEY=a\nB=1\nAI_PROVIDER_KEY=b\n', KEY_VAR, 'c')).toBe('AI_PROVIDER_KEY=c\nB=1\n');
});

test.each(['sk-ant-api03-AbC_d-9', 'has space', 'a#b', 'q"uote\\back', "it's"])('value %s round-trips', v => {
  expect(parseEnv(setEnvValue('', KEY_VAR, v))[KEY_VAR]).toBe(v);
});

test('write is private and atomic; read of a missing file is empty', async () => {
  const f = path.join(tmp, 'sub', '.env');
  expect(await readEnvFile(f)).toBe('');
  await writeEnvFile(f, 'A=1\n');
  expect(await readEnvFile(f)).toBe('A=1\n');
  expect((await fs.stat(f)).mode & 0o777).toBe(0o600);
  expect((await fs.readdir(path.dirname(f))).filter(n => n !== '.env')).toEqual([]);
});
