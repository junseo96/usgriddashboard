import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createLocalDatabase } from '../server/local-db.ts';
import { seedDatabase } from '../server/database.ts';
const db = createLocalDatabase(process.env.GRID_ATLAS_DB ?? '.state/grid-atlas.sqlite');
try {
  db.exec('CREATE TABLE IF NOT EXISTS _grid_atlas_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL)');
  const migrationDirectory = new URL('../migrations/', import.meta.url);
  for (const name of (await readdir(migrationDirectory)).filter(name => /^\d+_.+\.sql$/.test(name)).sort()) {
    const migration = await readFile(new URL(name, migrationDirectory), 'utf8');
    const hash = createHash('sha256').update(migration).digest('hex');
    const saved = await db.prepare('SELECT sha256 FROM _grid_atlas_migrations WHERE name = ?').bind(name).first<{ sha256: string }>();
    if (saved && saved.sha256 !== hash) throw new Error('이미 적용한 migration이 변경되었습니다. 기존 DB를 보존하고 새 migration을 작성하세요.');
    if (!saved) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(migration);
        await db.prepare('INSERT INTO _grid_atlas_migrations (name,sha256) VALUES (?,?)').bind(name, hash).run();
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  }
  const bootstrap = JSON.parse(await readFile(new URL('../data/bootstrap.json', import.meta.url), 'utf8'));
  const result = await seedDatabase(db, { projects: bootstrap.projects, sources: bootstrap.sources }, 'bootstrap');
  console.log('Grid Atlas 로컬 데이터 준비:', JSON.stringify(result));
} finally { db.close(); }
