import { useState } from 'react';
import { get, qs } from '../lib/api.js';
import { useApp } from '../lib/app.jsx';
import { fmtTime, monthLabel, monthOf, shiftMonth, todayIn, WEEKDAYS } from '../lib/format.js';
import { PageHead } from '../components/Layout.jsx';
import { Button, Card, Empty, ErrorBox, Flags, Loading, Stat, StatusBadge, useLoad } from '../components/ui.jsx';
import { ManualAttendanceModal } from '../components/ManualAttendance.jsx';

export function TodayBoard({ board }) {
  const { t, tz } = useApp();
  return (
    <div className="stack">
      <div className="grid stats">
        <Stat label={t('status.in_office', 'In office')} value={board.counts.present} />
        <Stat label={t('status.wfh', 'Work from home')} value={board.counts.wfh} />
        <Stat label={t('status.on_leave', 'On leave')} value={board.counts.on_leave} />
        <Stat label={t('status.absent', 'Absent')} value={board.counts.absent} />
        <Stat label={t('ui.not_yet_in', 'Not yet in')} value={board.counts.not_yet} />
        <Stat label={t('ui.late', 'Late')} value={board.counts.late} />
      </div>
      <div className="table-wrap"><table className="table">
        <thead><tr><th>{t('ui.name', 'Name')}</th><th>{t('ui.department', 'Department')}</th><th>{t('ui.status', 'Status')}</th><th>{t('ui.first_in', 'First in')}</th><th>{t('ui.flags', 'Notes')}</th></tr></thead>
        <tbody>{board.people.map((p) => (
          <tr key={p.employeeId}><td>{p.name}</td><td className="muted">{p.department}</td><td><StatusBadge status={p.status} />{p.leave && <span className="small muted"> {p.leave}</span>}</td>
            <td className="num">{fmtTime(p.firstIn, tz)}</td><td><Flags flags={p.flags} /></td></tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}

/** Employees × days grid; leave = L (dashed while pending), WFH = W; clash days marked in the header. */
export function TeamCalendar({ cal }) {
  const { t } = useApp();
  const days = [];
  for (let d = new Date(`${cal.from}T00:00:00Z`); d.toISOString().slice(0, 10) <= cal.to; d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10));
  const clash = new Set(cal.clashDates.map((c) => c.date));
  const cell = (e, date) => {
    const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
    const leave = e.leave.find((l) => l.start_date <= date && l.end_date >= date);
    if (leave) return <td key={date} className={`leave ${leave.status === 'pending' ? 'pending' : ''}`} title={`${leave.leave_type} (${leave.status})`}>L</td>;
    const w = e.wfh.find((x) => x.date === date);
    if (w) return <td key={date} className="wfh" title={`WFH (${w.status})`}>W</td>;
    return <td key={date} className={wd === 0 || wd === 6 ? 'off' : ''} />;
  };
  return (
    <div className="stack">
      <div className="table-wrap"><table className="team-cal">
        <thead><tr><th />{days.map((d) => <th key={d} className={clash.has(d) ? 'clash' : ''} title={clash.has(d) ? t('ui.clash', 'Many people off') : undefined}>
          {Number(d.slice(8))}<br />{WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()][0]}</th>)}</tr></thead>
        <tbody>{cal.employees.map((e) => <tr key={e.id}><th className="name">{e.name}</th>{days.map((d) => cell(e, d))}</tr>)}</tbody>
      </table></div>
      <div className="legend"><span><i style={{ background: 'var(--violet-soft)', outline: '1px solid var(--violet)' }} />L = {t('status.on_leave', 'On leave')}</span>
        <span><i style={{ outline: '1px dashed var(--violet)' }} />{t('ui.pending_leave', 'Pending leave')}</span>
        <span><i style={{ background: 'var(--info-soft)', outline: '1px solid var(--info)' }} />W = {t('status.wfh', 'Work from home')}</span>
        {cal.clashDates.length > 0 && <span style={{ color: 'var(--bad)' }}>{t('ui.clash_note', 'Red dates: {n}+ people off', { n: cal.clashThreshold })}</span>}</div>
    </div>
  );
}

export default function Team() {
  const { t, tz, session } = useApp();
  const [month, setMonth] = useState(monthOf(todayIn(tz)));
  const [manual, setManual] = useState(false);
  const { data, error, loading, reload } = useLoad(() => get(`/dashboard/manager${qs({ month })}`), [month]);
  const modules = session.modules ?? [];
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  return (
    <div className="stack lg">
      <PageHead title={t('nav.team', 'Team dashboard')} actions={<>
        {modules.includes('attendance') && data.team.people.length > 0 && <Button icon="clock" onClick={() => setManual(true)}>{t('ui.record_attendance', 'Record attendance')}</Button>}
        {modules.includes('tasks') && <a className="btn" href="#/tasks?scope=team">{t('ui.work_reports', 'Work reports')}</a>}
        <a className="btn primary" href="#/approvals">{t('nav.approvals', 'Approvals')} ({data.approvals.length})</a></>} />
      {manual && <ManualAttendanceModal onClose={() => setManual(false)} onDone={reload} />}
      <Card title={t('ui.team_today', 'Team today')}>{data.team.people.length ? <TodayBoard board={data.team} /> : <Empty>{t('ui.no_team', 'Nobody reports to you yet.')}</Empty>}</Card>
      <Card title={`${t('ui.team_calendar', 'Team calendar')} — ${monthLabel(month)}`} actions={<>
        <Button size="sm" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}>‹</Button>
        <Button size="sm" aria-label="Next month" onClick={() => setMonth(shiftMonth(month, 1))}>›</Button></>}>
        <TeamCalendar cal={data.calendar} />
      </Card>
    </div>
  );
}
