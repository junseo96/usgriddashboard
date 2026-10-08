import { MODEL_VERSION, type Assessment, type CollectionRun, type Project, type SnapshotMeta, type Source } from '../shared/types.ts';

export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  /** Must execute all statements in one transaction, rolling back on failure. */
  batch(statements: SqlStatement[]): Promise<unknown[]>;
}
export interface Inventory { projects: Project[]; sources: Source[]; }
interface SourceImport { sourceId: string; storedAt: string; timeBasis: 'bootstrap_import' | 'retrieved'; sourceSha256: string | null; }
type PayloadRow = { payload: string };
type SnapshotRow = { id: string; captured_at: string; content_hash: string; project_count: number; source_count: number; model_version: string; trigger_kind: SnapshotMeta['trigger'] };
const CHUNK_BYTES = 180_000;
export const MAX_PROJECTS = 100_000;

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + stableJson(v)).join(',') + '}';
  return JSON.stringify(value);
}
export async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
function chunks<T>(values: T[]): string[] {
  const result: string[] = [];
  let current: string[] = [], length = 2;
  for (const value of values) {
    const json = stableJson(value), bytes = new TextEncoder().encode(json).length;
    if (bytes > CHUNK_BYTES) throw new Error('Individual record exceeds storage limit');
    if (length + bytes + 1 > CHUNK_BYTES && current.length) { result.push('[' + current.join(',') + ']'); current = []; length = 2; }
    current.push(json); length += bytes + 1;
  }
  if (current.length) result.push('[' + current.join(',') + ']');
  return result;
}
export async function readInventory(db: SqlDatabase): Promise<Inventory> {
  return (await readInventoryWithRevision(db)).inventory;
}
export async function readInventoryWithRevision(db: SqlDatabase): Promise<{inventory: Inventory; revision: number; sourceImports: SourceImport[]}> {
  // One statement sees one consistent database revision during concurrent imports.
  const rows = await db.prepare("SELECT 'source' AS kind,id AS sort_id,0 AS chunk_index,payload FROM sources UNION ALL SELECT 'project' AS kind,source_id AS sort_id,chunk_index,payload FROM inventory_chunks UNION ALL SELECT 'source_import' AS kind,id AS sort_id,0 AS chunk_index,json_object('sourceId',id,'storedAt',imported_at,'timeBasis',CASE WHEN source_sha256 IS NULL THEN 'bootstrap_import' ELSE 'retrieved' END,'sourceSha256',source_sha256) AS payload FROM sources UNION ALL SELECT 'revision' AS kind,'' AS sort_id,0 AS chunk_index,CAST(version AS TEXT) AS payload FROM inventory_revision WHERE id=1 ORDER BY kind,sort_id,chunk_index").all<PayloadRow & { kind: string }>();
  const projects = rows.results.filter(r => r.kind === 'project').flatMap(row => JSON.parse(row.payload) as Project[]);
  if (projects.length > MAX_PROJECTS) throw new Error('Inventory exceeds supported project limit');
  const revision = Number(rows.results.find(r => r.kind === 'revision')?.payload);
  if (!Number.isInteger(revision)) throw new Error('Inventory revision is not initialized');
  return { inventory: { projects, sources: rows.results.filter(r => r.kind === 'source').map(row => JSON.parse(row.payload) as Source) }, revision, sourceImports: rows.results.filter(r => r.kind === 'source_import').map(r => JSON.parse(r.payload) as SourceImport) };
}
/** Failed optimistic checks abort the entire batch, including all replacements. */
export function inventoryRevisionGuard(db: SqlDatabase, revision: number, increment = true): SqlStatement {
  return db.prepare(`UPDATE inventory_revision SET version=CASE WHEN version=? THEN version${increment ? '+1' : ''} ELSE NULL END WHERE id=1`).bind(revision);
}
function bulkInsert(db: SqlDatabase, table: string, columns: string[], rows: unknown[][], groupSize: number, ignore = false): SqlStatement[] {
  const statements: SqlStatement[] = [];
  for (let i = 0; i < rows.length; i += groupSize) {
    const group = rows.slice(i, i + groupSize);
    statements.push(db.prepare(`INSERT ${ignore ? 'OR IGNORE ' : ''}INTO ${table} (${columns.join(',')}) VALUES ${group.map(() => '(' + columns.map(() => '?').join(',') + ')').join(',')}`).bind(...group.flat()));
  }
  return statements;
}
function snapshotMeta(row: SnapshotRow): SnapshotMeta {
  if (row.model_version !== MODEL_VERSION) throw new Error('Unsupported snapshot model version');
  return { id: row.id, capturedAt: row.captured_at, contentHash: row.content_hash, projectCount: row.project_count, sourceCount: row.source_count, modelVersion: MODEL_VERSION, trigger: row.trigger_kind };
}
export async function listSnapshots(db: SqlDatabase, cutoff: string, limit: number): Promise<SnapshotMeta[]> {
  const rows = await db.prepare('SELECT * FROM snapshots WHERE captured_at <= ? ORDER BY captured_at DESC, id DESC LIMIT ?').bind(cutoff, limit).all<SnapshotRow>();
  return rows.results.map(snapshotMeta);
}
export async function readSnapshot(db: SqlDatabase, snapshotId: string): Promise<Inventory> {
  const rows = await db.prepare('SELECT payload FROM snapshot_chunks WHERE snapshot_id = ? ORDER BY chunk_index').bind(snapshotId).all<PayloadRow>();
  const entries = rows.results.flatMap(row => JSON.parse(row.payload) as ({ kind: 'project'; value: Project } | { kind: 'source'; value: Source })[]);
  return { projects: entries.filter(e => e.kind === 'project').map(e => e.value as Project), sources: entries.filter(e => e.kind === 'source').map(e => e.value as Source) };
}
export async function readAssessments(db: SqlDatabase, asOf: string, knownAt: string): Promise<Assessment[]> {
  const rows = await db.prepare('SELECT payload FROM assessments WHERE effective_at <= ? AND recorded_at <= ? ORDER BY recorded_at, id LIMIT 200001').bind(asOf.slice(0, 10), knownAt).all<PayloadRow>();
  if (rows.results.length > 200_000) throw new Error('Assessment volume exceeds supported query limit');
  return rows.results.map(row => JSON.parse(row.payload) as Assessment);
}
export async function captureSnapshot(db: SqlDatabase, trigger: SnapshotMeta['trigger'] = 'manual'): Promise<{ snapshot: SnapshotMeta; duplicate: boolean }> {
  const { inventory, revision, sourceImports } = await readInventoryWithRevision(db);
  if (!inventory.projects.length || !inventory.sources.length) throw new Error('Cannot capture an empty inventory');
  const recorded = await db.prepare('SELECT id FROM assessments ORDER BY id').all<{ id: string }>();
  const capturedAt = new Date().toISOString();
  const contentHash = await sha256(stableJson({ ...inventory, sourceImports, assessmentIds: recorded.results.map(r => r.id), modelVersion: MODEL_VERSION }));
  const id = capturedAt.slice(0, 10) + '-' + contentHash;
  const existing = await db.prepare('SELECT * FROM snapshots WHERE id = ?').bind(id).first<SnapshotRow>();
  if (existing) return { snapshot: snapshotMeta(existing), duplicate: true };
  const entries = [...inventory.sources.map(value => ({ kind: 'source', value })), ...sourceImports.map(value => ({ kind: 'source_import', value })), ...inventory.projects.map(value => ({ kind: 'project', value }))];
  const payloads = chunks(entries);
  await db.batch([
    inventoryRevisionGuard(db, revision, false),
    db.prepare('INSERT OR IGNORE INTO snapshots (id,captured_at,content_hash,project_count,source_count,model_version,trigger_kind) VALUES (?,?,?,?,?,?,?)').bind(id, capturedAt, contentHash, inventory.projects.length, inventory.sources.length, MODEL_VERSION, trigger),
    ...bulkInsert(db, 'snapshot_chunks', ['snapshot_id','chunk_index','payload'], payloads.map((payload,i) => [id,i,payload]), 10, true),
  ]);
  const saved = await db.prepare('SELECT * FROM snapshots WHERE id = ?').bind(id).first<SnapshotRow>();
  if (!saved) throw new Error('Snapshot write was not persisted');
  return { snapshot: snapshotMeta(saved), duplicate: false };
}
export function sourceReplacementStatements(db: SqlDatabase, source: Source, projects: Project[], retrievedAt: string, sourceSha256: string | null): SqlStatement[] {
  return [
    db.prepare('DELETE FROM inventory_chunks WHERE source_id = ?').bind(source.id),
    db.prepare('INSERT INTO sources (id,payload,imported_at,source_sha256) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,imported_at=excluded.imported_at,source_sha256=excluded.source_sha256').bind(source.id, stableJson(source), retrievedAt, sourceSha256),
    ...bulkInsert(db, 'inventory_chunks', ['source_id','chunk_index','payload'], chunks(projects).map((payload,i) => [source.id,i,payload]), 10),
  ];
}
/** Explicit bootstrap only: the caller applies migrations first. Existing datasets are preserved. */
export async function seedDatabase(db: SqlDatabase, inventory: Inventory, trigger: SnapshotMeta['trigger'] = 'bootstrap'): Promise<{ seeded: boolean; snapshot: SnapshotMeta | null }> {
  const existing = await db.prepare('SELECT id FROM sources LIMIT 1').first<{ id: string }>();
  if (existing) {
    const snapshots = await listSnapshots(db, new Date().toISOString(), 1);
    return { seeded: false, snapshot: snapshots[0] ?? null };
  }
  if (!inventory.sources.length || !inventory.projects.length || inventory.projects.length > MAX_PROJECTS) throw new Error('Bootstrap inventory must contain supported sources and projects');
  const ids = new Set<string>();
  for (const project of inventory.projects) { if (ids.has(project.id)) throw new Error('Duplicate bootstrap project id'); ids.add(project.id); }
  const sourceIds = new Set(inventory.sources.map(s => s.id));
  if (sourceIds.size !== inventory.sources.length || inventory.projects.some(p => !sourceIds.has(p.sourceId))) throw new Error('Invalid bootstrap source scope');
  const importedAt = new Date().toISOString();
  const sourceRows = inventory.sources.map(source => [source.id, stableJson(source), importedAt, null]);
  const projectRows = inventory.sources.flatMap(source => chunks(inventory.projects.filter(p => p.sourceId === source.id)).map((payload,i) => [source.id,i,payload]));
  await db.batch([
    inventoryRevisionGuard(db, 0),
    ...bulkInsert(db, 'sources', ['id','payload','imported_at','source_sha256'], sourceRows, 20),
    ...bulkInsert(db, 'inventory_chunks', ['source_id','chunk_index','payload'], projectRows, 10),
  ]);
  const result = await captureSnapshot(db, trigger);
  return { seeded: true, snapshot: result.snapshot };
}
export async function recordCollectionRun(db: SqlDatabase, run: CollectionRun): Promise<void> {
  const existing = await db.prepare('SELECT status FROM collection_runs WHERE id = ?').bind(run.id).first<{ status: string }>();
  if (existing && existing.status !== 'running') throw new Error('Completed collection runs are immutable');
  await db.prepare('INSERT INTO collection_runs (id,started_at,finished_at,status,details) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET finished_at=excluded.finished_at,status=excluded.status,details=excluded.details WHERE collection_runs.status=\'running\' AND collection_runs.started_at=excluded.started_at').bind(run.id, run.startedAt, run.finishedAt, run.status, run.details).run();
}
