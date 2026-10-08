import { createServer } from 'node:http';
import { handleApi } from './api.ts';
import { createLocalDatabase } from './local-db.ts';
const db = createLocalDatabase(process.env.GRID_ATLAS_DB ?? '.state/grid-atlas.sqlite');
const port = Number(process.env.GRID_ATLAS_PORT ?? 8789);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('GRID_ATLAS_PORT must be a valid non-privileged local port.');
const server = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 16 * 1024 * 1024) { res.writeHead(413); res.end('Request too large'); return; } chunks.push(chunk); }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    // Preserve the Vite origin for same-origin checks; only trusted loopback dev callers are served.
    const origin = headers.get('origin');
    if (origin === 'http://127.0.0.1:5175' || origin === 'http://localhost:5175') { url.host = new URL(origin).host; }
    const request = new Request(url, { method: req.method, headers, ...(req.method !== 'GET' && req.method !== 'HEAD' ? { body: Buffer.concat(chunks) } : {}) });
    const response = await handleApi(request, { DB: db, LOCAL_DEV: '1', SCHEDULE_ENABLED: 'false' });
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { console.error('Local API request failed:', error instanceof Error ? error.message : 'unknown'); res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: '로컬 요청 처리 실패' })); }
});
server.on('error', error => { console.error('Grid Atlas local API could not start:', error.message); db.close(); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`Grid Atlas local API listening on 127.0.0.1:${port}`));
function close() { server.close(() => { db.close(); process.exit(0); }); }
process.on('SIGTERM', close); process.on('SIGINT', close);
