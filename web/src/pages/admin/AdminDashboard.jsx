import { get, post } from '../../lib/api.js';
import { useApp } from '../../lib/app.jsx';
import { fmtDate, fmtMoney, monthLabel } from '../../lib/format.js';
import { PageHead } from '../../components/Layout.jsx';
import StackedBars from '../../components/StackedBars.jsx';
import { CountUp } from '../../components/motion.jsx';
import { Alert, Button, Card, Empty, ErrorBox, Loading, Stat, StatusBadge, useLoad } from '../../components/ui.jsx';

/** Several currencies are shown side by side, never added together. */
const perCurrency = (rows, key) => (rows.length ? rows.map((r) => fmtMoney(r[key], r.currency)).join(' · ') : '—');
/** The same, counting up from zero, in whole rupees so big totals fit their card. */
const Money = ({ rows, k }) => (rows.length
  ? rows.map((r, i) => <span key={r.currency}>{i > 0 && ' · '}<CountUp value={r[k]} format={(n) => fmtMoney(Math.round(n), r.currency)} /></span>)
  : '—');

export default function AdminDashboard() {
  const { toast } = useApp();
  const { data: d, error, loading, reload } = useLoad(() => get('/admin/dashboard'), []);
  const runJobs = async () => {
    try {
      const r = await post('/admin/billing/run');
      toast(`Billing checked: ${r.renewed} renewed, ${r.pastDue} past due, ${r.unpaid} paused, ${r.trialsExpired} trials ended.`);
      reload();
    } catch (e) { toast(e.message, 'bad'); }
  };
  if (loading && !d) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const s = d.subscriptions;
  const shortMonth = (m) => monthLabel(m).replace(/ (\d{4})$/, (_, y) => ` ’${y.slice(2)}`);
  return (
    <div className="stack lg platform-dash">
      <div className="dash-hero">
        <PageHead title={<span className="gold-text">Platform dashboard</span>} subtitle={`Figures from recorded invoices and payments · ${fmtDate(d.today)}`}
          actions={<Button icon="refresh" onClick={runJobs}>Run billing check now</Button>} />
      </div>

      {d.people.payments_to_verify > 0 && (
        <Alert kind="warn" title={`${d.people.payments_to_verify} ${d.people.payments_to_verify === 1 ? 'payment is' : 'payments are'} waiting for your confirmation`}>
          <a href="#/admin/billing">Check and confirm</a>
        </Alert>
      )}
      {d.companies.pending > 0 && (
        <Alert kind="warn" title={`${d.companies.pending} new ${d.companies.pending === 1 ? 'company is' : 'companies are'} waiting for your approval`}>
          <a href="#/admin/companies?status=pending">Review sign-ups</a>
        </Alert>
      )}

      <div className="grid stats">
        <Stat label="Companies" value={<CountUp value={d.companies.total} />} sub={`${d.companies.active} active · ${d.companies.pending} awaiting approval · ${d.companies.suspended} suspended`} />
        <Stat label="On trial" value={<CountUp value={s.trialing ?? 0} />} sub={`${s.expired ?? 0} trials ended`} />
        <Stat label="Paying subscriptions" value={<CountUp value={(s.active ?? 0) + (s.past_due ?? 0)} />} sub={`${s.past_due ?? 0} past due`} />
        <Stat label="Paused or cancelled" value={<CountUp value={(s.unpaid ?? 0) + (s.cancelled ?? 0)} />} sub={`${s.unpaid ?? 0} unpaid · ${s.cancelled ?? 0} cancelled`} />
        <Stat label="Users" value={<CountUp value={d.people.users} />} sub={`${d.people.employees} active employees`} />
      </div>

      <div className="grid stats money">
        <Stat label="Monthly recurring revenue" value={<Money rows={d.mrr} k="mrr" />} sub="Active and past-due subscriptions; yearly ÷ 12" />
        <Stat label="Annual recurring revenue" value={<Money rows={d.mrr} k="arr" />} />
        <Stat label="Collected (all time)" value={<Money rows={d.collected} k="total" />} sub={`This month: ${perCurrency(d.collected, 'this_month')}`} />
        <Stat label="Awaiting payment" value={<Money rows={d.pending} k="amount" />} sub={`${d.pending.reduce((n, p) => n + p.invoices, 0)} open invoices`} />
        <Stat label="Overdue" value={<Money rows={d.pending.filter((p) => p.overdue)} k="overdue_amount" />}
          sub={`${d.pending.reduce((n, p) => n + p.overdue, 0)} invoices past their due date`} />
      </div>

      <div className="grid cols-2">
        <Card title="Revenue collected by month">
          {d.revenueByMonth.currencies.length === 0 ? <Empty>No payments recorded yet.</Empty> : (
            <StackedBars title="Revenue collected by month" labelKey={{ key: 'label', label: 'Month' }}
              rows={d.revenueByMonth.rows.map((r) => ({ ...r, label: shortMonth(r.month) }))}
              series={d.revenueByMonth.currencies.slice(0, 4).map((c) => ({ key: c, label: c }))} />
          )}
        </Card>
        <Card title="New companies by month">
          <StackedBars title="New companies by month" labelKey={{ key: 'label', label: 'Month' }}
            rows={d.signupsByMonth.map((r) => ({ ...r, label: shortMonth(r.month) }))} series={[{ key: 'companies', label: 'Companies' }]} />
        </Card>
      </div>

      <div className="grid cols-2">
        <Card title="Renewals and trial ends — next 30 days" className="flush">
          {d.renewals.length === 0 ? <Empty>Nothing due in the next 30 days.</Empty> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Company</th><th>Plan</th><th>Date</th><th className="num">Amount</th></tr></thead>
              <tbody>{d.renewals.map((r) => (
                <tr key={r.tenant_id}>
                  <td><a href={`#/admin/companies/detail?id=${r.tenant_id}`}>{r.name}</a></td>
                  <td>{r.plan_name} <StatusBadge status={r.status} /></td>
                  <td>{fmtDate(r.on_date)}{r.cancel_at_period_end && <div className="small muted">Cancels then</div>}</td>
                  <td className="num">{r.status === 'trialing' ? 'Trial ends' : fmtMoney(r.price, r.currency)}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
        <Card title="Recent payments" className="flush" actions={<a href="#/admin/billing" className="small">All payments</a>}>
          {d.recentPayments.length === 0 ? <Empty>No payments recorded yet.</Empty> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Date</th><th>Company</th><th>Invoice</th><th className="num">Amount</th></tr></thead>
              <tbody>{d.recentPayments.map((p) => (
                <tr key={p.id}><td>{fmtDate(p.received_on)}</td><td>{p.company}</td><td className="mono">{p.invoice_number}</td>
                  <td className="num">{p.kind === 'refund' ? '−' : ''}{fmtMoney(p.amount, p.currency)}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
      </div>

      <Card title="Recently registered companies" className="flush" actions={<a href="#/admin/companies" className="small">All companies</a>}>
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Company</th><th>Registered</th><th>Plan</th><th>Status</th></tr></thead>
          <tbody>{d.recentCompanies.map((c) => (
            <tr key={c.id}><td><a href={`#/admin/companies/detail?id=${c.id}`}>{c.name}</a></td><td>{fmtDate(c.created_at.slice(0, 10))}</td>
              <td>{c.plan_name ?? '—'}</td><td>{c.status ? <StatusBadge status={c.status} /> : '—'}</td></tr>
          ))}</tbody>
        </table></div>
      </Card>
    </div>
  );
}
