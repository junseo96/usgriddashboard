import { handleApi } from './api.ts';
import type { SqlDatabase } from './database.ts';
interface Env { DB: SqlDatabase; ASSETS: { fetch(request: Request): Promise<Response> }; ADMIN_TOKEN?: string; SCHEDULE_ENABLED?: string; SCHEDULE_CADENCE?: string; }
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = new URL(request.url).pathname.startsWith('/api/') ? await handleApi(request, env) : await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    headers.set('X-Frame-Options', 'DENY');
    return new Response(response.body, { status: response.status, headers });
  },
};
