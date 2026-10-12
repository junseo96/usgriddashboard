import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { projectCsv, PROJECT_CSV_HEADERS } from '../shared/csv.ts';
import { GATES, MODEL_VERSION, type Assessment, type Project, type ProjectScore } from '../shared/types.ts';
import { ratingPoint, scoreProject, summarize } from '../shared/scoring.ts';
import { scoreStageInference, type StageInferenceJudgement } from '../shared/project-stage-inference.ts';
import { calendarDayKst, endOfKstDay, isCalendarDay } from '../shared/time.ts';
import { isDemandDataset } from '../shared/market.ts';

const originalHeaders = 'id,name,types,region,state,status,eligible,generation_mw,storage_mw,load_mw,bottleneck_score,lower,upper,assessed_gates,estimated,source_url,source_as_of,snapshot_captured_at,as_of,known_at,model_version,rating_score,rating_basis,rating_model_version,raw_status,stage_model_rationale'.split(',');
const context = { snapshotCapturedAt: '2026-10-01T00:00:00Z', asOf: '2026-10-02', knownAt: '2026-10-02T00:00:00.000Z', modelVersion: MODEL_VERSION };
function project(id: string, rawStatus: string): Project {
  return { id, sourceId: 'lbnl-generation-storage-queues', sourceRecordId: id, name: id,
    types: ['generation'], region: 'ERCOT', state: 'TX', status: 'active', generationMw: 50,
    storageMw: null, loadMw: null, capacityStatus: 'known', eligible: true, exclusionReason: null,
    sourceUrl: 'https://emp.lbl.gov/queues', sourceAsOf: '2025-12-31', rawStatus, identityScope: 'source_record' };
}
/** Parse quoted multiline cells too, so provenance cannot pass after truncation at commas/newlines. */
function rows(csv: string): string[][] {
  const result: string[][] = [], row: string[] = [];
  let cell = '', quoted = false;
  for (let i = csv.startsWith('\uFEFF') ? 1 : 0; i < csv.length; i++) {
    const char = csv[i];
    if (char === '"') {
      if (quoted && csv[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted;
    } else if (!quoted && char === ',') { row.push(cell); cell = ''; }
    else if (!quoted && char === '\r' && csv[i + 1] === '\n') {
      row.push(cell); result.push([...row]); row.length = 0; cell = ''; i++;
    } else cell += char;
  }
  assert.equal(quoted, false);
  row.push(cell); result.push(row);
  assert.ok(result.every(r => r.length === result[0].length));
  return result;
}
function records(csv: string): Record<string, string>[] {
  const [headers, ...values] = rows(csv);
  return values.map(row => Object.fromEntries(headers.map((header, index) => [header, row[index]])));
}
function reviewFixture(): { score: ProjectScore; judgement: StageInferenceJudgement } {
  const p = project('csv-qualitative-review', 'In Progress (unknown study)');
  p.name = '=HYPERLINK("https://example.org", "sample")';
  const judgement: StageInferenceJudgement = {
    id: 'review:csv-fixture', censusId: null, projectId: p.id, projectSnapshot: p,
    evaluatedAt: '2026-10-01T00:00:00.000Z', asOf: '2026-09-15', status: 'active', statusBasis: 'inferred',
    stage: 'grid_upgrade_planning', confidence: 'medium', bottleneck: '@변전소 보강, 후속 계약 미확인',
    rationale: '개별 현장의 보강계획을 확인했다.\n실제 공사 착수는 "미확인"이다.',
    assumptions: ['단계별 진행률은 비교용 가정, 실제 공정률 아님.'], limitations: ['계약 원본 미공개.'],
    identityStatus: 'clear', identityRationale: 'Exact fixture source record.', applyToAverage: true,
    sourceEvidence: [{ url: 'https://utility.example.org/filing?year=2026&kind=plan', name: 'Utility "grid" plan',
      publisherKind: 'utility', retrievedAt: '2026-09-30T12:34:56.000Z', sha256: 'a'.repeat(64),
      publishedAt: '2026-09-15', sourceAsOf: '2026-09-15', excerpt: 'The "named site", grid upgrade plan.\nConstruction is not reported.' }],
  };
  return { score: { ...scoreProject(p, [], context), stageEstimate: scoreStageInference(judgement) }, judgement };
}

test('project CSV preserves the original column prefix and direct/proxy/unknown rating semantics', () => {
  const construction = project('csv-construction', 'Construction');
  const direct = project('csv-direct', 'Construction');
  const assessments: Assessment[] = GATES.map(gate => ({ id: direct.id + ':' + gate, projectId: direct.id,
    gate, status: 'complete', progress: 1, basis: 'official', sourceUrl: direct.sourceUrl,
    effectiveAt: '2026-09-01', publishedAt: '2026-09-01', observedAt: '2026-09-01T00:00:00Z',
    recordedAt: '2026-09-01T00:00:00Z', rationale: 'Verified completion fixture.', modelVersion: MODEL_VERSION }));
  const csv = projectCsv([scoreProject(construction, [], context), scoreProject(direct, assessments, context),
    scoreProject(project('csv-unknown', 'unknown'), [], context)], context);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.deepEqual(rows(csv)[0].slice(0, originalHeaders.length), originalHeaders);
  assert.deepEqual(rows(csv)[0], [...PROJECT_CSV_HEADERS]);
  const [proxy, evidence, unknown] = records(csv);
  assert.equal(proxy.rating_score, '25');
  assert.equal(proxy.rating_model_version, 'stage-proxy-v1');
  assert.equal(proxy.bottleneck_score, '');
  assert.equal(proxy.stage_model_stage, 'construction');
  assert.equal(evidence.rating_score, '0');
  assert.equal(evidence.bottleneck_score, '0');
  assert.equal(evidence.rating_basis, 'gate_evidence');
  assert.equal(evidence.assessed_gates, '5');
  assert.equal(evidence.stage_model_stage, '');
  assert.equal(unknown.rating_score, '');
  assert.equal(unknown.rating_basis, 'unknown');
  for (const record of [proxy, evidence, unknown]) {
    assert.equal(record.snapshot_captured_at, context.snapshotCapturedAt);
    assert.equal(record.as_of, context.asOf);
    assert.equal(record.known_at, context.knownAt);
    for (const header of PROJECT_CSV_HEADERS.filter(h => h.startsWith('stage_inference_'))) assert.equal(record[header], '');
  }
});

test('qualitative project CSV retains judgement timing, assumptions and complete source provenance safely', () => {
  const { score, judgement } = reviewFixture();
  const [row] = records(projectCsv([score], context));
  assert.equal(row.rating_score, '65');
  assert.equal(row.bottleneck_score, '', 'A qualitative rating must not be exported as five directly assessed gates.');
  assert.equal(row.rating_model_version, 'qualitative-stage-v1');
  assert.equal(row.stage_inference_judgement_id, judgement.id);
  assert.equal(row.stage_inference_confidence, 'medium');
  assert.equal(row.stage_inference_evaluated_at, judgement.evaluatedAt);
  assert.equal(row.stage_model_source_as_of, judgement.asOf);
  assert.equal(row.stage_model_source_url, judgement.sourceEvidence[0].url);
  assert.ok(row.stage_model_rationale.startsWith(judgement.rationale));
  assert.equal(row.stage_inference_apply_to_average, 'true');
  assert.equal(row.stage_inference_status_basis, 'inferred');
  assert.deepEqual(JSON.parse(row.stage_inference_assumptions), judgement.assumptions);
  assert.deepEqual(JSON.parse(row.stage_inference_limitations), judgement.limitations);
  assert.deepEqual(JSON.parse(row.stage_inference_source_evidence), judgement.sourceEvidence);
  assert.equal(row.name, "'" + score.project.name);
  assert.equal(row.stage_inference_bottleneck, "'" + judgement.bottleneck);
});

test('the static project export route includes the same qualitative metadata as the shared server formatter', async () => {
  const { score } = reviewFixture();
  const script = readFileSync(new URL('../scripts/export-preview.mjs', import.meta.url), 'utf8');
  const start = script.indexOf('function installOffline('), end = script.indexOf('\nasync function bundle(', start);
  assert.ok(start > 0 && end > start);
  const window = { fetch: globalThis.fetch, location: { protocol: 'file:' } };
  const install = vm.runInNewContext('(' + script.slice(start, end).trim() + ')', { window, Response, Request, URL, URLSearchParams, Date });
  install({ projects: [score.project], snapshot: { capturedAt: context.snapshotCapturedAt },
    exportedAt: context.knownAt, modelVersion: MODEL_VERSION, sources: [], limitations: [] },
  { scoreProject: () => score, summarize, ratingPoint, projectCsv, calendarDayKst, endOfKstDay, isCalendarDay, isDemandDataset }, false);
  const response = await window.fetch('/api/export?' + new URLSearchParams({ asOf: context.asOf, knownAt: context.knownAt }));
  assert.equal(response.status, 200);
  // Response.text() decodes the UTF-8 BOM; the download bytes retain it.
  assert.equal(await response.text(), projectCsv([score], context).replace(/^\uFEFF/, ''));
});
