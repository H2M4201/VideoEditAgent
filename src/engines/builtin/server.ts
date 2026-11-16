import { createReadStream, promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
};

let openServers = 0;

/** Number of media servers currently listening (lets tests check that renders close theirs). */
export function openServerCount(): number {
  return openServers;
}

export type MediaServer = { /** e.g. http://127.0.0.1:41234 (no trailing slash) */ url: string; close(): Promise<void> };

/** Decodes a URL path into a file inside `root` (real path); 'outside' when it is malformed or escapes `root`, 'missing' when absent. */
async function resolveInside(root: string, urlPath: string): Promise<string | 'outside' | 'missing'> {
  let parts: string[];
  try { parts = urlPath.split('/').filter(Boolean).map(decodeURIComponent); } catch { return 'outside'; }
  if (parts.some((p) => p === '.' || p === '..' || /[\\/\0]/.test(p))) return 'outside';
  const inside = (real: string) => real === root || real.startsWith(root + path.sep);
  for (let n = parts.length; n >= 0; n -= 1) {
    let real: string;
    try { real = await fs.realpath(path.join(root, ...parts.slice(0, n))); } catch { continue; }
    // The nearest existing ancestor decides whether a missing file would lie outside (e.g. under a symlink out of the folder).
    if (!inside(real)) return 'outside';
    return n === parts.length && real !== root ? real : 'missing';
  }
  return 'missing';
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

export type FileResponse =
  | { status: 403 | 404 | 416; headers: http.OutgoingHttpHeaders }
  | { status: 200 | 206; headers: http.OutgoingHttpHeaders; file: string; start: number; end: number; empty: boolean };

/**
 * Decides how to answer a GET for `urlPath` (still URL-encoded) under the real folder `root`:
 * 403 for anything that is malformed or resolves outside it (encoded `..`, symlinks), 404 when missing, else the byte range to send.
 */
export async function fileResponse(root: string, urlPath: string, range: string | undefined): Promise<FileResponse> {
  const file = await resolveInside(root, urlPath);
  if (file === 'outside') return { status: 403, headers: {} };
  const st = file === 'missing' ? null : await fs.stat(file).catch(() => null);
  if (file === 'missing' || !st?.isFile()) return { status: 404, headers: {} };
  const headers: http.OutgoingHttpHeaders = {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
  };
  let start = 0; let end = st.size - 1; let status: 200 | 206 = 200;
  if (range) {
    const r = parseRange(range, st.size);
    if (!r) return { status: 416, headers: { 'Content-Range': `bytes */${st.size}` } };
    ({ start, end } = r); status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  headers['Content-Length'] = st.size === 0 ? 0 : end - start + 1;
  return { status, headers, file, start, end, empty: st.size === 0 };
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
    const r = await fileResponse(root, (req.url ?? '/').split('?')[0], req.headers.range);
    res.writeHead(r.status, r.headers);
    if (!('file' in r) || req.method === 'HEAD' || r.empty) { res.end(); return; }
    const { file, start, end } = r;
    const stream = createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  openServers += 1;
  const { port } = server.address() as AddressInfo;
  let closed = false;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => {
      if (closed) { resolve(); return; }
      closed = true;
      server.closeAllConnections();
      server.close(() => { openServers -= 1; resolve(); });
    }),
  };
}
