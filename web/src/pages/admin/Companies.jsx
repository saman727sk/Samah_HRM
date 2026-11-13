import { useState } from 'react';
import { get, post, qs, storage } from '../../lib/api.js';
import { navigate, useApp } from '../../lib/app.jsx';
import { fmtDate, fmtMoney } from '../../lib/format.js';
import { PageHead } from '../../components/Layout.jsx';
import { renewalText } from '../../components/billing.jsx';
import CurrencySelect from '../../components/CurrencySelect.jsx';
import TimezoneSelect from '../../components/TimezoneSelect.jsx';
import { Button, Card, CompanyLogo, Empty, ErrorBox, Icon, Input, Loading, Modal, PasswordInput, StatusBadge, companyLogoUrl, useLoad } from '../../components/ui.jsx';

// Status filters, in the order they matter to the owner (waiting for approval first).
const FILTERS = [['', 'All'], ['pending', 'Awaiting approval'], ['trialing', 'On trial'], ['active', 'Active'], ['past_due', 'Past due'], ['unpaid', 'Unpaid'],
  ['expired', 'Trial ended'], ['cancelled', 'Cancelled'], ['suspended', 'Suspended']];
const TONE = { pending: 'gold', trialing: 'info', active: 'good', past_due: 'warn', unpaid: 'bad', expired: 'bad', cancelled: 'muted', suspended: 'bad' };
const matches = (c, st) => !st || c.status === st || c.subscription_status === st;
const detail = (c) => `/admin/companies/detail?id=${c.id}`;

export default function Companies({ query = {} }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState(query.status ?? '');
  const [view, setView] = useState(() => storage.get('hrm.companies.view') ?? 'cards');
  const pickView = (v) => { setView(v); storage.set('hrm.companies.view', v); };
  // Load every company once (search on the server), filter by status here so each filter can show its count.
  const { data, loading, error, reload } = useLoad(() => get(`/admin/tenants${qs({ q })}`), [q]);
  const [creating, setCreating] = useState(false);
  const all = data ?? [];
  const shown = all.filter((c) => matches(c, status));
  return (
    <div className="stack lg companies-page">
      <PageHead title={<span className="gold-text">Companies</span>} subtitle="Every company on the platform, its plan and what it owes"
        actions={<Button kind="primary" icon="plus" onClick={() => setCreating(true)}>New company</Button>} />

      <div className="company-toolbar">
        <label className="search-box">
          <Icon name="search" size={16} />
          <input className="input" type="search" placeholder="Search by name or slug" aria-label="Search companies" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className="view-toggle" role="group" aria-label="View">
          <button type="button" aria-pressed={view === 'cards'} onClick={() => pickView('cards')}><Icon name="grid" size={15} />Cards</button>
          <button type="button" aria-pressed={view === 'table'} onClick={() => pickView('table')}><Icon name="list" size={15} />Table</button>
        </div>
      </div>

      <div className="status-pills" role="group" aria-label="Filter by status">
        {FILTERS.map(([v, label]) => {
          const n = all.filter((c) => matches(c, v)).length;
          if (v && !n && status !== v) return null; // hide empty filters
          return (
            <button key={v || 'all'} type="button" className={`status-pill ${TONE[v] ?? ''}`} aria-pressed={status === v} onClick={() => setStatus(v)}>
              {label}<span className="n">{n}</span>
            </button>
          );
        })}
      </div>

      {loading && !data ? <Loading /> : error ? <ErrorBox error={error} /> : shown.length === 0 ? <Card><Empty>No companies match.</Empty></Card>
        : view === 'cards' ? (
          <div className="company-grid">
            {shown.map((c, i) => <CompanyCard key={c.id} c={c} index={i} />)}
          </div>
        ) : (
          <Card className="flush company-table">
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Company</th><th>Plan</th><th>Status</th><th>Next date</th><th>Employees</th><th className="num">Balance due</th><th>HR admins</th><th>Registered</th></tr></thead>
              <tbody>{shown.map((c) => (
                <tr key={c.id} className={c.status === 'pending' ? 'is-pending' : ''} onClick={() => navigate(detail(c))}>
                  <td><div className="row" style={{ gap: 10, flexWrap: 'nowrap' }}><CompanyLogo company={{ name: c.name, logoUrl: companyLogoUrl(c) }} size="sm" />
                    <div><a href={`#${detail(c)}`} onClick={(e) => e.stopPropagation()}>{c.name}</a><div className="small muted mono">{c.slug}</div></div></div></td>
                  <td>{c.plan_name ?? '—'}{c.price > 0 && <div className="small muted">{fmtMoney(c.price, c.billing_currency)} / {c.billing_cycle === 'yearly' ? 'yr' : 'mo'}</div>}</td>
                  <td><Badges c={c} /></td>
                  <td className="small">{c.subscription_status ? renewalText({ ...c, status: c.subscription_status }) : '—'}</td>
                  <td style={{ minWidth: 120 }}><Seats c={c} /></td>
                  <td className="num">{c.balance_due > 0 ? <span className="due">{fmtMoney(c.balance_due, c.billing_currency)}</span> : '—'}</td>
                  <td className="small">{c.admins ?? <span className="muted">None</span>}</td>
                  <td className="small">{fmtDate(c.created_at.slice(0, 10))}</td>
                </tr>
              ))}</tbody>
            </table></div>
          </Card>
        )}
      {creating && <NewCompany onClose={() => setCreating(false)} onDone={(id) => { setCreating(false); reload(); navigate(`/admin/companies/detail?id=${id}`); }} />}
    </div>
  );
}

const Badges = ({ c }) => (
  <div className="chips">
    {c.status !== 'active' && <StatusBadge status={c.status} />}
    {c.subscription_status && <StatusBadge status={c.subscription_status} />}
  </div>
);

/** Active employees against the plan's limit, as a small bar. */
function Seats({ c }) {
  const pct = c.max_employees ? Math.min(100, Math.round((c.employees / c.max_employees) * 100)) : null;
  return (
    <div className="seats">
      <div className="small"><strong>{c.employees}</strong>{c.max_employees ? <span className="muted"> / {c.max_employees}</span> : <span className="muted"> · no limit</span>}</div>
      {pct != null && <div className="seat-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} className={pct >= 100 ? 'full' : pct >= 85 ? 'near' : ''} /></div>}
    </div>
  );
}

function CompanyCard({ c, index }) {
  const tone = c.status !== 'active' ? c.status : c.subscription_status;
  return (
    <article className={`company-card tone-${TONE[tone] ?? 'muted'} ${c.status === 'pending' ? 'is-pending' : ''}`} style={{ '--i': index }}
      onClick={() => navigate(detail(c))} onKeyDown={(e) => e.key === 'Enter' && navigate(detail(c))} tabIndex={0} aria-label={`${c.name}: open`}>
      <header className="company-card-head">
        <CompanyLogo company={{ name: c.name, logoUrl: companyLogoUrl(c) }} size="md" />
        <div className="grow">
          <h3>{c.name}</h3>
          <div className="small muted mono">{c.slug}</div>
        </div>
      </header>
      <Badges c={c} />
      <dl className="company-facts">
        <div><dt>Plan</dt><dd>{c.plan_name ?? '—'}{c.price > 0 && <span className="muted"> · {fmtMoney(c.price, c.billing_currency)}/{c.billing_cycle === 'yearly' ? 'yr' : 'mo'}</span>}</dd></div>
        <div><dt>Next</dt><dd>{c.subscription_status ? renewalText({ ...c, status: c.subscription_status }) : '—'}</dd></div>
        <div><dt>Employees</dt><dd><Seats c={c} /></dd></div>
        <div><dt>Balance</dt><dd>{c.balance_due > 0 ? <span className="due">{fmtMoney(c.balance_due, c.billing_currency)} due</span> : <span className="muted">Nothing due</span>}</dd></div>
      </dl>
      <footer className="company-card-foot">
        <span className="small muted" title={c.admins ?? ''}>{c.admins ? c.admins.split(', ')[0] : 'No HR admin yet'}{c.admins?.includes(',') ? ` +${c.admins.split(',').length - 1}` : ''}</span>
        {c.status === 'pending'
          ? <Button size="sm" kind="primary" onClick={(e) => { e.stopPropagation(); navigate(detail(c)); }}>Review</Button>
          : <span className="small muted">Since {fmtDate(c.created_at.slice(0, 10))}</span>}
      </footer>
    </article>
  );
}

const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function NewCompany({ onClose, onDone }) {
  const { toast } = useApp();
  const [f, setF] = useState({ name: '', slug: '', timezone: 'Asia/Karachi', currency: 'PKR' });
  const [admin, setAdmin] = useState({ fullName: '', email: '', password: '' });
  const [slugEdited, setSlugEdited] = useState(false);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const tenant = await post('/admin/tenants', { ...f, admin });
      toast(`${tenant.name} created on the free trial.`);
      onDone(tenant.id);
    } catch (e) { setErr(e); setBusy(false); }
  };
  return (
    <Modal title="New company" onClose={onClose} wide
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={busy} onClick={create}>Create company</Button></>}>
      <div className="stack">
        <div className="form-grid">
          <Input label="Company name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, slug: slugEdited ? f.slug : slugify(e.target.value) })} />
          <Input label="Slug" help="Lowercase letters, numbers and dashes" value={f.slug} onChange={(e) => { setSlugEdited(true); setF({ ...f, slug: e.target.value }); }} />
          <TimezoneSelect help="Attendance and payroll dates use it" value={f.timezone} onChange={(timezone) => setF({ ...f, timezone })} />
          <CurrencySelect help="For salaries and payslips" value={f.currency} onChange={(currency) => setF({ ...f, currency })} />
        </div>
        <h3 style={{ margin: '8px 0 0' }}>First HR admin</h3>
        <p className="small muted" style={{ margin: 0 }}>This person signs in to set the company up and can add the other HR admins.</p>
        <div className="form-grid">
          <Input label="Full name" value={admin.fullName} onChange={(e) => setAdmin({ ...admin, fullName: e.target.value })} />
          <Input label="Email" type="email" value={admin.email} onChange={(e) => setAdmin({ ...admin, email: e.target.value })} />
          <PasswordInput label="Temporary password" help="At least 8 characters; share it securely" autoComplete="new-password"
            value={admin.password} onChange={(e) => setAdmin({ ...admin, password: e.target.value })} />
        </div>
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}
