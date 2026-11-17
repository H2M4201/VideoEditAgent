import { afterAll, beforeAll, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveOnDisk } from '../../src/project/paths';

let dir: string;
const NFD_DIR = 'thư mục'.normalize('NFD');
const NFD_FILE = 'cảnh 1.mp4'.normalize('NFD');
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vea-paths-'));
  await fs.mkdir(path.join(dir, NFD_DIR));
  await fs.writeFile(path.join(dir, NFD_DIR, NFD_FILE), 'x');
  await fs.writeFile(path.join(dir, 'plain.txt'), 'x');
});
afterAll(() => fs.rm(dir, { recursive: true, force: true }));

test('a path that exists as given is returned as is', async () => {
  expect(await resolveOnDisk(dir, 'plain.txt')).toBe(path.join(dir, 'plain.txt'));
});

test('an NFC path finds decomposed (NFD) names on disk, segment by segment', async () => {
  const rel = `${NFD_DIR}/${NFD_FILE}`.normalize('NFC');
  expect(rel).not.toBe(`${NFD_DIR}/${NFD_FILE}`);
  const abs = await resolveOnDisk(dir, rel);
  expect(abs).toBe(path.join(dir, NFD_DIR, NFD_FILE));
  expect(await fs.readFile(abs, 'utf8')).toBe('x');
});

test('a missing path comes back as given', async () => {
  expect(await resolveOnDisk(dir, 'raw/none.mp4')).toBe(path.join(dir, 'raw', 'none.mp4'));
});
