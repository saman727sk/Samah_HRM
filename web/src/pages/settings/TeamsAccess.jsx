import { useState } from 'react';
import { get, post, put } from '../../lib/api.js';
import { useApp } from '../../lib/app.jsx';
import { useConfirm } from '../../components/confirm.jsx';
import { PageHead } from '../../components/Layout.jsx';
import { Alert, Button, Card, Empty, ErrorBox, Input, Loading, Modal, PasswordInput, Stat, Tabs, useLoad } from '../../components/ui.jsx';
import { BulkLoginsDialog } from '../../components/LoginDialogs.jsx';

const LEVEL = { hr_admin: 'HR admin', manager: 'Manager / team lead', employee: 'Employee' };

/**
 * HR: who is a manager / team lead, who works under each one, and what each person may do.
 * Managers' team rights (approve, rota, tasks, attendance, team features) and company areas
 * (help desk, payroll) that can be given to anyone.
 */
export default function TeamsAccess() {
  const { toast } = useApp();
  const { data, error, loading, reload } = useLoad(() => get('/access'), []);
  const [tab, setTab] = useState('teams');
  const [selected, setSelected] = useState(null);
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [giving, setGiving] = useState(null);
  const [givingAll, setGivingAll] = useState(false);
  const [q, setQ] = useState('');
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;

  const people = data.people;
  const managers = people.filter((p) => p.access_level === 'manager' || p.access_level === 'hr_admin');
  const current = managers.find((m) => m.id === selected) ?? managers.find((m) => m.access_level === 'manager') ?? managers[0];
  const team = current ? people.filter((p) => p.manager_id === current.id) : [];
  const label = (k) => data.permissions.find((p) => p.key === k)?.label ?? k;
  const noManager = people.filter((p) => !p.manager_id && p.access_level !== 'hr_admin');
  const noLogin = people.filter((p) => !p.access_level);
  const extra = people.filter((p) => p.access_level !== 'hr_admin' && p.effective.some((k) => !k.startsWith('team.')));
  const shown = people.filter((p) => !q || `${p.full_name} ${p.employee_code} ${p.department ?? ''} ${p.role ?? ''}`.toLowerCase().includes(q.toLowerCase()));

  const removeFromTeam = async (p) => {
    try { await post(`/access/${current.id}/team`, { remove: [p.id] }); toast(`${p.full_name} no longer works under ${current.full_name}.`); reload(); }
    catch (e) { toast(e.message, 'bad'); }
  };

  return (
    <div className="stack lg">
      <PageHead title="Teams & access" subtitle="Choose managers and team leads, put people under them, and decide what each person can do."
        actions={<Button kind="primary" icon="plus" onClick={() => setPromoting(true)}>Add a manager / team lead</Button>} />
      <div className="grid stats">
        <Stat icon="users" label="Managers & team leads" value={managers.filter((m) => m.access_level === 'manager').length} />
        <Stat icon="users" label="People" value={people.length} />
        <Stat icon="alert" label="Without a manager" value={noManager.length} sub="their requests go to HR" />
        <Stat icon="shield" label="With extra access" value={extra.length} sub="help desk or payroll" />
      </div>
      {noLogin.length > 0 && <Alert kind="info" title={`${noLogin.length} of ${people.length} people have no login yet`}>
        They can't sign in, so they can't see tasks, rotas or payslips, and can't be managers. Give them all a login with one starting password, or one by one on the Everyone tab. No emails are sent.{' '}
        <button type="button" className="link" onClick={() => setTab('everyone')}>Show them</button>
        <div style={{ marginTop: 8 }}><Button size="sm" kind="primary" icon="lock" onClick={() => setGivingAll(true)}>Give logins to everyone</Button></div></Alert>}
      <Tabs tabs={[{ value: 'teams', label: 'Managers & teams' }, { value: 'everyone', label: 'Everyone' }]} value={tab} onChange={setTab} />

      {tab === 'teams' ? (
        managers.length === 0 ? <Empty>No managers yet. Click "Add a manager / team lead".</Empty> : (
          <div className="access-split">
            <Card className="flush">
              <ul className="ticket-list">
                {managers.map((m) => (
                  <li key={m.id}>
                    <button type="button" className={`ticket-row ${current?.id === m.id ? 'active' : ''}`} onClick={() => setSelected(m.id)}>
                      <div className="row between" style={{ flexWrap: 'nowrap' }}>
                        <strong className="ticket-subject">{m.full_name}</strong>
                        <span className="badge">{m.team_size} {m.team_size === 1 ? 'person' : 'people'}</span>
                      </div>
                      <div className="small muted">{[m.role, m.department].filter(Boolean).join(' · ') || m.employee_code}{m.access_level === 'hr_admin' ? ' · HR admin' : ''}</div>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
            {current && (
              <div className="stack">
                <Card title={current.full_name} actions={current.access_level !== 'hr_admin' && <Button size="sm" icon="edit" onClick={() => setEditing(current)}>Change rights</Button>}>
                  <div className="small muted" style={{ marginBottom: 8 }}>{LEVEL[current.access_level]}{current.manager_name ? ` · reports to ${current.manager_name}` : ''}</div>
                  {current.access_level === 'hr_admin'
                    ? <p className="small muted" style={{ margin: 0 }}>HR admins can do everything.</p>
                    : <RightsChips list={current.effective} label={label} custom={current.custom} />}
                </Card>
                <Card className="flush" title={`Team (${team.length})`} actions={<Button size="sm" kind="primary" icon="plus" onClick={() => setAdding(true)}>Add people</Button>}>
                  {team.length === 0 ? <Empty>Nobody works under {current.full_name} yet. Click "Add people".</Empty> : (
                    <div className="table-wrap"><table className="table">
                      <thead><tr><th>Person</th><th>Level</th><th>Rights</th><th /></tr></thead>
                      <tbody>{team.map((p) => (
                        <tr key={p.id}>
                          <td><strong>{p.full_name}</strong><div className="small muted">{[p.role, p.department].filter(Boolean).join(' · ') || p.employee_code}</div></td>
                          <td className="small">{LEVEL[p.access_level] ?? 'No login'}{p.team_size ? ` · leads ${p.team_size}` : ''}</td>
                          <td><RightsChips list={p.effective} label={label} small /></td>
                          <td className="nowrap">
                            {p.access_level && p.access_level !== 'hr_admin' && <Button size="sm" onClick={() => setEditing(p)}>Access</Button>}
                            {!p.access_level && <Button size="sm" icon="send" onClick={() => setGiving(p)}>Give login</Button>}
                            <Button size="sm" onClick={() => removeFromTeam(p)}>Remove</Button>
                          </td>
                        </tr>
                      ))}</tbody>
                    </table></div>
                  )}
                </Card>
              </div>
            )}
          </div>
        )
      ) : (
        <Card className="flush">
          <div style={{ padding: 14 }}><Input placeholder="Search name, code, department or role" aria-label="Search people" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Person</th><th>Level</th><th>Manager</th><th>Rights</th><th /></tr></thead>
            <tbody>{shown.map((p) => (
              <tr key={p.id}>
                <td><strong>{p.full_name}</strong><div className="small muted">{[p.role, p.department].filter(Boolean).join(' · ') || p.employee_code}</div></td>
                <td className="small">{LEVEL[p.access_level] ?? 'No login'}</td>
                <td className="small">{p.manager_name ?? <span className="muted">None</span>}</td>
                <td>{p.access_level === 'hr_admin' ? <span className="small muted">Everything</span> : <RightsChips list={p.effective} label={label} small />}</td>
                <td className="nowrap">{p.access_level && p.access_level !== 'hr_admin' && <Button size="sm" onClick={() => setEditing(p)}>Access</Button>}
                  {!p.access_level && <Button size="sm" icon="send" onClick={() => setGiving(p)}>Give login</Button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </Card>
      )}

      {editing && <RightsDialog person={editing} data={data} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload(); }} />}
      {adding && current && <AddPeopleDialog manager={current} people={people} onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
      {givingAll && <BulkLoginsDialog count={noLogin.length} onClose={() => setGivingAll(false)} onDone={() => { setGivingAll(false); reload(); }} />}
      {giving && <LoginDialog person={giving} onClose={() => setGiving(null)} onDone={() => { setGiving(null); reload(); }} />}
      {promoting && <PromoteDialog people={people} onClose={() => setPromoting(false)} onDone={(id) => { setPromoting(false); setSelected(id); setTab('teams'); reload(); }} />}
    </div>
  );
}

function RightsChips({ list, label, small, custom }) {
  if (!list.length) return <span className="small muted">Nothing extra</span>;
  return (
    <div className="chips">
      {list.map((k) => <span key={k} className={`badge ${k.startsWith('team.') ? 'info' : 'violet'}`}>{label(k)}</span>)}
      {!small && custom === false && <span className="small muted">(defaults)</span>}
    </div>
  );
}

/** Level (employee / manager) and rights for one person. */
function RightsDialog({ person, data, onClose, onDone }) {
  const { toast } = useApp();
  const confirm = useConfirm();
  const [level, setLevel] = useState(person.access_level);
  const [rights, setRights] = useState(new Set(person.effective));
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const toggle = (k) => setRights((cur) => { const n = new Set(cur); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const groups = [['team', 'Their team', 'Only for managers and team leads: what they can do for the people under them.'],
    ['area', 'Company areas', 'Work for the whole company, like HR, in one area. Can be given to anyone.']];

  const save = async () => {
    if (level === 'employee' && person.access_level === 'manager' && person.team_size > 0 && !(await confirm({
      title: `${person.full_name} is no longer a manager?`, confirmLabel: 'Yes, change',
      message: `${person.team_size} ${person.team_size === 1 ? 'person still reports' : 'people still report'} to them. Their requests will go to HR until you move them to another manager.`,
    }))) return;
    setBusy(true); setErr(null);
    try {
      await put(`/access/${person.id}`, { accessLevel: level, permissions: [...rights] });
      toast(`Access of ${person.full_name} saved. They were notified.`);
      onDone();
    } catch (e) { setErr(e); setBusy(false); }
  };
  const useDefaults = async () => {
    setBusy(true);
    try { await put(`/access/${person.id}`, { accessLevel: level, permissions: null }); toast('Back to the default rights.'); onDone(); }
    catch (e) { setErr(e); setBusy(false); }
  };

  return (
    <Modal wide title={`Access: ${person.full_name}`} onClose={onClose}
      footer={<>{level === 'manager' && <Button onClick={useDefaults} disabled={busy}>Use manager defaults</Button>}
        <Button onClick={onClose}>Cancel</Button><Button kind="primary" icon="check" disabled={busy} onClick={save}>Save</Button></>}>
      <div className="stack">
        <Input as="select" label="Level" value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="employee">Employee</option>
          <option value="manager">Manager / team lead</option>
        </Input>
        {groups.map(([g, title, help]) => (
          <fieldset key={g} className="rights-group" disabled={g === 'team' && level !== 'manager'}>
            <legend>{title}</legend>
            <p className="small muted" style={{ margin: '0 0 8px' }}>{g === 'team' && level !== 'manager' ? 'Make them a manager / team lead to give team rights.' : help}</p>
            {data.permissions.filter((p) => p.group === g).map((p) => (
              <label key={p.key} className={`people-pick-row ${rights.has(p.key) && !(g === 'team' && level !== 'manager') ? 'on' : ''}`}>
                <input type="checkbox" checked={rights.has(p.key) && !(g === 'team' && level !== 'manager')} onChange={() => toggle(p.key)} />
                <span><strong>{p.label}</strong> <span className="small muted">{p.help}</span></span>
              </label>
            ))}
          </fieldset>
        ))}
        {person.access_level === 'manager' && !rights.has('team.approve') && person.effective.includes('team.approve') &&
          <Alert kind="info">Their pending approvals will move to HR.</Alert>}
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}

/** Pick people to put under a manager (they leave their current manager). */
function AddPeopleDialog({ manager, people, onClose, onDone }) {
  const { toast } = useApp();
  const [chosen, setChosen] = useState(new Set());
  const [q, setQ] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const options = people.filter((p) => p.id !== manager.id && p.manager_id !== manager.id && p.access_level !== 'hr_admin')
    .filter((p) => !q || `${p.full_name} ${p.employee_code} ${p.department ?? ''} ${p.role ?? ''} ${p.manager_name ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  const toggle = (id) => setChosen((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const all = options.length > 0 && options.every((p) => chosen.has(p.id));
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await post(`/access/${manager.id}/team`, { add: [...chosen] });
      toast(`${r.added} ${r.added === 1 ? 'person now works' : 'people now work'} under ${manager.full_name}.`);
      onDone();
    } catch (e) { setErr(e); setBusy(false); }
  };
  return (
    <Modal wide title={`Add people to ${manager.full_name}'s team`} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={busy || !chosen.size} onClick={save}>{chosen.size ? `Add ${chosen.size}` : 'Add'}</Button></>}>
      <div className="stack">
        <div className="row">
          <div style={{ flex: 1 }}><Input placeholder="Search name, department, role or current manager" aria-label="Search people" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <Button size="sm" onClick={() => setChosen((cur) => { const n = new Set(cur); options.forEach((p) => (all ? n.delete(p.id) : n.add(p.id))); return n; })}>{all ? 'Clear' : 'Select all'}</Button>
        </div>
        <div className="people-pick" style={{ maxHeight: 360 }}>
          {options.map((p) => (
            <label key={p.id} className={`people-pick-row ${chosen.has(p.id) ? 'on' : ''}`}>
              <input type="checkbox" checked={chosen.has(p.id)} onChange={() => toggle(p.id)} />
              <span><strong>{p.full_name}</strong> <span className="small muted">{[p.role, p.department].filter(Boolean).join(' · ')}{p.manager_name ? ` · now under ${p.manager_name}` : ' · no manager'}{p.access_level ? '' : ' · no login yet'}</span></span>
            </label>
          ))}
          {options.length === 0 && <div className="small muted" style={{ padding: 8 }}>No one else to add.</div>}
        </div>
        <span className="small muted">People who already have a manager move to {manager.full_name}. Requests already waiting stay with their old approver.</span>
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}

/** Make an employee (with a login) a manager / team lead. */
function PromoteDialog({ people, onClose, onDone }) {
  const { toast } = useApp();
  const [id, setId] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [q, setQ] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const options = people.filter((p) => p.access_level !== 'hr_admin' && p.access_level !== 'manager')
    .filter((p) => !q || `${p.full_name} ${p.employee_code} ${p.department ?? ''} ${p.role ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  const chosen = people.find((p) => p.id === id);
  const needsLogin = chosen && !chosen.access_level;
  const pick = (p) => { setId(p.id); setEmail(p.email ?? ''); };
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await put(`/access/${id}`, { accessLevel: 'manager', permissions: null, ...(needsLogin && { email, password }) });
      toast(r.login ? `Login created: they sign in with ${r.login.email} and the password you set. They are now a manager.`
        : 'They are now a manager / team lead with the default rights.');
      onDone(id);
    } catch (e) { setErr(e); setBusy(false); }
  };
  return (
    <Modal title="Add a manager / team lead" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={busy || !id || (needsLogin && (!email.trim() || password.length < 8))} onClick={save}>Make manager</Button></>}>
      <div className="stack">
        <Input placeholder="Search name, code, department or role" aria-label="Search people" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="people-pick" style={{ maxHeight: 280 }}>
          {options.map((p) => (
            <label key={p.id} className={`people-pick-row ${id === p.id ? 'on' : ''}`}>
              <input type="radio" name="promote" checked={id === p.id} onChange={() => pick(p)} />
              <span><strong>{p.full_name}</strong> <span className="small muted">{[p.role, p.department].filter(Boolean).join(' · ') || p.employee_code}{p.access_level ? '' : ' · no login yet'}</span></span>
            </label>
          ))}
          {options.length === 0 && <div className="small muted" style={{ padding: 8 }}>{people.length ? 'No one matches.' : 'Add employees first (HR > People).'}</div>}
        </div>
        {needsLogin && (
          <div className="form-grid">
            <Input label="Login email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required
              help={`${chosen.full_name} has no login yet; one is made now.`} />
            <PasswordInput label="Password" autoComplete="new-password" help="At least 8 characters. Give it to them (no email is sent)."
              value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
        )}
        <p className="small muted" style={{ margin: 0 }}>They get the default manager rights (approve requests, plan the rota, assign tasks, record attendance). You can change them next, then add people to their team.</p>
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}

/** Create a login for someone added without one; they get an email to choose their password. */
function LoginDialog({ person, onClose, onDone }) {
  const { toast } = useApp();
  const [email, setEmail] = useState(person.email ?? '');
  const [level, setLevel] = useState('employee');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await post(`/employees/${person.id}/login`, { email, accessLevel: level, password });
      toast(`Login created: they sign in with ${r.email} and the password you set.`);
      onDone();
    } catch (e) { setErr(e); setBusy(false); }
  };
  return (
    <Modal title={`Give ${person.full_name} a login`} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" icon="lock" disabled={busy || !email.trim() || password.length < 8} onClick={save}>Create login</Button></>}>
      <div className="stack">
        <Input label="Login email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <Input as="select" label="Level" value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="employee">Employee</option>
          <option value="manager">Manager / team lead</option>
        </Input>
        <PasswordInput label="Password" autoComplete="new-password" help="At least 8 characters. Give it to them (no email is sent); they can change it after signing in."
          value={password} onChange={(e) => setPassword(e.target.value)} />
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}
