import { useEffect, useRef, useState } from 'react';
import { del, get, patch, post, qs } from '../lib/api.js';
import { navigate, useApp } from '../lib/app.jsx';
import { fmtDate, todayIn } from '../lib/format.js';
import { useConfirm } from '../components/confirm.jsx';
import { PageHead } from '../components/Layout.jsx';
import { Alert, Button, Card, Empty, ErrorBox, Icon, Input, Loading, Modal, Stat, Tabs, useLoad } from '../components/ui.jsx';

const TASK_STATUS = { todo: ['', 'To do'], in_progress: ['info', 'In progress'], done: ['good', 'Done'], blocked: ['bad', 'Blocked'] };
const PRIORITY = { low: ['', 'Low'], normal: ['', 'Normal'], high: ['warn', 'High'], urgent: ['bad', 'Urgent'] };
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

export const TaskStatus = ({ status }) => <span className={`badge ${TASK_STATUS[status][0]}`}>{TASK_STATUS[status][1]}</span>;
export const Priority = ({ priority }) => (priority === 'normal' ? null : <span className={`badge ${PRIORITY[priority][0]}`}>{PRIORITY[priority][1]}</span>);

/** "Today", "Tomorrow", "Overdue · 3 Mar" or "Fri 6 Mar". */
export function Due({ task, today }) {
  if (task.status !== 'done' && task.due_date < today) return <span className="due overdue"><Icon name="alert" size={12} /> Overdue · {fmtDate(task.due_date, { day: 'numeric', month: 'short' })}</span>;
  if (task.due_date === today) return <span className="due today">Today</span>;
  if (task.due_date === addDays(today, 1)) return <span className="due">Tomorrow</span>;
  return <span className="due">{fmtDate(task.due_date, { weekday: 'short', day: 'numeric', month: 'short' })}</span>;
}

/**
 * Tasks given by a manager (or HR) to their people. Employees see what they were given and update it;
 * managers also see what they gave. Each task has a discussion thread. ?task=<id> opens one.
 */
export default function AssignedTasks({ query = {}, switcher }) {
  const { isManager, tz } = useApp();
  const today = todayIn(tz);
  const [view, setView] = useState(query.view === 'team' && isManager ? 'team' : 'mine');
  const [status, setStatus] = useState('open');
  const [q, setQ] = useState('');
  const [assigning, setAssigning] = useState(false);
  const { data, error, loading, reload } = useLoad(() => get(`/assigned-tasks${qs({ view, status, q })}`), [view, status, q]);
  const openId = query.task ?? null;
  const close = () => navigate('/tasks');
  const c = data?.counts ?? {};

  return (
    <div className="stack lg">
      <PageHead title="Daily tasks" subtitle={view === 'team' ? 'Tasks you gave to your people, and their progress.' : 'Tasks your manager gave you. Update them and ask questions here.'}
        actions={isManager && <Button kind="primary" icon="plus" onClick={() => setAssigning(true)}>Assign a task</Button>} />
      {switcher}
      {isManager && <Tabs tabs={[{ value: 'mine', label: 'Given to me' }, { value: 'team', label: 'Assigned by me / my team' }]} value={view} onChange={setView} />}
      {data && (
        <div className="grid stats">
          <Stat icon="alert" label="Overdue" value={c.overdue ?? 0} />
          <Stat icon="calendar" label="Due today" value={c.today ?? 0} />
          <Stat icon="clock" label="Upcoming" value={c.upcoming ?? 0} />
          <Stat icon="check" label="Done" value={c.done ?? 0} />
        </div>
      )}
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="tabs" role="tablist">
          {[['open', 'Open'], ['blocked', 'Blocked'], ['done', 'Done'], ['all', 'All']].map(([v, l]) => (
            <button key={v} role="tab" className="tab" aria-selected={status === v} onClick={() => setStatus(v)}>{l}</button>
          ))}
        </div>
        {view === 'team' && <div style={{ minWidth: 240 }}><Input placeholder="Search task, person or #" aria-label="Search tasks" value={q} onChange={(e) => setQ(e.target.value)} /></div>}
      </div>
      {view === 'team' && c.blocked > 0 && status !== 'blocked' && <Alert kind="bad">{c.blocked} {c.blocked === 1 ? 'task is' : 'tasks are'} blocked and may need your help. <button type="button" className="link" onClick={() => setStatus('blocked')}>Show them</button></Alert>}
      <Card className="flush">
        {loading && !data ? <Loading /> : error ? <ErrorBox error={error} /> : data.tasks.length === 0
          ? <Empty>{status === 'open' ? (view === 'team' ? 'No open tasks. Use "Assign a task" to give someone work.' : 'Nothing to do right now. New tasks from your manager appear here.') : 'No tasks here.'}</Empty>
          : (
            <div className="table-wrap"><table className="table task-table">
              <thead><tr><th>Task</th>{view === 'team' && <th>Person</th>}<th>Due</th><th>Status</th><th className="num"><Icon name="chat" size={14} /></th></tr></thead>
              <tbody>{data.tasks.map((tk) => (
                <tr key={tk.id} className="clickable" tabIndex={0} onClick={() => navigate(`/tasks?task=${tk.id}`)}
                  onKeyDown={(e) => e.key === 'Enter' && navigate(`/tasks?task=${tk.id}`)}>
                  <td><div className="row" style={{ gap: 6, flexWrap: 'wrap' }}><strong>{tk.title}</strong><Priority priority={tk.priority} /></div>
                    <div className="small muted">#{tk.number}{view === 'mine' ? ` · from ${tk.assigned_by_name}` : ''}{tk.description ? ` · ${tk.description.slice(0, 90)}${tk.description.length > 90 ? '…' : ''}` : ''}</div></td>
                  {view === 'team' && <td>{tk.employee_name}<div className="small muted">{tk.department ?? tk.employee_code}</div></td>}
                  <td className="nowrap"><Due task={tk} today={today} /></td>
                  <td><TaskStatus status={tk.status} /></td>
                  <td className="num">{tk.messages || ''}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
      </Card>
      {openId && <TaskDetail key={openId} id={openId} onClose={close} onChanged={reload} />}
      {assigning && <AssignDialog onClose={() => setAssigning(false)} onDone={() => { setAssigning(false); setView('team'); reload(); }} />}
    </div>
  );
}

/** Pick people (with search and select all), then title, description, due date and priority. */
function AssignDialog({ onClose, onDone, task }) {
  const { tz, toast } = useApp();
  const today = todayIn(tz);
  const editing = !!task;
  const { data: people, error: peopleError } = useLoad(() => (editing ? Promise.resolve([]) : get('/assigned-tasks/people')), [editing]);
  const [chosen, setChosen] = useState(new Set());
  const [search, setSearch] = useState('');
  const [f, setF] = useState(task
    ? { title: task.title, description: task.description ?? '', dueDate: task.due_date, priority: task.priority }
    : { title: '', description: '', dueDate: today, priority: 'normal' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const shown = (people ?? []).filter((p) => !search || `${p.full_name} ${p.employee_code} ${p.department ?? ''} ${p.role ?? ''}`.toLowerCase().includes(search.toLowerCase()));
  const toggle = (id) => setChosen((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allShown = shown.length > 0 && shown.every((p) => chosen.has(p.id));

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      if (editing) {
        await patch(`/assigned-tasks/${task.id}`, f);
        toast('Task updated. The person was notified.');
      } else {
        const r = await post('/assigned-tasks', { ...f, employeeIds: [...chosen] });
        toast(`Task given to ${r.assigned} ${r.assigned === 1 ? 'person' : 'people'}. They were notified.`);
      }
      onDone();
    } catch (e) { setErr(e); setBusy(false); }
  };

  return (
    <Modal wide title={editing ? 'Edit task' : 'Assign a task'} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button kind="primary" icon={editing ? 'check' : 'send'} disabled={busy || !f.title.trim() || (!editing && chosen.size === 0)} onClick={save}>
          {editing ? 'Save' : chosen.size > 1 ? `Assign to ${chosen.size} people` : 'Assign'}</Button></>}>
      <div className="stack">
        {!editing && (
          <div className="field">
            <span className="field-label">Who should do it? {chosen.size > 0 && <span className="muted">({chosen.size} chosen)</span>}</span>
            {peopleError ? <ErrorBox error={peopleError} /> : !people ? <Loading /> : people.length === 0 ? <Empty>Nobody reports to you yet.</Empty> : (
              <>
                <div className="row">
                  <div style={{ flex: 1 }}><Input placeholder="Search people" aria-label="Search people" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
                  <Button size="sm" onClick={() => setChosen((cur) => { const n = new Set(cur); shown.forEach((p) => (allShown ? n.delete(p.id) : n.add(p.id))); return n; })}>
                    {allShown ? 'Clear' : 'Select all'}</Button>
                </div>
                <div className="people-pick">
                  {shown.map((p) => (
                    <label key={p.id} className={`people-pick-row ${chosen.has(p.id) ? 'on' : ''}`}>
                      <input type="checkbox" checked={chosen.has(p.id)} onChange={() => toggle(p.id)} />
                      <span><strong>{p.full_name}</strong> <span className="small muted">{[p.role, p.department].filter(Boolean).join(' · ') || p.employee_code}</span></span>
                    </label>
                  ))}
                  {shown.length === 0 && <div className="small muted" style={{ padding: 8 }}>No one matches.</div>}
                </div>
                {chosen.size > 1 && <span className="small muted">Each person gets their own copy of the task to update.</span>}
              </>
            )}
          </div>
        )}
        <Input label="Task" value={f.title} onChange={set('title')} maxLength={200} required placeholder="e.g. Call the 5 new leads from yesterday" />
        <Input as="textarea" rows={4} label="Description" value={f.description} onChange={set('description')} maxLength={5000}
          placeholder="What exactly needs doing, any links or details, and what 'done' looks like." />
        <div className="form-grid">
          <Input label="Due date" type="date" min={editing && task.due_date < today ? task.due_date : today} value={f.dueDate} onChange={set('dueDate')} required />
          <Input as="select" label="Priority" value={f.priority} onChange={set('priority')}>
            {Object.entries(PRIORITY).map(([v, [, l]]) => <option key={v} value={v}>{l}</option>)}
          </Input>
        </div>
        {!editing && <p className="small muted" style={{ margin: 0 }}>They get a notification and an email now, and a reminder on the morning it is due.</p>}
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}

/** One task: details, status buttons, and the discussion between the person and their manager. */
function TaskDetail({ id, onClose, onChanged }) {
  const { toast, tz } = useApp();
  const confirm = useConfirm();
  const today = todayIn(tz);
  const { data: tk, error, reload } = useLoad(() => get(`/assigned-tasks/${id}`), [id]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [editing, setEditing] = useState(false);
  const end = useRef(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [tk?.messages?.length]);

  const run = async (fn, done) => {
    setBusy(true);
    try { await fn(); reload(); onChanged(); if (done) toast(done); } catch (e) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };
  const send = () => run(async () => { await post(`/assigned-tasks/${id}/messages`, { body: text }); setText(''); });
  const move = (status, note) => run(async () => { await post(`/assigned-tasks/${id}/status`, { status, note }); setBlocking(false); setText(''); },
    { in_progress: 'Marked as in progress.', done: 'Marked as done. Well done!', blocked: 'Marked as blocked. Your manager was told.', todo: 'Task reopened.' }[status]);
  const remove = async () => {
    if (!(await confirm({ title: `Delete "${tk.title}"?`, message: 'The task and its messages are removed for good.', confirmLabel: 'Delete', danger: true }))) return;
    try { await del(`/assigned-tasks/${id}`); toast('Task deleted.'); onChanged(); onClose(); } catch (e) { toast(e.message, 'bad'); }
  };

  if (error) return <Modal title="Task" onClose={onClose}><ErrorBox error={error} /></Modal>;
  if (!tk) return <Modal title="Task" onClose={onClose}><Loading /></Modal>;
  if (editing) return <AssignDialog task={tk} onClose={() => setEditing(false)} onDone={() => { setEditing(false); reload(); onChanged(); }} />;
  const canMove = tk.isMine || tk.canManage;
  return (
    <Modal wide title={`#${tk.number} · ${tk.title}`} onClose={onClose}
      footer={tk.canManage && <><Button icon="edit" onClick={() => setEditing(true)}>Edit</Button><Button icon="trash" kind="danger" onClick={remove}>Delete</Button></>}>
      <div className="stack">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <TaskStatus status={tk.status} /><Priority priority={tk.priority} /><Due task={tk} today={today} />
          <span className="small muted">
            {tk.isMine ? `From ${tk.assigned_by_name}` : `${tk.employee_name} · from ${tk.assigned_by_name}`} · given {fmtDate(tk.created_at.slice(0, 10), { day: 'numeric', month: 'short' })}
            {tk.completed_at ? ` · done ${fmtDate(tk.completed_at.slice(0, 10), { day: 'numeric', month: 'short' })}` : ''}
          </span>
        </div>
        {tk.description ? <div className="task-desc">{tk.description}</div> : <div className="small muted">No description.</div>}
        {canMove && (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {tk.status !== 'in_progress' && tk.status !== 'done' && <Button icon="clock" disabled={busy} onClick={() => move('in_progress')}>Start</Button>}
            {tk.status !== 'done' && <Button kind="primary" icon="check" disabled={busy} onClick={() => move('done')}>Mark as done</Button>}
            {tk.status !== 'done' && tk.status !== 'blocked' && <Button icon="alert" disabled={busy} onClick={() => setBlocking(true)}>I'm blocked</Button>}
            {(tk.status === 'done' || tk.status === 'blocked') && <Button icon="refresh" disabled={busy} onClick={() => move(tk.status === 'blocked' ? 'in_progress' : 'todo')}>{tk.status === 'blocked' ? 'Unblocked, continue' : 'Reopen'}</Button>}
          </div>
        )}
        {blocking && (
          <Alert kind="warn" title="What is blocking you?">
            <div className="stack">
              <textarea className="input" rows={2} autoFocus aria-label="What is blocking you" value={text} onChange={(e) => setText(e.target.value)} maxLength={5000}
                placeholder="e.g. I need access to the sales folder" />
              <div className="row" style={{ gap: 8 }}>
                <Button kind="primary" disabled={busy || !text.trim()} onClick={() => move('blocked', text)}>Mark as blocked</Button>
                <Button onClick={() => setBlocking(false)}>Cancel</Button>
              </div>
            </div>
          </Alert>
        )}

        <div className="task-thread">
          <div className="field-label" style={{ padding: '12px 16px 0' }}>Discussion</div>
          <div className="thread-body">
            {tk.messages.length === 0 && <div className="small muted">No messages yet. Ask a question or share an update; {tk.isMine ? 'your manager' : tk.employee_name} is notified.</div>}
            {tk.messages.map((m) => m.kind === 'status'
              ? <div key={m.id} className="task-event small muted"><Icon name="info" size={12} /> {m.author}: {m.body} · {new Date(m.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</div>
              : (
                <div key={m.id} className={`bubble ${m.mine ? 'mine' : ''}`}>
                  <div className="bubble-meta">{m.author} · {new Date(m.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</div>
                  <div className="bubble-text">{m.body}</div>
                </div>
              ))}
            <div ref={end} />
          </div>
          {!blocking && (
            <div className="thread-reply">
              <textarea className="input" rows={2} placeholder="Write a message…" aria-label="Message" value={text} maxLength={5000}
                onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim()) send(); }} />
              <div className="row between">
                <span className="small muted">Ctrl + Enter to send</span>
                <Button kind="primary" icon="send" disabled={busy || !text.trim()} onClick={send}>Send</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
