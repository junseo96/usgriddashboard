/** Merge reviewed official load records into the checked-in seed. No DB is opened. */
import { createHash } from 'node:crypto';
import { applyProjectStatusReviewsToBootstrap, loadProjectStatusReviewDataset } from './apply-project-status-reviews.ts';
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { reviewedCanonicalJson, validateReviewedLoadProjects, type ReviewedLoadDataset } from '../shared/reviewed-load-projects.ts';
import type { Project, Source } from '../shared/types.ts';

export interface ReviewedBootstrap {
  projects: Project[]; sources: Source[];
  provenance: Record<string, unknown> & { summary: Record<string, unknown>; reviewedLoadImports?: ReviewedLoadImport[] };
  [key: string]: unknown;
}
interface ReviewedLoadImport {
  schemaVersion: 1; datasetSha256: string; generatedAt: string;
  sourceIds: string[]; projectIds: string[]; reviewedRecords: number;
  eligibleRecords: number; excludedRecords: number; eligibleKnownMwRecords: number;
  kind: 'reviewed_individual_load_records';
}
const recordKey = (project: Project) => JSON.stringify([project.sourceId, project.sourceRecordId]);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
function assertUnique(projects: Project[], sources: Source[]): void {
  if (new Set(sources.map(s => s.id)).size !== sources.length) throw new Error('Duplicate bootstrap source ID');
  const ids = new Set<string>(), records = new Set<string>(), sourceIds = new Set(sources.map(s => s.id));
  for (const project of projects) {
    if (ids.has(project.id) || records.has(recordKey(project)) || !sourceIds.has(project.sourceId)) throw new Error('Duplicate project/source record or unknown source in bootstrap');
    ids.add(project.id); records.add(recordKey(project));
  }
}

/** Exact upserts preserve all other rows, assessments, old acquisition hashes and history. */
export function applyReviewedLoadProjects(bootstrap: ReviewedBootstrap, dataset: ReviewedLoadDataset, datasetSha256: string, now = new Date()): ReviewedBootstrap {
  validateReviewedLoadProjects(dataset, now);
  if (!/^[a-f0-9]{64}$/.test(datasetSha256)) throw new Error('A real reviewed dataset SHA-256 is required');
  if (!Array.isArray(bootstrap.projects) || !Array.isArray(bootstrap.sources) || !bootstrap.provenance?.summary) throw new Error('Invalid bootstrap inventory/provenance');
  assertUnique(bootstrap.projects, bootstrap.sources);
  const projects = new Map(bootstrap.projects.map(project => [project.id, project]));
  const identities = new Map(bootstrap.projects.map(project => [recordKey(project), project.id]));
  for (const project of dataset.projects) {
    const previous = projects.get(project.id), identityOwner = identities.get(recordKey(project));
    if (previous && recordKey(previous) !== recordKey(project)) throw new Error(`A stored project identity cannot be reassigned: ${project.id}`);
    if (identityOwner && identityOwner !== project.id) throw new Error(`Source record already has a different project ID: ${project.id}`);
    projects.set(project.id, structuredClone(project));
    identities.set(recordKey(project), project.id);
  }
  const sources = new Map(bootstrap.sources.map(source => [source.id, source]));
  for (const source of dataset.sources) sources.set(source.id, structuredClone(source));
  const result = structuredClone(bootstrap);
  result.projects = [...projects.values()]; result.sources = [...sources.values()];
  assertUnique(result.projects, result.sources);
  for (const source of dataset.sources) {
    const count = result.projects.filter(project => project.sourceId === source.id).length;
    if (source.recordCount !== null && source.recordCount !== count) throw new Error(`Reviewed source recordCount must describe the preserved inventory scope: ${source.id} (${count})`);
  }
  const eligible = result.projects.filter(project => project.eligible);
  const eligibleByType: Record<string, number> = {}, coverageSources: Record<string, number> = {};
  for (const project of eligible) for (const type of project.types) eligibleByType[type] = (eligibleByType[type] ?? 0) + 1;
  for (const source of result.sources) coverageSources[source.coverage] = (coverageSources[source.coverage] ?? 0) + 1;
  Object.assign(result.provenance.summary, {
    records: result.projects.length, eligible: eligible.length, eligibleByType,
    capacityUnknownOrPartial: eligible.filter(project => project.capacityStatus !== 'known').length,
    coverageSources,
    knownCapacityMw: Object.fromEntries((['generation', 'storage', 'load'] as const).map(type => [type,
      Math.round(eligible.reduce((sum, project) => sum + (project[`${type}Mw`] ?? 0), 0) * 1e6) / 1e6])),
  });
  const record: ReviewedLoadImport = {
    kind: 'reviewed_individual_load_records', schemaVersion: 1, datasetSha256, generatedAt: dataset.generatedAt,
    sourceIds: dataset.sources.map(source => source.id).sort(), projectIds: dataset.projects.map(project => project.id).sort(),
    reviewedRecords: dataset.projects.length, eligibleRecords: dataset.projects.filter(project => project.eligible).length,
    excludedRecords: dataset.projects.filter(project => !project.eligible).length,
    eligibleKnownMwRecords: dataset.projects.filter(project => project.eligible && project.loadMw !== null).length,
  };
  const imports = result.provenance.reviewedLoadImports ?? [];
  const previous = imports.find(item => item.datasetSha256 === datasetSha256);
  if (previous && reviewedCanonicalJson(previous) !== reviewedCanonicalJson(record)) throw new Error('Existing reviewed import provenance does not match this dataset');
  if (!previous) result.provenance.reviewedLoadImports = [...imports, record];
  return result;
}

/** Seeds and Pages always overlay the checked-in reviews, including after archive regeneration. */
export function loadBootstrapWithReviewed(bootstrapPath = resolve(ROOT, 'data/bootstrap.json'), datasetPath = resolve(ROOT, 'data/reviewed-load-projects.json')): ReviewedBootstrap {
  const bootstrap = JSON.parse(readFileSync(bootstrapPath, 'utf8')) as ReviewedBootstrap;
  const bytes = readFileSync(datasetPath), dataset: unknown = JSON.parse(bytes.toString('utf8'));
  validateReviewedLoadProjects(dataset);
  const merged = applyReviewedLoadProjects(bootstrap, dataset, createHash('sha256').update(bytes).digest('hex'));
  // Custom fixture/archive imports remain isolated from the production current-status overlay.
  if (bootstrapPath !== resolve(ROOT, 'data/bootstrap.json') || datasetPath !== resolve(ROOT, 'data/reviewed-load-projects.json')) return merged;
  const statuses = loadProjectStatusReviewDataset();
  return applyProjectStatusReviewsToBootstrap(merged, statuses.dataset, statuses.sha256);
}

export function runReviewedLoadBuilder(args: string[]): { checked?: true; written?: string; reviewedRecords: number; summary: Record<string, unknown> } {
  let bootstrapPath = resolve(ROOT, 'data/bootstrap.json'), datasetPath = resolve(ROOT, 'data/reviewed-load-projects.json');
  let outputPath: string | undefined, check = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--check') { check = true; continue; }
    if (!['--bootstrap', '--reviewed', '--output'].includes(arg) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Usage: node scripts/apply-reviewed-load-projects.ts [--check] [--bootstrap FILE] [--reviewed FILE] [--output FILE]');
    const path = resolve(args[++i]);
    if (arg === '--bootstrap') bootstrapPath = path;
    if (arg === '--reviewed') datasetPath = path;
    if (arg === '--output') outputPath = path;
  }
  if (check && outputPath) throw new Error('--check is read-only; do not provide --output');
  const registryPath = !outputPath && bootstrapPath === resolve(ROOT, 'data/bootstrap.json') && datasetPath === resolve(ROOT, 'data/reviewed-load-projects.json')
    ? resolve(ROOT, 'data/source-registry.json') : null;
  const original = JSON.parse(readFileSync(bootstrapPath, 'utf8')) as ReviewedBootstrap;
  const merged = loadBootstrapWithReviewed(bootstrapPath, datasetPath);
  const reviewedRecords = (JSON.parse(readFileSync(datasetPath, 'utf8')) as ReviewedLoadDataset).projects.length;
  if (check) {
    if (reviewedCanonicalJson(original) !== reviewedCanonicalJson(merged)) throw new Error('Bootstrap differs from reviewed records or derived summary; apply the reviewed dataset first');
    if (registryPath && reviewedCanonicalJson(JSON.parse(readFileSync(registryPath, 'utf8'))) !== reviewedCanonicalJson(merged.sources)) throw new Error('Source registry differs from the merged bootstrap sources; apply the reviewed dataset first');
    return { checked: true, reviewedRecords, summary: merged.provenance.summary };
  }
  const target = outputPath ?? bootstrapPath, temporary = `${target}.tmp-${process.pid}`;
  try { writeFileSync(temporary, JSON.stringify(merged) + '\n'); renameSync(temporary, target); }
  finally { try { unlinkSync(temporary); } catch { /* Atomic rename removes the temporary file. */ } }
  if (registryPath) {
    const temporaryRegistry = `${registryPath}.tmp-${process.pid}`;
    try { writeFileSync(temporaryRegistry, JSON.stringify(merged.sources, null, 2) + '\n'); renameSync(temporaryRegistry, registryPath); }
    finally { try { unlinkSync(temporaryRegistry); } catch { /* Atomic rename removes the temporary file. */ } }
  }
  return { written: target, reviewedRecords, summary: merged.provenance.summary };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.stdout.write(JSON.stringify(runReviewedLoadBuilder(process.argv.slice(2))) + '\n'); }
  catch (error) { process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 1; }
}
