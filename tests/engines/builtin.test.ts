import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { builtinEngine } from '../../src/engines/builtin/render';
import { openServerCount, serveFolder } from '../../src/engines/builtin/server';
import { fitCaptionSize } from '../../src/engines/builtin/remotion/Captions';
import { fontStack, mediaUrl } from '../../src/engines/builtin/remotion/media';
import { probeMedia } from '../../src/project/probe';
import type { Timeline } from '../../src/core/timeline';
import { makeProject } from '../fixtures/make';
import { makeTimeline } from '../helpers/timeline';

const RENDER_TIMEOUT = 180_000;
const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true }))); });

/** 2-second timeline: two 1 s segments from the given raw clips, music track from reference/track.mp3. */
function twoSecondTimeline(a: string, b: string): Timeline {
  const t = makeTimeline(2, 30);
  t.segments[0].source = `raw/${a}`;
  t.segments[1].source = `raw/${b}`;
  t.audio = [{ id: 'm1', kind: 'music', source: 'reference/track.mp3', startFrame: 0, sourceIn: 0, gain: 0.3 }];
  return t;
}

/** Average luma (YAVG) of the frame at `sec`. */
async function frameLuma(file: string, sec: number): Promise<number> {
  const { stderr } = await execa('ffmpeg', ['-v', 'info', '-ss', String(sec), '-i', file, '-frames:v', '1',
    '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-']);
  const m = /YAVG=([\d.]+)/.exec(stderr);
  if (!m) throw new Error(`no YAVG in ffmpeg output: ${stderr}`);
  return Number(m[1]);
}

/** Average chroma red (VAVG) of an 80x80 crop at (x, y) of the frame at `sec`. */
async function cropRedness(file: string, sec: number, x: number, y: number): Promise<number> {
  const { stderr } = await execa('ffmpeg', ['-v', 'info', '-ss', String(sec), '-i', file, '-frames:v', '1',
    '-vf', `crop=80:80:${x}:${y},signalstats,metadata=print:key=lavfi.signalstats.VAVG`, '-f', 'null', '-']);
  const m = /VAVG=([\d.]+)/.exec(stderr);
  if (!m) throw new Error(`no VAVG in ffmpeg output: ${stderr}`);
  return Number(m[1]);
}

/** Mean audio volume in dB (very negative for silence). */
async function meanVolumeDb(file: string): Promise<number> {
  const { stderr } = await execa('ffmpeg', ['-v', 'info', '-i', file, '-af', 'volumedetect', '-f', 'null', '-']);
  const m = /mean_volume: (-?[\d.]+|-inf) dB/.exec(stderr);
  if (!m) throw new Error(`no mean_volume in ffmpeg output: ${stderr}`);
  return m[1] === '-inf' ? -Infinity : Number(m[1]);
}

describe('builtin engine render', () => {
  let projectDir: string;
  let outDir: string;
  beforeAll(async () => {
    projectDir = await makeProject({ music: true });
    dirs.push(projectDir);
    outDir = path.join(projectDir, 'out', 'nested'); // does not exist yet
  }, RENDER_TIMEOUT);

  test('renders a 1080x1920 30fps mp4 of the timeline length', async () => {
    const timeline = twoSecondTimeline('a.mp4', 'b.mp4');
    const progress: number[] = [];
    const r = await builtinEngine.render({ projectDir, timeline, outDir, name: 'v1', onProgress: (p) => progress.push(p) });
    expect(r).toEqual({ kind: 'mp4', path: path.join(outDir, 'v1.mp4') });
    const m = await probeMedia(outDir, 'v1.mp4');
    expect([m.width, m.height, m.fps]).toEqual([1080, 1920, 30]);
    expect(m.durationSec).toBeCloseTo(timeline.durationFrames / 30, 1);
    expect(m.hasAudio).toBe(true);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((p) => p >= 0 && p <= 1)).toBe(true);
    expect(await frameLuma(r.path, 0.5)).toBeGreaterThan(16);
    expect(await meanVolumeDb(r.path)).toBeGreaterThan(-60);
  }, RENDER_TIMEOUT);

  test('renders a caption, fade, pushIn, music and title overlay', async () => {
    const timeline = twoSecondTimeline('a.mp4', 'b.mp4');
    timeline.segments[0].effects = [{ type: 'pushIn' }];
    timeline.segments[1].transitionIn = { type: 'fade', frames: 10 };
    timeline.segments[1].crop = 'contain';
    timeline.captions = [{
      id: 'c1', text: 'Căn hộ đẹp ở Hà Nội', startFrame: 0, endFrame: 60, animation: 'word', approved: false,
      words: [
        { text: 'Căn', startFrame: 0, endFrame: 12 }, { text: 'hộ', startFrame: 12, endFrame: 24 },
        { text: 'đẹp', startFrame: 24, endFrame: 36 }, { text: 'ở', startFrame: 36, endFrame: 48 },
        { text: 'Hà Nội', startFrame: 48, endFrame: 60 },
      ],
    }];
    timeline.overlays = [{ id: 'o1', kind: 'title', text: 'Nhà mới', startFrame: 0, endFrame: 60, position: 'top-left' }];
    const r = await builtinEngine.render({ projectDir, timeline, outDir, name: 'rich' });
    const m = await probeMedia(outDir, 'rich.mp4');
    expect(m.durationSec).toBeCloseTo(2, 1);
    expect(m.hasAudio).toBe(true);
    expect(await frameLuma(r.path, 1.5)).toBeGreaterThan(16);
  }, RENDER_TIMEOUT);

  test('renders a logo overlay from an image in reference/', async () => {
    await execa('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:size=128x128', '-frames:v', '1',
      path.join(projectDir, 'reference', 'logo.png')]);
    const timeline = twoSecondTimeline('a.mp4', 'b.mp4');
    timeline.overlays = [{ id: 'o1', kind: 'logo', source: 'reference/logo.png', startFrame: 0, endFrame: 60, position: 'top-left' }];
    const r = await builtinEngine.render({ projectDir, timeline, outDir, name: 'logo' });
    // The logo is about 130 px wide at a 54 px margin; the bottom-right corner has footage only.
    expect(await cropRedness(r.path, 1, 70, 70)).toBeGreaterThan(200);
    expect(await cropRedness(r.path, 1, 900, 1700)).toBeLessThan(200);
  }, RENDER_TIMEOUT);

  test('closes the media server when the browser fails to launch', async () => {
    const saved = process.env.VEA_BROWSER;
    process.env.VEA_BROWSER = path.join(projectDir, 'no-such-browser');
    try {
      await expect(builtinEngine.render({ projectDir, timeline: twoSecondTimeline('a.mp4', 'b.mp4'), outDir, name: 'nobrowser' }))
        .rejects.toThrow();
    } finally {
      if (saved === undefined) delete process.env.VEA_BROWSER; else process.env.VEA_BROWSER = saved;
    }
    expect(openServerCount()).toBe(0);
  }, RENDER_TIMEOUT);

  test('renders a source stored under a decomposed (NFD) name from its NFC timeline path', async () => {
    const nfdDir = await makeProject({ rawNames: ['cảnh 1.mp4'.normalize('NFD'), 'b.mp4'], music: true });
    dirs.push(nfdDir);
    const timeline = twoSecondTimeline('cảnh 1.mp4'.normalize('NFC'), 'b.mp4');
    const r = await builtinEngine.render({ projectDir: nfdDir, timeline, outDir: path.join(nfdDir, 'out'), name: 'nfd' });
    expect(await frameLuma(r.path, 0.5)).toBeGreaterThan(16);
  }, RENDER_TIMEOUT);

  test('renders sources with Vietnamese names and spaces', async () => {
    const vnDir = await makeProject({ rawNames: ['cảnh 1.mp4', 'phòng khách.mp4'], music: true });
    dirs.push(vnDir);
    const timeline = twoSecondTimeline('cảnh 1.mp4', 'phòng khách.mp4');
    const r = await builtinEngine.render({ projectDir: vnDir, timeline, outDir: path.join(vnDir, 'out'), name: 'bản 1' });
    expect(r.kind).toBe('mp4');
    expect((await probeMedia(path.join(vnDir, 'out'), 'bản 1.mp4')).durationSec).toBeCloseTo(2, 1);
  }, RENDER_TIMEOUT);
});

function rawGet(port: number, rawPath: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, headers }, (res) => {
      let body = '';
      res.setEncoding('latin1');
      res.on('data', (c: string) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('media server', () => {
  let root: string;
  let proj: string;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'vea-serve-'));
    dirs.push(root);
    proj = path.join(root, 'proj');
    await fs.mkdir(path.join(proj, 'raw'), { recursive: true });
    await fs.writeFile(path.join(proj, 'raw', 'cảnh 1.txt'), '0123456789abcdef');
    await fs.mkdir(path.join(proj, 'thư mục'.normalize('NFD')));
    await fs.writeFile(path.join(proj, 'thư mục'.normalize('NFD'), 'phòng.txt'.normalize('NFD')), 'NFD file');
    await fs.writeFile(path.join(root, 'secret.txt'), 'SECRET');
    await fs.symlink(path.join(root, 'secret.txt'), path.join(proj, 'link.txt'));
  });

  /** Port and token path prefix of a running media server. */
  const where = (s: { url: string }) => ({ port: Number(new URL(s.url).port), prefix: new URL(s.url).pathname });

  test('serves project files with Range support on loopback', async () => {
    const s = await serveFolder(proj);
    try {
      expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);
      const { port, prefix } = where(s);
      const p = prefix + '/raw/' + encodeURIComponent('cảnh 1.txt');
      const full = await rawGet(port, p);
      expect([full.status, full.body]).toEqual([200, '0123456789abcdef']);
      const part = await rawGet(port, p, { Range: 'bytes=2-5' });
      expect([part.status, part.body, part.headers['content-range']]).toEqual([206, '2345', 'bytes 2-5/16']);
    } finally { await s.close(); }
  });

  test('serves a file stored under decomposed (NFD) names when asked for its NFC path', async () => {
    const s = await serveFolder(proj);
    try {
      const { port, prefix } = where(s);
      const p = prefix + '/' + ['thư mục', 'phòng.txt'].map(x => encodeURIComponent(x.normalize('NFC'))).join('/');
      expect(await rawGet(port, p)).toMatchObject({ status: 200, body: 'NFD file' });
    } finally { await s.close(); }
  });

  test('refuses requests that resolve outside the project folder', async () => {
    const s = await serveFolder(proj);
    try {
      const { port, prefix } = where(s);
      for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/raw/..%2F..%2Fsecret.txt', '/link.txt']) {
        const r = await rawGet(port, prefix + p);
        expect(r.status, p).toBeGreaterThanOrEqual(400);
        expect(r.body).not.toContain('SECRET');
      }
    } finally { await s.close(); }
  });
});

describe('media server access', () => {
  let proj: string;
  beforeAll(async () => {
    proj = await fs.mkdtemp(path.join(os.tmpdir(), 'vea-serve2-'));
    dirs.push(proj);
    await fs.mkdir(path.join(proj, 'raw'));
    await fs.writeFile(path.join(proj, 'raw', 'a.txt'), 'A');
    for (const d of ['analysis', 'downloads', 'videos']) {
      await fs.mkdir(path.join(proj, '.vea', d), { recursive: true });
      await fs.writeFile(path.join(proj, '.vea', d, 'f.mp4'), d);
    }
    await fs.writeFile(path.join(proj, '.vea', 'prepare.json'), '{}');
  });
  const where = (s: { url: string }) => ({ port: Number(new URL(s.url).port), prefix: new URL(s.url).pathname });

  test('refuses a request whose Host is not 127.0.0.1 or localhost on its port (403)', async () => {
    const s = await serveFolder(proj);
    try {
      const { port, prefix } = where(s);
      for (const host of ['evil.example', `evil.example:${port}`, '127.0.0.1:1', `localhost.evil:${port}`]) {
        const r = await rawGet(port, `${prefix}/raw/a.txt`, { Host: host });
        expect([r.status, r.body], host).toEqual([403, '']);
      }
      for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
        expect((await rawGet(port, `${prefix}/raw/a.txt`, { Host: host })).body, host).toBe('A');
      }
    } finally { await s.close(); }
  });

  test('serves only under its random token path; anything else is 404', async () => {
    const s = await serveFolder(proj);
    const other = await serveFolder(proj);
    try {
      const { port, prefix } = where(s);
      expect(prefix).not.toBe(where(other).prefix);
      for (const p of ['/raw/a.txt', `${where(other).prefix}/raw/a.txt`, `${prefix}raw/a.txt`, `${prefix.slice(0, -1)}/raw/a.txt`]) {
        const r = await rawGet(port, p);
        expect([r.status, r.body], p).toEqual([404, '']);
      }
      expect((await rawGet(port, `${prefix}/raw/a.txt`)).status).toBe(200);
    } finally { await s.close(); await other.close(); }
  });

  test('inside .vea/ only downloads/ is served', async () => {
    const s = await serveFolder(proj);
    try {
      const { port, prefix } = where(s);
      for (const p of ['/.vea/analysis/f.mp4', '/.vea/videos/f.mp4', '/.vea/prepare.json']) {
        const r = await rawGet(port, prefix + p);
        expect(r.status, p).toBe(403);
        expect(r.body).toBe('');
      }
      expect((await rawGet(port, `${prefix}/.vea/downloads/f.mp4`)).body).toBe('downloads');
    } finally { await s.close(); }
  });
});

describe('composition helpers', () => {
  test('media URLs encode each path part', () => {
    expect(mediaUrl('http://127.0.0.1:1', 'raw/cảnh 1#?.mp4')).toBe(`http://127.0.0.1:1/raw/${encodeURIComponent('cảnh 1#?.mp4')}`);
  });
  test('font stack falls back to Be Vietnam Pro then sans-serif', () => {
    expect(fontStack('Be Vietnam Pro')).toBe('"Be Vietnam Pro", sans-serif');
    expect(fontStack('Roboto')).toBe('"Roboto", "Be Vietnam Pro", sans-serif');
  });
  test('captions shrink to fit but not below 60% of captionSize', () => {
    expect(fitCaptionSize('Căn hộ đẹp', 64)).toBe(64);
    const long = 'Căn hộ hai phòng ngủ view sông Hồng nội thất đầy đủ giá tốt nhất khu vực';
    const s = fitCaptionSize(long, 64);
    expect(s).toBeLessThan(64);
    expect(s).toBeGreaterThanOrEqual(64 * 0.6);
    expect(fitCaptionSize(long.repeat(10), 64)).toBe(Math.ceil(64 * 0.6));
  });
});
