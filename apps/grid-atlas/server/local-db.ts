import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SqlDatabase, SqlStatement } from './database.ts';

export function createLocalDatabase(path: string): SqlDatabase & { exec(sql: string): void; close(): void } {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new DatabaseSync(path);
  sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  class Statement {
    sql: string; args: (string | number | bigint | Uint8Array | null)[];
    constructor(sql: string, args: (string | number | bigint | Uint8Array | null)[] = []) { this.sql = sql; this.args = args; }
    bind(...args: unknown[]) { return new Statement(this.sql, args.map(value => value === undefined ? null : value) as Statement['args']); }
    async first<T = Record<string, unknown>>() { return (sqlite.prepare(this.sql).get(...this.args) as T | undefined) ?? null; }
    async all<T = Record<string, unknown>>() { return { results: sqlite.prepare(this.sql).all(...this.args) as T[] }; }
    execute() {
      const statement = sqlite.prepare(this.sql);
      if (statement.columns().length) return { results: statement.all(...this.args), success: true, meta: { changes: 0 } };
      const result = statement.run(...this.args);
      return { results: [], success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    }
    async run() { return this.execute(); }
  }
  return {
    prepare(sql: string) { return new Statement(sql); },
    async batch(statements: SqlStatement[]) {
      sqlite.exec('BEGIN IMMEDIATE');
      try { const result = statements.map(statement => (statement as Statement).execute()); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    exec(sql: string) { sqlite.exec(sql); },
    close() { sqlite.close(); },
  };
}
