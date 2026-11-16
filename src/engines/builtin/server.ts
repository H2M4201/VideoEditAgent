import { createReadStream, promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
};

export type MediaServer = { /** e.g. http://127.0.0.1:41234 (no trailing slash) */ url: string; close(): Promise<void> };

/** Decodes a URL path into a file inside `root` (real path), or null if it is malformed or escapes `root`. */
async function resolveInside(root: string, urlPath: string): Promise<string | null> {
  let parts: string[];
  try { parts = urlPath.split('/').filter(Boolean).map(decodeURIComponent); } catch { return null; }
  if (parts.some((p) => p === '.' || p === '..' || /[\\/\0]/.test(p))) return null;
  let real: string;
  try { real = await fs.realpath(path.join(root, ...parts)); } catch { return null; }
  return real.startsWith(root + path.sep) ? real : null;
}

/** Parses a single-range `bytes=` header. Returns null for an unsatisfiable or unsupported range. */
function parseRange(h: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number; let end: number;
  if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  return start <= end && start < size ? { start, end } : null;
}

/**
 * Serves files under `rootDir` read-only on 127.0.0.1 (random free port) with HTTP Range support.
 * Requests that resolve outside the folder (including via symlinks) are refused.
 */
export async function serveFolder(rootDir: string): Promise<MediaServer> {
  const root = await fs.realpath(rootDir);
  const server = http.createServer((req, res) => {
    void handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    const urlPath = (req.url ?? '/').split('?')[0];
    const file = await resolveInside(root, urlPath);
    const st = file ? await fs.stat(file).catch(() => null) : null;
    if (!file || !st?.isFile()) { res.writeHead(404); res.end(); return; }
    const headers: http.OutgoingHttpHeaders = {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Accept-Ranges': 'bytes',
    };
    let start = 0; let end = st.size - 1; let status = 200;
    if (req.headers.range) {
      const r = parseRange(req.headers.range, st.size);
      if (!r) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); res.end(); return; }
      ({ start, end } = r); status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
    headers['Content-Length'] = st.size === 0 ? 0 : end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || st.size === 0) { res.end(); return; }
    const stream = createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
