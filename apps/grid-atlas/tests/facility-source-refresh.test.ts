import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLargeLoadFacilities } from '../scripts/build-large-load-facilities.ts';
import { facilityCanonicalJson, type FacilityDecision, type FacilityFragment, type FacilitySource, type LargeLoadFacility } from '../shared/large-load-facilities.ts';

const now = new Date('2026-10-14T15:00:00Z');
const oldId = 'operator-source:richmond:original-body';
const nextId = 'operator-source:richmond:changed-body';
const decision: FacilityDecision = { id: 'reviewed-same-campus', kind: 'same_entity', facilityIds: ['campus', 'research-alias'],
  sourceIds: [oldId], reason: 'The original operator document establishes the same exact address and campus.' };
function fragment(id: string, later = false): FacilityFragment {
  const source: FacilitySource = { id, name: 'Operator campus listing', url: 'https://example.org/campus',
    retrievedAt: later ? '2026-10-14T14:00:00Z' : '2026-10-14T12:00:00Z', sha256: (later ? 'b' : 'a').repeat(64),
    publishedAt: null, sourceAsOf: null, excerpt: later ? 'Changed listing, reviewed identity evidence omitted.' : 'Original exact address establishes the campus identity.' };
  const facility = (facilityId: string): LargeLoadFacility => ({ id: facilityId, name: 'Example campus', operator: 'Example', sector: 'data_center',
    region: 'PJM', state: 'VA', city: 'Richmond', county: null, lat: null, lon: null, identityKind: 'campus', parentId: null,
    lifecycle: 'construction', asOf: null, sourceIds: [id], capacityFacts: [], gridEvidence: [], events: [], aliases: [], legacyProjectIds: [], notes: [] });
  return { schemaVersion: 1, id: 'operators', generatedAt: later ? '2026-10-14T14:01:00Z' : '2026-10-14T12:01:00Z',
    sources: [source], facilities: [facility('campus'), facility('research-alias')], limitations: [] };
}
function independentSources(id: string, later = false): FacilityFragment[] {
  const operator = fragment(id, later);
  operator.facilities = [operator.facilities[0]];
  const research = fragment('research-csv-evidence');
  research.id = 'research'; research.facilities = [research.facilities[1]];
  research.sources[0].url = 'https://research.example.org/facility';
  return [operator, research];
}

test('a refreshed source cannot orphan identity decisions referencing preserved exact evidence', () => {
  const previous = buildLargeLoadFacilities({ fragments: independentSources(oldId), decisions: [decision], now });
  const original = previous.sources.find(s => s.id.startsWith(oldId + '@'))!;
  const fresh = independentSources(nextId, true);
  assert.ok(fresh.flatMap(f => f.sources).every(s => s.id !== oldId));
  const next = buildLargeLoadFacilities({ fragments: fresh, previous, decisions: [decision], now });
  assert.equal(next.facilities.length, 1);
  assert.deepEqual(next.decisions[0].sourceIds, [original.id]);
  assert.deepEqual(next.sources.find(s => s.id === original.id), original);
  const latest = next.sources.find(s => s.sha256 === 'b'.repeat(64))!;
  assert.ok(latest);
  assert.ok(!next.decisions[0].sourceIds.includes(latest.id));
  const replay = buildLargeLoadFacilities({ fragments: fresh, previous: next, decisions: [decision], now });
  assert.equal(facilityCanonicalJson(replay), facilityCanonicalJson(next));
});

test('a same-URL replacement is not a fallback for genuinely missing identity evidence', () => {
  const previous = buildLargeLoadFacilities({ fragments: [fragment(nextId, true)], now });
  assert.throws(() => buildLargeLoadFacilities({ fragments: [fragment(nextId, true)], previous, decisions: [decision], now }), /Missing source in facility identity decision/);
});

test('an apparent version suffix must verify the exact source content before alias recovery', () => {
  const previous = buildLargeLoadFacilities({ fragments: [fragment(oldId)], decisions: [decision], now });
  const sourceId = previous.sources[0].id;
  const forged = JSON.parse(JSON.stringify(previous).replaceAll(sourceId, oldId + '@0000000000000000'));
  assert.throws(() => buildLargeLoadFacilities({ fragments: [fragment(nextId, true)], previous: forged, decisions: [decision], now }), /Missing source in facility identity decision/);
});

test('current aliases do not gain unrelated older evidence versions during a reproducibility check', () => {
  // The old document was archived before a reviewed identity decision existed.
  const initial = buildLargeLoadFacilities({ fragments: independentSources(oldId), now });
  const originalVersion = initial.sources.find(s => s.id.startsWith(oldId + '@'))!.id;
  // Some adapters retain their logical source ID while the actual body changes.
  const fresh = independentSources(oldId, true);
  const reviewed = buildLargeLoadFacilities({ previous: initial, fragments: fresh, decisions: [decision], now });
  assert.ok(!reviewed.decisions[0].sourceIds.includes(originalVersion));
  const replay = buildLargeLoadFacilities({ previous: reviewed, fragments: fresh, decisions: [decision], now });
  assert.deepEqual(replay.decisions, reviewed.decisions);
  assert.equal(facilityCanonicalJson(replay), facilityCanonicalJson(reviewed));
});
