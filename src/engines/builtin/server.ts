import { randomBytes } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { resolveOnDisk } from '../../project/paths';

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

export type MediaServer = { /** e.g. http://127.0.0.1:41234/<token> (no trailing slash): the base every file URL starts with */ url: string; close(): Promise<void> };

/** Decodes a URL path into a file inside `root` (real path); 'outside' when it is malformed or escapes `root`, 'missing' when absent. */
async function resolveInside(root: string, urlPath: string): Promise<string | 'outside' | 'missing'> {
  let parts: string[];
  try { parts = urlPath.split('/').filter(Boolean).map(decodeURIComponent); } catch { return 'outside'; }
  if (parts.some((p) => p === '.' || p === '..' || /[\\/\0]/.test(p))) return 'outside';
  // Timeline paths are NFC; the file may be stored under a decomposed (NFD) name. Confinement is checked on the real path below.
  const onDisk = path.relative(root, await resolveOnDisk(root, parts.join('/')));
  if (onDisk !== '') parts = onDisk.split(path.sep);
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

/** Inside the project's .vea folder a render may read only downloaded samples (never analysis, renders or settings-like state). */
function servable(rel: string): boolean {
  if (/^\.env(\..*)?$/i.test(path.basename(rel))) return false;
  const parts = rel.split(path.sep);
  return parts[0] !== '.vea' || (parts.length > 2 && parts[1] === 'downloads');
}

/**
 * Serves files under `rootDir` read-only on 127.0.0.1 (random free port) with HTTP Range support, for one render.
 * Only requests addressed to 127.0.0.1:<port> or localhost:<port> are answered (403 otherwise: DNS rebinding), and only
 * under a random token path that is part of `url` (404 otherwise), so a web page cannot guess its way in.
 * Requests that resolve outside the folder (including via symlinks), or into .vea/ other than .vea/downloads/, are refused.
 */
export async function serveFolder(rootDir: string): Promise<MediaServer> {
  const root = await fs.realpath(rootDir);
  const prefix = `/${randomBytes(16).toString('hex')}/`;
  let hosts = new Set<string>();
  const server = http.createServer((req, res) => {
    void handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!hosts.has((req.headers.host ?? '').toLowerCase())) { res.writeHead(403); res.end(); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    const urlPath = (req.url ?? '/').split('?')[0];
    if (!urlPath.startsWith(prefix)) { res.writeHead(404); res.end(); return; }
    const r = await fileResponse(root, urlPath.slice(prefix.length - 1), req.headers.range);
    if ('file' in r && !servable(path.relative(root, r.file))) { res.writeHead(403); res.end(); return; }
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
  hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  let closed = false;
  return {
    url: `http://127.0.0.1:${port}${prefix.slice(0, -1)}`,
    close: () => new Promise<void>((resolve) => {
      if (closed) { resolve(); return; }
      closed = true;
      server.closeAllConnections();
      server.close(() => { openServers -= 1; resolve(); });
    }),
  };
}
