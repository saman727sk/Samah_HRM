import { useState } from 'react';
import { del, get, patch, post } from '../../lib/api.js';
import { useApp } from '../../lib/app.jsx';
import { fmtMoney } from '../../lib/format.js';
import { useConfirm } from '../../components/confirm.jsx';
import { PageHead } from '../../components/Layout.jsx';
import { MODULES, MODULE_LABELS } from '../../components/billing.jsx';
import PlanArt, { planArtKind } from '../../components/PlanArt.jsx';
import CurrencySelect from '../../components/CurrencySelect.jsx';
import { Alert, Button, Empty, ErrorBox, Input, Loading, Modal, StatusBadge, Switch, Tabs, useLoad } from '../../components/ui.jsx';

/**
 * Cards per row: up to 4 sit in one row; more are spread over balanced rows of at most 4
 * (5 = 3 + 2, 6 = 3 + 3, 7 = 4 + 3, 8 = 4 + 4, 9 = 3 + 3 + 3). Narrow screens use fewer (see CSS).
 */
const planCols = (n) => Math.ceil(n / Math.ceil(n / 4)) || 1;

export default function Plans() {
  const { toast } = useApp();
  const confirm = useConfirm();
  const [showArchived, setShowArchived] = useState(false);
  const { data, loading, error, reload } = useLoad(() => get(`/admin/plans${showArchived ? '?all=true' : ''}`), [showArchived]);
  const [editing, setEditing] = useState(null); // plan row, or {} for a new one
  const [cycle, setCycle] = useState('monthly');
  // "Most popular": the paid plan most companies are on (if any).
  const remove = async (p) => {
    if (!(await confirm({ title: `Delete the ${p.name} plan?`, danger: true, confirmLabel: 'Yes, delete', cancelLabel: 'No, keep it',
      message: 'This cannot be undone. A plan that any company has used can\'t be deleted (its history points to it): archive it instead.' }))) return;
    try { await del(`/admin/plans/${p.id}`); toast(`${p.name} deleted.`); reload(); } catch (e) { toast(e.message, 'bad'); }
  };
  const popularId = (data ?? []).filter((p) => p.price_monthly > 0 && p.companies > 0).sort((a, b) => b.companies - a.companies)[0]?.id;
  return (
    <div className="stack lg">
      <PageHead title="Subscription plans" subtitle="What companies can buy. Price changes apply to new assignments; existing companies keep their price."
        actions={<><Switch label="Show archived" checked={showArchived} onChange={setShowArchived} />
          <Button kind="primary" icon="plus" onClick={() => setEditing({})}>New plan</Button></>} />
      <div className="row">
        <Tabs value={cycle} onChange={setCycle} tabs={[{ value: 'monthly', label: 'Monthly prices' }, { value: 'yearly', label: 'Yearly prices' }]} />
      </div>
      {loading && !data ? <Loading /> : error ? <ErrorBox error={error} /> : data.length === 0 ? <Empty>No plans yet.</Empty> : (
        <div className="plan-grid" style={{ '--cols': planCols(data.length) }}>
          {data.map((p, i) => <PlanCard key={p.id} plan={p} index={i} cycle={cycle} popular={p.id === popularId} onEdit={() => setEditing(p)} onDelete={() => remove(p)} />)}
        </div>
      )}
      {editing && <PlanForm plan={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload(); }} />}
    </div>
  );
}

/** One plan as a card: picture, price, limits, which modules it includes. */
function PlanCard({ plan: p, index, cycle, popular, onEdit, onDelete }) {
  const price = cycle === 'yearly' ? p.price_yearly : p.price_monthly;
  const saving = p.price_monthly > 0 && p.price_yearly > 0 ? Math.round((1 - p.price_yearly / (p.price_monthly * 12)) * 100) : 0;
  return (
    <article className={`plan-card ${popular ? 'popular' : ''} ${p.status !== 'active' ? 'muted-plan' : ''}`} style={{ '--i': index }}>
      {popular && <span className="plan-ribbon">Most popular</span>}
      <div className="plan-top">
        <PlanArt kind={planArtKind(p, index)} />
      </div>
      <div className="plan-body">
        <div className="row between" style={{ alignItems: 'flex-start' }}>
          <div><h3 className="plan-name">{p.name}</h3><div className="small muted mono">{p.code}</div></div>
          <StatusBadge status={p.status} />
        </div>
        {p.description && <p className="small muted" style={{ margin: 0 }}>{p.description}</p>}
        <div className="plan-price">
          {price > 0
            ? <><strong>{fmtMoney(price, p.currency)}</strong><span>/ {cycle === 'yearly' ? 'year' : 'month'}</span></>
            : <><strong>Free</strong>{p.trial_days > 0 && <span>{p.trial_days}-day trial</span>}</>}
        </div>
        {cycle === 'yearly' && saving > 0 && <div className="plan-save">Save {saving}% vs monthly</div>}
        <ul className="plan-features">
          <li className="yes">{p.max_employees ? `Up to ${p.max_employees} active employees` : 'Unlimited employees'}</li>
          <li className="yes">{p.max_admins ? `${p.max_admins} HR admin ${p.max_admins === 1 ? 'login' : 'logins'}` : 'Unlimited HR admins'}</li>
          {MODULES.map((m) => {
            const on = p.modules == null || p.modules.includes(m);
            return <li key={m} className={on ? 'yes' : 'no'}>{MODULE_LABELS[m]}</li>;
          })}
        </ul>
      </div>
      <footer className="plan-foot">
        <span className="small muted">{p.companies} {p.companies === 1 ? 'company' : 'companies'} on this plan</span>
        <div className="row" style={{ gap: 6 }}>
          <Button size="sm" kind="danger" icon="x" onClick={onDelete} aria-label={`Delete ${p.name}`}>Delete</Button>
          <Button size="sm" kind="primary" onClick={onEdit}>Edit</Button>
        </div>
      </footer>
    </article>
  );
}

const num = (v) => (v === '' || v == null ? null : Number(v));

function PlanForm({ plan, onClose, onDone }) {
  const { toast } = useApp();
  const isNew = !plan.id;
  const confirm = useConfirm();
  const [f, setF] = useState({
    code: plan.code ?? '', name: plan.name ?? '', description: plan.description ?? '', currency: plan.currency ?? 'PKR',
    price_monthly: plan.price_monthly ?? 0, price_yearly: plan.price_yearly ?? 0, trial_days: plan.trial_days ?? 0,
    max_employees: plan.max_employees ?? '', max_admins: plan.max_admins ?? '', modules: plan.modules ?? null,
    status: plan.status ?? 'active', sort_order: plan.sort_order ?? 0,
  });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const toggleModule = (m, on) => {
    const list = new Set(f.modules ?? []);
    if (on) list.add(m); else list.delete(m);
    setF({ ...f, modules: MODULES.filter((x) => list.has(x)) });
  };
  const save = async () => {
    if (!isNew && plan.status === 'active' && f.status !== 'active' && !(await confirm({ title: `Make ${plan.name} ${f.status}?`, confirmLabel: f.status === 'archived' ? 'Archive plan' : 'Deactivate plan',
      message: `It can no longer be assigned or bought.${plan.companies ? ` The ${plan.companies} companies on it keep their plan and price.` : ''}` }))) return;
    setBusy(true);
    const body = {
      ...f, description: f.description.trim() || null, price_monthly: Number(f.price_monthly), price_yearly: Number(f.price_yearly),
      trial_days: Number(f.trial_days), max_employees: num(f.max_employees), max_admins: num(f.max_admins), sort_order: Number(f.sort_order),
    };
    if (!isNew) delete body.code;
    try {
      if (isNew) await post('/admin/plans', body); else await patch(`/admin/plans/${plan.id}`, body);
      toast(isNew ? 'Plan created.' : 'Plan saved.');
      onDone();
    } catch (e) { setErr(e); setBusy(false); }
  };
  return (
    <Modal title={isNew ? 'New plan' : `Edit ${plan.name}`} wide onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={busy} onClick={save}>{isNew ? 'Create plan' : 'Save plan'}</Button></>}>
      <div className="stack">
        {!isNew && plan.companies > 0 && <Alert kind="info">{plan.companies} companies are on this plan. They keep their current price and limits; changes apply when a plan is next assigned.</Alert>}
        <div className="form-grid">
          <Input label="Name" value={f.name} onChange={set('name')} />
          <Input label="Code" help={isNew ? 'Lowercase letters, numbers, dashes. Cannot change later.' : 'Cannot change'} disabled={!isNew} value={f.code} onChange={set('code')} />
          <CurrencySelect label="Price currency" value={f.currency} onChange={(currency) => setF({ ...f, currency })} />
          <Input label="Status" as="select" value={f.status} onChange={set('status')}>
            <option value="active">Active (can be assigned)</option><option value="inactive">Inactive (hidden from new assignments)</option><option value="archived">Archived</option>
          </Input>
          <Input label="Monthly price" type="number" min="0" step="0.01" value={f.price_monthly} onChange={set('price_monthly')} />
          <Input label="Yearly price" type="number" min="0" step="0.01" value={f.price_yearly} onChange={set('price_yearly')} />
          <Input label="Trial days" type="number" min="0" help="Used when this plan is free (e.g. the free trial)" value={f.trial_days} onChange={set('trial_days')} />
          <Input label="Display order" type="number" value={f.sort_order} onChange={set('sort_order')} />
          <Input label="Max active employees" type="number" min="1" help="Empty = unlimited" value={f.max_employees} onChange={set('max_employees')} />
          <Input label="Max HR admin logins" type="number" min="1" help="Empty = unlimited" value={f.max_admins} onChange={set('max_admins')} />
        </div>
        <Input label="Description" value={f.description} onChange={set('description')} />
        <fieldset className="stack" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 12, margin: 0 }}>
          <legend className="field-label">Modules</legend>
          <Switch label="All modules (including ones added later)" checked={f.modules == null} onChange={(on) => setF({ ...f, modules: on ? null : [...MODULES] })} />
          {f.modules != null && (
            <div className="form-grid">{MODULES.map((m) => <Switch key={m} label={MODULE_LABELS[m]} checked={f.modules.includes(m)} onChange={(on) => toggleModule(m, on)} />)}</div>
          )}
        </fieldset>
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}
