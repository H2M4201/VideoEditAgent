import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { downloadLinks } from '../../src/project/links';

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vea-links-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

// fake run: writes the file named by the -o arg (an output template: "%%" is a literal "%", as yt-dlp reads it)
const okRun = () => vi.fn(async (_bin: string, args: string[]) => {
  fs.writeFileSync(args[args.indexOf('-o') + 1].replace(/%%/g, '%'), 'x');
  return { stdout: '' };
});
const asRun = (f: unknown) => f as never;

describe('downloadLinks', () => {
  it('downloads and returns the relative path, with yt-dlp args', async () => {
    const run = okRun();
    const url = 'https://www.youtube.com/watch?v=abc';
    const [r] = await downloadLinks(dir, [url], { ytDlp: 'yt-dlp', run: asRun(run) });
    expect(r).toEqual({ url, ok: true, path: `.vea/downloads/${sha1(url)}.mp4` });
    expect(fs.existsSync(path.join(dir, '.vea', 'downloads', `${sha1(url)}.mp4`))).toBe(true);
    const [bin, args] = run.mock.calls[0];
    expect(bin).toBe('yt-dlp');
    expect(args.slice(0, 4)).toEqual(['--ignore-config', '-f', 'mp4/best', '--no-playlist']);
    expect(args[args.length - 1]).toBe(url);
  });

  it('escapes % in the project path for the yt-dlp output template', async () => {
    const pct = path.join(dir, '100% villa %(title)s');
    fs.mkdirSync(pct);
    const run = okRun();
    const url = 'https://youtu.be/x';
    const [r] = await downloadLinks(pct, [url], { ytDlp: 'yt-dlp', run: asRun(run) });
    const [, args] = run.mock.calls[0];
    expect(args[args.indexOf('-o') + 1]).toBe(path.join(pct, '.vea', 'downloads', `${sha1(url)}.mp4`).replace(/%/g, '%%'));
    expect(r).toEqual({ url, ok: true, path: `.vea/downloads/${sha1(url)}.mp4` });
  });

  it('reports stderr on failure and still processes others, in order', async () => {
    const bad = 'https://youtu.be/bad', good = 'https://vt.tiktok.com/good';
    const run = vi.fn(async (_b: string, args: string[]) => {
      if (args.includes(bad)) throw Object.assign(new Error('failed'), { stderr: 'ERROR: video unavailable' });
      fs.writeFileSync(args[args.indexOf('-o') + 1], 'x');
      return { stdout: '' };
    });
    const res = await downloadLinks(dir, [bad, good], { ytDlp: 'yt-dlp', run: asRun(run) });
    expect(res[0]).toMatchObject({ url: bad, ok: false });
    expect((res[0] as { error: string }).error).toContain('video unavailable');
    expect(res[1]).toMatchObject({ url: good, ok: true });
  });

  it('rejects unsupported sites without calling run', async () => {
    const run = okRun();
    const urls = ['http://evil.example/x', 'https://evil-youtube.com/a', 'https://youtube.com.evil.example/a', 'ftp://youtube.com/a'];
    const res = await downloadLinks(dir, urls, { ytDlp: 'yt-dlp', run: asRun(run) });
    for (const r of res) expect(r).toMatchObject({ ok: false, error: 'unsupported site' });
    expect(run).not.toHaveBeenCalled();
  });

  it('accepts exact hosts and subdomains', async () => {
    const run = okRun();
    const urls = ['https://youtube.com/a', 'https://m.youtube.com/a', 'https://youtu.be/a', 'https://tiktok.com/a', 'https://vt.tiktok.com/a'];
    const res = await downloadLinks(dir, urls, { ytDlp: 'yt-dlp', run: asRun(run) });
    expect(res.every(r => r.ok)).toBe(true);
    expect(run).toHaveBeenCalledTimes(5);
  });

  it('unparsable url is invalid url', async () => {
    const run = okRun();
    const [r] = await downloadLinks(dir, ['not a url'], { ytDlp: 'yt-dlp', run: asRun(run) });
    expect(r).toMatchObject({ ok: false, error: 'invalid url' });
    expect(run).not.toHaveBeenCalled();
  });

  it('skips already-downloaded urls', async () => {
    const run = okRun();
    const url = 'https://youtu.be/abc';
    await downloadLinks(dir, [url], { ytDlp: 'yt-dlp', run: asRun(run) });
    const [r] = await downloadLinks(dir, [url], { ytDlp: 'yt-dlp', run: asRun(run) });
    expect(run).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: true, path: `.vea/downloads/${sha1(url)}.mp4` });
  });

  it('missing yt-dlp binary gives a clear error', async () => {
    const run = vi.fn(async () => { throw Object.assign(new Error('spawn yt-dlp ENOENT'), { code: 'ENOENT' }); });
    const [r] = await downloadLinks(dir, ['https://youtu.be/a'], { ytDlp: 'yt-dlp', run: asRun(run) });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/yt-dlp not found/);
  });

  it('run resolving without an output file is a failure', async () => {
    const run = vi.fn(async () => ({ stdout: '' }));
    const [r] = await downloadLinks(dir, ['https://youtu.be/a'], { ytDlp: 'yt-dlp', run: asRun(run) });
    expect(r.ok).toBe(false);
  });

  it('runs downloads one at a time', async () => {
    let active = 0, max = 0;
    const run = vi.fn(async (_b: string, args: string[]) => {
      active++; max = Math.max(max, active);
      await new Promise(r => setTimeout(r, 5));
      fs.writeFileSync(args[args.indexOf('-o') + 1], 'x');
      active--; return { stdout: '' };
    });
    await downloadLinks(dir, ['https://youtu.be/a', 'https://youtu.be/b'], { ytDlp: 'yt-dlp', run: asRun(run) });
    expect(max).toBe(1);
  });
});
