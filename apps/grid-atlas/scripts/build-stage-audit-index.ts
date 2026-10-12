/** Minimal exact-ID display metadata for reviewed and pending project audits. */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Project } from '../shared/types.ts';
import type { ProjectStageInferenceDataset } from '../shared/project-stage-inference.ts';
const root = new URL('../data/', import.meta.url);
const dataset = JSON.parse(readFileSync(new URL('project-stage-inferences.json', root), 'utf8')) as ProjectStageInferenceDataset;
const bootstrap = JSON.parse(readFileSync(new URL('bootstrap.json', root), 'utf8')) as { projects: Project[] };
const ids = new Set(dataset.audits.map(a => a.projectId).filter(Boolean));
const result = bootstrap.projects.filter(p => ids.has(p.id)).map(({ id, name, region, types }) => ({ id, name, region, types })).sort((a, b) => a.id.localeCompare(b.id));
const path = fileURLToPath(new URL('project-stage-audit-index.json', root));
const bytes = JSON.stringify(result, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== bytes) throw new Error('Stage audit metadata differs from exact bootstrap project IDs');
} else writeFileSync(path, bytes);
console.log(JSON.stringify({ auditProjectMetadata: result.length }));
