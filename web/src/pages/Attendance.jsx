import { useState } from 'react';
import { get, post, qs } from '../lib/api.js';
import { useApp } from '../lib/app.jsx';
import { fmtDay, fmtTime, hm, monthEnd, monthLabel, monthOf, shiftMonth, todayIn } from '../lib/format.js';
import { PageHead } from '../components/Layout.jsx';
import { Button, Card, ErrorBox, Flags, Input, Loading, Modal, StatusBadge, useLoad } from '../components/ui.jsx';

function CorrectionModal({ day, onClose, onDone }) {
  const { t, tz, toast } = useApp();
  const [type, setType] = useState(day.lastOut ? 'out' : 'in');
  const [time, setTime] = useState(type === 'in' ? (day.shift?.start ?? '09:00') : (day.shift?.end ?? '18:00'));
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const submit = async () => {
    setError(null);
    try {
      // The chosen wall-clock time is in the company's timezone.
      const offset = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(new Date(`${day.date}T12:00:00Z`))
        .find((p) => p.type === 'timeZoneName').value.replace('GMT', '') || '+00:00';
      await post('/attendance/corrections', { workDate: day.date, eventType: type, correctedTime: `${day.date}T${time}:00${offset}`, reason });
      toast(t('ui.correction_sent', 'Correction sent for approval.'));
      onDone();
    } catch (err) { setError(err); }
  };
  return (
    <Modal title={`${t('ui.correct_time', 'Correct a time')} — ${fmtDay(day.date)}`} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('ui.cancel', 'Cancel')}</Button><Button kind="primary" disabled={!reason.trim()} onClick={submit}>{t('ui.send', 'Send')}</Button></>}>
      <div className="stack">
        <p className="small muted">{t('ui.correction_help', 'Your original punches stay on record. An approved correction is added as a new entry.')}</p>
        <p className="small">{t('ui.recorded', 'Recorded')}: {fmtTime(day.firstIn, tz)} – {fmtTime(day.lastOut, tz)}</p>
        <div className="form-grid">
          <Input as="select" label={t('ui.which', 'Which time')} value={type} onChange={(e) => setType(e.target.value)}>
            <option value="in">{t('ui.check_in', 'Check-in')}</option><option value="out">{t('ui.check_out', 'Check-out')}</option>
          </Input>
          <Input label={t('ui.correct_time_label', 'Correct time')} type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </div>
        <Input as="textarea" label={t('ui.reason', 'Reason')} value={reason} onChange={(e) => setReason(e.target.value)} required />
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

export default function Attendance() {
  const { t, tz } = useApp();
  const today = todayIn(tz);
  const [month, setMonth] = useState(monthOf(today));
  const [editing, setEditing] = useState(null);
  const from = `${month}-01`;
  const to = monthEnd(month) < today ? monthEnd(month) : today;
  const { data, error, loading, reload } = useLoad(() => (from > today ? Promise.resolve([]) : get(`/attendance/days${qs({ from, to })}`)), [month]);
  const { data: corrections, reload: reloadCorr } = useLoad(() => get('/attendance/corrections'), []);
  return (
    <div className="stack lg">
      <PageHead title={t('nav.attendance', 'My attendance')} subtitle={monthLabel(month)} actions={<>
        <Button onClick={() => setMonth(shiftMonth(month, -1))}>‹ {t('ui.previous', 'Previous')}</Button>
        <Button onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= monthOf(today)}>{t('ui.next', 'Next')} ›</Button></>} />
      <Card className="flush">
        {loading && !data ? <Loading /> : error ? <ErrorBox error={error} /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{t('ui.date', 'Date')}</th><th>{t('ui.status', 'Status')}</th><th>{t('ui.in', 'In')}</th><th>{t('ui.out', 'Out')}</th>
              <th className="num">{t('ui.worked', 'Worked')}</th><th className="num">{t('ui.late', 'Late')}</th><th>{t('ui.flags', 'Notes')}</th><th /></tr></thead>
            <tbody>
              {[...data].reverse().map((d) => (
                <tr key={d.date}>
                  <td>{fmtDay(d.date)}</td><td><StatusBadge status={d.status} />{d.leave && <span className="small muted"> {d.leave.name}</span>}</td>
                  <td className="num">{fmtTime(d.firstIn, tz)}</td><td className="num">{fmtTime(d.lastOut, tz)}</td>
                  <td className="num">{d.workedMinutes ? hm(d.workedMinutes) : '—'}</td><td className="num">{d.lateMinutes ? `${d.lateMinutes}m` : '—'}</td>
                  <td><Flags flags={d.flags} /></td>
                  <td>{['present', 'wfh', 'absent'].includes(d.status) && <Button size="sm" onClick={() => setEditing(d)}>{t('ui.correct', 'Correct')}</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>
      {corrections?.length > 0 && (
        <Card title={t('ui.my_corrections', 'My correction requests')}>
          <table className="table"><tbody>{corrections.map((c) => (
            <tr key={c.id}><td>{fmtDay(c.work_date)}</td><td>{c.event_type === 'in' ? t('ui.check_in', 'Check-in') : t('ui.check_out', 'Check-out')} → {fmtTime(c.corrected_time, tz)}</td>
              <td className="small muted">{c.reason}</td><td><StatusBadge status={c.status} /></td></tr>
          ))}</tbody></table>
        </Card>
      )}
      {editing && <CorrectionModal day={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload(); reloadCorr(); }} />}
    </div>
  );
}
