import { useState } from 'react';
import AssignedTasks from './AssignedTasks.jsx';
import { del, download, get, patch, post, qs } from '../lib/api.js';
import { navigate, useApp } from '../lib/app.jsx';
import { fmtDay, todayIn } from '../lib/format.js';
import { useConfirm } from '../components/confirm.jsx';
import { PageHead } from '../components/Layout.jsx';
import { Alert, Button, Card, Empty, ErrorBox, Icon, Input, Loading, Modal, Stat, StatusBadge, Tabs, useLoad } from '../components/ui.jsx';

const MAX_FILE_MB = 10;
const ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.pptx,.png,.jpg,.jpeg,.gif,.webp,.zip';
const addDays = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const fileSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

/** Add / edit one task; new files are uploaded after the task is saved. */
export function TaskForm({ item, onClose, onSaved }) {
  const { t, tz, toast } = useApp();
  const confirm = useConfirm();
  const today = todayIn(tz);
  const [f, setF] = useState(item
    ? { workDate: item.work_date, title: item.title, description: item.description ?? '', hours: String(item.hours), status: item.status,
      blocker: item.blocker ?? '', links: (item.links ?? []).join('\n') }
    : { workDate: today, title: '', description: '', hours: '', status: 'completed', blocker: '', links: '' });
  const [files, setFiles] = useState([]);
  const [existing, setExisting] = useState(item?.files ?? []);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const pick = (e) => {
    const chosen = [...e.target.files];
    e.target.value = '';
    const tooBig = chosen.filter((x) => x.size > MAX_FILE_MB * 1048576);
    if (tooBig.length) toast(t('ui.file_too_big', '{name} is bigger than {mb} MB.', { name: tooBig[0].name, mb: MAX_FILE_MB }), 'bad');
    setFiles([...files, ...chosen.filter((x) => x.size <= MAX_FILE_MB * 1048576)]);
  };
  const removeExisting = async (file) => {
    if (!(await confirm({ title: t('ui.remove_file_q', 'Remove {name}?', { name: file.file_name }), confirmLabel: t('ui.remove', 'Remove'), danger: true }))) return;
    try { await del(`/tasks/files/${file.id}`); setExisting(existing.filter((x) => x.id !== file.id)); } catch (err) { toast(err.message, 'bad'); }
  };

  const save = async () => {
    setError(null);
    setBusy(true);
    const body = { ...f, hours: Number(f.hours), links: f.links.split(/\s+/).filter(Boolean), blocker: f.status === 'blocked' ? f.blocker : null };
    let saved;
    try {
      saved = item ? await patch(`/tasks/${item.id}`, body) : await post('/tasks', body);
    } catch (err) { setError(err); setBusy(false); return; }
    const failed = [];
    for (const file of files) {
      try { await post(`/tasks/${saved.id}/files`, { fileName: file.name, dataUrl: await readAsDataUrl(file) }); }
      catch (err) { failed.push(`${file.name}: ${err.message}`); }
    }
    setBusy(false);
    if (failed.length) toast(t('ui.task_saved_files_failed', 'Task saved, but some files were not attached: {list}', { list: failed.join('; ') }), 'bad');
    else toast(t('ui.task_saved', 'Task saved.'));
    onSaved();
  };

  return (
    <Modal wide title={item ? t('ui.edit_task', 'Edit task') : t('ui.log_task', 'Log a daily task')} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('ui.cancel', 'Cancel')}</Button>
        <Button kind="primary" disabled={busy || !f.title.trim() || f.hours === ''} onClick={save}>{busy ? t('ui.saving', 'Saving…') : t('ui.save', 'Save')}</Button></>}>
      <div className="stack">
        <div className="form-grid">
          <Input label={t('ui.date', 'Date')} type="date" max={today} value={f.workDate} onChange={set('workDate')} required />
          <Input label={t('ui.hours_spent', 'Hours spent')} type="number" min="0" max="24" step="0.25" value={f.hours} onChange={set('hours')} required />
        </div>
        <Input label={t('ui.title', 'Title')} value={f.title} onChange={set('title')} maxLength={200} required placeholder={t('ui.task_title_ph', 'e.g. Fixed login bug on the mobile app')} />
        <Input as="textarea" rows={3} label={t('ui.description', 'Description')} value={f.description} onChange={set('description')} maxLength={5000} />
        <Input as="select" label={t('ui.status', 'Status')} value={f.status} onChange={set('status')}>
          <option value="completed">✅ {t('status.completed', 'Completed')}</option>
          <option value="in_progress">⏳ {t('status.in_progress', 'In progress')}</option>
          <option value="blocked">⚠️ {t('status.blocked', 'Blocked')}</option>
        </Input>
        {f.status === 'blocked' && (
          <Input as="textarea" rows={2} label={t('ui.blocker', 'What is blocking you?')} value={f.blocker} onChange={set('blocker')} maxLength={2000} required
            help={t('ui.blocker_help', 'Your manager is notified so they can help.')} />
        )}
        <Input as="textarea" rows={2} label={t('ui.links', 'Links (one per line)')} value={f.links} onChange={set('links')}
          placeholder="https://github.com/…/pull/42" help={t('ui.links_help', 'Pull requests, Figma, Jira, Google Docs… up to 10.')} />
        <div className="field">
          <span className="field-label">{t('ui.attachments', 'Attachments')}</span>
          {existing.map((x) => (
            <div key={x.id} className="row small"><Icon name="paperclip" size={14} />{x.file_name} <span className="muted">{fileSize(x.size_bytes)}</span>
              <Button size="sm" onClick={() => removeExisting(x)}>{t('ui.remove', 'Remove')}</Button></div>
          ))}
          {files.map((x, i) => (
            <div key={`${x.name}-${i}`} className="row small"><Icon name="paperclip" size={14} />{x.name} <span className="muted">{fileSize(x.size)} · {t('ui.uploads_on_save', 'uploads on save')}</span>
              <Button size="sm" onClick={() => setFiles(files.filter((_, j) => j !== i))}>{t('ui.remove', 'Remove')}</Button></div>
          ))}
          <input type="file" multiple accept={ACCEPT} onChange={pick} aria-label={t('ui.add_files', 'Add files')} />
          <span className="small muted">{t('ui.file_rules', 'PDF, Word, Excel, PowerPoint, images or ZIP; up to {mb} MB each, 10 per task.', { mb: MAX_FILE_MB })}</span>
        </div>
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

function TaskRow({ log, showName, canEdit, canDelete, onEdit, onDelete }) {
  const { t, toast } = useApp();
  const open = (file) => download(`/tasks/files/${file.id}`, file.file_name).catch((err) => toast(err.message, 'bad'));
  return (
    <tr>
      <td className="nowrap">{fmtDay(log.work_date)}</td>
      {showName && <td>{log.employee_name}<div className="small muted">{log.department_name ?? ''}</div></td>}
      <td>
        <strong>{log.title}</strong>
        {log.description && <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{log.description}</div>}
        {log.status === 'blocked' && log.blocker && <div className="small" style={{ color: 'var(--bad)' }}><Icon name="alert" size={12} /> {log.blocker}</div>}
        {(log.links.length > 0 || log.files.length > 0) && (
          <div className="chips" style={{ marginTop: 4 }}>
            {log.links.map((l) => <a key={l} className="badge" href={l} target="_blank" rel="noopener noreferrer"><Icon name="link" size={12} />{l.replace(/^https?:\/\//, '').slice(0, 40)}</a>)}
            {log.files.map((x) => <button key={x.id} type="button" className="badge" onClick={() => open(x)} title={t('ui.download', 'Download')}><Icon name="download" size={12} />{x.file_name}</button>)}
          </div>
        )}
      </td>
      <td className="num">{log.hours} h</td>
      <td><StatusBadge status={log.status} /></td>
      <td className="nowrap">
        {canEdit && <Button size="sm" onClick={() => onEdit(log)}>{t('ui.edit', 'Edit')}</Button>}
        {canDelete && <Button size="sm" onClick={() => onDelete(log)}>{t('ui.delete', 'Delete')}</Button>}
      </td>
    </tr>
  );
}

/** The person's own work log (what they did, hours, blockers, files). */
function WorkLog({ query = {}, switcher }) {
  const { t, tz, toast, isHr, isManager: manager, can, session } = useApp();
  const isManager = manager && can('team.tasks');
  const confirm = useConfirm();
  const today = todayIn(tz);
  const scopes = [{ value: 'mine', label: t('ui.my_tasks', 'My tasks') },
    ...(isManager && !isHr ? [{ value: 'team', label: t('ui.team_tasks', 'My team') }] : []),
    ...(isHr ? [{ value: 'all', label: t('ui.everyone', 'Everyone') }] : [])];
  const [scope, setScope] = useState(scopes.some((s) => s.value === query.scope) ? query.scope : query.scope === 'team' && isHr ? 'all' : 'mine');
  const [range, setRange] = useState({ from: addDays(today, -6), to: today });
  const [status, setStatus] = useState(query.status ?? '');
  const [editing, setEditing] = useState(query.new ? {} : null);
  const { data, error, loading, reload } = useLoad(() => get(`/tasks${qs({ scope, ...range, status })}`), [scope, range.from, range.to, status]);
  const me = session.employee?.id;

  const remove = async (log) => {
    if (!(await confirm({ title: t('ui.delete_task_q', 'Delete "{title}"?', { title: log.title }), danger: true, confirmLabel: t('ui.delete', 'Delete'),
      message: t('ui.delete_task_msg', 'The task and its files are removed for good.') }))) return;
    try { await del(`/tasks/${log.id}`); toast(t('ui.deleted', 'Deleted.')); reload(); } catch (err) { toast(err.message, 'bad'); }
  };

  const logs = data?.logs ?? [];
  const sum = (list) => Math.round(list.reduce((n, l) => n + l.hours, 0) * 100) / 100;
  const blocked = logs.filter((l) => l.status === 'blocked');
  return (
    <div className="stack lg">
      <PageHead title={t('nav.tasks', 'Daily tasks')} subtitle={t('ui.tasks_sub', 'What was done, how long it took, and what is blocked.')}
        actions={<Button kind="primary" icon="plus" disabled={!me} onClick={() => setEditing({})}>{t('ui.log_task', 'Log a daily task')}</Button>} />
      {switcher}
      {scopes.length > 1 && <Tabs tabs={scopes} value={scope} onChange={setScope} />}
      <div className="row">
        <Input label={t('ui.from', 'From')} type="date" max={range.to} value={range.from} onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })} />
        <Input label={t('ui.to', 'To')} type="date" min={range.from} max={today} value={range.to} onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })} />
        <Input as="select" label={t('ui.status', 'Status')} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t('ui.all', 'All')}</option>
          <option value="completed">{t('status.completed', 'Completed')}</option>
          <option value="in_progress">{t('status.in_progress', 'In progress')}</option>
          <option value="blocked">{t('status.blocked', 'Blocked')}</option>
        </Input>
      </div>
      {data && (
        <div className="grid stats">
          <Stat icon="clock" label={t('ui.hours_logged', 'Hours logged')} value={sum(logs)} />
          <Stat icon="check" label={t('status.completed', 'Completed')} value={logs.filter((l) => l.status === 'completed').length} />
          <Stat icon="tasks" label={t('status.in_progress', 'In progress')} value={logs.filter((l) => l.status === 'in_progress').length} />
          <Stat icon="alert" label={t('status.blocked', 'Blocked')} value={blocked.length} />
        </div>
      )}
      {scope !== 'mine' && blocked.length > 0 && !status && (
        <Alert kind="bad" title={t('ui.blockers_title', '{n} blocked task(s) need attention', { n: blocked.length })}
          items={blocked.map((l) => `${l.employee_name}: ${l.title} — ${l.blocker}`)} />
      )}
      <Card className="flush">
        {loading && !data ? <Loading /> : error ? <ErrorBox error={error} /> : logs.length === 0 ? <Empty>{t('ui.no_tasks', 'No tasks logged in this period.')}</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{t('ui.date', 'Date')}</th>{scope !== 'mine' && <th>{t('ui.employee', 'Employee')}</th>}<th>{t('ui.task', 'Task')}</th>
              <th className="num">{t('ui.hours', 'Hours')}</th><th>{t('ui.status', 'Status')}</th><th /></tr></thead>
            <tbody>{logs.map((l) => (
              <TaskRow key={l.id} log={l} showName={scope !== 'mine'} canEdit={l.employee_id === me} canDelete={l.employee_id === me || isHr}
                onEdit={setEditing} onDelete={remove} />
            ))}</tbody>
          </table></div>
        )}
      </Card>
      {editing && <TaskForm item={editing.id ? editing : null} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </div>
  );
}

/**
 * Daily tasks: "Assigned tasks" (given by a manager, discussed in a thread) and "Work log" (what I did).
 * ?view=log, ?new=1, ?scope= or ?status= open the work log; ?task=<id> opens an assigned task.
 */
export default function Tasks({ query = {} }) {
  const [view, setView] = useState(query.view === 'log' || query.new || query.scope || query.status ? 'log' : 'assigned');
  const switcher = <Tabs tabs={[{ value: 'assigned', label: 'Assigned tasks' }, { value: 'log', label: 'Work log' }]} value={view}
    onChange={(v) => { setView(v); if (query.task) navigate('/tasks'); }} />;
  return view === 'log' ? <WorkLog query={query} switcher={switcher} /> : <AssignedTasks query={query} switcher={switcher} />;
}
