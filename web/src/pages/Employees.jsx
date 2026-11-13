import { useEffect, useState } from 'react';
import { get, patch, post } from '../lib/api.js';
import { useApp } from '../lib/app.jsx';
import { fmtDate } from '../lib/format.js';
import { useConfirm } from '../components/confirm.jsx';
import { PageHead } from '../components/Layout.jsx';
import { Button, Card, ErrorBox, Input, Loading, Modal, PasswordInput, StatusBadge, Switch, useLoad } from '../components/ui.jsx';

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
  const [login, setLogin] = useState(item ? null : { email: '', password: '', accessLevel: 'employee' });
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
    try {
      if (item) await patch(`/employees/${item.id}`, body);
      else await post('/employees', { ...body, login: login?.email ? login : undefined });
      toast('Saved.'); onSaved();
    } catch (err) { setError(err); }
  };
  const select = (k, label, list, labelKey = 'name') => (
    <Input as="select" label={label} value={v[k] ?? ''} onChange={set(k)}>
      <option value="">—</option>{list.filter((x) => x.is_active !== false || x.id === v[k]).map((x) => <option key={x.id} value={x.id}>{x[labelKey]}</option>)}
    </Input>
  );
  const custom = refs.customFields.filter((f) => f.entity === 'employee' && f.is_active);
  return (
    <Modal wide title={item ? `Edit ${item.full_name}` : 'Add employee'} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" onClick={save}>Save</Button></>}>
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
        {login && (
          <Card title="Sign-in account (optional)">
            <div className="form-grid">
              <Input label="Login email" type="email" value={login.email} onChange={(e) => setLogin({ ...login, email: e.target.value })} />
              <PasswordInput label="Temporary password" autoComplete="new-password" help="At least 8 characters" value={login.password} onChange={(e) => setLogin({ ...login, password: e.target.value })} />
              <Input as="select" label="Access" value={login.accessLevel} onChange={(e) => setLogin({ ...login, accessLevel: e.target.value })}>
                <option value="employee">Employee</option><option value="manager">Manager</option><option value="hr_admin">HR admin</option>
              </Input>
            </div>
          </Card>
        )}
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

export default function Employees() {
  const [showInactive, setShowInactive] = useState(false);
  const [search, setSearch] = useState('');
  const { data, error, loading, reload } = useLoad(() => get(`/employees?status=${showInactive ? 'all' : 'active'}`), [showInactive]);
  const { data: refs } = useLoad(async () => {
    const [departments, roles, employmentTypes, shifts, locations, customFields, employees] = await Promise.all(
      ['departments', 'roles', 'employment-types', 'shifts', 'locations', 'custom-fields'].map((e) => get(`/lookups/${e}`)).concat(get('/employees')));
    return { departments, roles, employmentTypes, shifts, locations, customFields, employees };
  }, []);
  const [editing, setEditing] = useState(null);
  const rows = (data ?? []).filter((e) => `${e.full_name} ${e.employee_code} ${e.department_name}`.toLowerCase().includes(search.toLowerCase()));
  return (
    <div className="stack lg">
      <PageHead title="Employees" subtitle={data ? `${data.length} shown` : ''} actions={<Button kind="primary" icon="plus" disabled={!refs} onClick={() => setEditing({})}>Add employee</Button>} />
      <div className="row">
        <Input placeholder="Search name, code or department" aria-label="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Switch label="Show inactive" checked={showInactive} onChange={setShowInactive} />
      </div>
      <Card className="flush">
        {loading && !data ? <Loading /> : error ? <ErrorBox error={error} /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Code</th><th>Name</th><th>Department</th><th>Role</th><th>Manager</th><th>Joined</th><th>Status</th><th /></tr></thead>
            <tbody>{rows.map((e) => (
              <tr key={e.id}><td style={{ fontVariantNumeric: 'tabular-nums' }}>{e.employee_code}</td><td>{e.full_name}</td><td>{e.department_name ?? '—'}</td><td>{e.role_name ?? '—'}</td>
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
