import { useState } from 'react';
import { download, get, qs } from '../lib/api.js';
import { useApp } from '../lib/app.jsx';
import { fmtDay, monthLabel, monthOf, shiftMonth, todayIn } from '../lib/format.js';
import { PageHead } from '../components/Layout.jsx';
import StackedBars from '../components/StackedBars.jsx';
import { TodayBoard } from './Team.jsx';
import { Button, Card, Empty, ErrorBox, Loading, Stat, StatusBadge, useLoad } from '../components/ui.jsx';
import { ManualAttendanceModal } from '../components/ManualAttendance.jsx';

export default function HrDashboard() {
  const { t, toast, tz } = useApp();
  const [month, setMonth] = useState(monthOf(todayIn(tz)));
  const [manual, setManual] = useState(false);
  const { data, error, loading, reload } = useLoad(() => get(`/dashboard/hr${qs({ month })}`), [month]);
  const exportCsv = (detail) => download(`/reports/attendance.csv${qs({ month, detail })}`, `attendance-${detail}-${month}.csv`).catch((e) => toast(e.message, 'bad'));
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const d = data;
  const leaveTypes = [...new Set(d.departments.flatMap((x) => Object.keys(x.leaveDays)))].sort();
  return (
    <div className="stack lg">
      <PageHead title={t('nav.hr_dashboard', 'HR dashboard')} subtitle={`${monthLabel(month)} · ${d.headcount} ${t('ui.employees', 'employees')}`} actions={<>
        <Button aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}>‹</Button>
        <Button aria-label="Next month" onClick={() => setMonth(shiftMonth(month, 1))}>›</Button>
        <Button icon="download" onClick={() => exportCsv('daily')}>{t('ui.csv_daily', 'CSV (daily)')}</Button>
        <Button icon="download" onClick={() => exportCsv('summary')}>{t('ui.csv_summary', 'CSV (summary)')}</Button>
        <Button icon="printer" onClick={() => window.print()}>{t('ui.pdf', 'PDF / print')}</Button>
        <Button kind="primary" icon="clock" onClick={() => setManual(true)}>{t('ui.record_attendance', 'Record attendance')}</Button></>} />
      {manual && <ManualAttendanceModal onClose={() => setManual(false)} onDone={reload} />}

      <Card title={`${t('ui.today', 'Today')} — ${fmtDay(d.today.date)}`}><TodayBoard board={d.today} /></Card>

      <div className="grid cols-2">
        <Card title={t('ui.attendance_by_dept', 'Attendance days by department')}>
          <StackedBars title="Attendance days by department" rows={d.departments} labelKey={{ key: 'department', label: t('ui.department', 'Department') }} unit=" d"
            series={[{ key: 'present', label: t('status.in_office', 'In office') }, { key: 'wfh', label: t('status.wfh', 'WFH') },
              { key: 'onLeave', label: t('status.on_leave', 'On leave') }, { key: 'absent', label: t('status.absent', 'Absent') }]} />
        </Card>
        <Card title={t('ui.pending_and_payroll', 'Approvals & payroll')}>
          <div className="grid stats">
            <Stat icon="calendar" label={t('ui.pending_leave', 'Pending leave')} value={d.pendingApprovals.leave} />
            <Stat icon="home" label={t('ui.pending_wfh', 'Pending WFH')} value={d.pendingApprovals.wfh} />
            <Stat icon="history" label={t('ui.pending_corrections', 'Corrections')} value={d.pendingApprovals.corrections} />
          </div>
          <h3 style={{ margin: '18px 0 8px' }}>{t('ui.payroll_status', 'Payroll')}</h3>
          {d.payroll.length === 0 ? <p className="muted small">{t('ui.no_payroll', 'No payroll runs yet (payroll arrives in Phase 4).')}</p> : (
            <table className="table"><tbody>{d.payroll.map((p) => <tr key={p.period_key}><td>{p.period_key}</td><td><StatusBadge status={p.status} /></td></tr>)}</tbody></table>
          )}
        </Card>
      </div>

      <Card title={t('ui.usage_by_dept', 'WFH and leave usage by department')} className="flush">
        <div className="table-wrap"><table className="table">
          <thead><tr><th>{t('ui.department', 'Department')}</th><th className="num">{t('ui.headcount', 'Headcount')}</th><th className="num">{t('ui.late', 'Late')}</th>
            <th className="num">{t('ui.missed_checkouts', 'Missed check-outs')}</th><th className="num">WFH</th>{leaveTypes.map((lt) => <th key={lt} className="num">{lt}</th>)}</tr></thead>
          <tbody>{d.departments.map((x) => (
            <tr key={x.department}><td>{x.department}</td><td className="num">{x.headcount}</td><td className="num">{x.late}</td><td className="num">{x.missedCheckout}</td>
              <td className="num">{x.wfhDays}</td>{leaveTypes.map((lt) => <td key={lt} className="num">{x.leaveDays[lt] ?? '—'}</td>)}</tr>
          ))}</tbody>
        </table></div>
      </Card>

      <Card title={t('ui.alerts', 'Alerts — last 14 days')} className="flush">
        {d.alerts.length === 0 ? <Empty>{t('ui.no_alerts', 'No unverified times or missed check-outs.')}</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{t('ui.date', 'Date')}</th><th>{t('ui.name', 'Name')}</th><th>{t('ui.issue', 'Issue')}</th><th>{t('ui.time', 'Time')}</th></tr></thead>
            <tbody>{d.alerts.map((a) => (
              <tr key={a.event_id}><td>{fmtDay(a.work_date)}</td><td>{a.name}</td>
                <td><span className={`badge ${a.kind === 'missed_checkout' ? 'bad' : 'warn'}`}>{a.kind === 'missed_checkout' ? t('flag.missed_checkout', 'Missed check-out') : t('flag.unverified_time', 'Unverified time')}</span></td>
                <td className="num">{a.time}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}
