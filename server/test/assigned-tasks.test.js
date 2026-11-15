/**
 * Assigned tasks: managers give tasks to their people, the person is notified (and reminded each
 * morning), both sides discuss the task in its thread.
 * Clock: Wed 2026-03-04 10:00 Asia/Karachi. Demo: E001 HR, E002 Bilal manages E003 Ali and E004 Ayesha.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { buildApp } from '../src/api/app.js';
import { DEMO_PASSWORD } from '../seed/demo.js';
import * as tasks from '../src/services/assignedTasks.js';
import { runTenantJobs } from '../src/services/jobs.js';
import { listNotifications } from '../src/services/notifications.js';

describe('assigned tasks', () => {
  let t, hr, bilal, ali, ayesha;
  before(async () => {
    t = await setup();
    [hr, bilal, ali, ayesha] = [t.hr, await t.as('E002'), await t.as('E003'), await t.as('E004')];
  });
  after(() => t.close());

  test('a manager assigns to their people only; the person is notified in the app and by email', async () => {
    const people = (await tasks.assignablePeople(bilal)).map((p) => p.employee_code);
    assert.ok(people.includes('E003') && people.includes('E004') && !people.includes('E001'));
    assert.equal((await tasks.assignablePeople(ali)).length, 0);
    await assert.rejects(tasks.assignTask(ali, { employeeIds: [t.emp('E004')], title: 'x' }), /report to you/);
    await assert.rejects(tasks.assignTask(bilal, { employeeIds: [t.emp('E006')], title: 'Not mine' }), /report to you/);
    await assert.rejects(tasks.assignTask(bilal, { employeeIds: [t.emp('E003')], title: 'Late', dueDate: '2026-03-01' }), /past/);

    const r = await tasks.assignTask(bilal, { employeeIds: [t.emp('E003'), t.emp('E004')], title: 'Prepare the March stock count',
      description: 'Count the warehouse shelves A-F.', priority: 'high' });
    assert.equal(r.assigned, 2);
    assert.equal(r.tasks[0].due_date, '2026-03-04', 'due today by default');
    const note = (await listNotifications(ali)).find((n) => n.event === 'task_assigned');
    assert.match(note.title, /March stock count/);
    assert.match(note.body, /Bilal.*due today.*high/);
    const { rows } = await t.db.query(`select count(*)::int as n from notifications where template_key = 'task_assigned' and channel = 'email'`);
    assert.equal(rows[0].n, 2);
  });

  test('lists: mine for the employee, team for the manager, everyone for HR; others cannot open it', async () => {
    const mine = await tasks.listTasks(ali, {});
    assert.equal(mine.tasks.length, 1);
    assert.equal(mine.counts.today, 1);
    assert.equal((await tasks.listTasks(bilal, { view: 'team' })).tasks.length, 2);
    assert.equal((await tasks.listTasks(hr, { view: 'team' })).tasks.length, 2);
    const id = mine.tasks[0].id;
    await assert.rejects(tasks.getTask(await t.as('E006'), id), /not found/i);
    await assert.rejects(tasks.getTask(ayesha, id), /not found/i, 'a colleague cannot read it');
    const full = await tasks.getTask(ali, id);
    assert.equal(full.isMine, true);
    assert.equal(full.canManage, false);
    await assert.rejects(tasks.updateTask(ali, id, { title: 'Easier task' }), /Only the person who assigned/);
  });

  test('discussion: messages reach the other side; blocked needs a reason; done is recorded', async () => {
    const id = (await tasks.listTasks(ali, {})).tasks[0].id;
    await tasks.postMessage(ali, id, { body: 'Do shelves G-H count too?' });
    assert.ok((await listNotifications(bilal)).some((n) => n.event === 'task_message' && /G-H/.test(n.body)));
    await tasks.postMessage(bilal, id, { body: 'No, only A-F.' });
    assert.ok((await listNotifications(ali)).some((n) => n.event === 'task_message' && /only A-F/.test(n.body)));

    await assert.rejects(tasks.setStatus(ali, id, { status: 'blocked' }), /blocking/);
    await tasks.setStatus(ali, id, { status: 'blocked', note: 'The scanner is broken' });
    assert.ok((await listNotifications(bilal)).some((n) => n.event === 'task_status' && /blocked/.test(n.title) && /scanner/.test(n.body)));
    const done = await tasks.setStatus(ali, id, { status: 'done' });
    assert.equal(done.status, 'done');
    assert.ok(done.completed_at);
    assert.deepEqual(done.messages.map((m) => m.kind), ['message', 'message', 'status', 'status']);
    assert.equal(done.messages[0].mine, true);
    assert.equal(done.messages[1].author, (await t.db.one(`select full_name from employees where id = $1`, [t.emp('E002')])).full_name);
    assert.equal((await tasks.listTasks(ali, {})).tasks.length, 0, 'open list no longer shows it');
    assert.equal((await tasks.listTasks(ali, { status: 'done' })).tasks.length, 1);
    const reopened = await tasks.setStatus(bilal, id, { status: 'todo', note: 'Recount shelf C please' });
    assert.equal(reopened.completed_at, null);
  });

  test('the manager can change the due date (person notified) and delete a task', async () => {
    const r = await tasks.assignTask(bilal, { employeeIds: [t.emp('E004')], title: 'Wrong one', dueDate: '2026-03-06' });
    const id = r.tasks[0].id;
    await tasks.updateTask(bilal, id, { dueDate: '2026-03-05' });
    assert.ok((await listNotifications(ayesha)).some((n) => n.event === 'task_changed' && /tomorrow/.test(n.body)));
    await tasks.deleteTask(bilal, id);
    await assert.rejects(tasks.getTask(bilal, id), /not found/i);
  });

  test('morning reminder: once a day after 08:00, listing tasks due today and overdue', async () => {
    const reminders = async (ctx) => (await listNotifications(ctx)).filter((n) => n.event === 'tasks_today');
    t.at('2026-03-05 07:30');
    assert.equal((await runTenantJobs(t.db, t.clock, t.tenant)).taskReminders, 0, 'not before 08:00');
    t.at('2026-03-05 08:05');
    const first = await runTenantJobs(t.db, t.clock, t.tenant);
    assert.ok(first.taskReminders >= 2, 'Ali and Ayesha');
    assert.equal((await runTenantJobs(t.db, t.clock, t.tenant)).taskReminders, 0, 'only once a day');
    const [r] = await reminders(ayesha);
    assert.match(r.title, /Your tasks for today \(1\)/);
    assert.match(r.body, /March stock count \(overdue/);
    t.at('2026-03-04 10:00');
  });

  test('over HTTP: employees read their own, cannot list assignable people', async () => {
    const app = buildApp({ db: t.db, clock: t.clock, jwtSecret: 'test-secret' });
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ali@acme.test', password: DEMO_PASSWORD } });
    const auth = { authorization: `Bearer ${JSON.parse(res.body).token}` };
    assert.equal((await app.inject({ method: 'GET', url: '/api/assigned-tasks?status=all', headers: auth })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/assigned-tasks/me', headers: auth })).statusCode, 200);
    const people = await app.inject({ method: 'GET', url: '/api/assigned-tasks/people', headers: auth });
    assert.equal(JSON.parse(people.body).length, 0);
    const post = await app.inject({ method: 'POST', url: '/api/assigned-tasks', headers: auth, payload: { employeeIds: [t.emp('E004')], title: 'Hi' } });
    assert.equal(post.statusCode, 403);
    await app.close();
  });
});
