/** Append reviewed judgements without rewriting prior opinions or touching a database. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stageInferenceCanonicalJson, stageInferenceCoverage, validateProjectStageInferenceFragment, validateProjectStageInferences,
  type ProjectStageInferenceDataset, type ProjectStageInferenceFragment, type StageInferenceAudit, type StageInferenceJudgement } from '../shared/project-stage-inference.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export interface StageInferenceBuildInput {
  previous?: ProjectStageInferenceDataset | null; fragments: ProjectStageInferenceFragment[];
  manifests?: ProjectStageInferenceDataset['inputs']; now?: Date;
}
export function buildProjectStageInferences(input: StageInferenceBuildInput): ProjectStageInferenceDataset {
  const now = input.now ?? new Date(), previous = input.previous ?? null;
  if (previous) validateProjectStageInferences(previous, now);
  const fragments = [...input.fragments].sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(fragments.map(f => f.id)).size !== fragments.length) throw new Error('Duplicate inference fragment ID');
  for (const fragment of fragments) validateProjectStageInferenceFragment(fragment, now);
  const generatedAt = [previous?.generatedAt, ...fragments.map(f => f.generatedAt)].filter((v): v is string => !!v).sort().at(-1);
  if (!generatedAt) throw new Error('Inference build requires a real reviewed fragment or previous dataset');
  const judgements = new Map<string, StageInferenceJudgement>((previous?.judgements ?? []).map(j => [j.id, structuredClone(j)]));
  const audits = new Map<string, StageInferenceAudit>((previous?.audits ?? []).map(a => [a.id, structuredClone(a)]));
  const append = <T extends { id: string }>(target: Map<string, T>, values: T[], label: string) => {
    for (const value of values) {
      const old = target.get(value.id);
      if (old && stageInferenceCanonicalJson(old) !== stageInferenceCanonicalJson(value)) throw new Error(`Immutable ${label} changed: ${value.id}; append a new reviewed ID`);
      if (!old) target.set(value.id, structuredClone(value));
    }
  };
  for (const fragment of fragments) { append(judgements, fragment.judgements, 'judgement'); append(audits, fragment.audits, 'audit'); }
  const manifests = new Map((previous?.inputs ?? []).map(m => [m.id, structuredClone(m)]));
  for (const manifest of input.manifests ?? []) manifests.set(manifest.id, structuredClone(manifest));
  const result: ProjectStageInferenceDataset = {
    schemaVersion: 1, generatedAt, judgements: [...judgements.values()].sort((a, b) => a.evaluatedAt.localeCompare(b.evaluatedAt) || a.id.localeCompare(b.id)),
    audits: [...audits.values()].sort((a, b) => a.evaluatedAt.localeCompare(b.evaluatedAt) || a.id.localeCompare(b.id)), inputs: [...manifests.values()].sort((a, b) => a.id.localeCompare(b.id)),
    limitations: [...new Set([...(previous?.limitations ?? []), ...fragments.flatMap(f => f.limitations), '정성 자료에 따른 진행 단계는 검토자의 판단입니다. 다섯 요건의 진행률은 공통 모형 가정이며 직접 근거 평가를 대체하지 않습니다.', '과거 원문 기준일과 실제 평가·자료 취득 시각을 구분하며, 새 판단은 이전 판단을 삭제하지 않고 추가합니다.'])].sort(),
  };
  validateProjectStageInferences(result, now); return result;
}

export function runProjectStageInferenceBuilder(args: string[]): ProjectStageInferenceDataset {
  let output = resolve(ROOT, 'data/project-stage-inferences.json'), previousPath: string | null = null, check = false;
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check') { check = true; continue; }
    if (!['--fragment', '--output', '--previous'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: node scripts/build-project-stage-inferences.ts [--fragment FILE ...] [--output FILE] [--previous FILE] [--check]');
    const option = args[i], value = resolve(args[++i]);
    if (option === '--fragment') files.push(value); else if (option === '--previous') previousPath = value; else output = value;
  }
  const directory = resolve(ROOT, 'data/project-stage-inference-fragments');
  if (!files.length && existsSync(directory)) files.push(...readdirSync(directory).filter(f => f.endsWith('.json')).sort().map(f => resolve(directory, f)));
  const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
  const previousFile = previousPath ?? output, previous = existsSync(previousFile) ? read(previousFile) as ProjectStageInferenceDataset : null;
  const manifests: ProjectStageInferenceDataset['inputs'] = [];
  const fragments = files.map(path => {
    const bytes = readFileSync(path), fragment = JSON.parse(bytes.toString('utf8')) as ProjectStageInferenceFragment;
    manifests.push({ id: fragment.id, path: relative(ROOT, path), sha256: createHash('sha256').update(bytes).digest('hex') }); return fragment;
  });
  const result = buildProjectStageInferences({ previous, fragments, manifests });
  if (check) { if (!existsSync(output) || stageInferenceCanonicalJson(read(output)) !== stageInferenceCanonicalJson(result)) throw new Error('Inference dataset differs from reviewed append-preserved inputs'); }
  else {
    const temporary = output + `.tmp-${process.pid}`;
    try { writeFileSync(temporary, JSON.stringify(result, null, 2) + '\n'); renameSync(temporary, output); }
    finally { try { unlinkSync(temporary); } catch { /* renamed */ } }
  }
  return result;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { const data = runProjectStageInferenceBuilder(process.argv.slice(2)); const coverage = stageInferenceCoverage(data); process.stdout.write(JSON.stringify({ judgements: data.judgements.length, reviewed: coverage.reviewedCount, scored: coverage.scoredCount, averageApproved: coverage.averageApprovedCount }) + '\n'); }
  catch (error) { process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 1; }
}
