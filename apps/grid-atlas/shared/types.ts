import type { StageEstimate } from './stage-estimate.ts';

export const MODEL_VERSION = 'grid-atlas-v1' as const;
export const GATES = ['technical', 'commercial', 'permitting', 'construction', 'energization'] as const;
export type Gate = typeof GATES[number];
export type ProjectType = 'generation' | 'storage' | 'load';
export type GateStatus = 'unknown' | 'not_started' | 'in_progress' | 'complete' | 'not_applicable';
export interface Project {
  id: string; sourceId: string; sourceRecordId: string; name: string;
  types: ProjectType[]; region: string; state: string | null;
  status: 'active' | 'withdrawn' | 'operational' | 'unknown' | 'reference';
  generationMw: number | null; storageMw: number | null; loadMw: number | null;
  capacityStatus: 'known' | 'partial' | 'unknown'; eligible: boolean; exclusionReason: string | null;
  sourceUrl: string; sourceAsOf: string | null; rawStatus: string; identityScope: 'source_record';
}
export interface Source {
  id: string; name: string; region: string; types: ProjectType[]; url: string;
  coverage: 'full_register' | 'filtered_register' | 'aggregate' | 'case' | 'not_reviewed' | 'access_failed' | 'not_public';
  sourceAsOf: string | null; lastCheckedAt: string | null; refreshCadence: 'weekly' | 'monthly' | 'annual';
  recordCount: number | null; gaps: string[]; adapter: string | null;
}
export interface Assessment {
  id: string; projectId: string; gate: Gate; status: GateStatus; progress: number | null;
  basis: 'official' | 'estimate'; sourceUrl: string; effectiveAt: string; publishedAt: string | null;
  observedAt: string; recordedAt: string; rationale: string; modelVersion: typeof MODEL_VERSION;
}
export interface GateScore { gate: Gate; status: GateStatus; progress: number | null; points: number | null; assessment: Assessment | null; }
export interface ProjectScore {
  project: Project; point: number | null; lower: number; upper: number; assessedGates: number;
  estimated: boolean; gates: GateScore[]; stageEstimate: StageEstimate | null;
}
export interface Summary {
  recordCount: number; eligibleCount: number; scoredCount: number; unknownCount: number; excludedCount: number;
  estimatedCount: number; pointMean: number | null; lowerMean: number | null; upperMean: number | null;
  generationMw: number; storageMw: number; loadMw: number; capacityUnknownCount: number;
  typeCounts: Record<ProjectType, number>;
  knownCapacityCounts: Record<ProjectType, number>;
  ratingMean: number | null; ratedCount: number; ratingUnknownCount: number; ratingEstimatedCount: number;
  ratingTypeMeans: Record<ProjectType, number | null>;
  ratingTypeCounts: Record<ProjectType, number>;
  ratingRegions: Array<{ region: string; mean: number | null; ratedCount: number; unknownCount: number; estimatedCount: number }>;
}
export interface SnapshotMeta {
  id: string; capturedAt: string; contentHash: string; projectCount: number; sourceCount: number;
  modelVersion: typeof MODEL_VERSION; trigger: 'bootstrap' | 'manual' | 'scheduled';
}
export interface Filters { type?: ProjectType | 'all'; region?: string; q?: string; status?: 'all' | 'scored' | 'unknown'; asOf?: string; knownAt?: string; page?: number; pageSize?: number; }
export interface HistoryPoint { snapshot: SnapshotMeta; summary: Summary; }
export interface DashboardResponse {
  available: boolean; modelVersion: typeof MODEL_VERSION; ratingMethodVersion: string; snapshot: SnapshotMeta | null; summary: Summary;
  regions: string[]; projects: ProjectScore[]; total: number; page: number; pageSize: number;
  sources: Source[]; history: HistoryPoint[]; historyTruncated: boolean;
  nationalComplete: false; identityScope: 'source_record'; limitations: string[];
}
export interface CollectionRun { id: string; startedAt: string; finishedAt: string | null; status: 'running' | 'success' | 'partial' | 'failed'; details: string; }
export interface HealthResponse {
  ok: boolean; app: 'grid-atlas'; modelVersion: typeof MODEL_VERSION; database: 'ready' | 'uninitialized';
  lastSnapshotAt: string | null; canWrite: boolean; schedule: { configured: boolean; cadence: string; lastRunAt: string | null; lastRunStatus: string | null };
}
export interface ImportPayload { sourceId: string; projects: Project[]; source: Source; completeScope: true; retrievedAt: string; sourceSha256: string; }
