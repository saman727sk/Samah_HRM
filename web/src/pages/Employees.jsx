import { useEffect, useState } from 'react';
import { api, download, get, patch, post } from '../lib/api.js';
import { useApp } from '../lib/app.jsx';
import { fmtDate } from '../lib/format.js';
import { useConfirm } from '../components/confirm.jsx';
import { PageHead } from '../components/Layout.jsx';
import EmployeeImport from '../components/EmployeeImport.jsx';
import { Button, Card, ErrorBox, Input, Loading, Modal, PasswordInput, StatusBadge, Switch, useLoad } from '../components/ui.jsx';
import { BulkLoginsDialog } from '../components/LoginDialogs.jsx';

/** Modules HR can switch off for one person (matches PERSONAL_MODULES on the server). */
const PERSONAL_MODULES = [
  ['attendance', 'Attendance', 'Check in / out and attendance history'],
  ['leave', 'Leave', 'Apply for leave, see balances'],
  ['wfh', 'Work from home', 'Request WFH days'],
  ['tasks', 'Daily tasks', 'Log daily work, links and files'],
  ['payroll', 'Payslips', 'See their own payslips'],
];

function ModuleAccess({ value, onChange, companyModules, isHrLogin }) {
  const on = (m) => value == null || value.includes(m);
  const toggle = (m, checked) => {
    const next = PERSONAL_MODULES.map(([k]) => k).filter((k) => (k === m ? checked : on(k)));
    onChange(next.length === PERSONAL_MODULES.length ? null : next);
  };
  return (
    <Card title="Module access">
      {isHrLogin ? <p className="small muted">HR admins always have every module.</p> : (
        <div className="stack">
          <p className="small muted">Untick what this person should not see. Their menu hides it and the server refuses it.</p>
          <div className="form-grid">
            {PERSONAL_MODULES.map(([m, label, help]) => {
              const companyOff = !companyModules.includes(m);
              return (
                <label key={m} className="row" style={{ alignItems: 'flex-start', gap: 8, opacity: companyOff ? 0.6 : 1 }}>
                  <input type="checkbox" checked={on(m)} onChange={(e) => toggle(m, e.target.checked)} />
                  <span><strong>{label}</strong><br /><span className="small muted">{companyOff ? 'Switched off for the whole company' : help}</span></span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}

function EmployeeForm({ item, refs, onClose, onSaved }) {
  const { toast, session } = useApp();
  const confirm = useConfirm();
  const [v, setV] = useState(item ?? { status: 'active', custom_fields: {}, module_access: null });
  const [login, setLogin] = useState(item ? null : { enabled: true, accessLevel: 'employee', password: '' });
  const [acct, setAcct] = useState({ accessLevel: 'employee', password: '' }); // editing: create a login / set a new password
  const [error, setError] = useState(null);
  const set = (k) => (e) => setV({ ...v, [k]: e.target.value || null });
  // New employee: pre-fill the next code (editable; left empty, the server generates it).
  useEffect(() => {
    if (item) return;
    get('/employees/next-code').then(({ code }) => setV((cur) => (cur.employee_code ? cur : { ...cur, employee_code: code }))).catch(() => {});
  }, [item]);
  const save = async () => {
    setError(null);
    if (item && item.status === 'active' && v.status !== 'active' && !(await confirm({ title: `Mark ${item.full_name} as ${v.status}?`, danger: true,
      confirmLabel: v.status === 'exited' ? 'Mark as exited' : 'Deactivate', message: 'Their sign-in is disabled straight away, and they drop out of attendance, approvals and new payroll runs. Their history is kept, and you can reactivate them later.' }))) return;
    const keys = ['employee_code', 'full_name', 'email', 'phone', 'department_id', 'role_id', 'employment_type_id', 'manager_id', 'shift_id', 'location_id',
      'joining_date', 'probation_end_date', 'exit_date', 'status', 'custom_fields', 'module_access'];
    const body = Object.fromEntries(keys.filter((k) => v[k] !== undefined).map((k) => [k, v[k]]));
    if (!item && login?.enabled && !v.email?.trim()) {
      setError(new Error('Enter their email (they sign in with it), or switch off "Give them a login".'));
      return;
    }
    if (!item && login?.enabled && login.password.length < 8) {
      setError(new Error('Set a password for their login (at least 8 characters), or switch off "Give them a login".'));
      return;
    }
    if (item && acct.password && acct.password.length < 8) { setError(new Error('The password must be at least 8 characters.')); return; }
    if (item && !item.user_id && acct.password && !v.email?.trim()) { setError(new Error('Enter their email above: they sign in with it.')); return; }
    let created;
    try {
      if (item) await patch(`/employees/${item.id}`, body);
      else created = await post('/employees', body);
    } catch (err) { setError(err); return; }
    if (item && acct.password) {
      try {
        if (item.user_id) await api(`/employees/${item.id}/password`, { method: 'PUT', body: { password: acct.password } });
        else await post(`/employees/${item.id}/login`, { email: v.email, accessLevel: acct.accessLevel, password: acct.password });
      } catch (err) {
        setError(new Error(`The details were saved, but the password was not: ${err.message}`));
        return;
      }
      toast(item.user_id ? 'Saved, with the new password.' : `Saved. They sign in with ${v.email.trim().toLowerCase()} and the password you set.`);
      onSaved();
      return;
    }
    if (created && login?.enabled) {
      try {
        const r = await post(`/employees/${created.id}/login`, { email: v.email, accessLevel: login.accessLevel, password: login.password });
        toast(`Saved. They sign in with ${r.email} and the password you set.`);
      } catch (err) {
        toast(`Employee saved, but no login was made: ${err.message} Open Edit to try again.`, 'bad');
      }
    } else toast('Saved.');
    onSaved();
  };
  /** Delete someone added by mistake; someone with history is offered "Exited" instead (the server decides). */
  const remove = async () => {
    setError(null);
    if (!(await confirm({ title: `Delete ${item.full_name}?`, danger: true, confirmLabel: 'Yes, delete', cancelLabel: 'No, keep',
      message: 'For someone added by mistake (a duplicate or a wrong import row). They and their login are removed for good. ' +
        'Someone who already has attendance, requests or payroll can\'t be deleted: you\'ll be offered "Exited" instead.' }))) return;
    try {
      await api(`/employees/${item.id}`, { method: 'DELETE' });
      toast(`${item.full_name} deleted.`); onSaved();
    } catch (err) {
      if (err.code !== 'employee_has_history') { setError(err); return; }
      if (!(await confirm({ title: `Mark ${item.full_name} as exited instead?`, confirmLabel: 'Mark as exited', cancelLabel: 'Cancel', message: err.message }))) return;
      try {
        await patch(`/employees/${item.id}`, { status: 'exited', exit_date: v.exit_date ?? new Date().toISOString().slice(0, 10) });
        toast(`${item.full_name} marked as exited.`); onSaved();
      } catch (e) { setError(e); }
    }
  };
  const select = (k, label, list, labelKey = 'name') => (
    <Input as="select" label={label} value={v[k] ?? ''} onChange={set(k)}>
      <option value="">—</option>{list.filter((x) => x.is_active !== false || x.id === v[k]).map((x) => <option key={x.id} value={x.id}>{x[labelKey]}</option>)}
    </Input>
  );
  const custom = refs.customFields.filter((f) => f.entity === 'employee' && f.is_active);
  return (
    <Modal wide title={item ? `Edit ${item.full_name}` : 'Add employee'} onClose={onClose}
      footer={<>
        {item && item.id !== session.user.employeeId && <Button kind="danger" icon="trash" onClick={remove} style={{ marginInlineEnd: 'auto' }}>Delete</Button>}
        <Button onClick={onClose}>Cancel</Button><Button kind="primary" onClick={save}>Save</Button></>}>
      <div className="stack">
        <div className="form-grid">
          <Input label="Employee code" value={v.employee_code ?? ''} onChange={set('employee_code')} required={!!item}
            placeholder={item ? undefined : 'Automatic'} help={item ? undefined : 'Filled in automatically; change it if you need to.'} />
          <Input label="Full name" value={v.full_name ?? ''} onChange={set('full_name')} required />
          <Input label="Email" type="email" value={v.email ?? ''} onChange={set('email')} />
          <Input label="Phone" value={v.phone ?? ''} onChange={set('phone')} />
          {select('department_id', 'Department', refs.departments)}
          {select('role_id', 'Role', refs.roles)}
          {select('employment_type_id', 'Employment type', refs.employmentTypes)}
          {select('manager_id', 'Manager', refs.employees.filter((e) => e.id !== item?.id), 'full_name')}
          {select('shift_id', 'Shift', refs.shifts)}
          {select('location_id', 'Office', refs.locations)}
          <Input label="Joining date" type="date" value={v.joining_date ?? ''} onChange={set('joining_date')} required />
          <Input label="Probation ends" type="date" value={v.probation_end_date ?? ''} onChange={set('probation_end_date')} />
          {item && <Input label="Exit date" type="date" value={v.exit_date ?? ''} onChange={set('exit_date')} />}
          {item && <Input as="select" label="Status" value={v.status} onChange={set('status')}><option value="active">Active</option><option value="inactive">Inactive</option><option value="exited">Exited</option></Input>}
          {custom.map((f) => (
            <Input key={f.id} label={`${f.label}${f.required ? ' *' : ''}`} type={f.field_type === 'number' ? 'number' : f.field_type === 'date' ? 'date' : 'text'}
              value={v.custom_fields?.[f.field_key] ?? ''} onChange={(e) => setV({ ...v, custom_fields: { ...v.custom_fields, [f.field_key]: f.field_type === 'number' ? Number(e.target.value) : e.target.value } })} />
          ))}
        </div>
        <ModuleAccess value={v.module_access ?? null} onChange={(module_access) => setV({ ...v, module_access })}
          companyModules={session.modules ?? []} isHrLogin={item ? item.access_level === 'hr_admin' : login?.accessLevel === 'hr_admin'} />
        {item && <LoginCard item={item} email={v.email} value={acct} onChange={setAcct} />}
        {login && (
          <Card title="Sign-in account">
            <div className="stack">
              <Switch label="Give them a login (no email is sent: you give them the password)" checked={login.enabled} onChange={(enabled) => setLogin({ ...login, enabled })} />
              {login.enabled && (
                <div className="form-grid">
                  <Input as="select" label="Access" value={login.accessLevel} onChange={(e) => setLogin({ ...login, accessLevel: e.target.value })}
                    help={login.accessLevel === 'employee' ? 'Sees only their own attendance, leave, tasks and payslips.' : login.accessLevel === 'manager' ? 'Also their team (rights set under Teams & access).' : 'Can do everything.'}>
                    <option value="employee">Employee</option><option value="manager">Manager / team lead</option><option value="hr_admin">HR admin</option>
                  </Input>
                  <PasswordInput label="Password" autoComplete="new-password" help={`At least 8 characters. They sign in with ${v.email || 'the email above'} and can change it later.`}
                    value={login.password} onChange={(e) => setLogin({ ...login, password: e.target.value })} />
                </div>
              )}
            </div>
          </Card>
        )}
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

const LEVEL_LABEL = { employee: 'Employee', manager: 'Manager / team lead', hr_admin: 'HR admin' };

/**
 * Editing someone: shows their sign-in account, or (added without one, e.g. by an import or with
 * the login fields left empty) creates it and emails them a link to choose their password.
 */
function LoginCard({ item, email, value, onChange }) {
  const set = (k) => (e) => onChange({ ...value, [k]: e.target.value });
  if (item.user_id) {
    const emailChanges = email && item.login_email && email.trim().toLowerCase() !== item.login_email.toLowerCase();
    return (
      <Card title="Sign-in account">
        <p className="small" style={{ margin: 0 }}>
          <span className="badge good">Has a login</span> Signs in with <strong>{item.login_email ?? item.email}</strong> · {LEVEL_LABEL[item.access_level] ?? item.access_level}
        </p>
        {emailChanges && <p className="small" style={{ margin: '6px 0 0', color: 'var(--warn)' }}>After saving they sign in with <strong>{email.trim().toLowerCase()}</strong> instead.</p>}
        <div className="form-grid" style={{ marginTop: 12 }}>
          <PasswordInput label="New password (optional)" autoComplete="new-password"
            help="Leave empty to keep their password. At least 8 characters; saved with Save, and they are signed out everywhere."
            value={value.password} onChange={set('password')} />
        </div>
        <p className="small muted" style={{ margin: '8px 0 0' }}>Their sign-in email is the Email above. Change what they can do, or who they manage, under HR &gt; Teams &amp; access.</p>
      </Card>
    );
  }
  return (
    <Card title="Sign-in account">
      <div className="stack">
        <p className="small" style={{ margin: 0 }}><span className="badge warn">No login yet</span> {item.full_name} can't sign in. Set a password here and click
          Save: they sign in with the Email above{email ? ` (${email})` : ''} and this password. No email is sent.</p>
        <div className="form-grid">
          <Input as="select" label="Access" value={value.accessLevel} onChange={set('accessLevel')}>
            <option value="employee">Employee</option><option value="manager">Manager / team lead</option><option value="hr_admin">HR admin</option>
          </Input>
          <PasswordInput label="Password" autoComplete="new-password" help="At least 8 characters. Leave empty for no login." value={value.password} onChange={set('password')} />
        </div>
      </div>
    </Card>
  );
}

export default function Employees() {
  const [showInactive, setShowInactive] = useState(false);
  const [search, setSearch] = useState('');
  const { data, error, loading, reload } = useLoad(() => get(`/employees?status=${showInactive ? 'all' : 'active'}`), [showInactive]);
  const { toast } = useApp();
  const [importing, setImporting] = useState(false);
  const { data: refs, reload: reloadRefs } = useLoad(async () => {
    const [departments, roles, employmentTypes, shifts, locations, customFields, employees] = await Promise.all(
      ['departments', 'roles', 'employment-types', 'shifts', 'locations', 'custom-fields'].map((e) => get(`/lookups/${e}`)).concat(get('/employees')));
    return { departments, roles, employmentTypes, shifts, locations, customFields, employees };
  }, []);
  const [editing, setEditing] = useState(null);
  const [giving, setGiving] = useState(false);
  const missing = (data ?? []).filter((e) => !e.user_id && e.status === 'active');
  const rows = (data ?? []).filter((e) => `${e.full_name} ${e.employee_code} ${e.department_name}`.toLowerCase().includes(search.toLowerCase()));
  return (
    <div className="stack lg">
      <PageHead title="Employees" subtitle={data ? `${data.length} shown` : ''} actions={<>
        <Button icon="download" title={showInactive ? 'Everyone, including inactive and exited' : 'Active employees (turn on "Show inactive" for everyone)'}
          onClick={() => download(`/employees/export.csv${showInactive ? '?status=all' : ''}`, `employees-${new Date().toISOString().slice(0, 10)}.csv`)
            .catch((e) => toast(e.message, 'bad'))}>Export CSV</Button>
        <Button icon="file" onClick={() => setImporting(true)}>Import from CSV</Button>
        {missing.length > 0 && <Button icon="lock" onClick={() => setGiving(true)}>Give logins to everyone ({missing.length})</Button>}
        <Button kind="primary" icon="plus" disabled={!refs} onClick={() => setEditing({})}>Add employee</Button></>} />
      {giving && <BulkLoginsDialog count={missing.length} onClose={() => setGiving(false)} onDone={() => { setGiving(false); reload(); }} />}
      {importing && <EmployeeImport onClose={() => setImporting(false)}
        onDone={(r) => { setImporting(false); reload(); reloadRefs(); toast(`Import done: ${r.added} added, ${r.updated} updated${r.failed ? `, ${r.failed} skipped` : ''}.`); }} />}
      <div className="row">
        <Input placeholder="Search name, code or department" aria-label="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Switch label="Show inactive" checked={showInactive} onChange={setShowInactive} />
      </div>
      <Card className="flush">
        {loading && !data ? <Loading /> : error ? <ErrorBox error={error} /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Code</th><th>Name</th><th>Department</th><th>Role</th><th>Manager</th><th>Joined</th><th>Status</th><th /></tr></thead>
            <tbody>{rows.map((e) => (
              <tr key={e.id}><td style={{ fontVariantNumeric: 'tabular-nums' }}>{e.employee_code}</td><td>{e.full_name}{!e.user_id && e.status === 'active' && <> <span className="badge warn" title="Can't sign in yet: open Edit to create a login">No login</span></>}</td><td>{e.department_name ?? '—'}</td><td>{e.role_name ?? '—'}</td>
                <td>{e.manager_name ?? '—'}</td><td>{fmtDate(e.joining_date)}</td>
                <td>{e.status === 'active' ? <span className="badge good">Active</span> : <StatusBadge status={e.status} />}
                  {e.module_access && e.access_level !== 'hr_admin' && <span className="badge" title={`Can use: ${e.module_access.join(', ') || 'nothing'}`}>Limited access</span>}</td>
                <td><Button size="sm" disabled={!refs} onClick={() => setEditing(e)}>Edit</Button></td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      {editing && refs && <EmployeeForm item={editing.id ? editing : null} refs={refs} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </div>
  );
}
