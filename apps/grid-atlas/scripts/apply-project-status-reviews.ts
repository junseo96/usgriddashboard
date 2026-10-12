/** Materialize reviewed current-status changes. Never opens a database. */
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Project, Source } from '../shared/types.ts';
import { stageInferenceCanonicalJson } from '../shared/project-stage-inference.ts';
import { applyProjectStatusReviews, validateProjectStatusReviews, type ProjectStatusReviewDataset } from '../shared/project-status-reviews.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export interface StatusReviewedBootstrap {
  projects: Project[]; sources: Source[];
  provenance: Record<string, unknown> & { summary: Record<string, unknown>; projectStatusImports?: Array<Record<string, unknown>> };
  [key: string]: unknown;
}
export function applyProjectStatusReviewsToBootstrap<T extends StatusReviewedBootstrap>(bootstrap: T, dataset: ProjectStatusReviewDataset, datasetSha256: string, now = new Date()): T {
  if (!/^[a-f0-9]{64}$/.test(datasetSha256)) throw new Error('Actual status-review dataset SHA-256 is required');
  if (!bootstrap.provenance?.summary) throw new Error('Bootstrap summary provenance is required');
  const result = structuredClone(bootstrap); result.projects = applyProjectStatusReviews(bootstrap.projects, dataset, bootstrap.sources, now);
  const eligible = result.projects.filter(p => p.eligible), eligibleByType: Record<string, number> = {}, coverageSources: Record<string, number> = {};
  for (const p of eligible) for (const type of p.types) eligibleByType[type] = (eligibleByType[type] ?? 0) + 1;
  for (const source of result.sources) coverageSources[source.coverage] = (coverageSources[source.coverage] ?? 0) + 1;
  Object.assign(result.provenance.summary, { records: result.projects.length, eligible: eligible.length, eligibleByType, coverageSources,
    capacityUnknownOrPartial: eligible.filter(p => p.capacityStatus !== 'known').length,
    knownCapacityMw: Object.fromEntries((['generation', 'storage', 'load'] as const).map(type => [type, Math.round(eligible.reduce((sum, p) => sum + (p[`${type}Mw`] ?? 0), 0) * 1e6) / 1e6])),
  });
  const reviewHashes = Object.fromEntries(dataset.reviews.map(review => [review.id, createHash('sha256').update(stageInferenceCanonicalJson(review)).digest('hex')]));
  const record = { kind: 'reviewed_current_project_status', schemaVersion: 1, datasetSha256, generatedAt: dataset.generatedAt, reviewHashes,
    reviewedRecords: dataset.reviews.length, projectIds: [...new Set(dataset.reviews.map(r => r.project.id))].sort(), judgementIds: [...new Set(dataset.reviews.map(r => r.judgementId))].sort() };
  const imports = result.provenance.projectStatusImports ?? [], previous = imports.find(r => r.datasetSha256 === datasetSha256);
  for (const imported of imports) for (const [id, hash] of Object.entries(imported.reviewHashes ?? {})) {
    if (reviewHashes[id] && reviewHashes[id] !== hash) throw new Error(`Immutable status review changed: ${id}; append a new review ID`);
  }
  if (previous && stageInferenceCanonicalJson(previous) !== stageInferenceCanonicalJson(record)) throw new Error('Status-review import provenance conflict');
  if (!previous && dataset.reviews.length) result.provenance.projectStatusImports = [...imports, record];
  return result;
}
export function loadProjectStatusReviewDataset(path = resolve(ROOT, 'data/project-status-reviews.json')): { dataset: ProjectStatusReviewDataset; sha256: string } {
  const bytes = readFileSync(path), dataset: unknown = JSON.parse(bytes.toString('utf8')); validateProjectStatusReviews(dataset);
  return { dataset, sha256: createHash('sha256').update(bytes).digest('hex') };
}
export function runProjectStatusReviewBuilder(args: string[]) {
  let bootstrapPath = resolve(ROOT, 'data/bootstrap.json'), reviewsPath = resolve(ROOT, 'data/project-status-reviews.json'), output: string | undefined, check = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check') { check = true; continue; }
    if (!['--bootstrap', '--reviews', '--output'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: node scripts/apply-project-status-reviews.ts [--bootstrap FILE] [--reviews FILE] [--output FILE] [--check]');
    const option = args[i], path = resolve(args[++i]); if (option === '--bootstrap') bootstrapPath = path; else if (option === '--reviews') reviewsPath = path; else output = path;
  }
  if (check && output) throw new Error('--check is read-only; do not provide --output');
  const bootstrap = JSON.parse(readFileSync(bootstrapPath, 'utf8')) as StatusReviewedBootstrap, { dataset, sha256 } = loadProjectStatusReviewDataset(reviewsPath);
  const result = applyProjectStatusReviewsToBootstrap(bootstrap, dataset, sha256);
  if (check) { if (stageInferenceCanonicalJson(bootstrap) !== stageInferenceCanonicalJson(result)) throw new Error('Bootstrap differs from reviewed current project statuses; apply the overlay'); }
  else {
    const target = output ?? bootstrapPath, temporary = target + `.tmp-${process.pid}`;
    try { writeFileSync(temporary, JSON.stringify(result) + '\n'); renameSync(temporary, target); } finally { try { unlinkSync(temporary); } catch { /* renamed */ } }
  }
  return { reviewedRecords: dataset.reviews.length, eligible: result.projects.filter(p => p.eligible).length, checked: check };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.stdout.write(JSON.stringify(runProjectStatusReviewBuilder(process.argv.slice(2))) + '\n'); }
  catch (error) { process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 1; }
}
