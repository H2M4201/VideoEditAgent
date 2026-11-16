import { afterEach, beforeEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VersionStore } from '../../src/core/versions';
import { makeTimeline } from '../helpers/timeline';

let tmp: string;
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'versions-')); });
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

test('versions are numbered and reloadable', async () => { const vs = new VersionStore(tmp);
  expect(await vs.save(makeTimeline(1), 'first')).toBe(1); expect(await vs.save(makeTimeline(2), 'fix')).toBe(2);
  expect((await vs.load(1)).segments).toHaveLength(1); expect((await vs.latest())!.n).toBe(2);
  await fs.access(path.join(tmp, 'v1.timeline.json')); });
test('latest is null when empty', async () => { expect(await new VersionStore(tmp).latest()).toBeNull(); });
test('list returns notes and timestamps in order', async () => { const vs = new VersionStore(tmp);
  await vs.save(makeTimeline(1), 'first'); await vs.save(makeTimeline(1), 'fix');
  const l = await vs.list();
  expect(l.map(v => [v.n, v.note])).toEqual([[1, 'first'], [2, 'fix']]);
  expect(Number.isNaN(Date.parse(l[0].createdAt))).toBe(false); });
test('numbering continues from an existing store', async () => { await new VersionStore(tmp).save(makeTimeline(1), 'a');
  expect(await new VersionStore(tmp).save(makeTimeline(1), 'b')).toBe(2); });
