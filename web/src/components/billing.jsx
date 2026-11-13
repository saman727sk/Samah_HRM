/* eslint-disable react/only-export-components */
/** Building blocks shared by the super admin billing screens and the company's Subscription page. */
import { useState } from 'react';
import { api, post } from '../lib/api.js';
import { useApp } from '../lib/app.jsx';
import { fmtDate, fmtMoney, humanize } from '../lib/format.js';
import { Alert, Button, Empty, ErrorBox, Input, Modal, StatusBadge } from './ui.jsx';

export const PAYMENT_METHODS = [['bank_transfer', 'Bank transfer'], ['cash', 'Cash'], ['cheque', 'Cheque'], ['card', 'Card'], ['online', 'Online'], ['other', 'Other']];
export const MODULE_LABELS = {
  attendance: 'Attendance', wfh: 'Work from home', leave: 'Leave', payroll: 'Payroll', overtime: 'Overtime',
  loans: 'Loans & advances', auto_checkin: 'Auto check-in', selfie_verification: 'Selfie verification',
};
export const MODULES = Object.keys(MODULE_LABELS);

export const limitText = (n) => (n == null ? 'Unlimited' : n);
export const modulesText = (m) => (m == null ? 'All modules' : m.map((k) => MODULE_LABELS[k] ?? k).join(', '));
export const priceText = (sub) => (sub.price > 0 ? `${fmtMoney(sub.price, sub.currency)} / ${sub.billing_cycle === 'yearly' ? 'year' : 'month'}` : 'Free');

/** "Renews 3 Apr 2026", "Trial ends 18 Nov 2026"... */
export function renewalText(sub) {
  if (!sub) return '—';
  if (sub.status === 'trialing' || sub.status === 'expired') return `Trial ${sub.status === 'expired' ? 'ended' : 'ends'} ${fmtDate(sub.trial_ends_on)}`;
  if (!sub.current_period_end) return '—';
  if (sub.cancel_at_period_end) return `Ends ${fmtDate(sub.current_period_end)}`;
  return ['cancelled', 'unpaid'].includes(sub.status) ? `Period ended ${fmtDate(sub.current_period_end)}` : `Renews ${fmtDate(addDay(sub.current_period_end))}`;
}
const addDay = (ymd) => new Date(Date.parse(`${ymd}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

/** Usage against a limit, with a bar. */
export function UsageBar({ label, used, max }) {
  const pct = max ? Math.min(100, Math.round((used / max) * 100)) : 0;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row between"><span>{label}</span><strong className="num">{used}{max != null ? ` / ${max}` : ''}</strong></div>
      {max != null
        ? <div className="progress" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={used} aria-label={label}>
          <span style={{ width: `${pct}%`, background: pct >= 100 ? 'var(--bad)' : pct >= 85 ? 'var(--warn)' : undefined }} /></div>
        : <span className="small muted">Unlimited</span>}
    </div>
  );
}

export function InvoiceTable({ invoices, showCompany = false, onPay, onVoid, payLabel = 'Record payment', empty = 'No invoices yet.', rowActions }) {
  if (!invoices.length) return <Empty>{empty}</Empty>;
  const actions = !!(onPay || onVoid || rowActions);
  return (
    <div className="table-wrap"><table className="table">
      <thead><tr>
        <th>Invoice</th>{showCompany && <th>Company</th>}<th>Period</th><th>Issued</th><th>Due</th><th className="num">Total</th><th className="num">Due now</th><th>Status</th>
        {actions && <th className="no-print"><span className="sr-only">Actions</span></th>}
      </tr></thead>
      <tbody>{invoices.map((i) => {
        const overdue = i.status === 'open' && i.due_on < new Date().toISOString().slice(0, 10);
        return (
          <tr key={i.id}>
            <td className="mono">{i.number}</td>
            {showCompany && <td>{i.company}</td>}
            <td className="small">{fmtDate(i.period_start)} – {fmtDate(i.period_end)}</td>
            <td>{fmtDate(i.issued_on)}</td>
            <td>{fmtDate(i.due_on)}{overdue && <> <span className="badge bad">Overdue</span></>}</td>
            <td className="num">{fmtMoney(i.total, i.currency)}</td>
            <td className="num">{i.status === 'open' ? fmtMoney(i.amount_due, i.currency) : '—'}</td>
            <td><StatusBadge status={i.status} />{i.void_reason && <div className="small muted">{i.void_reason}</div>}</td>
            {actions && <td className="no-print"><div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
              {rowActions?.(i)}
              {onPay && i.status === 'open' && <Button size="sm" kind="primary" onClick={() => onPay(i)}>{payLabel}</Button>}
              {onVoid && i.status === 'open' && i.amount_paid === 0 && <Button size="sm" onClick={() => onVoid(i)}>Void</Button>}
            </div></td>}
          </tr>
        );
      })}</tbody>
    </table></div>
  );
}

export function PaymentTable({ payments, showCompany = false, onRefund }) {
  if (!payments.length) return <Empty>No payments recorded yet.</Empty>;
  return (
    <div className="table-wrap"><table className="table">
      <thead><tr><th>Received</th>{showCompany && <th>Company</th>}<th>Invoice</th><th>Type</th><th>Method</th><th>Reference</th><th className="num">Amount</th>
        {onRefund && <th className="no-print"><span className="sr-only">Actions</span></th>}</tr></thead>
      <tbody>{payments.map((p) => (
        <tr key={p.id}>
          <td>{fmtDate(p.received_on)}</td>
          {showCompany && <td>{p.company}</td>}
          <td className="mono">{p.invoice_number}</td>
          <td>{p.kind === 'refund' ? <span className="badge warn">Refund</span> : <span className="badge good">Payment</span>}</td>
          <td>{humanize(p.method)}</td>
          <td className="small">{p.reference ?? p.note ?? '—'}</td>
          <td className="num">{p.kind === 'refund' ? '−' : ''}{fmtMoney(p.amount, p.currency)}
            {p.refunded > 0 && <div className="small muted">{fmtMoney(p.refunded, p.currency)} refunded</div>}</td>
          {onRefund && <td className="no-print">{p.kind === 'payment' && p.refunded < p.amount && <Button size="sm" onClick={() => onRefund(p)}>Refund</Button>}</td>}
        </tr>
      ))}</tbody>
    </table></div>
  );
}

/** Super admin: record money received against an invoice. */
export function PaymentModal({ invoice, onClose, onDone }) {
  const { toast } = useApp();
  const [f, setF] = useState({ amount: String(invoice.amount_due), method: 'bank_transfer', reference: '', receivedOn: new Date().toISOString().slice(0, 10), note: '' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await post(`/admin/invoices/${invoice.id}/payments`, { ...f, amount: Number(f.amount) });
      toast(`Payment recorded on ${invoice.number}.`);
      onDone();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Record payment — ${invoice.number}`} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={busy} onClick={save}>Record payment</Button></>}>
      <div className="stack">
        <p className="muted small" style={{ margin: 0 }}>{invoice.company ? `${invoice.company} · ` : ''}{fmtMoney(invoice.amount_due, invoice.currency)} due of {fmtMoney(invoice.total, invoice.currency)}</p>
        <div className="form-grid">
          <Input label={`Amount (${invoice.currency})`} type="number" min="0" step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          <Input label="Received on" type="date" value={f.receivedOn} onChange={(e) => setF({ ...f, receivedOn: e.target.value })} />
          <Input label="Method" as="select" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
            {PAYMENT_METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Input>
          <Input label="Reference" help="Bank transaction ID, cheque number…" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
        </div>
        <Input label="Note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}

/** A dialog that only asks for a reason (void, suspend, refund...). */
export function ReasonModal({ title, label = 'Reason', action, danger, onClose, onSubmit, children }) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { await onSubmit(reason); } catch (e) { setErr(e); setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind={danger ? 'danger' : 'primary'} disabled={busy} onClick={go}>{action}</Button></>}>
      <div className="stack">
        {children}
        <Input label={label} as="textarea" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------
// Payments reported by companies (bank transfer, cash...), confirmed by the owner
// ---------------------------------------------------------------------

export const REPORT_METHODS = [['bank_transfer', 'Bank transfer'], ['online', 'JazzCash / EasyPaisa / online'], ['cheque', 'Cheque'], ['cash', 'Cash'], ['other', 'Other']];
const MAX_PROOF = 2 * 1024 * 1024;

/** Opens a receipt (an authenticated file) in a new tab. */
export async function openProof(path) {
  const tab = window.open('', '_blank'); // opened now, so the browser doesn't block it as a pop-up
  try {
    const res = await api(path, { raw: true });
    const url = URL.createObjectURL(await res.blob());
    if (tab) tab.location = url; else window.location.assign(url);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) { tab?.close(); throw e; }
}

const SUB_STATUS = {
  pending: ['warn', 'Waiting for confirmation'],
  confirmed: ['good', 'Confirmed'],
  rejected: ['bad', 'Not confirmed'],
};
export const SubmissionBadge = ({ status }) => { const [k, l] = SUB_STATUS[status] ?? ['', status]; return <span className={`badge ${k}`}>{l}</span>; };
const forWhat = (s) => (s.kind === 'plan' ? `${s.plan_name} plan (${s.billing_cycle})` : s.invoice_number);

/**
 * Company HR: tell the owner about a payment made outside the system.
 * target: { invoice } (an open invoice) or { plan, cycle, amount } (buying a plan).
 */
export function ReportPaymentModal({ target, instructions, onCardPay, onClose, onDone }) {
  const { toast } = useApp();
  const inv = target.invoice;
  const currency = inv?.currency ?? target.plan.currency;
  const due = inv ? inv.amount_due : target.amount;
  const [f, setF] = useState({ amount: String(due), method: 'bank_transfer', reference: '', paidOn: new Date().toISOString().slice(0, 10), note: '' });
  const [proof, setProof] = useState(null); // { name, dataUrl }
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const pick = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'application/pdf'].includes(file.type)) { toast('Choose a photo (PNG/JPEG) or a PDF of the receipt.', 'bad'); return; }
    if (file.size > MAX_PROOF) { toast('The receipt must be 2 MB or smaller.', 'bad'); return; }
    const r = new FileReader();
    r.onload = () => setProof({ name: file.name, dataUrl: r.result });
    r.readAsDataURL(file);
  };
  const send = async () => {
    setBusy(true); setErr(null);
    try {
      await post('/billing/payments', {
        ...(inv ? { invoiceId: inv.id } : { planId: target.plan.id, billingCycle: target.cycle }),
        ...f, amount: Number(f.amount), proof: proof?.dataUrl,
      });
      toast('Payment sent for confirmation. You will be notified when it is confirmed.');
      onDone();
    } catch (e) { setErr(e); setBusy(false); }
  };
  const title = inv ? `Report payment: ${inv.number}` : `Pay for ${target.plan.name} (${target.cycle})`;
  return (
    <Modal title={title} wide onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" icon="send" disabled={busy} onClick={send}>{busy ? 'Sending…' : 'Send for confirmation'}</Button></>}>
      <div className="stack">
        <div className="pay-amount"><span>Amount to pay</span><strong>{fmtMoney(due, currency)}</strong></div>
        {instructions
          ? <Alert kind="info" title="Where to pay"><div style={{ whiteSpace: 'pre-line' }}>{instructions}</div></Alert>
          : <Alert kind="info">Pay using the details you received from us, then fill in this form.</Alert>}
        {onCardPay && <Button icon="money" onClick={onCardPay}>Pay by card instead</Button>}
        <h3 style={{ margin: '6px 0 0' }}>After paying, tell us:</h3>
        <div className="form-grid">
          <Input label={`Amount paid (${currency})`} type="number" min="0" step="0.01" value={f.amount} onChange={set('amount')} />
          <Input label="How you paid" as="select" value={f.method} onChange={set('method')}>{REPORT_METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Input>
          <Input label="Transaction ID / cheque number" help="As shown on the receipt" value={f.reference} onChange={set('reference')} />
          <Input label="Date paid" type="date" max={new Date().toISOString().slice(0, 10)} value={f.paidOn} onChange={set('paidOn')} />
        </div>
        <div className="field">
          <span className="field-label">Receipt (photo or PDF, optional but faster)</span>
          <label className="file-drop">
            <input type="file" accept="image/png,image/jpeg,application/pdf" onChange={pick} hidden />
            <span>{proof ? `✓ ${proof.name}` : 'Choose the receipt or a screenshot of the transfer'}</span>
          </label>
        </div>
        <Input label="Note (optional)" value={f.note} onChange={set('note')} />
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}

/** Reported payments. For the owner: company column, receipt, Confirm / Reject. */
export function SubmissionTable({ rows, owner = false, onConfirm, onReject, proofPath }) {
  const { toast } = useApp();
  if (!rows.length) return <Empty>{owner ? 'No payments are waiting for you.' : 'You have not reported any payments.'}</Empty>;
  return (
    <div className="table-wrap"><table className="table">
      <thead><tr><th>Sent</th>{owner && <th>Company</th>}<th>For</th><th>Method</th><th>Reference</th><th>Paid on</th><th className="num">Amount</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
      <tbody>{rows.map((s) => (
        <tr key={s.id} className={s.status === 'pending' ? 'is-pending' : ''}>
          <td className="small">{new Date(s.created_at).toLocaleString()}{owner && s.submitted_by_email && <div className="muted">{s.submitted_by_email}</div>}</td>
          {owner && <td>{s.company}</td>}
          <td>{forWhat(s)}{owner && s.kind === 'invoice' && s.status === 'pending' && Number(s.amount) < Number(s.invoice_due) &&
            <div className="small" style={{ color: 'var(--warn)' }}>Part payment: {fmtMoney(s.invoice_due, s.currency)} due</div>}</td>
          <td>{humanize(s.method)}</td>
          <td className="small mono">{s.reference ?? '—'}</td>
          <td>{fmtDate(s.paid_on)}</td>
          <td className="num">{fmtMoney(s.amount, s.currency)}</td>
          <td><SubmissionBadge status={s.status} />{s.review_note && <div className="small muted">{s.review_note}</div>}</td>
          <td><div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
            {s.has_proof && <Button size="sm" icon="file" onClick={() => openProof(proofPath(s)).catch((e) => toast(e.message, 'bad'))}>Receipt</Button>}
            {owner && s.status === 'pending' && <>
              <Button size="sm" kind="primary" icon="check" onClick={() => onConfirm(s)}>Confirm</Button>
              <Button size="sm" kind="danger" onClick={() => onReject(s)}>Reject</Button>
            </>}
          </div></td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}
