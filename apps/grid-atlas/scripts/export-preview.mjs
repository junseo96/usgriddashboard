#!/usr/bin/env node
/** Export a real observation into a self-contained, read-only HTML preview. */
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { rolldown } from 'rolldown';
import { scoreProject, summarize } from '../shared/scoring.ts';
import { calendarDayKst } from '../shared/time.ts';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const options = { api: 'http://127.0.0.1:8789', output: resolve(appRoot, '.state/grid-atlas-preview.html') };
for (let index = 0; index < args.length; index++) {
  const option = args[index];
  if (option === '--help') {
    console.log('node scripts/export-preview.mjs [--api http://127.0.0.1:8789] [--output file.html] [--snapshot snapshot.json] [--save-snapshot snapshot.json]');
    process.exit(0);
  }
  if (!['--api', '--output', '--snapshot', '--save-snapshot'].includes(option) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Unknown or incomplete option: ${option}`);
  options[option.slice(2)] = args[++index];
}

const jsonScript = value => JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
const htmlText = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const scriptText = value => value.replace(/<\/script/gi, '<\\/script');
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);

async function getObservation() {
  const origin = new URL(options.api);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || origin.protocol !== 'http:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('--api must be a plain loopback HTTP origin. Remote credentials are not supported.');
  const exportedAt = new Date().toISOString();
  async function get(path) {
    const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(60_000), redirect: 'error' });
    if (!response.ok) throw new Error(`${path.split('?')[0]} returned HTTP ${response.status}`);
    return response.json();
  }
  const params = new URLSearchParams({ pageSize: '100', knownAt: exportedAt, asOf: calendarDayKst(exportedAt) });
  const [first, health, runs] = await Promise.all([get(`/api/dashboard?${params}`), get('/api/health'), get('/api/runs?limit=100')]);
  if (!first.available || !first.snapshot) throw new Error('A real initialized snapshot is required. Run seed:local first.');
  const pages = Math.ceil(first.total / 100);
  if (!Number.isInteger(first.total) || first.total < 1 || first.total > 100_000) throw new Error('Unexpected inventory size.');
  const scores = [...first.projects];
  for (let start = 2; start <= pages; start += 4) {
    const batch = await Promise.all(Array.from({ length: Math.min(4, pages - start + 1) }, (_, offset) => get(`/api/dashboard?${params}&page=${start + offset}`)));
    for (const page of batch) {
      if (page.snapshot?.id !== first.snapshot.id || page.snapshot?.contentHash !== first.snapshot.contentHash || page.total !== first.total || stable(page.summary) !== stable(first.summary)) throw new Error('Inventory changed during export; retry against a stable observation.');
      scores.push(...page.projects);
    }
  }
  if (scores.length !== first.total || new Set(scores.map(score => score.project.id)).size !== first.total) throw new Error('Incomplete or duplicate API inventory.');
  if (stable(summarize(scores)) !== stable(first.summary)) throw new Error('Export summary does not match the actual API.');
  if (scores.some(score => score.point !== null || score.assessedGates !== 0 || score.estimated || score.lower !== 0 || score.upper !== 100 || score.gates.length !== 5 || score.gates.some(gate => gate.status !== 'unknown' || gate.assessment !== null || gate.progress !== null || gate.points !== null))) {
    throw new Error('This initial preview exporter supports observations with no gate assessments only. Export of real evidence/history must be added before exporting an assessed inventory.');
  }
  return {
    format: 'grid-atlas-offline-preview-v1', exportedAt,
    snapshot: first.snapshot, modelVersion: first.modelVersion,
    projects: scores.map(score => score.project), sources: first.sources,
    summary: first.summary, limitations: first.limitations,
    originalHistoryCount: first.history.length, originalHistoryTruncated: first.historyTruncated,
    health, runs,
    verification: { actualApiProjectCount: scores.length, assessedGateCount: 0, allGatesVerifiedUnknown: true },
  };
}

function validateObservation(data) {
  if (data?.format !== 'grid-atlas-offline-preview-v1' || !data.snapshot || !Array.isArray(data.projects) || !Array.isArray(data.sources) || !Array.isArray(data.limitations) || !data.health || !Array.isArray(data.runs?.runs)) throw new Error('Invalid preview snapshot file. Use --save-snapshot to save an API-verified export.');
  if (!Number.isFinite(Date.parse(data.exportedAt)) || !Number.isFinite(Date.parse(data.snapshot.capturedAt)) || Date.parse(data.snapshot.capturedAt) > Date.parse(data.exportedAt)) throw new Error('Invalid observation/export timestamps.');
  if (data.verification?.allGatesVerifiedUnknown !== true || data.verification.assessedGateCount !== 0 || data.verification.actualApiProjectCount !== data.projects.length || data.summary?.scoredCount !== 0 || data.summary?.estimatedCount !== 0 || data.snapshot.projectCount !== data.projects.length || data.snapshot.sourceCount !== data.sources.length) throw new Error('Snapshot is not a verified unassessed inventory.');
  if (data.modelVersion !== 'grid-atlas-v1' || data.snapshot.modelVersion !== data.modelVersion) throw new Error('Unsupported score model.');
  const reproduced = summarize(data.projects.map(project => scoreProject(project, [], { asOf: calendarDayKst(data.exportedAt), knownAt: data.exportedAt })));
  if (reproduced.recordCount !== data.projects.length || stable(reproduced) !== stable(data.summary)) throw new Error('Cached observation does not reproduce the verified API summary.');
}

// Bundled with the same score functions as the live API. This does not write or
// call a server: the browser receives only the explicitly exported observation.
function installOffline(data, scoring) {
  const { summarize, scoreProject, calendarDayKst, endOfKstDay, isCalendarDay } = scoring;
  const baseUrl = 'https://grid-atlas-offline.invalid';
  const scores = data.projects.map(project => scoreProject(project, [], { asOf: calendarDayKst(data.exportedAt), knownAt: data.exportedAt }));
  const byId = new Map(scores.map(score => [score.project.id, score]));
  const extraLimit = '오프라인 미리보기에는 내보낸 최신 관측 1개만 포함됩니다. 새 수집·평가·저장은 서버 연결 후 사용할 수 있습니다.';
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  const scoped = filters => scores.filter(score => (filters.type === 'all' || score.project.types.includes(filters.type)) && (!filters.region || filters.region === 'all' || score.project.region === filters.region));
  const visible = (items, filters) => items.filter(score => (!filters.q || [score.project.name, score.project.id, score.project.sourceRecordId, score.project.state ?? ''].some(value => value.toLocaleLowerCase().includes(filters.q.toLocaleLowerCase()))) && (filters.status !== 'scored' || (score.project.eligible && score.point !== null)) && (filters.status !== 'unknown' || (score.project.eligible && score.point === null)));
  function numberParam(params, name, fallback, maximum) {
    if (!params.has(name)) return fallback;
    const value = params.get(name);
    if (!/^[1-9]\d*$/.test(value) || Number(value) > maximum) throw new Error(`Invalid ${name}`);
    return Number(value);
  }
  function filters(url) {
    const p = url.searchParams;
    const asOf = p.get('asOf') || calendarDayKst();
    const knownAt = p.get('knownAt') || new Date().toISOString();
    const type = p.get('type') || 'all', status = p.get('status') || 'all';
    if (!isCalendarDay(asOf) || asOf > calendarDayKst() || !Number.isFinite(Date.parse(knownAt)) || Date.parse(knownAt) > Date.now() || !['all', 'generation', 'storage', 'load'].includes(type) || !['all', 'scored', 'unknown'].includes(status)) throw new Error('Invalid or future asOf / knownAt or filter');
    return { type, status, region: p.get('region') || '', q: p.get('q') || '', asOf, knownAt: new Date(knownAt).toISOString(), page: numberParam(p, 'page', 1, 100000), pageSize: numberParam(p, 'pageSize', 30, 100) };
  }
  const available = filter => data.snapshot.capturedAt <= [endOfKstDay(filter.asOf), filter.knownAt].sort()[0];
  function dashboard(filter) {
    const result = { available: false, modelVersion: data.modelVersion, snapshot: null, summary: summarize([]), regions: [], projects: [], total: 0, page: filter.page, pageSize: filter.pageSize, sources: [], history: [], historyTruncated: false, nationalComplete: false, identityScope: 'source_record', limitations: [...data.limitations, extraLimit] };
    if (!available(filter)) return result;
    const scope = scoped(filter), projects = visible(scope, filter), summary = summarize(scope);
    return { ...result, available: true, snapshot: data.snapshot, summary, regions: [...new Set(data.projects.map(project => project.region))].sort(), projects: projects.slice((filter.page - 1) * filter.pageSize, filter.page * filter.pageSize), total: projects.length, sources: data.sources, history: [{ snapshot: data.snapshot, summary }] };
  }
  const csvValue = value => { const raw = value === null || value === undefined ? '' : String(value); const safe = /^[=+\-@\t\r]/.test(raw) ? "'" + raw : raw; return '"' + safe.replaceAll('"', '""') + '"'; };
  window.fetch = async (input, init = {}) => {
    const requested = input instanceof Request ? input.url : String(input);
    const method = (init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method !== 'GET') return json({ error: '오프라인 미리보기는 읽기 전용입니다. 변경사항을 저장할 수 없습니다.' }, 401);
    let url;
    try { url = new URL(requested, baseUrl); } catch { return json({ error: 'Invalid preview request' }, 400); }
    if (url.origin !== baseUrl && url.protocol !== 'file:') return json({ error: 'External requests are disabled in this self-contained preview.' }, 403);
    const path = url.pathname.replace(/\/$/, '');
    try {
      if (path === '/api/health') return json({ ...data.health, lastSnapshotAt: data.snapshot.capturedAt, canWrite: false, schedule: { ...data.health.schedule, configured: false, cadence: '자동 실행 없음 · 읽기 전용 미리보기' }, offlinePreview: true, exportedAt: data.exportedAt });
      if (path === '/api/runs') {
        const page = numberParam(url.searchParams, 'page', 1, 100000), limit = numberParam(url.searchParams, 'limit', 20, 100);
        return json({ runs: data.runs.runs.slice((page - 1) * limit, page * limit), page, limit, truncated: data.runs.runs.length > page * limit || data.runs.truncated });
      }
      const filter = filters(url);
      if (path === '/api/dashboard') return json(dashboard(filter));
      if (path.startsWith('/api/projects/')) {
        if (!available(filter)) return json({ available: false, snapshot: null, score: null, assessments: [], assessmentsTruncated: false, totalAssessments: 0 });
        const score = byId.get(decodeURIComponent(path.slice('/api/projects/'.length)));
        return score ? json({ available: true, snapshot: data.snapshot, score, assessments: [], assessmentsTruncated: false, totalAssessments: 0 }) : json({ error: 'Project not found in exported observation' }, 404);
      }
      if (path === '/api/export') {
        if (!available(filter)) return json({ error: 'No inventory observed at selected time' }, 404);
        const items = visible(scoped(filter), filter);
        if (items.length > 25000) return json({ error: 'Export exceeds 25000 rows; narrow type or region' }, 413);
        const headers = ['id','name','types','region','state','status','eligible','generation_mw','storage_mw','load_mw','bottleneck_score','lower','upper','assessed_gates','estimated','source_url','source_as_of','snapshot_captured_at','as_of','known_at','model_version'];
        const rows = items.map(score => [score.project.id, score.project.name, score.project.types.join('|'), score.project.region, score.project.state, score.project.status, score.project.eligible, score.project.generationMw, score.project.storageMw, score.project.loadMw, score.point, score.lower, score.upper, score.assessedGates, score.estimated, score.project.sourceUrl, score.project.sourceAsOf, data.snapshot.capturedAt, filter.asOf, filter.knownAt, data.modelVersion].map(csvValue).join(','));
        return new Response('\uFEFF' + [headers.join(','), ...rows].join('\r\n'), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="grid-atlas-preview.csv"' } });
      }
      return json({ error: 'API is unavailable in the read-only offline preview' }, 404);
    } catch (error) { return json({ error: error.message || 'Invalid preview request' }, 400); }
  };
  window.__GRID_ATLAS_OFFLINE__ = Object.freeze({ exportedAt: data.exportedAt, snapshotAt: data.snapshot.capturedAt, readOnly: true, observationCount: 1 });
}

async function bundle(input, virtualSource) {
  const name = '\0grid-atlas-offline';
  const compiler = await rolldown({ input: virtualSource ? name : input, plugins: virtualSource ? [{ name: 'offline-runtime', resolveId: id => id === name ? id : null, load: id => id === name ? virtualSource : null }] : [] });
  try {
    const result = await compiler.generate({ format: 'iife', codeSplitting: false, minify: true });
    const chunks = result.output.filter(item => item.type === 'chunk');
    if (chunks.length !== 1 || result.output.some(item => item.type !== 'chunk')) throw new Error('Preview bundle must contain one inline JavaScript chunk.');
    return chunks[0].code;
  } finally { await compiler.close(); }
}

const observation = options.snapshot ? JSON.parse(await readFile(resolve(options.snapshot), 'utf8')) : await getObservation();
validateObservation(observation);
const dist = resolve(appRoot, 'dist');
let html = await readFile(resolve(dist, 'index.html'), 'utf8');
const mime = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon' };
function assetPath(url, parent = dist) {
  if (/^(?:https?:|data:|\/\/)/i.test(url)) throw new Error(`External asset cannot be embedded: ${url}`);
  const path = resolve(url.startsWith('/') ? dist : parent, url.replace(/^\//, ''));
  if (relative(dist, path).startsWith('..')) throw new Error('Asset escapes the build directory.');
  return path;
}
async function dataUrl(url, parent) {
  const path = assetPath(url, parent);
  if (!mime[extname(path)]) throw new Error(`Unsupported inline asset: ${url}`);
  return `data:${mime[extname(path)]};base64,${(await readFile(path)).toString('base64')}`;
}
for (const match of [...html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi)]) {
  const href = /href=["']([^"']+)["']/i.exec(match[0])?.[1];
  if (!href) throw new Error('Stylesheet without href');
  const path = assetPath(href);
  let css = await readFile(path, 'utf8');
  // The live UI's optional web fonts are omitted; declared system fallbacks
  // keep this artifact usable without any network access.
  css = css.replace(/@import\s*(?:url\(\s*)?["']https:\/\/fonts\.googleapis\.com\/[^"']*["']\s*\)?\s*;/gi, '');
  for (const url of [...css.matchAll(/url\(\s*["']?([^)'"\s]+)["']?\s*\)/g)]) if (!url[1].startsWith('data:')) css = css.replaceAll(url[0], `url("${await dataUrl(url[1], dirname(path))}")`);
  if (/@import\b/.test(css)) throw new Error('CSS imports must be bundled before export.');
  html = html.replace(match[0], () => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`);
}
for (const match of [...html.matchAll(/<script\b[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/gi)]) {
  const javascript = await bundle(assetPath(match[1]));
  html = html.replace(match[0], () => `<script defer>${scriptText(javascript)}</script>`);
}
html = html.replace(/<link\b[^>]*rel=["']modulepreload["'][^>]*>/gi, '');
for (const match of [...html.matchAll(/<link\b[^>]*rel=["'](?:icon|shortcut icon)["'][^>]*>/gi)]) {
  const href = /href=["']([^"']+)["']/i.exec(match[0])?.[1];
  if (href && !href.startsWith('data:')) html = html.replace(match[0], match[0].replace(href, await dataUrl(href)));
}
const runtime = await bundle(null, `import {scoreProject,summarize} from ${JSON.stringify(resolve(appRoot, 'shared/scoring.ts'))}; import {calendarDayKst,endOfKstDay,isCalendarDay} from ${JSON.stringify(resolve(appRoot, 'shared/time.ts'))}; (${installOffline.toString()})(${jsonScript(observation)}, {scoreProject,summarize,calendarDayKst,endOfKstDay,isCalendarDay});`);
const exportedKst = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(observation.exportedAt));
const snapshotKst = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(observation.snapshot.capturedAt));
html = html.replace(/<head([^>]*)>/i, match => `${match}\n<script>${scriptText(runtime)}</script>\n<style>body{padding-bottom:72px!important}#grid-atlas-offline-banner{all:initial;box-sizing:border-box;position:fixed;bottom:0;left:0;right:0;z-index:2147483647;background:#102a28;color:#fff;font:13px/1.5 system-ui,sans-serif;padding:11px 18px;border-top:2px solid #58d3af;text-align:center;box-shadow:0 -3px 16px #0002}#grid-atlas-offline-banner strong{font-weight:700;color:#8de8cc}</style>`);
html = html.replace('</body>', `<aside id="grid-atlas-offline-banner" role="note"><strong>오프라인 미리보기 · 변경사항 저장 불가</strong><br>${htmlText(snapshotKst)} KST 관측 자료 · ${htmlText(exportedKst)} KST 내보냄 · 최신 관측 1개 포함</aside></body>`);
// Inline classic scripts must run after the root element exists. defer has no
// effect on inline scripts, so move the built application to the body's end.
const appScripts = [...html.matchAll(/<script defer>([\s\S]*?)<\/script>/g)];
for (const match of appScripts) html = html.replace(match[0], '');
html = html.replace('</body>', () => `${appScripts.map(match => `<script>${match[1]}</script>`).join('\n')}</body>`);
if (/<script\b[^>]*src\s*=/i.test(html) || /<link\b[^>]*rel=["']stylesheet["']/i.test(html)) throw new Error('Unresolved build resources remain.');
const output = resolve(options.output);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, html);
if (options['save-snapshot']) { const path = resolve(options['save-snapshot']); await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(observation)); }
console.log(JSON.stringify({ output, bytes: (await stat(output)).size, sha256: createHash('sha256').update(html).digest('hex'), exportedAt: observation.exportedAt, snapshotAt: observation.snapshot.capturedAt, recordCount: observation.projects.length, scoredCount: observation.summary.scoredCount, readOnly: true, observationCount: 1 }, null, 2));
