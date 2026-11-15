/** Two processes on one embedded database folder corrupt it; the second open must be refused. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb } from '../src/db/index.js';

test('an embedded database folder can only be opened by one process at a time', async () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'hrm-lock-')), 'db');
  const db = await createDb({ url: '', dataDir: dir });
  const other = spawnSync(process.execPath, ['-e',
    `import('${new URL('../src/db/index.js', import.meta.url)}').then((m) => m.createDb({ url: '', dataDir: ${JSON.stringify(dir)} }))
       .then(() => process.exit(0), (e) => { console.error(e.message); process.exit(3); })`], { encoding: 'utf8' });
  assert.equal(other.status, 3);
  assert.match(other.stderr, /already open in another process/);
  await db.close();
  const again = await createDb({ url: '', dataDir: dir }); // released on close
  await again.close();
  rmSync(path.dirname(dir), { recursive: true, force: true });
});

test('a stale lock is taken over even when its PID now belongs to another live process', async () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'hrm-lock-')), 'db');
  const lockPath = `${path.resolve(dir)}.lock`;
  // The owner was killed without cleanup and the OS reused its PID: here, the
  // parent process, which is certainly alive. The lock has not been refreshed.
  writeFileSync(lockPath, String(process.ppid));
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(lockPath, old, old);
  const db = await createDb({ url: '', dataDir: dir });
  assert.equal(readFileSync(lockPath, 'utf8'), String(process.pid));
  await db.close();
  rmSync(path.dirname(dir), { recursive: true, force: true });
});
