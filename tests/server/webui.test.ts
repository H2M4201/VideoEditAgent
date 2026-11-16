import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/server/app';
import { JobQueue } from '../../src/server/jobs';
import { SettingsStore } from '../../src/server/settings';
import { registerWebUi } from '../../src/server/webui';

let tmp: string;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vea-webui-'));
  await fs.mkdir(path.join(tmp, 'ui', 'assets'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'ui', 'index.html'), '<html>app</html>');
  await fs.writeFile(path.join(tmp, 'ui', 'assets', 'a.js'), 'console.log(1)');
  await fs.writeFile(path.join(tmp, 'secret.txt'), 'secret');
  app = buildApp({ settings: new SettingsStore(path.join(tmp, 'home', 'settings.json')), queue: new JobQueue(), model: () => { throw new Error('no'); }, transcriber: () => { throw new Error('no'); } });
  registerWebUi(app, path.join(tmp, 'ui'));
});
afterAll(async () => { await app.close(); await fs.rm(tmp, { recursive: true, force: true }); });

const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: 'localhost:4317' } });

describe('registerWebUi', () => {
  test('serves index.html at / and for unknown client routes', async () => {
    for (const url of ['/', '/projects', '/result/abc']) {
      const r = await get(url);
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toContain('text/html');
      expect(r.body).toBe('<html>app</html>');
    }
  });

  test('serves built assets with their content type', async () => {
    const r = await get('/assets/a.js');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('javascript');
  });

  test('does not serve files outside the folder', async () => {
    const r = await get('/..%2Fsecret.txt');
    expect(r.body).not.toBe('secret');
    expect((await get('/%2e%2e/secret.txt')).body).not.toBe('secret');
  });

  test('unknown /api and /media paths stay JSON 404s and the API still works', async () => {
    const r = await get('/api/nope');
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('NOT_FOUND');
    expect((await get('/api/settings')).statusCode).toBe(200);
  });

  test('the Host guard still applies', async () => {
    const r = await app.inject({ method: 'GET', url: '/', headers: { host: 'evil.example' } });
    expect(r.statusCode).toBe(403);
  });
});
