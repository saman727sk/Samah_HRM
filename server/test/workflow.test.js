/**
 * Approval workflows: steps, auto-approve, escalation, HR override,
 * self-approval rules, cancellation, notifications — all driven by the
 * versioned 'workflow.*' settings.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, codes } from './helpers.js';
import * as leave from '../src/services/leave.js';
import * as wfh from '../src/services/wfh.js';
import * as wf from '../src/services/workflow.js';
import * as settings from '../src/services/settings.js';
import { dispatchEmails, listNotifications } from '../src/services/notifications.js';
import { createLookup } from '../src/services/lookups.js';

const companyWorkflow = async (t) => (await settings.list(t.hr, { key: 'workflow.leave' })).find((s) => s.scope_type === 'company').current.value;
const applyLeave = async (t, code, type, startDate, endDate = startDate) =>
  leave.createLeaveRequest(await t.as(code), { employeeId: t.emp(code), leaveTypeId: t.demo.leaveTypes[type], startDate, endDate });
const status = async (t, id) => (await t.db.one('select status from leave_requests where id = $1', [id])).status;

describe('default workflow: manager approves', () => {
  let t;
  before(async () => { t = await setup(); });
  after(() => t.close());

  test('request lands in the manager inbox with a notification; approval notifies the employee', async () => {
    const { request, workflow } = await applyLeave(t, 'E004', 'CASUAL', '2026-03-09');
    assert.equal(workflow.status, 'pending');
    const bilal = await t.as('E002');
    const inbox = await wf.inbox(bilal);
    assert.equal(inbox.length, 1);
    assert.match(inbox[0].request.summary, /^Casual Leave 2026-03-09 \(1 day\)$/);
    const [note] = await listNotifications(bilal);
    assert.equal(note.title, 'Approval needed: Leave request');
    assert.equal(note.body, 'Ayesha Siddiqui requested Casual Leave 2026-03-09 (1 day).');

    await assert.rejects(wf.decide(await t.as('E005'), inbox[0].task.id, { decision: 'approved' }), { code: 'forbidden' }, 'not their team');
    await wf.decide(bilal, inbox[0].task.id, { decision: 'approved', comment: 'OK' });
    assert.equal(await status(t, request.id), 'approved');
    const [mine] = await listNotifications(await t.as('E004'));
    assert.equal(mine.title, 'Leave request approved');
  });

  test('emails go out through the transport', async () => {
    const sent = [];
    const n = await dispatchEmails(t.db, { send: async (m) => sent.push(m) });
    assert.equal(n, sent.length);
    assert.ok(sent.some((m) => m.to === 'bilal@acme.test' && m.subject === 'Approval needed: Leave request'));
  });

  test('rejection keeps the balance untouched', async () => {
    const { request } = await applyLeave(t, 'E003', 'ANNUAL', '2026-03-16', '2026-03-17');
    await leave.decideLeave(await t.as('E002'), request.id, { decision: 'rejected', comment: 'Quarter close' });
    assert.equal(await status(t, request.id), 'rejected');
    const b = (await leave.getBalances(t.hr, t.emp('E003'))).find((x) => x.leaveType.code === 'ANNUAL');
    assert.deepEqual([b.used, b.pending, b.available], [0, 0, 20]);
  });

  test('a workflow change does not affect requests already in flight', async () => {
    const { request } = await applyLeave(t, 'E003', 'CASUAL', '2026-03-10');
    await t.publishSetting({ key: 'workflow.leave', value: { ...(await companyWorkflow(t)), steps: [{ approver: 'manager' }, { approver: 'hr' }] } });
    await leave.decideLeave(await t.as('E002'), request.id, { decision: 'approved' });
    assert.equal(await status(t, request.id), 'approved', 'still single-step');
  });
});

describe('configurable steps', () => {
  let t;
  before(async () => {
    t = await setup();
    await t.publishSetting({ key: 'workflow.leave', value: { ...(await companyWorkflow(t)), steps: [{ approver: 'manager' }, { approver: 'hr' }] } });
  });
  after(() => t.close());

  test('manager then HR', async () => {
    const { request } = await applyLeave(t, 'E003', 'ANNUAL', '2026-03-16', '2026-03-17');
    const first = await leave.decideLeave(await t.as('E002'), request.id, { decision: 'approved' });
    assert.equal(first.status, 'pending');
    assert.equal(await status(t, request.id), 'pending');
    assert.equal((await wf.inbox(await t.as('E002'))).length, 0);
    const hrInbox = await wf.inbox(t.hr);
    assert.equal(hrInbox.length, 1);
    await wf.decide(t.hr, hrInbox[0].task.id, { decision: 'approved' });
    assert.equal(await status(t, request.id), 'approved');
    const usage = (await leave.getLedger(t.hr, t.emp('E003'), t.demo.leaveTypes.ANNUAL)).find((l) => l.kind === 'usage');
    assert.equal(usage.days, -2);
  });

  test('HR override completes the request immediately', async () => {
    const { request } = await applyLeave(t, 'E004', 'CASUAL', '2026-03-10');
    await leave.decideLeave(t.hr, request.id, { decision: 'approved', override: true });
    assert.equal(await status(t, request.id), 'approved');
    const tasks = await wf.tasksFor(t.hr, 'leave', request.id);
    assert.deepEqual(tasks.map((x) => [x.approver_kind, x.status, x.override]), [['manager', 'approved', true], ['hr', 'skipped', false]]);
  });

  test('a manager without a manager goes straight to HR; nobody approves their own request', async () => {
    const { request } = await applyLeave(t, 'E002', 'CASUAL', '2026-03-11');
    const tasks = await wf.tasksFor(t.hr, 'leave', request.id);
    assert.deepEqual(tasks.map((x) => x.approver_kind), ['hr']);
    await assert.rejects(leave.decideLeave(await t.as('E002'), request.id, { decision: 'approved' }), { code: 'forbidden' });
  });

  test('the only HR admin may decide their own request (audited)', async () => {
    const { request } = await applyLeave(t, 'E001', 'CASUAL', '2026-03-12');
    await leave.decideLeave(t.hr, request.id, { decision: 'approved' });
    assert.equal(await status(t, request.id), 'approved');
  });

  test('department-scoped auto-approve: Engineering 1-day leave is approved instantly', async () => {
    await t.publishSetting({ key: 'workflow.leave', scopeType: 'department', scopeId: t.demo.departments.ENG,
      value: { autoApprove: { enabled: true, maxDays: 1, leaveTypeIds: [t.demo.leaveTypes.CASUAL] } } });
    const eng = await applyLeave(t, 'E006', 'CASUAL', '2026-03-13');
    assert.equal(eng.workflow.status, 'approved');
    assert.equal(eng.request.status, 'approved');
    const twoDays = await applyLeave(t, 'E008', 'CASUAL', '2026-03-12', '2026-03-13');
    assert.equal(twoDays.workflow.status, 'pending', 'over the 1-day limit');
    const sales = await applyLeave(t, 'E004', 'CASUAL', '2026-03-13');
    assert.equal(sales.workflow.status, 'pending', 'Sales is not covered');
  });
});

describe('escalation, cancellation, clash warnings, custom fields', () => {
  let t;
  before(async () => { t = await setup(); });
  after(() => t.close());

  test('undecided after N days escalates to HR', async () => {
    const { request } = await applyLeave(t, 'E004', 'ANNUAL', '2026-03-16');
    t.at('2026-03-05 10:00');
    assert.equal(await wf.runEscalations(t.system), 0);
    t.at('2026-03-06 10:01'); // 2 days after submission
    assert.equal(await wf.runEscalations(t.system), 1);
    const tasks = await wf.tasksFor(t.hr, 'leave', request.id);
    assert.deepEqual(tasks.map((x) => [x.approver_kind, x.status]), [['manager', 'escalated'], ['hr', 'pending']]);
    const [note] = await listNotifications(await t.as('E004'));
    assert.equal(note.title, 'Escalated: Leave request');
    await leave.decideLeave(t.hr, request.id, { decision: 'approved' });
    assert.equal(await status(t, request.id), 'approved');
  });

  test('cancelling approved future leave returns the days via the ledger', async () => {
    const { request } = await applyLeave(t, 'E003', 'CASUAL', '2026-03-12', '2026-03-13');
    await leave.decideLeave(await t.as('E002'), request.id, { decision: 'approved' });
    const before = (await leave.getBalances(t.hr, t.emp('E003'))).find((x) => x.leaveType.code === 'CASUAL');
    assert.equal(before.balance, 8);
    await leave.cancelLeave(await t.as('E003'), request.id, { reason: 'Plans changed' });
    const after = (await leave.getBalances(t.hr, t.emp('E003'))).find((x) => x.leaveType.code === 'CASUAL');
    assert.deepEqual([after.balance, after.used], [10, 0]);
    const kinds = (await leave.getLedger(t.hr, t.emp('E003'), t.demo.leaveTypes.CASUAL)).map((l) => l.kind);
    assert.deepEqual(kinds, ['grant', 'usage', 'usage_reversal']);
  });

  test('cancelling a pending request closes its approval steps', async () => {
    const { request } = await applyLeave(t, 'E003', 'CASUAL', '2026-03-17');
    await leave.cancelLeave(await t.as('E003'), request.id);
    const tasks = await wf.tasksFor(t.hr, 'leave', request.id);
    assert.deepEqual(tasks.map((x) => x.status), ['skipped']);
    assert.equal((await wf.inbox(await t.as('E002'))).length, 0);
  });

  test('team clash warning uses the HR threshold', async () => {
    await applyLeave(t, 'E003', 'CASUAL', '2026-03-19');
    const req = { employeeId: t.emp('E004'), leaveTypeId: t.demo.leaveTypes.CASUAL, startDate: '2026-03-19' };
    assert.deepEqual(codes((await leave.checkLeave(t.hr, req)).warnings), [], '1 off < threshold 2');
    await t.publishSetting({ key: 'leave.rules', patch: { teamClashMaxOff: 1 } });
    const w = (await leave.checkLeave(t.hr, req)).warnings;
    assert.deepEqual(codes(w), ['leave.team_clash']);
    assert.deepEqual(w[0].params, { date: '2026-03-19', count: 1, max: 1 });
    const cal = await leave.teamCalendar(await t.as('E002'), { from: '2026-03-16', to: '2026-03-20' });
    assert.deepEqual(cal.employees.map((e) => e.name), ['Ali Raza', 'Ayesha Siddiqui', 'Bilal Khan']);
  });

  test('HR-defined required custom field on leave requests', async () => {
    await createLookup(t.hr, 'custom-fields', { entity: 'leave_request', field_key: 'handover_to', label: 'Work handed over to', field_type: 'text', required: true });
    await assert.rejects(applyLeave(t, 'E006', 'CASUAL', '2026-03-18'), { code: 'custom_fields_invalid', message: 'Work handed over to is required.' });
    const ok = await leave.createLeaveRequest(await t.as('E006'), { employeeId: t.emp('E006'), leaveTypeId: t.demo.leaveTypes.CASUAL,
      startDate: '2026-03-18', customFields: { handover_to: 'Zainab' } });
    assert.equal(ok.request.custom_fields.handover_to, 'Zainab');
  });

  test('WFH requests use the same engine; cancelling frees the quota', async () => {
    const hira = await t.as('E010');
    const r = await wfh.createWfhRequest(hira, { employeeId: t.emp('E010'), dates: ['2026-03-16', '2026-03-17'] });
    assert.equal(r.workflow.status, 'pending');
    const [item] = await wf.inbox(await t.as('E009'));
    assert.equal(item.request.summary, 'WFH on 2026-03-16, 2026-03-17');
    await wf.decide(await t.as('E009'), item.task.id, { decision: 'approved' });
    assert.equal((await wfh.getWfhQuota(t.hr, t.emp('E010'), { date: '2026-03-16' })).week.used, 2);
    await wfh.cancelWfh(hira, r.requestGroupId);
    assert.equal((await wfh.getWfhQuota(t.hr, t.emp('E010'), { date: '2026-03-16' })).week.used, 0);
  });
});
