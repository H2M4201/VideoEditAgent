import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execa } from 'execa';

export type LinkResult = { url: string; ok: true; path: string /*relative, .vea/downloads/<sha1>.mp4*/ } | { url: string; ok: false; error: string };

const HOSTS = ['youtube.com', 'youtu.be', 'tiktok.com'];
const hostSupported = (h: string) => HOSTS.some(d => h === d || h.endsWith('.' + d));

/** Downloads reference links with yt-dlp, one at a time, into <projectDir>/.vea/downloads. Results keep input order. */
export async function downloadLinks(projectDir: string, urls: string[],
  o: { ytDlp: string; run?: typeof execa }): Promise<LinkResult[]> {
  const run = o.run ?? execa;
  const results: LinkResult[] = [];
  for (const url of urls) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { results.push({ url, ok: false, error: 'invalid url' }); continue; }
    if (!/^https?:$/.test(parsed.protocol) || !hostSupported(parsed.hostname.toLowerCase())) {
      results.push({ url, ok: false, error: 'unsupported site' }); continue;
    }
    const rel = `.vea/downloads/${createHash('sha1').update(url).digest('hex')}.mp4`;
    const abs = path.join(projectDir, ...rel.split('/'));
    if (fs.existsSync(abs)) { results.push({ url, ok: true, path: rel }); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    try {
      await run(o.ytDlp, ['-f', 'mp4/best', '--no-playlist', '-o', abs, url]);
    } catch (e) {
      const err = e as { code?: string; stderr?: string; message?: string };
      const error = err.code === 'ENOENT' ? `yt-dlp not found (${o.ytDlp})` : (err.stderr || err.message || 'download failed');
      results.push({ url, ok: false, error }); continue;
    }
    results.push(fs.existsSync(abs) ? { url, ok: true, path: rel } : { url, ok: false, error: 'download produced no file' });
  }
  return results;
}
