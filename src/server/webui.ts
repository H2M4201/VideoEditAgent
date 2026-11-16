import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

/**
 * Serves the built web UI from `root`: files by path, and index.html for any other GET that is not /api or /media
 * (the UI picks its page from the URL hash, but a reload on a deeper path must still work).
 */
export function registerWebUi(app: FastifyInstance, root: string): void {
  const base = path.resolve(root);
  app.get('/*', async (req, reply) => {
    const urlPath = (req.raw.url ?? '/').split('?')[0];
    if (urlPath === '/api' || urlPath.startsWith('/api/') || urlPath === '/media' || urlPath.startsWith('/media/')) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    }
    let file = path.join(base, 'index.html');
    try {
      const candidate = path.join(base, decodeURIComponent(urlPath));
      const inside = candidate.startsWith(base + path.sep);
      if (inside && (await fs.stat(candidate)).isFile()) file = candidate;
    } catch { /* unknown path or bad encoding: fall back to the app shell */ }
    const body = await fs.readFile(file);
    return reply.header('Content-Type', TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream')
      .header('X-Content-Type-Options', 'nosniff').send(body);
  });
}
