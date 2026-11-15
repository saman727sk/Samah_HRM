/**
 * Rota: managers plan their people's shifts per day, the rota shift drives attendance, "Off" is a rest day.
 * Help desk: employees ask HR, HR answers in a thread.
 * Clock: Wed 2026-03-04 10:00 Asia/Karachi. Demo: E001 HR, E002 Bilal manages E003 Ali and E004 Ayesha.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { buildApp } from '../src/api/app.js';
import { DEMO_PASSWORD } from '../seed/demo.js';
import * as rota from '../src/services/rota.js';
import * as helpdesk from '../src/services/helpdesk.js';
import * as att from '../src/services/attendance.js';
import { createLookup } from '../src/services/lookups.js';
import { seedPublished } from '../src/services/tenants.js';
import { listNotifications } from '../src/services/notifications.js';

describe('rota', () => {
  let t, hr, bilal, ali, evening;
  before(async () => {
    t = await setup();
    [hr, bilal, ali] = [t.hr, await t.as('E002'), await t.as('E003')];
    // An evening shift 14:00-22:00 next to the demo's 09:00-18:00 general shift
    evening = await createLookup(t.hr, 'shifts', { code: 'EVENING', name: 'Evening' });
    await seedPublished(t.db, t.system, { key: 'shift.rules', subjectId: evening.id, effectiveFrom: '2026-01-01',
      value: { start: '14:00', end: '22:00', graceMinutes: 15, halfDayLateMinutes: 120, fullDayMinHours: 8, halfDayMinHours: 4 } });
  });
  after(() => t.close());

  const day = async (code, date) => (await att.daySummaries(t.hr, t.emp(code), { from: date, to: date }))[0];

  test('a manager sees and plans only the people under them; employees cannot plan', async () => {
    const r = await rota.getRota(bilal, { week: '2026-03-04' });
    assert.equal(r.weekStart, '2026-03-02');
    assert.equal(r.days.length, 7);
    const codes = r.people.map((p) => p.employee_code).sort();
    assert.ok(codes.includes('E003') && codes.includes('E004'));
    assert.ok(!codes.includes('E006'), 'not someone from another team');
    assert.ok(r.shifts.some((s) => s.name === 'Evening' && s.start === '14:00'));
    await assert.rejects(rota.saveRota(bilal, { changes: [{ employeeId: t.emp('E006'), date: '2026-03-05', shiftId: evening.id }] }), /doesn't report to you/);
    await assert.rejects(rota.getRota(ali, {}), /Only managers and HR/);
    const all = await rota.getRota(hr, { week: '2026-03-04' });
    assert.ok(all.people.length > r.people.length && all.canPlanEveryone);
  });

  test('the rota shift is what attendance judges lateness against', async () => {
    const reason = 'Forgot to check in';
    await att.recordManual(hr, { employeeId: t.emp('E003'), workDate: '2026-03-03', checkIn: '14:05', checkOut: '22:00', reason });
    assert.ok((await day('E003', '2026-03-03')).flags.includes('late'), 'against the usual 09:00 shift: late');
    await rota.saveRota(bilal, { changes: [{ employeeId: t.emp('E003'), date: '2026-03-03', shiftId: evening.id }] });
    const d = await day('E003', '2026-03-03');
    assert.deepEqual([d.status, d.lateMinutes, d.flags.includes('late')], ['present', 5, false]); // 5 min, within the 15 min grace
    // Ali is told his rota changed
    const notes = await listNotifications(ali);
    assert.ok(notes.some((n) => n.event === 'rota_changed' && /Bilal/.test(n.body)), JSON.stringify(notes.map((n) => n.body)));
  });

  test('"Off" makes a rest day (not absent), and a shift on a weekend makes it a working day', async () => {
    assert.equal((await day('E004', '2026-03-02')).status, 'absent');
    await rota.saveRota(bilal, { changes: [{ employeeId: t.emp('E004'), date: '2026-03-02', off: true }] });
    assert.equal((await day('E004', '2026-03-02')).status, 'weekend');
    // Clearing the cell brings the usual pattern back
    await rota.saveRota(bilal, { changes: [{ employeeId: t.emp('E004'), date: '2026-03-02' }] });
    assert.equal((await day('E004', '2026-03-02')).status, 'absent');
    // Sunday 1 March: a rest day normally; with a rota shift and no attendance, absent
    assert.equal((await day('E004', '2026-03-01')).status, 'weekend');
    await rota.saveRota(bilal, { changes: [{ employeeId: t.emp('E004'), date: '2026-03-01', shiftId: evening.id }] });
    assert.equal((await day('E004', '2026-03-01')).status, 'absent');
  });

  test('copy last week fills the next week; the employee sees their own days', async () => {
    await rota.saveRota(bilal, { changes: [
      { employeeId: t.emp('E004'), date: '2026-03-05', shiftId: evening.id },
      { employeeId: t.emp('E004'), date: '2026-03-06', off: true },
    ] });
    const res = await rota.copyWeek(bilal, { fromWeek: '2026-03-02', toWeek: '2026-03-09' });
    assert.ok(res.saved > 0);
    const next = await rota.getRota(bilal, { week: '2026-03-09' });
    const ayesha = next.entries.filter((e) => e.employee_id === t.emp('E004'));
    assert.ok(ayesha.some((e) => e.date === '2026-03-12' && e.shift_id === evening.id));
    assert.ok(ayesha.some((e) => e.date === '2026-03-13' && e.is_off));
    const mine = await rota.myRota(await t.as('E004'), { from: '2026-03-09', days: 7 });
    const thu = mine.days.find((d) => d.date === '2026-03-12');
    assert.deepEqual([thu.source, thu.shift?.name, thu.shift?.start], ['rota', 'Evening', '14:00']);
    const fri = mine.days.find((d) => d.date === '2026-03-13');
    assert.deepEqual([fri.off, fri.shift], [true, null]);
    assert.equal(mine.days.find((d) => d.date === '2026-03-10').source, 'usual');
  });
});

describe('help desk', () => {
  let t, hr, ali, ayesha, ticket;
  before(async () => {
    t = await setup();
    [hr, ali, ayesha] = [t.hr, await t.as('E003'), await t.as('E004')];
  });
  after(() => t.close());

  test('an employee asks HR; HR is notified and sees it, other employees do not', async () => {
    await assert.rejects(helpdesk.openTicket(ali, { category: 'payroll', subject: 'x', body: '' }), /subject.*Write your question/s);
    ticket = await helpdesk.openTicket(ali, { category: 'payroll', subject: 'Overtime missing on payslip', body: 'My February overtime is not on my payslip.' });
    assert.deepEqual([ticket.number, ticket.status, ticket.messages.length], [1, 'open', 1]);
    assert.ok((await listNotifications(hr)).some((n) => n.event === 'ticket_new' && /#1/.test(n.title)));
    const inbox = await helpdesk.listTickets(hr, { status: 'open' });
    assert.equal(inbox.tickets[0].subject, 'Overtime missing on payslip');
    assert.equal((await helpdesk.openCount(hr)).open, 1);
    assert.equal((await helpdesk.listTickets(ayesha)).tickets.length, 0);
    await assert.rejects(helpdesk.getTicket(ayesha, ticket.id), /not found/i);
  });

  test('HR replies (answered, the employee is told), the employee replies (open again), HR closes', async () => {
    let r = await helpdesk.replyTicket(hr, ticket.id, { body: 'Checked: it is added to the March payroll.' });
    assert.equal(r.status, 'answered');
    assert.ok((await listNotifications(ali)).some((n) => n.event === 'ticket_reply' && /March payroll/.test(n.body)));
    r = await helpdesk.replyTicket(ali, ticket.id, { body: 'Thanks, will it show the hours too?' });
    assert.deepEqual([r.status, r.messages.length, r.messages.at(-1).from_hr], ['open', 3, false]);
    r = await helpdesk.setTicketStatus(hr, ticket.id, { status: 'closed' });
    assert.equal(r.status, 'closed');
    assert.ok((await listNotifications(ali)).some((n) => n.event === 'ticket_closed'));
    r = await helpdesk.replyTicket(ali, ticket.id, { body: 'One more question...' });
    assert.equal(r.status, 'open', 'a reply reopens it');
  });

  test('over HTTP: routes answer and an employee cannot plan a rota', async () => {
    const app = buildApp({ db: t.db, clock: t.clock, jwtSecret: 'test-secret' });
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ali@acme.test', password: DEMO_PASSWORD } });
    const auth = { authorization: `Bearer ${JSON.parse(res.body).token}` };
    assert.equal((await app.inject({ method: 'GET', url: '/api/helpdesk', headers: auth })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/rota/me', headers: auth })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/rota', headers: auth })).statusCode, 403);
    await app.close();
  });
});
