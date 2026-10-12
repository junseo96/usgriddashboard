/** Deterministic facility inventory assembly. Does not modify the queue register or a database. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { facilityCanonicalJson, summarizeFacilities, validateFacilityFragment, validateFacilityJurisdictions, validateLargeLoadFacilities,
  type FacilityDataset, type FacilityDecision, type FacilityFragment, type FacilityJurisdictionDataset, type FacilityObservation, type FacilitySource, type LargeLoadFacility } from '../shared/large-load-facilities.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const union = <T>(...values: T[][]): T[] => [...new Set(values.flat())];
function records<T extends { id: string }>(a: T[], b: T[], label: string): T[] {
  const result = new Map(a.map(x => [x.id, structuredClone(x)]));
  for (const item of b) { const old = result.get(item.id); if (old && facilityCanonicalJson(old) !== facilityCanonicalJson(item)) throw new Error('Changed immutable ' + label + ': ' + item.id); result.set(item.id, structuredClone(item)); }
  return [...result.values()].sort((x, y) => x.id.localeCompare(y.id));
}
function sourceLinkedRecords<T extends { id: string; sourceIds: string[] }>(a: T[], b: T[], label: string): T[] {
  const result = new Map(a.map(x => [x.id, structuredClone(x)]));
  for (const item of b) { const old = result.get(item.id); if (old && facilityCanonicalJson({ ...old, sourceIds: [] }) !== facilityCanonicalJson({ ...item, sourceIds: [] })) throw new Error('Changed immutable ' + label + ': ' + item.id); result.set(item.id, { ...item, sourceIds: union(old?.sourceIds ?? [], item.sourceIds).sort() }); }
  return [...result.values()].sort((x, y) => x.id.localeCompare(y.id));
}
function mergeFacility(a: LargeLoadFacility, b: LargeLoadFacility): LargeLoadFacility {
  if (a.parentId && b.parentId && a.parentId !== b.parentId) throw new Error('Conflicting parent facility: ' + a.id);
  const latest = (f: LargeLoadFacility) => f.observations?.filter(o => !o.evidenceOnly).map(o => o.observedAt).sort().at(-1) ?? '';
  const comparison = latest(b).localeCompare(latest(a)) || (b.asOf ?? '').localeCompare(a.asOf ?? '');
  const current = comparison >= 0 ? b : a, older = comparison >= 0 ? a : b;
  const facts = new Map<string, LargeLoadFacility['capacityFacts'][number]>();
  // A changed capacity assertion remains a separate claim, so contradictory MW cannot silently add or replace.
  for (const c of [...a.capacityFacts, ...b.capacityFacts]) { const old = facts.get(c.id); const id = old && facilityCanonicalJson(old) !== facilityCanonicalJson(c) ? c.id + '@' + hash(facilityCanonicalJson(c)).slice(0, 12) : c.id; facts.set(id, { ...c, id }); }
  const grid = new Map<string, LargeLoadFacility['gridEvidence'][number]>();
  for (const e of [...a.gridEvidence, ...b.gridEvidence]) { const old = grid.get(e.id); const id = old && facilityCanonicalJson(old) !== facilityCanonicalJson(e) ? e.id + '@' + hash(facilityCanonicalJson(e)).slice(0, 12) : e.id; grid.set(id, { ...e, id }); }
  return { ...older, ...current, id: a.id, name: current.name, parentId: a.parentId ?? b.parentId, sourceIds: union(a.sourceIds, b.sourceIds).sort(), aliases: union(a.aliases, b.aliases, a.name === b.name ? [] : [older.name]).sort(),
    legacyProjectIds: union(a.legacyProjectIds, b.legacyProjectIds).sort(), notes: union(a.notes, b.notes).sort(), possibleDuplicateIds: union(a.possibleDuplicateIds ?? [], b.possibleDuplicateIds ?? []).sort(),
    capacityFacts: [...facts.values()].sort((x, y) => x.id.localeCompare(y.id)), gridEvidence: [...grid.values()].sort((x, y) => x.id.localeCompare(y.id)),
    events: sourceLinkedRecords(a.events, b.events, 'event'), observations: records(a.observations ?? [], b.observations ?? [], 'observation') };
}
export interface FacilityBuildInput {
  fragments: FacilityFragment[]; jurisdictions?: FacilityJurisdictionDataset | null; decisions?: FacilityDecision[];
  previous?: FacilityDataset | null; inputs?: FacilityDataset['inputs']; now?: Date;
}
export function buildLargeLoadFacilities(input: FacilityBuildInput): FacilityDataset {
  const now = input.now ?? new Date(); if (input.previous) validateLargeLoadFacilities(input.previous, now);
  const fragments = [...input.fragments].sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(fragments.map(f => f.id)).size !== fragments.length) throw new Error('Duplicate facility fragment ID');
  for (const f of fragments) validateFacilityFragment(f, now);
  if (input.jurisdictions) validateFacilityJurisdictions(input.jurisdictions, now);
  const generatedAt = [input.previous?.generatedAt, input.jurisdictions?.generatedAt, ...fragments.map(f => f.generatedAt)].filter((x): x is string => !!x).sort().at(-1);
  if (!generatedAt) throw new Error('A real facility fragment, jurisdiction dataset or previous observation is required');
  const sources = new Map((input.previous?.sources ?? []).map(s => [s.id, structuredClone(s)]));
  const aliasSources = new Map<string, Set<string>>();
  const registerSources = (items: FacilitySource[]): Map<string, string> => {
    const ids = new Map<string, string>();
    for (const s of items) {
      // Stable content-addressed source versions retain old artifacts, including the original acquisition time.
      const version = s.id + '@' + hash(facilityCanonicalJson(s)).slice(0, 16); ids.set(s.id, version);
      sources.set(version, { ...structuredClone(s), id: version }); const aliases = aliasSources.get(s.id) ?? new Set<string>(); aliases.add(version); aliasSources.set(s.id, aliases);
    } return ids;
  };
  const facilities = new Map((input.previous?.facilities ?? []).map(f => [f.id, structuredClone(f)]));
  const enrichmentOrigins = new Set(fragments.flatMap(f => (f.enrichmentOnlyFacilityIds ?? []).map(id => f.id + ':' + id)));
  // Classify already-preserved derived observations without deleting or changing their original facts/timestamps.
  for (const f of facilities.values()) for (const o of f.observations ?? []) if (o.originId && enrichmentOrigins.has(o.originId)) o.evidenceOnly = true;
  for (const fragment of fragments) {
      const sourceIds = registerSources(fragment.sources), refs = (ids: string[]) => ids.map(id => sourceIds.get(id)!).sort();
    for (const raw of fragment.facilities) {
      const f: LargeLoadFacility = { ...structuredClone(raw), sourceIds: refs(raw.sourceIds),
        capacityFacts: raw.capacityFacts.map(c => ({ ...c, sourceIds: refs(c.sourceIds) })).sort((a, b) => a.id.localeCompare(b.id)), gridEvidence: raw.gridEvidence.map(e => ({ ...e, sourceIds: refs(e.sourceIds) })).sort((a, b) => a.id.localeCompare(b.id)),
        events: raw.events.map(e => ({ ...e, sourceIds: refs(e.sourceIds) })).sort((a, b) => a.id.localeCompare(b.id)), observations: [], possibleDuplicateIds: [...raw.possibleDuplicateIds ?? []].sort(),
        aliases: [...raw.aliases].sort(), legacyProjectIds: [...raw.legacyProjectIds].sort(), notes: [...raw.notes].sort() };
      const observedAt = fragment.generatedAt;
      const identity = { name: f.name, operator: f.operator, sector: f.sector, region: f.region, ...(f.regionBasis ? { regionBasis: f.regionBasis } : {}), state: f.state, city: f.city, county: f.county, lat: f.lat, lon: f.lon, identityKind: f.identityKind, aliases: f.aliases, legacyProjectIds: f.legacyProjectIds };
      const payload = { originId: fragment.id + ':' + raw.id, ...(enrichmentOrigins.has(fragment.id + ':' + raw.id) ? { evidenceOnly: true } : {}), identity, observedAt, lifecycle: f.lifecycle, asOf: f.asOf, sourceIds: f.sourceIds, capacityFacts: f.capacityFacts, gridEvidence: f.gridEvidence };
      const observation: FacilityObservation = { id: f.id + ':observation:' + hash(facilityCanonicalJson(payload)).slice(0, 16), ...payload };
      f.observations = [observation];
      const old = facilities.get(f.id); facilities.set(f.id, old ? mergeFacility(old, f) : f);
    }
  }
  let jurisdictions = structuredClone(input.previous?.jurisdictions ?? []);
  if (input.jurisdictions) { const ids = registerSources(input.jurisdictions.sources); jurisdictions = input.jurisdictions.rules.map(r => ({ ...r, sourceIds: r.sourceIds.map(id => ids.get(id)!) })); }
  const decisionSources = (ids: string[]) => union(...ids.map(id => { if (sources.has(id)) return [id]; const matches = [...(aliasSources.get(id) ?? [])]; if (!matches.length) throw new Error('Missing source in facility identity decision: ' + id); return matches; })).sort();
  const decisions = sourceLinkedRecords(input.previous?.decisions ?? [], (input.decisions ?? []).map(d => ({ ...d, sourceIds: decisionSources(d.sourceIds) })), 'identity decision');
  const aliases = new Map<string, string>();
  for (const d of decisions.filter(d => d.kind === 'same_entity')) { const target = d.facilityIds[0]; for (const alias of d.facilityIds.slice(1)) { const previous = aliases.get(alias); if (previous && previous !== target) throw new Error('Conflicting canonical facility: ' + alias); aliases.set(alias, target); } }
  const canonical = (id: string): string => { const seen = new Set<string>(); while (aliases.has(id)) { if (seen.has(id)) throw new Error('Facility alias cycle'); seen.add(id); id = aliases.get(id)!; } return id; };
  for (const [id, f] of [...facilities]) { const target = canonical(id); if (target === id) continue; const existing = facilities.get(target); if (!existing) throw new Error('Missing facility merge target: ' + target); facilities.set(target, mergeFacility(existing, { ...f, id: target, aliases: union(f.aliases, [id, f.name]) })); facilities.delete(id); }
  for (const f of facilities.values()) { f.parentId = f.parentId ? canonical(f.parentId) : null; f.possibleDuplicateIds = union((f.possibleDuplicateIds ?? []).map(canonical)).filter(id => id !== f.id); }
  for (const d of decisions) {
    if (d.kind === 'same_entity') continue;
    const ids = union(d.facilityIds.map(canonical)); if (ids.length < 2) continue;
    if (ids.some(id => !facilities.has(id))) throw new Error('Missing facility in identity decision: ' + d.id);
    if (d.kind === 'part_of') { const f = facilities.get(ids[0])!; if (f.parentId && f.parentId !== ids[1]) throw new Error('Conflicting parent facility'); f.parentId = ids[1]; }
    if (d.kind === 'possible_duplicate') for (const id of ids) { const f = facilities.get(id)!; f.possibleDuplicateIds = union(f.possibleDuplicateIds ?? [], ids.filter(x => x !== id)).sort(); }
  }
  // Exact queue references shared by unmerged facilities are a collision to review, not permission to merge names.
  const coreLinks = new Map<string, string[]>(); for (const f of facilities.values()) for (const id of f.legacyProjectIds) coreLinks.set(id, [...(coreLinks.get(id) ?? []), f.id]);
  for (const ids of coreLinks.values()) if (ids.length > 1) for (const id of ids) { const f = facilities.get(id)!; const others = ids.filter(other => other !== id && f.parentId !== other && facilities.get(other)!.parentId !== id); f.possibleDuplicateIds = union(f.possibleDuplicateIds ?? [], others).sort(); }
  for (const f of facilities.values()) {
    const primary = (f.observations ?? []).filter(o => !o.evidenceOnly).sort((a, b) => a.observedAt.localeCompare(b.observedAt) || (a.asOf ?? '').localeCompare(b.asOf ?? '') || a.id.localeCompare(b.id)).at(-1);
    if (!primary) throw new Error('Evidence-only enrichment has no primary facility observation: ' + f.id);
    if (primary.identity) { const { aliases: _aliases, legacyProjectIds: _legacy, ...identity } = primary.identity; Object.assign(f, identity); }
    f.lifecycle = primary.lifecycle; f.asOf = primary.asOf;
  }
  const inputs = new Map((input.previous?.inputs ?? []).map(i => [i.id, i])); for (const i of input.inputs ?? []) inputs.set(i.id, i);
  const result: FacilityDataset = { schemaVersion: 1, generatedAt, sources: [...sources.values()].sort((a, b) => a.id.localeCompare(b.id)), facilities: [...facilities.values()].sort((a, b) => a.id.localeCompare(b.id)), jurisdictions,
    decisions, inputs: [...inputs.values()].sort((a, b) => a.id.localeCompare(b.id)), limitations: union(input.previous?.limitations ?? [], ...fragments.map(f => f.limitations), input.jurisdictions?.limitations ?? [], [
      '공개된 시설·개발계획 조사이며 미국 전수 목록이나 ISO 접속신청 원장을 뜻하지 않습니다.',
      '운영·중단·취소는 현재 개발평균에서 제외합니다. 용량은 측정 의미별로 분리하며 MVA를 MW로 바꾸지 않습니다.',
      '과거 점수는 실제 날짜가 있는 사건만 현재 모형으로 재평가하며, 자료 확인 시각 이전에 알려졌다고 표시하지 않습니다.',
    ]).sort() };
  validateLargeLoadFacilities(result, now); return result;
}

export function runLargeLoadFacilityBuilder(args: string[]): FacilityDataset {
  let directory = resolve(ROOT, 'data/large-load-facility-fragments'), output = resolve(ROOT, 'data/large-load-facilities.json'), jurisdictionPath = resolve(ROOT, 'data/large-load-jurisdictions.json'), decisionsPath = resolve(ROOT, 'data/large-load-facility-decisions.json');
  let previousPath: string | null = null, check = false, validatePath: string | null = null, manifestInputDirectory: string | null = null; const explicit: string[] = [];
  for (let i = 0; i < args.length; i++) { const option = args[i]; if (option === '--check') { check = true; continue; }
    if (!['--input-dir', '--manifest-input-dir', '--output', '--jurisdictions', '--decisions', '--previous', '--fragment', '--validate'].includes(option) || !args[i + 1]) throw new Error('Usage: build-large-load-facilities.ts [--input-dir DIR] [--manifest-input-dir DIR] [--fragment FILE] [--output FILE] [--jurisdictions FILE] [--decisions FILE] [--previous FILE] [--check] [--validate FILE]');
    const value = resolve(args[++i]); if (option === '--input-dir') directory = value; else if (option === '--manifest-input-dir') manifestInputDirectory = value; else if (option === '--output') output = value; else if (option === '--jurisdictions') jurisdictionPath = value; else if (option === '--decisions') decisionsPath = value; else if (option === '--previous') previousPath = value; else if (option === '--validate') validatePath = value; else explicit.push(value);
  }
  const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
  if (validatePath) { const d = read(validatePath); validateLargeLoadFacilities(d); return d; }
  const paths = explicit.length ? explicit : existsSync(directory) ? readdirSync(directory).filter(f => f.endsWith('.json')).sort().map(f => resolve(directory, f)) : [];
  const inputs: FacilityDataset['inputs'] = [];
  const load = (path: string, id: string, manifestPath = path) => { const bytes = readFileSync(path); inputs.push({ id, path: relative(ROOT, manifestPath), sha256: hash(bytes) }); return JSON.parse(bytes.toString('utf8')); };
  const fragments = paths.map(path => { const f = read(path) as FacilityFragment; const manifestPath = manifestInputDirectory ? resolve(manifestInputDirectory, path.slice(path.lastIndexOf('/') + 1)) : path; return load(path, 'fragment:' + f.id, manifestPath) as FacilityFragment; });
  const result = buildLargeLoadFacilities({ fragments, jurisdictions: existsSync(jurisdictionPath) ? load(jurisdictionPath, 'jurisdictions') : null,
    decisions: existsSync(decisionsPath) ? load(decisionsPath, 'decisions').decisions : [], previous: existsSync(previousPath ?? output) ? read(previousPath ?? output) : null, inputs });
  if (check) { if (!existsSync(output) || facilityCanonicalJson(read(output)) !== facilityCanonicalJson(result)) throw new Error('Facility dataset differs from its source fragments and preserved history'); }
  else { const temporary = output + '.tmp-' + process.pid; try { writeFileSync(temporary, JSON.stringify(result, null, 2) + '\n'); renameSync(temporary, output); } finally { try { unlinkSync(temporary); } catch { /* renamed */ } } }
  return result;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { const data = runLargeLoadFacilityBuilder(process.argv.slice(2)); process.stdout.write(JSON.stringify(summarizeFacilities(data)) + '\n'); }
  catch (error) { process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 1; }
}
