import { useEffect, useState } from 'react';
import { get, post } from '../lib/api.js';
import { navigate, useApp } from '../lib/app.jsx';
import { fmtDate, fmtMoney } from '../lib/format.js';
import { useConfirm } from '../components/confirm.jsx';
import { PageHead } from '../components/Layout.jsx';
import { InvoiceTable, PaymentTable, ReportPaymentModal, SubmissionTable, UsageBar, limitText, modulesText, priceText, renewalText } from '../components/billing.jsx';
import { Alert, Button, Card, ErrorBox, Input, Loading, PRODUCT_NAME, StatusBadge, useLoad } from '../components/ui.jsx';

/** HR admins: the company's plan, usage, invoices, and paying (card via the payment provider, or by bank transfer). */
export default function Subscription({ query = {} }) {
  const { t, session, reloadSession, toast } = useApp();
  const { data: d, loading, error, reload } = useLoad(() => get('/billing/subscription'), []);
  const [cycle, setCycle] = useState('monthly');
  const [busy, setBusy] = useState(null);
  const [report, setReport] = useState(null); // { invoice } or { plan, cycle, amount }: the "I've paid" form
  // Access may have come back (payment recorded) or gone since sign-in: refresh the menus.
  const stale = d?.summary && d.summary.blocked !== !!session.subscription?.blocked;
  useEffect(() => { if (stale) reloadSession(); }, [stale, reloadSession]);
  // Back from the payment page: the provider confirms a moment later, so look again shortly.
  const returned = query.checkout;
  useEffect(() => {
    if (returned !== 'success') return undefined;
    const timers = [2500, 7000].map((ms) => setTimeout(reload, ms));
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returned]);

  const confirm = useConfirm();
  const checkout = async (key, body, question) => {
    if (!(await confirm({ confirmLabel: 'Continue to payment', ...question }))) return;
    setBusy(key);
    try {
      const { url } = await post('/billing/checkout', body);
      window.location.assign(url); // the provider's hosted payment page
    } catch (e) { toast(e.message, 'bad'); setBusy(null); }
  };

  if (loading && !d) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const sub = d.subscription;
  const s = d.summary;
  const online = d.onlinePayments;
  const contact = d.supportEmail ? <a href={`mailto:${d.supportEmail}`}>{d.supportEmail}</a> : PRODUCT_NAME;
  const priceOf = (p) => (cycle === 'yearly' ? p.price_yearly : p.price_monthly);
  const withTax = (price) => Math.round((price + (price * d.taxRate) / 100) * 100) / 100;
  const pendingFor = (inv) => d.submissions.some((x) => x.status === 'pending' && x.invoice_number === inv.number);
  const planPending = d.submissions.some((x) => x.status === 'pending' && x.kind === 'plan');
  const waiting = d.submissions.filter((x) => x.status === 'pending');
  const paidPlans = d.plans.filter((p) => p.price_monthly > 0 || p.price_yearly > 0 || p.id === sub?.plan_id);
  const dismiss = () => navigate('/billing');
  return (
    <div className="stack lg">
      <PageHead title={t('nav.subscription', 'Subscription')} subtitle={sub ? `${sub.plan_name} · ${priceText(sub)}` : ''} />

      {returned === 'success' && (
        <Alert kind="good" title="Thank you, your payment went through">It appears here as soon as the payment provider confirms it (usually a few seconds). <button type="button" className="link" onClick={dismiss}>Dismiss</button></Alert>
      )}
      {returned === 'cancelled' && <Alert kind="info">Payment cancelled; nothing was charged. <button type="button" className="link" onClick={dismiss}>Dismiss</button></Alert>}
      {s?.status === 'expired' && <Alert kind="bad" title="Your free trial has ended">The HRM is paused for everyone in your company until you choose a plan{online ? ' below' : <> with {contact}</>}. Your data is kept.</Alert>}
      {s?.status === 'unpaid' && <Alert kind="bad" title="Access is paused">Invoice {s.overdue?.number} is unpaid. Access returns as soon as it is paid.</Alert>}
      {s?.status === 'cancelled' && <Alert kind="bad" title="Your subscription was cancelled">{online ? 'Choose a plan below to reactivate it' : <>Contact {contact} to reactivate it</>}; your data is kept.</Alert>}
      {s?.status === 'past_due' && s.overdue && (
        <Alert kind="warn" title={`Invoice ${s.overdue.number} is overdue`}>{fmtMoney(s.overdue.amountDue, s.overdue.currency)} was due on {fmtDate(s.overdue.dueOn)}. Please pay soon to avoid a pause.</Alert>
      )}

      <div className="grid cols-2">
        <Card title="Current plan" actions={sub && <StatusBadge status={s.status} />}>
          {sub && (
            <dl className="facts">
              <dt>Plan</dt><dd><strong>{sub.plan_name}</strong> · {priceText(sub)}</dd>
              <dt>Dates</dt><dd>{renewalText(sub)}</dd>
              <dt>Included</dt><dd>{modulesText(sub.modules)}</dd>
            </dl>
          )}
        </Card>
        <Card title="Usage">
          <div className="stack">
            <UsageBar label="Active employees" used={d.usage.active_employees} max={sub?.max_employees} />
            <UsageBar label="HR admin logins" used={d.usage.admins} max={sub?.max_admins} />
          </div>
        </Card>
      </div>

      {waiting.length > 0 && (
        <Alert kind="info" title={`${waiting.length === 1 ? 'Your payment is' : `${waiting.length} payments are`} waiting for confirmation`}>
          We check every payment you send and confirm it, usually within one working day. You'll get a notification and an email.
        </Alert>
      )}
      {report && <ReportPaymentModal target={report} instructions={d.paymentInstructions}
        onCardPay={online ? () => { const r = report; setReport(null); if (r.invoice) checkout(r.invoice.id, { invoiceId: r.invoice.id }, { title: `Pay invoice ${r.invoice.number}?` }); else checkout(r.plan.id, { planId: r.plan.id, billingCycle: r.cycle }, { title: `Switch to ${r.plan.name} (${r.cycle})?` }); } : undefined}
        onClose={() => setReport(null)} onDone={() => { setReport(null); reload(); }} />}

      {(d.paymentInstructions || (!online && d.invoices.some((i) => i.status === 'open'))) && (
        <Card title={online ? 'Paying by bank transfer instead' : 'How to pay'}>
          <div className="stack">
            {d.paymentInstructions ? <p style={{ whiteSpace: 'pre-line', margin: 0 }}>{d.paymentInstructions}</p> : <p style={{ margin: 0 }}>Contact {contact} for payment details.</p>}
            <p className="small muted" style={{ margin: 0 }}>Put the invoice number as the payment reference. After paying, press <strong>I've paid</strong> on the invoice and attach the receipt; {PRODUCT_NAME} confirms it, usually within one working day.</p>
          </div>
        </Card>
      )}

      <Card title="Invoices" className="flush">
        <InvoiceTable invoices={d.invoices} payLabel={busy ? 'Opening…' : 'Pay by card'}
          onPay={online ? (inv) => !busy && checkout(inv.id, { invoiceId: inv.id }, { title: `Pay invoice ${inv.number}?`,
            message: `You'll pay ${fmtMoney(inv.amount_due, inv.currency)} by card on the payment provider's secure page.` }) : undefined}
          rowActions={(inv) => inv.status === 'open' && (pendingFor(inv)
            ? <span className="badge warn">Payment sent</span>
            : <Button size="sm" kind={online ? undefined : 'primary'} icon="send" onClick={() => setReport({ invoice: inv })}>I've paid</Button>)} />
      </Card>
      {d.submissions.length > 0 && (
        <Card title="Payments you reported" className="flush">
          <SubmissionTable rows={d.submissions} proofPath={(x) => `/billing/payments/${x.id}/proof`} />
        </Card>
      )}
      {d.payments.length > 0 && <Card title="Payments received" className="flush"><PaymentTable payments={d.payments} /></Card>}

      <Card title="Plans" className="flush" actions={(
        <Input label={<span className="sr-only">Billing</span>} as="select" value={cycle} onChange={(e) => setCycle(e.target.value)}>
          <option value="monthly">Monthly</option><option value="yearly">Yearly</option>
        </Input>)}>
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Plan</th><th className="num">Monthly</th><th className="num">Yearly</th><th className="num">Employees</th><th className="num">HR admins</th><th>Modules</th>
            <th><span className="sr-only">Choose</span></th></tr></thead>
          <tbody>{paidPlans.map((p) => {
            const current = p.id === sub?.plan_id && ['active', 'past_due', 'trialing'].includes(s.status) && (sub.billing_cycle === cycle || sub.price === 0);
            return (
              <tr key={p.id} aria-current={p.id === sub?.plan_id ? 'true' : undefined}>
                <td><strong>{p.name}</strong>{p.id === sub?.plan_id && <> <span className="badge info">Current</span></>}{p.description && <div className="small muted">{p.description}</div>}</td>
                <td className="num">{p.price_monthly > 0 ? fmtMoney(p.price_monthly, p.currency) : 'Free'}</td>
                <td className="num">{p.price_yearly > 0 ? fmtMoney(p.price_yearly, p.currency) : 'Free'}</td>
                <td className="num">{limitText(p.max_employees)}</td>
                <td className="num">{limitText(p.max_admins)}</td>
                <td className="small">{modulesText(p.modules)}</td>
                <td>{priceOf(p) > 0 && !current && (planPending
                  ? <span className="badge warn">Payment sent</span>
                  : <Button size="sm" kind="primary" disabled={!!busy} onClick={() => setReport({ plan: p, cycle, amount: withTax(priceOf(p)) })}>
                    {`Choose · ${fmtMoney(priceOf(p), p.currency)}`}</Button>)}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
        <p className="small muted" style={{ padding: '0 18px 16px', margin: 0 }}>
          Choose a plan, pay{online ? ' by card or' : ''} using the payment details, and send us the payment. The plan starts as soon as the payment is confirmed, for a full {cycle === 'yearly' ? 'year' : 'month'} from that day{d.taxRate > 0 ? ` (plus ${d.taxRate}% ${d.taxLabel})` : ''}.
        </p>
      </Card>
    </div>
  );
}
