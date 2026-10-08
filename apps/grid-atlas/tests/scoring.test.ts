import assert from 'node:assert/strict';
import test from 'node:test';
import { GATES, MODEL_VERSION } from '../shared/types.ts';
import type { Assessment, Project } from '../shared/types.ts';
import { scoreProject, summarize, validateAssessment } from '../shared/scoring.ts';

const NOW = new Date('2026-10-08T06:00:00Z');
const project: Project = {
  id: 'nyiso:request-1', sourceId: 'nyiso', sourceRecordId: 'request-1', name: 'A real register request',
  types: ['load'], region: 'NYISO', state: 'NY', status: 'active', generationMw: null,
  storageMw: null, loadMw: 100, capacityStatus: 'known', eligible: true, exclusionReason: null,
  sourceUrl: 'https://example.org/register', sourceAsOf: '2026-10-01', rawStatus: 'Study pending', identityScope: 'source_record',
};
function evidence(overrides: Partial<Assessment> = {}): Assessment {
  return {
    id: 'assessment-1', projectId: project.id, gate: 'technical', status: 'not_started', progress: null,
    basis: 'official', sourceUrl: 'https://example.org/evidence', effectiveAt: '2026-09-01',
    publishedAt: '2026-09-02', observedAt: '2026-09-03T10:00:00Z', recordedAt: '2026-09-04T10:00:00Z',
    rationale: 'The official register explicitly reports that this requirement has not started.', modelVersion: MODEL_VERSION,
    ...overrides,
  };
}
function allGates(overrides: Partial<Assessment> = {}): Assessment[] {
  return GATES.map(gate => evidence({ ...overrides, gate, id: `assessment-${gate}` }));
}
const at = { asOf: '2026-10-08', knownAt: '2026-10-08T06:00:00Z' };

test('confirmed no progress is 100 and complete evidence for all five gates is zero', () => {
  const stopped = scoreProject(project, allGates(), at);
  assert.equal(stopped.point, 100);
  assert.deepEqual(stopped.gates.map(gate => gate.points), [20, 20, 20, 20, 20]);
  assert.equal(stopped.assessedGates, 5);
  const complete = scoreProject(project, allGates({ status: 'complete' }), at);
  assert.equal(complete.point, 0);
  assert.equal(complete.lower, 0);
  assert.equal(complete.upper, 0);
});

test('one half-complete gate reduces the score by 10 without inferring other gates', () => {
  const rows = allGates();
  rows[0] = evidence({ id: rows[0].id, status: 'in_progress', progress: 0.5 });
  assert.equal(scoreProject(project, rows, at).point, 90);
  const onlyTechnical = scoreProject(project, [rows[0]], at);
  assert.equal(onlyTechnical.point, null);
  assert.equal(onlyTechnical.lower, 10);
  assert.equal(onlyTechnical.upper, 90);
  assert.equal(onlyTechnical.assessedGates, 1);
  assert.equal(onlyTechnical.gates[1].assessment, null);
});

test('legacy status and missing capacity never become fabricated progress or a zero capacity', () => {
  const unknown = scoreProject({ ...project, rawStatus: 'Application submitted', loadMw: null, capacityStatus: 'unknown' }, [], at);
  assert.equal(unknown.point, null);
  assert.equal(unknown.lower, 0);
  assert.equal(unknown.upper, 100);
  assert.ok(unknown.gates.every(gate => gate.status === 'unknown' && gate.points === null));
  const summary = summarize([unknown]);
  assert.equal(summary.scoredCount, 0);
  assert.equal(summary.unknownCount, 1);
  assert.equal(summary.pointMean, null);
  assert.equal(summary.capacityUnknownCount, 1);
  assert.equal(unknown.project.loadMw, null);
});

test('an evidenced exemption renormalizes remaining requirements; all exemptions have no score', () => {
  const rows = allGates({ status: 'complete' });
  rows[0] = evidence({ id: rows[0].id, status: 'not_applicable', rationale: 'Explicit official exemption.' });
  rows[1] = evidence({ id: rows[1].id, gate: rows[1].gate, status: 'not_started' });
  assert.equal(scoreProject(project, rows, at).point, 25);
  rows[2] = evidence({ id: rows[2].id, gate: rows[2].gate, status: 'unknown' });
  const partial = scoreProject(project, rows, at);
  assert.equal(partial.point, null);
  assert.equal(partial.lower, 25);
  assert.equal(partial.upper, 50);
  const exempt = scoreProject(project, allGates({ status: 'not_applicable', rationale: 'Exemption evidence.' }), at);
  assert.equal(exempt.point, null);
  assert.equal(exempt.lower, 0);
  assert.equal(exempt.upper, 100);
});

test('effective date and recorded time give distinct historical answers', () => {
  const rows = allGates();
  const revision = evidence({
    id: 'later-evidence', status: 'complete', effectiveAt: '2026-09-10', publishedAt: '2026-09-11',
    observedAt: '2026-09-12T10:00:00Z', recordedAt: '2026-09-20T10:00:00Z',
  });
  rows.push(revision);
  assert.equal(scoreProject(project, rows, { asOf: '2026-09-09', knownAt: at.knownAt }).point, 100);
  assert.equal(scoreProject(project, rows, { asOf: '2026-09-15', knownAt: '2026-09-19T23:59:59Z' }).point, 100);
  assert.equal(scoreProject(project, rows, { asOf: '2026-09-15', knownAt: at.knownAt }).point, 80);
  assert.equal(scoreProject(project, rows, { asOf: '2026-08-31', knownAt: at.knownAt }).point, null);
  assert.equal(rows[0].status, 'not_started');
});

test('same-effective-date revisions use recorded chronology, independent of input order', () => {
  const original = evidence();
  const revised = evidence({ id: 'revised', status: 'in_progress', progress: 0.75, recordedAt: '2026-09-05T10:00:00Z' });
  const laterEffective = evidence({ id: 'later-effective', status: 'complete', effectiveAt: '2026-09-02', recordedAt: '2026-09-04T11:00:00Z' });
  assert.equal(scoreProject(project, [revised, original], at).gates[0].points, 5);
  assert.equal(scoreProject(project, [original, revised], at).gates[0].points, 5);
  assert.equal(scoreProject(project, [revised, original, laterEffective], at).gates[0].points, 0);
});

test('explicit unknown revision revokes the old score instead of retaining false certainty', () => {
  const rows = allGates();
  rows.push(evidence({ id: 'correction', status: 'unknown', recordedAt: '2026-09-06T10:00:00Z' }));
  const result = scoreProject(project, rows, at);
  assert.equal(result.point, null);
  assert.equal(result.lower, 80);
  assert.equal(result.upper, 100);
});

test('qualitative evidence requires quarter-step progress and a rationale', () => {
  for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
    const assessment = evidence({ status: 'in_progress', progress, basis: 'estimate', rationale: 'Dated reporting describes this gate.' });
    assert.deepEqual(validateAssessment(assessment, NOW), []);
    assert.equal(scoreProject(project, [assessment], at).estimated, true);
  }
  assert.match(validateAssessment(evidence({ status: 'in_progress', progress: 0.6, basis: 'estimate' }), NOW).join(' '), /Estimated progress/);
  assert.match(validateAssessment(evidence({ basis: 'estimate', rationale: ' ' }), NOW).join(' '), /requires a rationale/);
  assert.deepEqual(validateAssessment(evidence({ status: 'in_progress', progress: 0.6 }), NOW), []);
});

test('validation rejects malformed and future dates, impossible evidence chronology, and unsafe provenance', () => {
  const cases: Partial<Assessment>[] = [
    { sourceUrl: 'http://example.org/news' }, { sourceUrl: 'https://secret@example.org/news' },
    { sourceUrl: 'javascript:alert(1)' }, { sourceUrl: ' https://example.org/news' },
    { effectiveAt: '2026-02-30' }, { effectiveAt: '2026-10-09' }, { effectiveAt: '2026-09-04' },
    { publishedAt: '2026-09-04' }, { publishedAt: '2026-10-09T00:00:00Z' },
    { observedAt: '2026-10-09T00:00:00Z' }, { observedAt: '2026-09-03T24:00:00Z' },
    { observedAt: '2026-02-30T10:00:00Z' }, { observedAt: '2026-09-03' },
    { gate: 'unrecognized' as Assessment['gate'] }, { modelVersion: 'other' as Assessment['modelVersion'] },
  ];
  for (const invalid of cases) assert.ok(validateAssessment(evidence(invalid), NOW).length > 0, JSON.stringify(invalid));
  assert.deepEqual(validateAssessment(evidence({ publishedAt: '2026-09-03T18:30:00+09:00' }), NOW), []);
  assert.deepEqual(validateAssessment(evidence({ effectiveAt: '2026-09-03', publishedAt: '2026-09-03' }), NOW), []);
});

test('validation catches contradictory status/progress and exemption without a reason', () => {
  for (const invalid of [
    { status: 'not_started', progress: 0.5 }, { status: 'complete', progress: 0.75 },
    { status: 'unknown', progress: 0 }, { status: 'not_applicable', progress: 1 },
    { status: 'in_progress', progress: null }, { status: 'in_progress', progress: NaN },
    { status: 'in_progress', progress: 1.01 }, { status: 'in_progress', progress: -0.01 },
    { status: 'not_applicable', rationale: '' },
  ] satisfies Partial<Assessment>[]) assert.ok(validateAssessment(evidence(invalid), NOW).length > 0);
});

test('stored assessments cannot conflict by id or precede the observation they cite', () => {
  assert.throws(() => scoreProject(project, [evidence({ recordedAt: '2026-09-03T09:59:59Z' })], at), /before observation/);
  assert.throws(() => scoreProject(project, [evidence(), evidence({ status: 'complete' })], at), /Conflicting assessment/);
  assert.throws(() => scoreProject(project, [evidence({ recordedAt: 'not-a-date' })], at), /Invalid recordedAt/);
  assert.throws(() => scoreProject(project, [], { asOf: '2026-02-30' }), /asOf/);
  assert.throws(() => scoreProject(project, [], { knownAt: '2026-10-08' }), /knownAt/);
  assert.equal(scoreProject(project, [evidence(), evidence()], at).lower, 20);
  assert.equal(scoreProject(project, [evidence({ projectId: 'unrelated' })], at).assessedGates, 0);
});

test('summary uses an unweighted project mean with unknown and excluded counts separate', () => {
  const large = { ...project, id: 'nyiso:large', sourceRecordId: 'large', loadMw: 10000 };
  const small = { ...project, id: 'nyiso:small', sourceRecordId: 'small', loadMw: 1 };
  const unknown = { ...project, id: 'nyiso:unknown', sourceRecordId: 'unknown', loadMw: null, capacityStatus: 'unknown' as const };
  const excluded = { ...project, id: 'nyiso:excluded', sourceRecordId: 'excluded', eligible: false };
  const result = summarize([
    scoreProject(large, allGates({ projectId: large.id }), at),
    scoreProject(small, allGates({ projectId: small.id, status: 'complete', basis: 'estimate' }), at),
    scoreProject(unknown, [], at), scoreProject(excluded, allGates({ projectId: excluded.id }), at),
  ]);
  assert.equal(result.recordCount, 4);
  assert.equal(result.eligibleCount, 3);
  assert.equal(result.scoredCount, 2);
  assert.equal(result.unknownCount, 1);
  assert.equal(result.excludedCount, 1);
  assert.equal(result.estimatedCount, 1);
  assert.equal(result.pointMean, 50);
  assert.equal(result.lowerMean, 33.3333333333);
  assert.equal(result.upperMean, 66.6666666667);
  assert.equal(result.loadMw, 10001);
  assert.equal(result.capacityUnknownCount, 1);
  assert.deepEqual(result.knownCapacityCounts, { generation: 0, storage: 0, load: 2 });
});

test('hybrids count once overall, once per type, and retain distinct capacity measures', () => {
  const hybrid = { ...project, types: ['generation', 'storage'] as Project['types'], generationMw: 200, storageMw: 50, loadMw: null };
  const scored = scoreProject(hybrid, allGates(), at);
  const summary = summarize([scored, structuredClone(scored)]);
  assert.equal(summary.recordCount, 1);
  assert.equal(summary.eligibleCount, 1);
  assert.deepEqual(summary.typeCounts, { generation: 1, storage: 1, load: 0 });
  assert.deepEqual(summary.knownCapacityCounts, { generation: 1, storage: 1, load: 0 });
  assert.equal(summary.generationMw, 200);
  assert.equal(summary.storageMw, 50);
  assert.equal(summary.loadMw, 0);
  assert.equal(summary.capacityUnknownCount, 0);
});

test('conflicting duplicates and alternate IDs for the same source record are rejected', () => {
  const original = scoreProject(project, [], at);
  const changed = scoreProject({ ...project, loadMw: 101 }, [], at);
  assert.throws(() => summarize([original, changed]), /Conflicting duplicate/);
  assert.throws(() => summarize([original, scoreProject({ ...project, id: 'alternate-id' }, [], at)]), /Conflicting canonical IDs/);
  assert.throws(() => summarize([{ ...original, lower: NaN }]), /Invalid score bounds/);
  assert.throws(() => summarize([scoreProject({ ...project, loadMw: -1 }, [], at)]), /Invalid loadMw/);
});

test('known capacity counts distinguish entirely undisclosed MW from a disclosed zero', () => {
  const unknown = { ...project, loadMw: null, capacityStatus: 'unknown' as const };
  const missing = summarize([scoreProject(unknown, [], at)]);
  const zero = summarize([scoreProject({ ...project, loadMw: 0 }, [], at)]);
  assert.equal(missing.typeCounts.load, 1);
  assert.equal(zero.typeCounts.load, 1);
  assert.equal(missing.loadMw, 0);
  assert.equal(zero.loadMw, 0);
  assert.equal(missing.knownCapacityCounts.load, 0);
  assert.equal(zero.knownCapacityCounts.load, 1);
  assert.equal(missing.pointMean, zero.pointMean);
  assert.equal(missing.lowerMean, zero.lowerMean);
  assert.equal(missing.upperMean, zero.upperMean);

  const partialHybrid = { ...project, types: ['generation', 'storage'] as Project['types'],
    generationMw: 0, storageMw: null, loadMw: 100, capacityStatus: 'partial' as const };
  const partial = summarize([scoreProject(partialHybrid, [], at)]);
  // Nonmember load capacity and undisclosed storage do not become known components.
  assert.deepEqual(partial.knownCapacityCounts, { generation: 1, storage: 0, load: 0 });
  assert.equal(partial.loadMw, 0);
});

test('empty summaries and all-excluded inventories have no manufactured mean', () => {
  for (const rows of [[], [scoreProject({ ...project, eligible: false }, [], at)]]) {
    const summary = summarize(rows);
    assert.equal(summary.eligibleCount, 0);
    assert.equal(summary.pointMean, null);
    assert.equal(summary.lowerMean, null);
    assert.equal(summary.upperMean, null);
    assert.deepEqual(summary.knownCapacityCounts, { generation: 0, storage: 0, load: 0 });
  }
});

test('same-day evidence works at midnight KST while exact future timestamps remain rejected', t => {
  const midnight = new Date('2026-10-08T15:00:00.000Z');
  const rows = allGates({ effectiveAt: '2026-10-09', publishedAt: '2026-10-09', observedAt: midnight.toISOString(), recordedAt: midnight.toISOString() });
  assert.deepEqual(validateAssessment(rows[0], midnight), []);
  assert.ok(validateAssessment({ ...rows[0], effectiveAt: '2026-10-10' }, midnight).length > 0);
  assert.ok(validateAssessment({ ...rows[0], publishedAt: '2026-10-09T00:00:00Z' }, midnight).length > 0);
  assert.ok(validateAssessment({ ...rows[0], observedAt: '2026-10-08T15:00:00.001Z' }, midnight).length > 0);
  assert.ok(validateAssessment({ ...rows[0], observedAt: '2026-10-08T14:59:59.999Z' }, midnight).length > 0);
  t.mock.timers.enable({ apis: ['Date'], now: midnight.getTime() });
  try {
    assert.equal(scoreProject(project, rows).point, 100);
    assert.equal(scoreProject(project, rows, { asOf: '2026-10-08' }).point, null);
    assert.equal(rows[0].effectiveAt, '2026-10-09');
    assert.equal(rows[0].publishedAt, '2026-10-09');
  } finally { t.mock.timers.reset(); }
});
