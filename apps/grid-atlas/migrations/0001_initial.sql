PRAGMA foreign_keys = ON;
CREATE TABLE inventory_revision (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
INSERT INTO inventory_revision(id,version) VALUES (1,0);

CREATE TABLE sources (
  id TEXT PRIMARY KEY NOT NULL,
  payload TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  source_sha256 TEXT
);
CREATE TABLE inventory_chunks (
  source_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (source_id, chunk_index)
);
CREATE TABLE snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  captured_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  project_count INTEGER NOT NULL,
  source_count INTEGER NOT NULL,
  model_version TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('bootstrap','manual','scheduled'))
);
CREATE INDEX snapshots_captured_at ON snapshots(captured_at);
CREATE TABLE snapshot_chunks (
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  chunk_index INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, chunk_index)
);
CREATE TABLE assessments (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX assessments_project_time ON assessments(project_id,effective_at,recorded_at);
CREATE INDEX assessments_recorded_at ON assessments(recorded_at);
CREATE TABLE collection_runs (
  id TEXT PRIMARY KEY NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('running','success','partial','failed')),
  details TEXT NOT NULL
);
CREATE INDEX collection_runs_started_at ON collection_runs(started_at);
CREATE TRIGGER assessments_no_update BEFORE UPDATE ON assessments BEGIN SELECT RAISE(ABORT,'assessments are immutable'); END;
CREATE TRIGGER assessments_no_delete BEFORE DELETE ON assessments BEGIN SELECT RAISE(ABORT,'assessments are immutable'); END;
CREATE TRIGGER snapshots_no_update BEFORE UPDATE ON snapshots BEGIN SELECT RAISE(ABORT,'snapshots are immutable'); END;
CREATE TRIGGER snapshots_no_delete BEFORE DELETE ON snapshots BEGIN SELECT RAISE(ABORT,'snapshots are immutable'); END;
CREATE TRIGGER snapshot_chunks_no_update BEFORE UPDATE ON snapshot_chunks BEGIN SELECT RAISE(ABORT,'snapshot chunks are immutable'); END;
CREATE TRIGGER snapshot_chunks_no_delete BEFORE DELETE ON snapshot_chunks BEGIN SELECT RAISE(ABORT,'snapshot chunks are immutable'); END;
