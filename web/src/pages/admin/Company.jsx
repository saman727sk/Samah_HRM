import { useState } from 'react';
import { api, get, patch, post } from '../../lib/api.js';
import { navigate, useApp } from '../../lib/app.jsx';
import CurrencySelect from '../../components/CurrencySelect.jsx';
import TimezoneSelect from '../../components/TimezoneSelect.jsx';
import { fmtDate, fmtMoney, humanize } from '../../lib/format.js';
import { useConfirm } from '../../components/confirm.jsx';
import { PageHead } from '../../components/Layout.jsx';
import { InvoiceTable, PaymentModal, PaymentTable, ReasonModal, SubmissionTable, UsageBar, limitText, modulesText, priceText, renewalText } from '../../components/billing.jsx';
import { Alert, Button, Card, CompanyLogo, Empty, ErrorBox, Input, Loading, Modal, PasswordInput, StatusBadge, Switch, companyLogoUrl, useLoad } from '../../components/ui.jsx';

export default function Company({ query }) {
  const { toast } = useApp();
  const confirm = useConfirm();
  const id = query.id;
  const { data: d, loading, error, reload } = useLoad(() => get(`/admin/tenants/${id}`), [id]);
  const reports = useLoad(() => get(`/admin/payment-submissions?tenantId=${id}`), [id]);
  const [dialog, setDialog] = useState(null); // { kind, ... }
  const close = () => setDialog(null);
  const done = (msg) => { if (msg) toast(msg); close(); reload(); };
  if (loading && !d) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const { tenant, subscription: sub, usage } = d;
  const act = (path, body, msg) => post(`/admin/tenants/${id}/${path}`, body).then(() => done(msg));

  return (
    <div className="stack lg">
      <a href="#/admin/companies" className="small">‹ All companies</a>
      <PageHead title={<span className="title-with-logo"><CompanyLogo company={{ name: tenant.name, logoUrl: companyLogoUrl(tenant) }} size="lg" />{tenant.name}</span>} subtitle={<span className="mono">{tenant.slug} · {tenant.timezone} · {tenant.currency}</span>} actions={<>
        <Button icon="edit" onClick={() => setDialog({ kind: 'edit' })}>Edit company</Button>
        {tenant.status === 'pending' ? <>
          <Button kind="primary" icon="check" onClick={async () => (await confirm({ title: `Approve ${tenant.name}?`, confirmLabel: 'Approve',
            message: 'Its users can sign in straight away, its free trial starts today, and the owner is emailed.' }))
            && act('approve', {}, `${tenant.name} approved; their free trial starts today.`).catch((e) => toast(e.message, 'bad'))}>Approve</Button>
          <Button kind="danger" onClick={() => setDialog({ kind: 'reject' })}>Reject</Button></>
          : tenant.status === 'suspended'
            ? <Button onClick={() => setDialog({ kind: 'reactivate' })}>Reactivate company</Button>
            : <Button kind="danger" icon="lock" onClick={() => setDialog({ kind: 'suspend' })}>Suspend company</Button>}
        <Button kind="danger" icon="trash" onClick={() => setDialog({ kind: 'delete' })}>Delete company</Button>
      </>} />

      {tenant.status === 'pending' && (
        <Alert kind="warn" title="Waiting for your approval">
          This company signed itself up{tenant.contact_email ? <> ({tenant.contact_email}{tenant.phone ? `, ${tenant.phone}` : ''}{tenant.country ? `, ${tenant.country}` : ''})</> : ''}. Nobody in it can sign in until you approve it. Approving emails them and starts their free trial.
        </Alert>
      )}
      {tenant.status === 'suspended' && <Alert kind="bad" title="This company is suspended">Nobody in it can sign in until you reactivate it.</Alert>}

      <div className="grid cols-2">
        <Card title="Subscription" actions={<StatusBadge status={sub?.status ?? 'inactive'} />}>
          {!sub ? <Empty>No subscription.</Empty> : (
            <div className="stack">
              <dl className="facts">
                <dt>Plan</dt><dd><strong>{sub.plan_name}</strong> · {priceText(sub)}</dd>
                <dt>Dates</dt><dd>{renewalText(sub)}{sub.current_period_start && <div className="small muted">Current period {fmtDate(sub.current_period_start)} – {fmtDate(sub.current_period_end)}</div>}</dd>
                <dt>Limits</dt><dd>{limitText(sub.max_employees)} employees · {limitText(sub.max_admins)} HR admins</dd>
                <dt>Modules</dt><dd>{modulesText(sub.modules)}</dd>
              </dl>
              {sub.cancel_at_period_end && <Alert kind="warn" title={`Cancels on ${fmtDate(sub.current_period_end)}`} />}
              <div className="row">
                <Button kind="primary" onClick={() => setDialog({ kind: 'plan' })}>Change plan</Button>
                <Button onClick={() => setDialog({ kind: 'limits' })}>Custom limits</Button>
                {['trialing', 'expired'].includes(sub.status) && <Button onClick={() => setDialog({ kind: 'trial' })}>Extend trial</Button>}
                {sub.cancel_at_period_end
                  ? <Button onClick={async () => (await confirm({ title: 'Withdraw the cancellation?', confirmLabel: 'Keep subscription',
                    message: 'The subscription continues and renews (and is invoiced) at the end of the period as usual.' }))
                    && act('resume', {}, 'Cancellation withdrawn.').catch((e) => toast(e.message, 'bad'))}>Withdraw cancellation</Button>
                  : !['cancelled', 'expired'].includes(sub.status) && <Button kind="danger" onClick={() => setDialog({ kind: 'cancel' })}>Cancel subscription</Button>}
              </div>
            </div>
          )}
        </Card>
        <Card title="Usage">
          <div className="stack">
            <UsageBar label="Active employees" used={usage.active_employees} max={sub?.max_employees} />
            <UsageBar label="HR admin logins" used={usage.admins} max={sub?.max_admins} />
            <p className="small muted" style={{ margin: 0 }}>{usage.total_employees} employee records in total · {usage.offices} active offices</p>
            <h3 style={{ margin: '8px 0 0' }}>HR admins</h3>
            {d.admins.length === 0 ? <p className="small muted">No HR admin login yet.</p> : (
              <ul className="stack" style={{ margin: 0, padding: 0, listStyle: 'none', gap: 8 }}>{d.admins.map((a) => (
                <li key={a.id} className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap', gap: 8 }}>
                  <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{a.full_name ?? '—'} · <span className="mono">{a.email}</span>{!a.is_active && <> <span className="badge">Disabled</span></>}</span>
                  <Button size="sm" icon="edit" onClick={() => setDialog({ kind: 'login', login: a })}>Edit</Button>
                </li>
              ))}</ul>
            )}
          </div>
        </Card>
      </div>

      <Card title="Invoices" className="flush">
        <InvoiceTable invoices={d.invoices} onPay={(inv) => setDialog({ kind: 'pay', invoice: inv })} onVoid={(inv) => setDialog({ kind: 'void', invoice: inv })} />
      </Card>
      {(reports.data ?? []).length > 0 && (
        <Card title="Payments this company reported" className="flush" actions={<a href="#/admin/billing" className="small">Confirm or reject in Billing</a>}>
          <SubmissionTable rows={reports.data} proofPath={(x) => `/admin/payment-submissions/${x.id}/proof`} />
        </Card>
      )}
      <Card title="Payments" className="flush">
        <PaymentTable payments={d.payments} onRefund={(p) => setDialog({ kind: 'refund', payment: p })} />
      </Card>
      <Card title="Subscription history" className="flush">
        {d.events.length === 0 ? <Empty>No history yet.</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>When</th><th>Event</th><th>Status</th><th>Details</th><th>By</th></tr></thead>
            <tbody>{d.events.map((e) => (
              <tr key={e.id}><td className="small">{new Date(e.created_at).toLocaleString()}</td><td>{humanize(e.event)}</td>
                <td className="small">{e.from_status && e.from_status !== e.to_status ? `${humanize(e.from_status)} → ${humanize(e.to_status)}` : humanize(e.to_status)}</td>
                <td className="small">{eventDetail(e.detail)}</td><td className="small">{e.actor_email ?? 'System'}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>

      {dialog?.kind === 'plan' && <PlanDialog sub={sub} onClose={close} onSave={(body) => act('plan', body, 'Plan changed.')} />}
      {dialog?.kind === 'limits' && <LimitsDialog sub={sub} onClose={close} onSave={(body) => act('limits', body, 'Limits saved.')} />}
      {dialog?.kind === 'trial' && <TrialDialog sub={sub} onClose={close} onSave={(body) => act('trial', body, 'Trial extended.')} />}
      {dialog?.kind === 'cancel' && <CancelDialog sub={sub} onClose={close} onSave={(body) => act('cancel', body, 'Subscription cancelled.')} />}
      {dialog?.kind === 'suspend' && (
        <ReasonModal title={`Suspend ${tenant.name}`} action="Suspend company" danger onClose={close}
          onSubmit={(reason) => act('suspend', { reason }, 'Company suspended.')}>
          <Alert kind="warn">Every user of this company is signed out and can't sign in until you reactivate it. Their data is kept.</Alert>
        </ReasonModal>
      )}
      {dialog?.kind === 'reject' && (
        <ReasonModal title={`Reject ${tenant.name}`} label="Reason (kept in the audit log, not sent)" action="Reject" danger onClose={close}
          onSubmit={(reason) => act('reject', { reason }, 'Company rejected.')}>
          <p className="small muted" style={{ margin: 0 }}>The company stays blocked and gets a short "not approved" email. You can still reactivate it later.</p>
        </ReasonModal>
      )}
      {dialog?.kind === 'reactivate' && (
        <ReasonModal title={`Reactivate ${tenant.name}`} label="Note (optional)" action="Reactivate" onClose={close}
          onSubmit={(reason) => act('reactivate', { reason }, 'Company reactivated.')} />
      )}
      {dialog?.kind === 'edit' && <EditCompanyDialog tenant={tenant} onClose={close} onDone={() => done('Company details saved.')} />}
      {dialog?.kind === 'login' && <EditLoginDialog tenantId={id} login={dialog.login} onClose={close} onDone={(msg) => done(msg)} />}
      {dialog?.kind === 'delete' && <DeleteCompanyDialog tenant={tenant} usage={usage} onClose={close}
        onDone={() => { toast(`${tenant.name} and all its data were deleted.`); navigate('/admin/companies'); }} />}
      {dialog?.kind === 'pay' && <PaymentModal invoice={{ ...dialog.invoice, company: tenant.name }} onClose={close} onDone={() => done()} />}
      {dialog?.kind === 'void' && (
        <ReasonModal title={`Void ${dialog.invoice.number}`} action="Void invoice" danger onClose={close}
          onSubmit={(reason) => post(`/admin/invoices/${dialog.invoice.id}/void`, { reason }).then(() => done('Invoice voided.'))} />
      )}
      {dialog?.kind === 'refund' && <RefundDialog payment={dialog.payment} onClose={close} onDone={() => done('Refund recorded.')} />}
    </div>
  );
}

const eventDetail = (x) => {
  if (!x) return '';
  const parts = [];
  if (x.fromPlan || x.toPlan) parts.push(`${x.fromPlan ?? '—'} → ${x.toPlan}`);
  if (x.invoice) parts.push(`invoice ${x.invoice}`);
  if (x.amount) parts.push(String(x.amount));
  if (x.reason) parts.push(x.reason);
  if (x.periodStart) parts.push(`${x.periodStart} – ${x.periodEnd}`);
  if (x.to && x.from) parts.push(`trial ${x.from} → ${x.to}`);
  if ('maxEmployees' in x) parts.push(`employees ${x.maxEmployees ?? '∞'}, admins ${x.maxAdmins ?? '∞'}`);
  return parts.join(' · ');
};

function useSave(onSave, onClose) {
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const save = async (body) => {
    setBusy(true);
    try { await onSave(body); } catch (e) { setErr(e); setBusy(false); }
  };
  return { err, busy, save, onClose };
}

function PlanDialog({ sub, onClose, onSave }) {
  const { data: plans } = useLoad(() => get('/admin/plans'), []);
  const [planId, setPlanId] = useState(sub?.plan_id ?? '');
  const [cycle, setCycle] = useState(sub?.billing_cycle ?? 'monthly');
  const s = useSave(onSave, onClose);
  const active = (plans ?? []).filter((p) => p.status === 'active');
  const plan = active.find((p) => p.id === planId);
  const price = plan && (cycle === 'yearly' ? plan.price_yearly : plan.price_monthly);
  return (
    <Modal title="Change plan" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={!plan || s.busy} onClick={() => s.save({ planId, billingCycle: cycle })}>Change plan</Button></>}>
      <div className="stack">
        <div className="form-grid">
          <Input label="Plan" as="select" value={planId} onChange={(e) => setPlanId(e.target.value)}>
            <option value="">Choose…</option>
            {active.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Input>
          <Input label="Billing" as="select" value={cycle} onChange={(e) => setCycle(e.target.value)}>
            <option value="monthly">Monthly</option><option value="yearly">Yearly</option>
          </Input>
        </div>
        {plan && (
          <Alert kind="info" title={price > 0 ? `${fmtMoney(price, plan.currency)} per ${cycle === 'yearly' ? 'year' : 'month'}` : plan.trial_days ? `Free ${plan.trial_days}-day trial` : 'Free'}>
            {price > 0
              ? 'A new billing period starts today and an invoice is issued now. Unpaid invoices of the current plan are voided (no proration).'
              : 'No invoice is issued.'}
            <div className="small">Limits: {limitText(plan.max_employees)} employees, {limitText(plan.max_admins)} HR admins · {modulesText(plan.modules)}</div>
          </Alert>
        )}
        <ErrorBox error={s.err} />
      </div>
    </Modal>
  );
}

function LimitsDialog({ sub, onClose, onSave }) {
  const [f, setF] = useState({ maxEmployees: sub.max_employees ?? '', maxAdmins: sub.max_admins ?? '' });
  const s = useSave(onSave, onClose);
  return (
    <Modal title="Custom limits" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={s.busy} onClick={() => s.save(f)}>Save limits</Button></>}>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>For this company only, e.g. a negotiated deal. Leave empty for unlimited. Changing plan resets them to the plan's limits.</p>
        <div className="form-grid">
          <Input label="Max active employees" type="number" min="1" value={f.maxEmployees} onChange={(e) => setF({ ...f, maxEmployees: e.target.value })} />
          <Input label="Max HR admin logins" type="number" min="1" value={f.maxAdmins} onChange={(e) => setF({ ...f, maxAdmins: e.target.value })} />
        </div>
        <ErrorBox error={s.err} />
      </div>
    </Modal>
  );
}

function TrialDialog({ sub, onClose, onSave }) {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(sub.trial_ends_on > today ? sub.trial_ends_on : today);
  const s = useSave(onSave, onClose);
  return (
    <Modal title="Extend trial" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={s.busy} onClick={() => s.save({ trialEndsOn: date })}>Save</Button></>}>
      <div className="stack">
        <Input label="Trial ends on" type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} />
        {sub.status === 'expired' && <p className="small muted" style={{ margin: 0 }}>The company gets access again until this date.</p>}
        <ErrorBox error={s.err} />
      </div>
    </Modal>
  );
}

function CancelDialog({ sub, onClose, onSave }) {
  const canWait = sub.status !== 'trialing' && !!sub.current_period_end;
  const [atPeriodEnd, setAtPeriodEnd] = useState(canWait);
  const [reason, setReason] = useState('');
  const s = useSave(onSave, onClose);
  return (
    <Modal title="Cancel subscription" onClose={onClose}
      footer={<><Button onClick={onClose}>Keep subscription</Button><Button kind="danger" disabled={s.busy} onClick={() => s.save({ atPeriodEnd, reason })}>Cancel subscription</Button></>}>
      <div className="stack">
        {canWait && <Switch label={`At the end of the paid period (${fmtDate(sub.current_period_end)})`} checked={atPeriodEnd} onChange={setAtPeriodEnd} />}
        <Alert kind="warn">{atPeriodEnd ? 'The company keeps access until then and is not billed again.' : 'Access stops now. Data is kept, and assigning a plan reactivates the company.'}</Alert>
        <Input label="Reason" as="textarea" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        <ErrorBox error={s.err} />
      </div>
    </Modal>
  );
}

function EditCompanyDialog({ tenant, onClose, onDone }) {
  const [f, setF] = useState({ name: tenant.name ?? '', slug: tenant.slug ?? '', timezone: tenant.timezone, currency: tenant.currency,
    contactEmail: tenant.contact_email ?? '', phone: tenant.phone ?? '', country: tenant.country ?? '', address: tenant.address ?? '' });
  const set = (k) => (e) => setF({ ...f, [k]: e?.target ? e.target.value : e });
  const s = useSave(async (body) => { await patch(`/admin/tenants/${tenant.id}`, body); onDone(); }, onClose);
  return (
    <Modal title={`Edit ${tenant.name}`} onClose={onClose} wide
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={s.busy} onClick={() => s.save(f)}>Save changes</Button></>}>
      <div className="stack">
        <div className="form-grid">
          <Input label="Company name" value={f.name} onChange={set('name')} />
          <Input label="Slug" help="Lowercase letters, numbers and dashes" value={f.slug} onChange={set('slug')} />
          <Input label="Contact email" type="email" value={f.contactEmail} onChange={set('contactEmail')} />
          <Input label="Phone" value={f.phone} onChange={set('phone')} />
          <Input label="Country" value={f.country} onChange={set('country')} />
          <Input label="Address" value={f.address} onChange={set('address')} />
          <TimezoneSelect help="Attendance and payroll dates use it" value={f.timezone} onChange={set('timezone')} />
          <CurrencySelect help="Can't change after the first payroll run" value={f.currency} onChange={set('currency')} />
        </div>
        <ErrorBox error={s.err} />
      </div>
    </Modal>
  );
}

function EditLoginDialog({ tenantId, login, onClose, onDone }) {
  const [f, setF] = useState({ fullName: login.full_name ?? '', email: login.email, password: '' });
  const s = useSave(async () => {
    const body = { email: f.email };
    if (f.fullName.trim() && f.fullName !== login.full_name) body.fullName = f.fullName;
    if (f.password) body.password = f.password;
    const { changed } = await patch(`/admin/tenants/${tenantId}/logins/${login.id}`, body);
    onDone(changed.length ? `Saved: ${changed.join(', ')} changed.` : 'Nothing changed.');
  }, onClose);
  return (
    <Modal title="Edit HR admin login" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={s.busy} onClick={() => s.save()}>Save</Button></>}>
      <div className="stack">
        <Input label="Full name" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} />
        <Input label="Sign-in email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <PasswordInput label="New password" help="Leave empty to keep the current one. At least 8 characters; they are signed out everywhere."
          autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        <ErrorBox error={s.err} />
      </div>
    </Modal>
  );
}

function DeleteCompanyDialog({ tenant, usage, onClose, onDone }) {
  const [typed, setTyped] = useState('');
  const s = useSave(async () => {
    await api(`/admin/tenants/${tenant.id}`, { method: 'DELETE', body: { confirmName: typed } });
    onDone();
  }, onClose);
  const ok = typed.trim().toLowerCase() === tenant.name.trim().toLowerCase();
  return (
    <Modal title={`Delete ${tenant.name}?`} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind="danger" icon="trash" disabled={!ok || s.busy} onClick={() => s.save()}>Delete permanently</Button></>}>
      <div className="stack">
        <Alert kind="bad" title="This cannot be undone">
          Everything in this company is deleted for good: {usage.total_employees} employee records, every login, attendance, leave,
          payroll and payslips, tasks and files, invoices and payments. Its people can no longer sign in.
          To only block access and keep the data, suspend the company instead.
        </Alert>
        <Input label={<>Type <strong>{tenant.name}</strong> to confirm</>} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        <ErrorBox error={s.err} />
      </div>
    </Modal>
  );
}

export function RefundDialog({ payment, onClose, onDone }) {
  const left = Math.round((payment.amount - payment.refunded) * 100) / 100;
  const [amount, setAmount] = useState(String(left));
  const [reason, setReason] = useState('');
  const s = useSave(async (body) => { await post(`/admin/payments/${payment.id}/refund`, body); onDone(); }, onClose);
  return (
    <Modal title={`Refund — ${payment.invoice_number}`} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind="danger" disabled={s.busy} onClick={() => s.save({ amount: Number(amount), reason })}>Record refund</Button></>}>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>Records money you returned (outside the HRM). Up to {fmtMoney(left, payment.currency)}. The invoice becomes payable again for the refunded amount.</p>
        <Input label={`Amount (${payment.currency})`} type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <Input label="Reason" as="textarea" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        <ErrorBox error={s.err} />
      </div>
    </Modal>
  );
}
