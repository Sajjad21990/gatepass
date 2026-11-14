// Serves dashboard/ on http://127.0.0.1:4173 (override the port with PORT).
// Run: node scripts/dashboard.ts
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 4173;
const ROOT = await realpath(fileURLToPath(new URL('../dashboard', import.meta.url)));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body + '\n');
}

/** Map a request path to a real file inside ROOT, or null if it is outside or missing. */
async function locate(rawUrl: string): Promise<string | null> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(rawUrl.split(/[?#]/, 1)[0]);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;
  const candidate = resolve(ROOT, '.' + sep + pathname);
  if (candidate !== ROOT && !candidate.startsWith(ROOT + sep)) return null;
  try {
    let file = await realpath(candidate);
    if ((await stat(file)).isDirectory()) file = await realpath(resolve(file, 'index.html'));
    // realpath again guards against a symlink that points out of the folder.
    if (file !== ROOT && !file.startsWith(ROOT + sep)) return null;
    return (await stat(file)).isFile() ? file : null;
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return send(res, 405, 'Method not allowed');
  }
  const file = await locate(req.url ?? '/');
  if (!file) return send(res, 404, 'Not found');
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
});

server.on('error', (err: NodeJS.ErrnoException) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is in use. Try PORT=4174 node scripts/dashboard.ts` : err.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Gatepass dashboard: http://${HOST}:${PORT}`);
  console.log(`Serving ${ROOT} (Ctrl+C to stop)`);
});
