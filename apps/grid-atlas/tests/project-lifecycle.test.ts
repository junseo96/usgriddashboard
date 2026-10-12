import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { projectLifecycles, lifecycleSegments, lifecyclePeriod, projectLifecycleCsv } from '../shared/project-lifecycle.ts';
import type { LoadBottleneckDataset } from '../shared/load-bottleneck.ts';

const published = (): LoadBottleneckDataset => JSON.parse(readFileSync(new URL('../data/load-bottleneck.json', import.meta.url), 'utf8'));

test('NYISO retains the same seven identities and each actual historical stage without inventing transition dates', () => {
  const projects = projectLifecycles(published()).filter(row => row.region === 'NYISO');
  assert.deepEqual(new Set(projects.map(row => row.projectId)), new Set(['1213', '1484', '1536', '580', '776', '850', '979']));
  const stamp = projects.find(row => row.projectId === '1484')!;
  assert.deepEqual(stamp.points.map(row => row.point), [85, 75, 75, 75, 25]);
  assert.deepEqual(stamp.points.map(row => row.date), ['2023-11-02', '2024-09-17', '2025-09-01', '2026-03-07', '2026-10-08']);
  assert.equal(stamp.points[0].archiveCapturedAt, '2023-11-02T05:02:14Z');
  assert.equal(stamp.points[0].sourceAsOf, null, 'archive capture is not the unknown source cutoff');
  assert.equal(stamp.points.at(-1)!.rawStage, 'Under Construction');
  for (const project of projects) for (const point of project.points) {
    assert.equal(point.definition!.gates.reduce((sum, gate) => sum + gate.points, 0), point.point);
    assert.equal(point.definition!.gates.length, 5);
  }
  assert.ok(stamp.limitations.some(note => note.includes('생존 표본')));
});

test('BPA removal from a selected register stays unobserved, without a completion score or connecting line', () => {
  const projects = projectLifecycles(published()).filter(row => row.region === 'West');
  assert.equal(projects.length, 26);
  const missing = projects.find(row => row.projectId === 'L0628')!;
  assert.equal(missing.points.at(-2)!.point, 80);
  assert.equal(missing.points.at(-1)!.observed, false);
  assert.equal(missing.points.at(-1)!.point, null);
  assert.equal(missing.points.at(-1)!.definition, null);
  assert.ok(missing.points.at(-1)!.notes.some(note => note.includes('어느 상태인지 추정하지')));
  assert.ok(lifecycleSegments(missing).every(([, b]) => b.observationId !== missing.points.at(-1)!.observationId));
  const data = published();
  const series = data.series.find(row => row.id === 'bpa-explicit-mainland-loads')!;
  series.points[2].bins = series.points[2].bins.filter(bin => bin.id !== 'L0629');
  const gap = projectLifecycles(data).find(row => row.projectId === 'L0629')!;
  assert.equal(lifecycleSegments(gap).length, 3, 'neither side of a missing intermediate row can be bridged');
});

test('DTE prior-source reuse is not a newly confirmed lifecycle event and preserves the original publication', () => {
  const projects = projectLifecycles(published());
  const oracle = projects.find(row => row.projectId === 'oracle-saline')!;
  const last = oracle.points.at(-1)!;
  assert.equal(last.date, '2026-10-01');
  assert.equal(last.publishedAt, '2026-09-28');
  assert.equal(last.sourceAsOf, null);
  assert.equal(last.reusedEvidence, true);
  assert.equal(last.point, 50);
  assert.equal(lifecycleSegments(oracle).length, 1);
  const google = projects.find(row => row.projectId === 'google-van-buren')!;
  assert.equal(google.points[0].observed, false, 'later contract cannot be backfilled before the first evidence');
  assert.equal(google.points[0].point, null);
  assert.equal(google.points.at(-1)!.reusedEvidence, false);
  assert.equal(google.points.at(-1)!.point, 50, 'customer campus construction is not inferred grid construction');
});

test('MW pools, three-project aggregates and unlinked anonymous AES rows cannot become lifecycle identities', () => {
  const data = published();
  const projects = projectLifecycles(data);
  assert.equal(projects.length, 35);
  assert.deepEqual(new Set(projects.map(row => row.seriesId)), new Set(['nyiso-load-fixed-cohort', 'bpa-explicit-mainland-loads', 'miso-dte-selected-load-projects']));
  const fixed = data.series.find(row => row.id === 'nyiso-load-fixed-cohort')!;
  fixed.points[0].bins.push({ ...fixed.points[0].bins[0], id: 'anonymous-customer' });
  fixed.points[0].bins[0].weight = 3;
  const revised = projectLifecycles(data);
  assert.equal(revised.some(row => row.projectId === 'anonymous-customer'), false);
  assert.equal(revised.find(row => row.projectId === fixed.points[0].bins[0].id)!.points[0].point, null, 'a known ID with an aggregate weight cannot carry an individual score');
  fixed.weightBasis = 'capacity_mw';
  assert.equal(projectLifecycles(data).some(row => row.region === 'NYISO'), false);
});

test('disclosed comparison breaks, unknown stages and unresolved membership do not create scored trend segments', () => {
  const data = published();
  const fixed = data.series.find(row => row.id === 'nyiso-load-fixed-cohort')!;
  fixed.points[1].breakBefore = true;
  const project = projectLifecycles(data).find(row => row.projectId === '1484')!;
  assert.equal(lifecycleSegments(project).length, 3);
  fixed.points[2].bins.find(bin => bin.id === '1484')!.stage = 'unknown';
  fixed.points[3].bins.find(bin => bin.id === '1484')!.membership = 'unresolved';
  const missing = projectLifecycles(data).find(row => row.projectId === '1484')!;
  assert.equal(missing.points[2].point, null);
  assert.equal(missing.points[3].point, null);
  assert.equal(lifecycleSegments(missing).length, 0);
});

test('CSV includes exact dates, per-gate model scores, missing rows and original evidence provenance', () => {
  const project = projectLifecycles(published()).find(row => row.projectId === 'L0628')!;
  const csv = projectLifecycleCsv(project);
  assert.equal(csv.split('\r\n').length, project.points.length + 1);
  assert.match(csv, /technical_points,commercial_points,permitting_points,construction_points,energization_points/);
  assert.ok(csv.includes(project.points[0].source.sha256));
  assert.ok(csv.includes('"false","false","","",""'), 'missing record keeps blank raw stage, membership and score');
  assert.match(csv, /load-stage-v1/);
  project.name = '=HYPERLINK("https://example.org")';
  assert.ok(projectLifecycleCsv(project).includes("'=HYPERLINK"), 'spreadsheet formulas are escaped');
});

test('display and CSV retain disclosed year/month/quarter precision rather than the graph axis anchor', () => {
  assert.equal(lifecyclePeriod({ date: '2025-01-01', datePrecision: 'year' }), '2025');
  assert.equal(lifecyclePeriod({ date: '2025-03-01', datePrecision: 'month' }), '2025-03');
  assert.equal(lifecyclePeriod({ date: '2025-07-01', datePrecision: 'quarter' }), '2025 Q3');
});
