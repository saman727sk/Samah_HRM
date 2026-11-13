/**
 * Firebase Realtime Database as the system of record.
 *
 * Every row of every business table lives in Realtime Database at
 *   /<root>/tables/<table>/<id>
 * The API keeps a local embedded-Postgres copy as its query engine, so the
 * business rules (SQL constraints, append-only and payroll-lock triggers,
 * ledgers, reports) work unchanged:
 *
 *  - Startup: if Firebase holds a newer version than the local copy, the
 *    local copy is reloaded from Firebase; if Firebase is empty, the local
 *    data is uploaded once.
 *  - Writes: a trigger records each changed row in `_changes` (on disk, in
 *    the same transaction as the change); a flusher sends them to Firebase
 *    as one atomic multi-path update and bumps /<root>/_meta/version.
 *  - One writer: a lease at /<root>/_meta/writer stops a second API instance
 *    from writing to the same database at the same time.
 *
 * Values are stored as Firebase fields; JSON columns are stored as JSON text
 * (Firebase drops empty arrays/objects and nulls, which would lose data).
 * Password hashes and pending sign-ups are never uploaded.
 */
import { randomUUID } from 'node:crypto';

// signup_requests, password_resets, login_challenges: short-lived, hold password / token hashes; never leave the server.
const SKIP_TABLES = new Set(['schema_migrations', '_changes', '_sync_state', 'signup_requests', 'password_resets', 'login_challenges']);
const SECRET_COLUMNS = { users: ['password_hash'] };
const LEASE_MS = 60_000;
const BATCH = 1000;
// Realtime Database refuses very large single writes; file chunks (512 KB of
// base64 each) are big, so a flush also stops at about this many bytes.
const BATCH_BYTES = 6 * 1024 * 1024;

export class SyncConflictError extends Error {}

/** Business tables and which of their columns hold JSON. */
async function tableInfo(db) {
  const { rows } = await db.query(
    `select c.table_name, c.column_name, c.data_type from information_schema.columns c
       join information_schema.tables t on t.table_name = c.table_name and t.table_schema = c.table_schema
      where c.table_schema = 'public' and t.table_type = 'BASE TABLE' order by c.table_name, c.ordinal_position`);
  const tables = new Map();
  for (const r of rows) {
    if (SKIP_TABLES.has(r.table_name)) continue;
    if (!tables.has(r.table_name)) tables.set(r.table_name, { json: new Set(), columns: [] });
    const t = tables.get(r.table_name);
    t.columns.push(r.column_name);
    if (r.data_type === 'json' || r.data_type === 'jsonb') t.json.add(r.column_name);
  }
  return tables;
}

export function encodeRow(row, info, table) {
  const out = {};
  const secret = SECRET_COLUMNS[table] ?? [];
  for (const [k, v] of Object.entries(row)) {
    if (v == null || secret.includes(k)) continue;
    out[k] = info.json.has(k) ? JSON.stringify(v) : v;
  }
  return out;
}

export function decodeRow(stored, info) {
  const out = {};
  for (const [k, v] of Object.entries(stored ?? {})) out[k] = info.json.has(k) && typeof v === 'string' ? JSON.parse(v) : v;
  return out;
}

const sourceOf = (rtdbUrl, root) => `${rtdbUrl ?? 'firebase'}#${root}`;

export function createSync({ db, rtdb, root = 'hrm', source = null, instanceId = randomUUID(), log = () => {}, intervalMs = 300 }) {
  const ref = (p) => rtdb.ref(`${root}/${p}`);
  const src = source ?? sourceOf(null, root);
  let tables = null;
  let timer = null;
  let heartbeat = null;
  let flushing = null;

  async function info() {
    tables ??= await tableInfo(db);
    return tables;
  }

  async function acquireLease() {
    const now = Date.now();
    const result = await ref('_meta/writer').transaction((cur) => {
      if (cur && cur.instance !== instanceId && now - cur.heartbeat < LEASE_MS) return undefined; // abort: someone else holds it
      return { instance: instanceId, heartbeat: now };
    });
    if (!result.committed) {
      const cur = result.snapshot.val();
      throw new SyncConflictError(`Another API instance (${cur?.instance}) is writing to this Firebase database. Stop it first, or wait a minute if it crashed.`);
    }
  }

  async function installCapture() {
    for (const table of (await info()).keys()) {
      await db.exec(`drop trigger if exists ${table}_capture on ${table};
        create trigger ${table}_capture after insert or update or delete on ${table} for each row execute function capture_change();`);
    }
  }

  const localState = () => db.one('select version, source from _sync_state where id = 1');

  /** Uploads every table, replacing what Firebase holds. */
  async function pushSnapshot() {
    const t = await info();
    const { version } = await localState();
    const next = version + 1;
    let rowsSent = 0;
    for (const [table, ti] of t) {
      const { rows } = await db.query(`select to_jsonb(x) as r from ${table} x`);
      const obj = {};
      for (const { r } of rows) obj[String(r.id)] = encodeRow(r, ti, table);
      await ref(`tables/${table}`).set(rows.length ? obj : null);
      rowsSent += rows.length;
    }
    await ref('_meta').update({ version: next, updatedAt: Date.now(), by: instanceId });
    await db.query('delete from _changes');
    await db.query('update _sync_state set version = $1, source = $2, updated_at = now() where id = 1', [next, src]);
    log(`Uploaded ${rowsSent} rows to Firebase (version ${next}).`);
    return rowsSent;
  }

  /** Replaces the local copy with what Firebase holds. */
  async function pullSnapshot(remoteVersion) {
    const t = await info();
    const snap = (await ref('tables').get()).val() ?? {};
    let rowsLoaded = 0;
    await db.tx(async (tx) => {
      await tx.exec('set local session_replication_role = replica'); // no triggers / FK checks while loading
      await tx.exec(`truncate ${[...t.keys()].join(', ')}`);
      for (const [table, ti] of t) {
        const rows = Object.values(snap[table] ?? {}).map((r) => decodeRow(r, ti));
        // Only columns present in the data: a column added by a newer migration takes its default.
        const present = new Set(rows.flatMap((r) => Object.keys(r)));
        const cols = ti.columns.filter((c) => present.has(c)).map((c) => `"${c}"`).join(', ');
        for (let i = 0; i < rows.length; i += BATCH) {
          await tx.query(`insert into ${table} (${cols}) overriding system value
                          select ${cols} from jsonb_populate_recordset(null::${table}, $1::jsonb)`, [JSON.stringify(rows.slice(i, i + BATCH))]);
        }
        rowsLoaded += rows.length;
        const seq = await tx.one(`select pg_get_serial_sequence($1, 'id') as s`, [table]);
        if (seq?.s && rows.length) await tx.query(`select setval($1, (select max(id) from ${table}))`, [seq.s]);
      }
      await tx.query('delete from _changes');
      await tx.query('update _sync_state set version = $1, source = $2, updated_at = now() where id = 1', [remoteVersion, src]);
    });
    log(`Loaded ${rowsLoaded} rows from Firebase (version ${remoteVersion}).`);
    return rowsLoaded;
  }

  /** Sends pending local changes to Firebase; returns how many were sent. */
  function flush() {
    flushing ??= (async () => {
      let sent = 0;
      try {
        for (;;) {
          const { rows: sizes } = await db.query(
            'select id, coalesce(octet_length(row::text), 0) as bytes from _changes order by id limit $1', [BATCH]);
          if (!sizes.length) return sent;
          let upTo = sizes[0].id;
          for (let i = 0, total = 0; i < sizes.length; i += 1) {
            total += Number(sizes[i].bytes);
            if (i > 0 && total > BATCH_BYTES) break; // always at least one row
            upTo = sizes[i].id;
          }
          const { rows } = await db.query('select id, tbl, pk, op, row from _changes where id <= $1 order by id', [upTo]);
          const t = await info();
          const { version } = await localState();
          const updates = {};
          for (const c of rows) {
            const ti = t.get(c.tbl);
            if (!ti) continue;
            updates[`tables/${c.tbl}/${c.pk}`] = c.op === 'DELETE' ? null : encodeRow(c.row, ti, c.tbl);
          }
          updates['_meta/version'] = version + 1;
          updates['_meta/updatedAt'] = Date.now();
          await rtdb.ref(root).update(updates); // atomic: all of these or none
          const last = rows.at(-1).id;
          await db.tx(async (tx) => {
            await tx.query('delete from _changes where id <= $1', [last]);
            await tx.query('update _sync_state set version = $1, updated_at = now() where id = 1', [version + 1]);
          });
          sent += rows.length;
        }
      } finally {
        flushing = null;
      }
    })();
    return flushing;
  }

  async function start({ forceUpload = false } = {}) {
    await acquireLease();
    tables = null;
    await installCapture();
    const local = await localState();
    const pending = (await db.one('select count(*)::int as n from _changes')).n;
    const remote = (await ref('_meta/version').get()).val();
    const sameSource = local.source === src;

    if (forceUpload || remote == null) {
      await pushSnapshot();
    } else if (!sameSource || remote > local.version) {
      if (pending && sameSource) {
        throw new SyncConflictError(`This server has ${pending} change(s) not yet in Firebase, but Firebase was changed by someone else since. Resolve this before starting (see README: Firebase).`);
      }
      await pullSnapshot(remote);
    } else if (remote < local.version) {
      await pushSnapshot(); // Firebase was restored from an older backup: the local copy is newer
    } else if (pending) {
      await flush();
    }

    timer = setInterval(() => flush().catch((err) => log(`Firebase sync failed (will retry): ${err.message}`)), intervalMs);
    heartbeat = setInterval(() => acquireLease().catch((err) => log(`Firebase lease lost: ${err.message}`)), LEASE_MS / 3);
    timer.unref?.();
    heartbeat.unref?.();
  }

  async function stop() {
    clearInterval(timer);
    clearInterval(heartbeat);
    await flush();
    await ref('_meta/writer').transaction((cur) => (cur?.instance === instanceId ? null : undefined)).catch(() => {});
  }

  /** Deletes everything under the root (used by `npm run seed -- --reset`). */
  const wipeRemote = () => rtdb.ref(root).set(null);

  return { start, stop, flush, pushSnapshot, pullSnapshot, wipeRemote, acquireLease, instanceId };
}

/** Sync wired to the real Firebase project from server/.env. */
export async function createFirebaseSync({ db, log }) {
  const { rtdb, dbRoot } = await import('./admin.js');
  return createSync({ db, rtdb: rtdb(), root: dbRoot(), source: sourceOf(process.env.FIREBASE_DATABASE_URL, dbRoot()), log });
}
