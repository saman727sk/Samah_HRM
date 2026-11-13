import { useState } from 'react';
import { get, qs } from '../lib/api.js';
import { useApp } from '../lib/app.jsx';
import { fmtDate, fmtMoney, hm, monthLabel, monthOf, shiftMonth, todayIn } from '../lib/format.js';
import { PageHead } from '../components/Layout.jsx';
import { CheckInCard, MonthCalendar } from '../components/attendance.jsx';
import { Button, Card, Empty, ErrorBox, Loading, Stat, StatusBadge, useLoad } from '../components/ui.jsx';

export function BalanceTable({ balances }) {
  const { t } = useApp();
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>{t('ui.leave_type', 'Leave type')}</th><th className="num">{t('ui.entitled', 'Entitled')}</th><th className="num">{t('ui.accrued', 'Accrued')}</th>
          <th className="num">{t('ui.used', 'Used')}</th><th className="num">{t('ui.pending', 'Pending')}</th><th className="num">{t('ui.available', 'Available')}</th></tr></thead>
        <tbody>
          {balances.map((b) => (
            <tr key={b.leaveType.id}>
              <td><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: b.leaveType.color ?? 'var(--text-3)', marginInlineEnd: 8 }} />{b.leaveType.name}</td>
              <td className="num">{b.unlimited ? '∞' : b.entitled + b.carriedForward}</td>
              <td className="num">{b.accrued || '—'}</td>
              <td className="num">{b.used}</td>
              <td className="num">{b.pending || '—'}</td>
              <td className="num"><strong>{b.unlimited ? '∞' : b.available}</strong></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function MyDashboard() {
  const { t, tz, session } = useApp();
  const [month, setMonth] = useState(monthOf(todayIn(tz)));
  const { data, error, loading, reload } = useLoad(() => get(`/dashboard/employee${qs({ month })}`), [month]);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const d = data;
  const today = todayIn(tz);
  return (
    <div className="stack lg">
      <PageHead title={`${t('ui.hello', 'Hello')}, ${session.employee?.full_name?.split(' ')[0] ?? ''}`} subtitle={fmtDate(today, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} />
      <CheckInCard today={d.today} onDone={reload} />
      <div className="grid stats">
        <Stat label={t('ui.days_present', 'Days in office')} value={d.month.totals.present} sub={monthLabel(month)} />
        <Stat label={t('ui.days_wfh', 'WFH days')} value={d.month.totals.wfh} />
        <Stat label={t('ui.days_leave', 'Leave days')} value={d.month.totals.onLeave} />
        <Stat label={t('ui.late_arrivals', 'Late arrivals')} value={d.month.totals.late} />
        {d.wfhQuota && <Stat label={t('ui.wfh_left_week', 'WFH left this week')} value={`${d.wfhQuota.week.remaining}/${d.wfhQuota.week.max}`} sub={`${d.wfhQuota.month.remaining}/${d.wfhQuota.month.max} ${t('ui.this_month', 'this month')}`} />}
      </div>
      <div className="grid cols-2">
        <Card title={monthLabel(month)} actions={<>
          <Button size="sm" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}>‹</Button>
          <Button size="sm" aria-label="Next month" onClick={() => setMonth(shiftMonth(month, 1))}>›</Button></>}>
          <MonthCalendar days={d.month.days} today={today} />
          <p className="small muted">{t('ui.worked_this_month', 'Worked')} {hm(d.month.totals.workedMinutes)} · {t('ui.overtime', 'Overtime')} {hm(d.month.totals.overtimeMinutes)}</p>
        </Card>
        <div className="stack lg">
          <Card title={t('ui.leave_balances', 'Leave balances')} actions={<a className="btn sm" href="#/requests">{t('ui.apply', 'Apply')}</a>}>
            <BalanceTable balances={d.balances} />
          </Card>
          <Card title={t('ui.recent_requests', 'Recent requests')}>
            {d.leaveRequests.length + d.wfhRequests.length === 0 ? <Empty>{t('ui.no_requests', 'No requests yet.')}</Empty> : (
              <table className="table"><tbody>
                {d.leaveRequests.slice(0, 4).map((r) => <tr key={r.id}><td>{r.leave_type}</td><td>{fmtDate(r.start_date)}{r.end_date !== r.start_date ? ` – ${fmtDate(r.end_date)}` : ''}</td><td><StatusBadge status={r.status} /></td></tr>)}
                {d.wfhRequests.slice(0, 4).map((r) => <tr key={r.id}><td>WFH</td><td>{fmtDate(r.start_date)}{r.days > 1 ? ` (+${r.days - 1})` : ''}</td><td><StatusBadge status={r.status} /></td></tr>)}
              </tbody></table>
            )}
          </Card>
          <Card title={t('ui.payslips', 'Payslips')}>
            {d.payslips.length === 0 ? <Empty>{t('ui.no_payslips', 'Payslips appear here after payroll is locked.')}</Empty> : (
              <table className="table"><tbody>{d.payslips.slice(0, 4).map((p) => <tr key={p.id}><td><a href={`#/payslips?id=${p.id}`}>{monthLabel(p.period_key)}</a></td><td className="num">{fmtMoney(p.net)}</td></tr>)}</tbody></table>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
