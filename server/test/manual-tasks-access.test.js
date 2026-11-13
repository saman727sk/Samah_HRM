/**
 * Manual attendance by HR / managers, daily tasks with files, and
 * per-employee module access.
 * Clock: Wednesday 2026-03-04 10:00 Asia/Karachi (see helpers.js).
 * Bilal (E002) manages Ali (E003) and Ayesha (E004).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { buildApp } from '../src/api/app.js';
import { DEMO_PASSWORD } from '../seed/demo.js';

const PDF = Buffer.from('%PDF-1.4\n% test file\n%%EOF\n');
const dataUrl = (buf, mime = 'application/pdf') => `data:${mime};base64,${buf.toString('base64')}`;

describe('manual attendance, tasks and module access', () => {
  let t, app;
  const tokens = {};
  const call = async (who, method, url, body) => {
    const res = await app.inject({ method, url, payload: body, headers: { authorization: `Bearer ${tokens[who]}`, 'accept-language': 'en' } });
    const json = res.headers['content-type']?.includes('json');
    return { status: res.statusCode, body: json && res.body ? JSON.parse(res.body) : res.rawPayload, headers: res.headers };
  };
  const reasons = (res) => res.body?.error?.details?.reasons?.map((r) => r.code) ?? [];

  before(async () => {
    t = await setup();
    app = buildApp({ db: t.db, clock: t.clock, jwtSecret: 'test-secret' });
    for (const [who, email] of [['hr', 'hr@acme.test'], ['bilal', 'bilal@acme.test'], ['ali', 'ali@acme.test'],
      ['ayesha', 'ayesha@acme.test'], ['fatima', 'fatima@acme.test']]) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: DEMO_PASSWORD } });
      assert.equal(res.statusCode, 200, `login ${email}`);
      tokens[who] = JSON.parse(res.body).token;
    }
  });
  after(async () => { await app.close(); await t.close(); });

  describe('manual attendance', () => {
    test('a manager records a full day for a report; it shows as entered manually', async () => {
      const res = await call('bilal', 'POST', '/api/attendance/manual',
        { employeeId: t.emp('E003'), workDate: '2026-03-02', checkIn: '09:00', checkOut: '17:30', reason: 'Phone was broken' });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.events.length, 2);
      assert.ok(res.body.events.every((e) => e.method === 'manual' && e.note === 'Phone was broken'));
      assert.equal(res.body.day.workedMinutes, 510);
      assert.ok(res.body.day.flags.includes('manual_entry'));
      const log = await t.db.one(`select * from audit_log where action = 'attendance.manual_entry' and entity_id = $1`, [t.emp('E003')]);
      assert.ok(log);
      const note = await t.db.one(`select n.* from notifications n join employees e on e.user_id = n.user_id
                                   where e.id = $1 and n.template_key = 'attendance_recorded'`, [t.emp('E003')]);
      assert.ok(note);
    });

    test('overlapping, future, missing reason and outsiders are refused', async () => {
      const again = await call('bilal', 'POST', '/api/attendance/manual',
        { employeeId: t.emp('E003'), workDate: '2026-03-02', checkIn: '10:00', checkOut: '12:00', reason: 'Again' });
      assert.equal(again.status, 422);
      assert.deepEqual(reasons(again), ['attendance.manual_overlaps']);
      const future = await call('hr', 'POST', '/api/attendance/manual',
        { employeeId: t.emp('E003'), workDate: '2026-03-04', checkIn: '11:00', reason: 'Too early' });
      assert.deepEqual(reasons(future), ['attendance.manual_in_future']);
      const noReason = await call('hr', 'POST', '/api/attendance/manual', { employeeId: t.emp('E003'), workDate: '2026-03-03', checkIn: '09:00' });
      assert.equal(noReason.status, 400);
      // Bilal does not manage Fatima; employees can't record for others or themselves.
      assert.equal((await call('bilal', 'POST', '/api/attendance/manual',
        { employeeId: t.emp('E006'), workDate: '2026-03-03', checkIn: '09:00', reason: 'x' })).status, 403);
      assert.equal((await call('ali', 'POST', '/api/attendance/manual',
        { employeeId: t.emp('E004'), workDate: '2026-03-03', checkIn: '09:00', reason: 'x' })).status, 403);
      assert.equal((await call('bilal', 'POST', '/api/attendance/manual',
        { employeeId: t.emp('E002'), workDate: '2026-03-03', checkIn: '09:00', reason: 'x' })).status, 403);
    });

    test('HR closes an open check-in with a check-out only', async () => {
      const open = await call('hr', 'POST', '/api/attendance/manual',
        { employeeId: t.emp('E004'), workDate: '2026-03-03', checkIn: '09:15', reason: 'Card reader down' });
      assert.equal(open.status, 201, JSON.stringify(open.body));
      const close = await call('hr', 'POST', '/api/attendance/manual',
        { employeeId: t.emp('E004'), workDate: '2026-03-03', checkOut: '18:00', reason: 'Forgot to check out' });
      assert.equal(close.status, 201, JSON.stringify(close.body));
      assert.equal(close.body.day.workedMinutes, 525);
      const nothingOpen = await call('hr', 'POST', '/api/attendance/manual',
        { employeeId: t.emp('E004'), workDate: '2026-03-03', checkOut: '19:00', reason: 'Again' });
      assert.deepEqual(reasons(nothingOpen), ['attendance.manual_no_check_in']);
    });
  });

  describe('daily tasks', () => {
    let taskId, fileId;

    test('an employee logs a task, attaches a file and downloads it', async () => {
      const res = await call('ali', 'POST', '/api/tasks', {
        workDate: '2026-03-04', title: 'Client follow-ups', description: 'Called 5 leads', hours: 3.5, status: 'completed',
        links: ['https://example.com/crm/123'] });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.hours, 3.5);
      taskId = res.body.id;
      const up = await call('ali', 'POST', `/api/tasks/${taskId}/files`, { fileName: 'report.pdf', dataUrl: dataUrl(PDF) });
      assert.equal(up.status, 201, JSON.stringify(up.body));
      fileId = up.body.id;
      const down = await call('ali', 'GET', `/api/tasks/files/${fileId}`);
      assert.equal(down.status, 200);
      assert.equal(down.headers['content-type'], 'application/pdf');
      assert.match(down.headers['content-disposition'], /attachment; filename="report.pdf"/);
      assert.ok(Buffer.from(down.body).equals(PDF));
      const mine = await call('ali', 'GET', '/api/tasks?from=2026-03-01&to=2026-03-04');
      assert.equal(mine.body.logs.length, 1);
      assert.equal(mine.body.logs[0].files[0].file_name, 'report.pdf');
    });

    test('files are checked by type, content and size', async () => {
      const exe = await call('ali', 'POST', `/api/tasks/${taskId}/files`, { fileName: 'virus.exe', dataUrl: dataUrl(PDF) });
      assert.equal(exe.status, 400);
      const fake = await call('ali', 'POST', `/api/tasks/${taskId}/files`, { fileName: 'fake.pdf', dataUrl: dataUrl(Buffer.from('MZ not a pdf')) });
      assert.equal(fake.status, 400);
      const big = Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]);
      const tooBig = await call('ali', 'POST', `/api/tasks/${taskId}/files`, { fileName: 'big.pdf', dataUrl: dataUrl(big) });
      assert.equal(tooBig.status, 400);
      assert.equal(tooBig.body.error.code, 'file_too_big');
      // Just under the limit is accepted and stored in chunks.
      const nine = Buffer.concat([PDF, Buffer.alloc(9 * 1024 * 1024)]);
      const ok = await call('ali', 'POST', `/api/tasks/${taskId}/files`, { fileName: 'scan.pdf', dataUrl: dataUrl(nine) });
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      const chunks = await t.db.one('select count(*)::int as n from work_log_file_chunks where file_id = $1', [ok.body.id]);
      assert.equal(chunks.n, 19);
      const back = await call('hr', 'GET', `/api/tasks/files/${ok.body.id}`);
      assert.equal(Buffer.from(back.body).length, nine.length);
    });

    test('validation: blocked needs a note, no future dates, max 24 hours a day, web links only', async () => {
      const noNote = await call('ali', 'POST', '/api/tasks', { workDate: '2026-03-04', title: 'X', hours: 1, status: 'blocked' });
      assert.equal(noNote.status, 400);
      const future = await call('ali', 'POST', '/api/tasks', { workDate: '2026-03-05', title: 'X', hours: 1 });
      assert.equal(future.status, 400);
      const tooMany = await call('ali', 'POST', '/api/tasks', { workDate: '2026-03-04', title: 'X', hours: 21 });
      assert.equal(tooMany.status, 400);
      const badLink = await call('ali', 'POST', '/api/tasks', { workDate: '2026-03-04', title: 'X', hours: 1, links: ['javascript:alert(1)'] });
      assert.equal(badLink.status, 400);
    });

    test('a blocked task notifies the manager; managers and HR see it, others do not', async () => {
      const res = await call('ali', 'POST', '/api/tasks',
        { workDate: '2026-03-04', title: 'Quote approval', hours: 1, status: 'blocked', blocker: 'Waiting for pricing from finance' });
      assert.equal(res.status, 201);
      const note = await t.db.one(`select n.payload from notifications n join employees e on e.user_id = n.user_id
                                   where e.id = $1 and n.template_key = 'task_blocked'`, [t.emp('E002')]);
      assert.equal(note.payload.title, 'Quote approval');

      const team = await call('bilal', 'GET', '/api/tasks?scope=team&from=2026-03-04&to=2026-03-04&status=blocked');
      assert.deepEqual(team.body.logs.map((l) => l.title), ['Quote approval']);
      const all = await call('hr', 'GET', '/api/tasks?scope=all&from=2026-03-04&to=2026-03-04');
      assert.equal(all.body.logs.length, 2);
      assert.equal((await call('ali', 'GET', '/api/tasks?scope=all')).status, 403);
      assert.equal((await call('fatima', 'GET', `/api/tasks/files/${fileId}`)).status, 403);
      assert.equal((await call('ayesha', 'GET', `/api/tasks?employeeId=${t.emp('E003')}`)).status, 403);
      // Only the owner edits; others can't change or attach.
      assert.equal((await call('bilal', 'PATCH', `/api/tasks/${taskId}`, { title: 'Hacked' })).status, 403);
      assert.equal((await call('bilal', 'POST', `/api/tasks/${taskId}/files`, { fileName: 'a.pdf', dataUrl: dataUrl(PDF) })).status, 403);
    });

    test('the owner edits and deletes; files go with the task', async () => {
      const edit = await call('ali', 'PATCH', `/api/tasks/${taskId}`, { hours: 4, status: 'in_progress' });
      assert.equal(edit.status, 200, JSON.stringify(edit.body));
      assert.equal(edit.body.hours, 4);
      assert.equal(edit.body.title, 'Client follow-ups');
      assert.equal((await call('ali', 'DELETE', `/api/tasks/${taskId}`)).status, 204);
      const left = await t.db.one('select count(*)::int as n from work_log_files where work_log_id = $1', [taskId]);
      assert.equal(left.n, 0);
    });
  });

  describe('per-employee module access', () => {
    test('HR unticks modules for one person; the server and /me follow it', async () => {
      const ayesha = t.emp('E004');
      const bad = await call('hr', 'PATCH', `/api/employees/${ayesha}`, { module_access: ['attendance', 'nonsense'] });
      assert.equal(bad.status, 400);
      const res = await call('hr', 'PATCH', `/api/employees/${ayesha}`, { module_access: ['attendance', 'leave'] });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.module_access, ['attendance', 'leave']);

      const me = await call('ayesha', 'GET', '/api/me');
      assert.ok(me.body.modules.includes('attendance') && me.body.modules.includes('leave'));
      assert.ok(!me.body.modules.includes('tasks') && !me.body.modules.includes('wfh') && !me.body.modules.includes('payroll'));
      const tasks = await call('ayesha', 'GET', '/api/tasks');
      assert.equal(tasks.status, 403);
      assert.equal(tasks.body.error.code, 'module_disabled');
      assert.deepEqual((await call('ayesha', 'GET', '/api/payroll/payslips/mine')).body, []);
      // Others are not affected.
      assert.equal((await call('ali', 'GET', '/api/tasks')).status, 200);

      // Ticking everything again removes the limit.
      const all = await call('hr', 'PATCH', `/api/employees/${ayesha}`, { module_access: ['attendance', 'wfh', 'leave', 'payroll', 'tasks'] });
      assert.equal(all.body.module_access, null);
      assert.equal((await call('ayesha', 'GET', '/api/tasks')).status, 200);
    });

    test('HR admins are never limited', async () => {
      await call('hr', 'PATCH', `/api/employees/${t.emp('E001')}`, { module_access: [] });
      const me = await call('hr', 'GET', '/api/me');
      assert.ok(me.body.modules.includes('tasks') && me.body.modules.includes('payroll'));
      await call('hr', 'PATCH', `/api/employees/${t.emp('E001')}`, { module_access: null });
    });
  });
});
