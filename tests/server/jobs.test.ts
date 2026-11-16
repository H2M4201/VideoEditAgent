import { expect, test } from 'vitest';
import { execa } from 'execa';
import { AgentError } from '../../src/agent/model';
import { ProjectError } from '../../src/project/scan';
import { toJobError } from '../../src/server/errors';
import { JobQueue, type Job } from '../../src/server/jobs';

const settle = (q: JobQueue, id: string) => new Promise<Job>(resolve => {
  const check = () => { const j = q.get(id)!; if (j.status === 'done' || j.status === 'failed') { off(); resolve(j); } };
  const off = q.subscribe(check);
  check();
});

test('runs jobs one at a time, in order', async () => {
  const q = new JobQueue();
  const log: string[] = [];
  const job = (name: string) => q.add('render', { projectId: 'p' }, async () => {
    log.push(`start ${name}`);
    await new Promise(r => setTimeout(r, 10));
    log.push(`end ${name}`);
    return name;
  });
  const a = job('a'); const b = job('b');
  expect(a.status).toBe('queued');
  expect((await settle(q, b.id)).result).toBe('b');
  expect(log).toEqual(['start a', 'end a', 'start b', 'end b']);
  expect(q.list().map(j => j.id)).toEqual([a.id, b.id]);
});

test('a failing job does not stop the queue', async () => {
  const q = new JobQueue();
  const a = q.add('fix', { projectId: 'p', videoId: 'v' }, async () => { throw new Error('boom'); });
  const b = q.add('render', { projectId: 'p' }, async () => 'ok');
  const done = await settle(q, b.id);
  expect(done.status).toBe('done');
  expect(q.get(a.id)).toMatchObject({ status: 'failed', videoId: 'v', error: { code: 'INTERNAL', message: 'boom' } });
});

test('the error mapper names the code', async () => {
  const q = new JobQueue({ toError: e => ({ code: 'X', message: String((e as Error).message) }) });
  const a = q.add('fix', { projectId: 'p' }, async () => { throw new Error('bad'); });
  expect((await settle(q, a.id)).error).toEqual({ code: 'X', message: 'bad' });
});

test('subscribers see queued, running (with progress) and done', async () => {
  const q = new JobQueue();
  const seen: string[] = [];
  const off = q.subscribe(j => seen.push(`${j.status}:${j.progress}:${j.message}`));
  const a = q.add('prepare', { projectId: 'p' }, async report => { report(0.5, 'half'); return { x: 1 }; });
  await settle(q, a.id);
  off();
  q.add('render', { projectId: 'p' }, async () => null);
  expect(seen).toEqual(['queued:0:', 'running:0:', 'running:0.5:half', 'done:1:half']);
});

test('get and list return copies', async () => {
  const q = new JobQueue();
  const a = q.add('render', { projectId: 'p' }, async () => 1);
  q.get(a.id)!.status = 'failed';
  expect((await settle(q, a.id)).status).toBe('done');
});

test('toJobError keeps known codes, spots a missing ffmpeg, and calls the rest INTERNAL', async () => {
  expect(toJobError(new AgentError('NO_API_KEY', 'no key'))).toEqual({ code: 'NO_API_KEY', message: 'no key' });
  expect(toJobError(new ProjectError('NO_RAW_FOLDER', 'no raw'))).toEqual({ code: 'NO_RAW_FOLDER', message: 'no raw' });
  expect(toJobError({ code: 'ENOENT', command: 'ffprobe -v error -of json x.mp4' }).code).toBe('FFMPEG_MISSING');
  const other = await execa('vea-no-such-binary', ['-v']).catch((e: unknown) => e);
  expect(toJobError(other).code).toBe('INTERNAL');
  expect(toJobError('weird')).toEqual({ code: 'INTERNAL', message: 'weird' });
});
