/**
 * Database access.
 *
 * One small interface over two drivers:
 *   - PostgreSQL via `pg` when DATABASE_URL is set (production / staging)
 *   - PGlite (real Postgres compiled to WASM, in-process) otherwise, so the
 *     app and the test-suite run with zero installs. PGLITE_DIR persists it.
 *
 * Interface: query(sql, params) -> { rows }, one(sql, params) -> row | null,
 *            exec(sql), tx(fn), close()
 * DATE columns are returned as 'YYYY-MM-DD' strings and NUMERIC as numbers.
 */
import { readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

const OID = { INT8: 20, NUMERIC: 1700, DATE: 1082 };
const parsers = {
  [OID.INT8]: (v) => Number(v),
  [OID.NUMERIC]: (v) => Number(v),
  [OID.DATE]: (v) => v,
};

export async function createDb({ url = process.env.DATABASE_URL, dataDir = process.env.PGLITE_DIR } = {}) {
  return url ? createPgDb(url) : createPgliteDb(dataDir);
}

function wrap(runner, { tx, close }) {
  const db = {
    query: async (sql, params = []) => {
      const res = await runner.query(sql, params);
      return { rows: res.rows };
    },
    one: async (sql, params = []) => (await db.query(sql, params)).rows[0] ?? null,
    exec: (sql) => runner.exec ? runner.exec(sql) : runner.query(sql),
    tx,
    close,
    inTransaction: false,
  };
  return db;
}

/**
 * Embedded Postgres must have a single owner: two processes opening the same
 * folder corrupt it. A lock file next to the folder records the owner's PID,
 * and the owner touches it every LOCK_HEARTBEAT_MS. A second process is
 * refused only while that PID is alive AND the lock is fresh. A lock left by a
 * killed process (crash, closed terminal, --watch restart) is taken over even
 * when the OS has since reused its PID for an unrelated process.
 */
export const LOCK_HEARTBEAT_MS = 5_000;
export const LOCK_STALE_MS = 30_000;

function lockDataDir(dataDir) {
  const lockPath = `${path.resolve(dataDir)}.lock`;
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };
  const fresh = () => { try { return Date.now() - statSync(lockPath).mtimeMs < LOCK_STALE_MS; } catch { return false; } };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      const heartbeat = setInterval(() => {
        try { const now = new Date(); utimesSync(lockPath, now, now); } catch { /* released or removed */ }
      }, LOCK_HEARTBEAT_MS);
      heartbeat.unref();
      const release = () => {
        clearInterval(heartbeat);
        try { if (readFileSync(lockPath, 'utf8') === String(process.pid)) unlinkSync(lockPath); } catch { /* already gone */ }
      };
      process.once('exit', release);
      return release;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const owner = Number(readFileSync(lockPath, 'utf8'));
      if (owner && owner !== process.pid && alive(owner) && fresh()) {
        throw new Error(`The database in ${dataDir} is already open in another process (PID ${owner}). ` +
          'Only one API (or seed) may use it at a time: stop the other one first.');
      }
      unlinkSync(lockPath); // stale lock from a process that is gone
    }
  }
  throw new Error(`Could not lock ${dataDir}.`);
}

async function createPgliteDb(dataDir) {
  let release = () => {};
  if (dataDir) {
    await mkdir(path.dirname(path.resolve(dataDir)), { recursive: true });
    release = lockDataDir(dataDir);
  }
  let pgl;
  try {
    pgl = await PGlite.create(dataDir, { parsers });
  } catch (err) {
    release();
    throw err;
  }
  let db;
  const tx = async (fn) =>
    pgl.transaction(async (t) => {
      const inner = wrap(t, { tx: (f) => f(inner), close: async () => {} });
      inner.exec = (sql) => t.exec(sql);
      inner.inTransaction = true;
      return fn(inner);
    });
  db = wrap(pgl, { tx, close: async () => { await pgl.close(); release(); } });
  return db;
}

async function createPgDb(url) {
  for (const [oid, fn] of Object.entries(parsers)) pg.types.setTypeParser(Number(oid), fn);
  const pool = new pg.Pool({ connectionString: url });
  const tx = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const inner = wrap(client, { tx: (f) => f(inner), close: async () => {} });
      inner.inTransaction = true;
      const result = await fn(inner);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  };
  return wrap(pool, { tx, close: () => pool.end() });
}
