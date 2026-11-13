import { useEffect, useState } from 'react';
import { get, post } from '../lib/api.js';
import { useApp } from '../lib/app.jsx';
import { fmtDate, hm, todayIn, WEEKDAYS } from '../lib/format.js';
import { useConfirm } from '../components/confirm.jsx';
import { PageHead } from '../components/Layout.jsx';
import { BalanceTable } from './MyDashboard.jsx';
import { Alert, Button, Card, Empty, ErrorBox, Input, Loading, StatusBadge, Tabs, useLoad } from '../components/ui.jsx';

/** Debounced live policy check while the form is being filled. */
function useLiveCheck(path, body, ready) {
  const [state, setState] = useState({ result: null, error: null, checking: false });
  const key = JSON.stringify(body);
  useEffect(() => {
    if (!ready) { setState({ result: null, error: null, checking: false }); return; }
    setState((s) => ({ ...s, checking: true }));
    const id = setTimeout(() => post(path, body).then((result) => setState({ result, error: null, checking: false }))
      .catch((error) => setState({ result: null, error, checking: false })), 350);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, key, ready]);
  return state;
}

function CustomFieldInputs({ entity, values, onChange }) {
  const { data: fields } = useLoad(() => get('/lookups/custom-fields'), []);
  const list = (fields ?? []).filter((f) => f.entity === entity && f.is_active);
  if (!list.length) return null;
  return list.map((f) => {
    const v = values[f.field_key] ?? '';
    const set = (x) => onChange({ ...values, [f.field_key]: x === '' ? undefined : x });
    if (f.field_type === 'dropdown') {
      return <Input key={f.id} as="select" label={`${f.label}${f.required ? ' *' : ''}`} value={v} onChange={(e) => set(e.target.value)}>
        <option value="">—</option>{f.options.map((o) => <option key={o}>{o}</option>)}</Input>;
    }
    return <Input key={f.id} label={`${f.label}${f.required ? ' *' : ''}`} type={f.field_type === 'number' ? 'number' : f.field_type === 'date' ? 'date' : 'text'}
      value={v} onChange={(e) => set(f.field_type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)} />;
  });
}

function LeaveForm({ onSubmitted }) {
  const { t, toast } = useApp();
  const { data: types } = useLoad(() => get('/leave/types'), []);
  const [f, setF] = useState({ leaveTypeId: '', startDate: '', endDate: '', unit: 'day', reason: '', attachmentRef: '', customFields: {} });
  const set = (k) => (e) => setF({ ...f, [k]: e.target ? e.target.value : e });
  const body = { leaveTypeId: f.leaveTypeId, startDate: f.startDate, endDate: f.unit === 'day' ? (f.endDate || f.startDate) : f.startDate, unit: f.unit,
    hours: f.unit === 'hour' ? Number(f.hours) : undefined, attachmentRef: f.attachmentRef || undefined };
  const live = useLiveCheck('/leave/check', body, !!(f.leaveTypeId && f.startDate));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await post('/leave/requests', { ...body, reason: f.reason, customFields: f.customFields });
      toast(r.workflow.status === 'approved' ? t('ui.leave_auto_approved', 'Leave approved automatically.') : t('ui.leave_submitted', 'Leave request sent for approval.'));
      setF({ ...f, startDate: '', endDate: '', reason: '' });
      onSubmitted();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const r = live.result;
  return (
    <form className="stack" onSubmit={submit}>
      <div className="form-grid">
        <Input as="select" label={t('ui.leave_type', 'Leave type')} value={f.leaveTypeId} onChange={set('leaveTypeId')} required>
          <option value="">{t('ui.choose', 'Choose…')}</option>
          {(types ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </Input>
        <Input as="select" label={t('ui.duration', 'Duration')} value={f.unit} onChange={set('unit')}>
          <option value="day">{t('ui.full_days', 'Full day(s)')}</option>
          <option value="half_day">{t('ui.half_day', 'Half day')}</option>
          <option value="hour">{t('ui.hours', 'Hours')}</option>
        </Input>
        <Input label={t('ui.from', 'From')} type="date" value={f.startDate} onChange={set('startDate')} required />
        {f.unit === 'day' ? <Input label={t('ui.to', 'To')} type="date" value={f.endDate} min={f.startDate} onChange={set('endDate')} />
          : f.unit === 'hour' ? <Input label={t('ui.hours', 'Hours')} type="number" min="0.5" step="0.5" value={f.hours ?? ''} onChange={set('hours')} /> : <div />}
      </div>
      <Input as="textarea" label={t('ui.reason', 'Reason')} value={f.reason} onChange={set('reason')} />
      {r?.requiresCertificate && <Input label={t('ui.certificate', 'Medical certificate (file reference)')} help={t('ui.certificate_help', 'File upload arrives with the mobile app; paste a reference for now.')} value={f.attachmentRef} onChange={set('attachmentRef')} />}
      <div className="form-grid"><CustomFieldInputs entity="leave_request" values={f.customFields} onChange={(v) => setF({ ...f, customFields: v })} /></div>
      {live.checking && <div className="small muted">{t('ui.checking', 'Checking the policy…')}</div>}
      {r && (r.allowed
        ? <Alert kind="good" title={`${r.days} ${t('ui.days_counted', 'day(s) will be counted')}${r.unpaidDays ? ` (${r.unpaidDays} ${t('ui.unpaid', 'unpaid')})` : ''}`}
          items={[...r.warnings.map((w) => w.message), ...(r.balance ? [`${t('ui.available_after', 'Available after this')}: ${Math.max(0, r.balance.available - r.paidDays)}`] : [])]} />
        : <Alert kind="bad" title={t('ui.not_allowed', 'This request breaks the policy')} items={r.reasons.map((x) => x.message)} />)}
      <ErrorBox error={live.error ?? error} />
      <div><Button kind="primary" type="submit" disabled={busy || (r && !r.allowed)}>{t('ui.send_request', 'Send request')}</Button></div>
    </form>
  );
}

function WfhForm({ onSubmitted }) {
  const { t, toast } = useApp();
  const [mode, setMode] = useState('dates');
  const [dates, setDates] = useState([]);
  const [pick, setPick] = useState('');
  const [rec, setRec] = useState({ startDate: '', endDate: '', weekdays: [1] });
  const [reason, setReason] = useState('');
  const body = mode === 'dates' ? { dates } : { recurrence: rec };
  const ready = mode === 'dates' ? dates.length > 0 : !!(rec.startDate && rec.endDate && rec.weekdays.length);
  const live = useLiveCheck('/wfh/check', body, ready);
  const [error, setError] = useState(null);
  const addDate = () => { if (pick && !dates.includes(pick)) setDates([...dates, pick].sort()); setPick(''); };
  const submit = async (e) => {
    e.preventDefault(); setError(null);
    try {
      const r = await post('/wfh/requests', { ...body, reason });
      toast(r.status === 'approved' ? t('ui.wfh_approved', 'WFH approved.') : t('ui.wfh_submitted', 'WFH request sent for approval.'));
      setDates([]); setReason(''); onSubmitted();
    } catch (err) { setError(err); }
  };
  const r = live.result;
  return (
    <form className="stack" onSubmit={submit}>
      <Tabs value={mode} onChange={setMode} tabs={[{ value: 'dates', label: t('ui.specific_dates', 'Specific dates') }, { value: 'recurring', label: t('ui.weekly_pattern', 'Weekly pattern') }]} />
      {mode === 'dates' ? (
        <div className="stack">
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <Input label={t('ui.add_date', 'Add a date')} type="date" value={pick} onChange={(e) => setPick(e.target.value)} />
            <Button onClick={addDate} disabled={!pick}>{t('ui.add', 'Add')}</Button>
          </div>
          <div className="chips">{dates.map((d) => <button type="button" key={d} className="chip" aria-pressed="true" onClick={() => setDates(dates.filter((x) => x !== d))} aria-label={`Remove ${d}`}>{fmtDate(d)} ✕</button>)}</div>
        </div>
      ) : (
        <div className="form-grid">
          <Input label={t('ui.from', 'From')} type="date" value={rec.startDate} onChange={(e) => setRec({ ...rec, startDate: e.target.value })} />
          <Input label={t('ui.to', 'To')} type="date" value={rec.endDate} onChange={(e) => setRec({ ...rec, endDate: e.target.value })} />
          <div className="field"><span className="field-label">{t('ui.weekdays', 'Every')}</span>
            <div className="chips">{[1, 2, 3, 4, 5, 6, 0].map((d) => <button type="button" key={d} className="chip" aria-pressed={rec.weekdays.includes(d)}
              onClick={() => setRec({ ...rec, weekdays: rec.weekdays.includes(d) ? rec.weekdays.filter((x) => x !== d) : [...rec.weekdays, d] })}>{WEEKDAYS[d]}</button>)}</div></div>
        </div>
      )}
      <Input label={t('ui.reason', 'Reason')} value={reason} onChange={(e) => setReason(e.target.value)} />
      {r && (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>{t('ui.date', 'Date')}</th><th>{t('ui.result', 'Result')}</th><th className="num">{t('ui.week_left', 'Left this week')}</th><th className="num">{t('ui.month_left', 'Left this month')}</th></tr></thead>
          <tbody>{r.results.map((x) => (
            <tr key={x.date}><td>{fmtDate(x.date)}</td>
              <td>{x.allowed ? <span className="badge good">{x.coveredByOverride ? t('ui.override', 'Covered by override') : t('ui.ok', 'OK')}</span> : x.reasons.map((y) => <div key={y.code} className="small" style={{ color: 'var(--bad)' }}>{y.message}</div>)}</td>
              <td className="num">{x.quota.week.remaining}/{x.quota.week.max}</td><td className="num">{x.quota.month.remaining}/{x.quota.month.max}</td></tr>
          ))}</tbody>
        </table></div>
      )}
      <ErrorBox error={live.error ?? error} />
      <div><Button kind="primary" type="submit" disabled={!ready || (r && !r.ok)}>{t('ui.send_request', 'Send request')}</Button></div>
    </form>
  );
}

/** Claim overtime the attendance engine recorded; approval follows the overtime workflow. */
function OvertimeForm({ onSubmitted }) {
  const { t, toast, tz } = useApp();
  const [date, setDate] = useState('');
  const [minutes, setMinutes] = useState(null); // null: claim everything attendance recorded
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const { data: day } = useLoad(() => (date ? get(`/attendance/days?from=${date}&to=${date}`).then((d) => d[0]) : Promise.resolve(null)), [date]);
  const { data: claims, reload } = useLoad(() => get('/overtime/claims'), []);
  const mine = (claims ?? []).slice(0, 8);
  const submit = async (e) => {
    e.preventDefault(); setError(null);
    try {
      await post('/overtime/claims', { workDate: date, minutes: minutes ? Number(minutes) : undefined, reason: reason || null });
      setMinutes(null);
      toast(t('ui.overtime_submitted', 'Overtime claim sent for approval.'));
      setDate(''); setReason(''); reload(); onSubmitted();
    } catch (err) { setError(err); }
  };
  const confirm = useConfirm();
  const cancel = async (id) => {
    if (!(await confirm({ title: 'Cancel this overtime claim?', message: 'It is withdrawn from approval. You can submit a new claim later.', confirmLabel: 'Cancel claim', cancelLabel: 'Keep it' }))) return;
    try { await post(`/overtime/claims/${id}/cancel`, {}); reload(); } catch (err) { toast(err.message, 'bad'); }
  };
  return (
    <div className="stack">
      <form className="stack" onSubmit={submit}>
        <div className="form-grid">
          <Input label={t('ui.date', 'Date')} type="date" max={todayIn(tz)} value={date} onChange={(e) => { setDate(e.target.value); setMinutes(null); }} required />
          <Input label={t('ui.minutes', 'Minutes to claim')} type="number" min="1" max={day?.overtimeMinutes || undefined}
            value={minutes ?? (day?.overtimeMinutes || '')} onChange={(e) => setMinutes(e.target.value)} />
        </div>
        {day && (day.overtimeMinutes > 0
          ? <Alert kind="info">{t('ui.overtime_recorded', 'Attendance recorded {time} of overtime that day.', { time: hm(day.overtimeMinutes) })}</Alert>
          : <Alert kind="warn">{t('ui.no_overtime_recorded', 'No overtime was recorded that day.')}</Alert>)}
        <Input label={t('ui.reason', 'Reason')} value={reason} onChange={(e) => setReason(e.target.value)} />
        <ErrorBox error={error} />
        <div><Button kind="primary" type="submit" disabled={!date || !(day?.overtimeMinutes > 0)}>{t('ui.send_request', 'Send request')}</Button></div>
      </form>
      {mine.length > 0 && (
        <table className="table"><tbody>{mine.map((c) => (
          <tr key={c.id}><td>{fmtDate(c.work_date)}</td><td className="num">{hm(c.minutes)}</td><td><StatusBadge status={c.status} /></td>
            <td>{c.status === 'pending' && <Button size="sm" onClick={() => cancel(c.id)}>{t('ui.cancel', 'Cancel')}</Button>}</td></tr>
        ))}</tbody></table>
      )}
    </div>
  );
}

export default function Requests() {
  const { t, toast, session } = useApp();
  const [tab, setTab] = useState('leave');
  const overtimeOn = session.modules?.includes('overtime');
  const { data, loading, error, reload } = useLoad(() => get('/dashboard/employee'), []);
  const confirm = useConfirm();
  const cancel = async (kind, id) => {
    const what = kind === 'leave' ? 'leave request' : 'WFH request';
    if (!(await confirm({ title: `Cancel this ${what}?`, confirmLabel: 'Cancel request', cancelLabel: 'Keep it',
      message: kind === 'leave' ? 'If it was approved, the days go back to your balance. Your manager is told.' : 'If it was approved, those days become office days again.' }))) return;
    try {
      await post(kind === 'leave' ? `/leave/requests/${id}/cancel` : `/wfh/requests/${id}/cancel`, {});
      toast(t('ui.cancelled', 'Request cancelled.')); reload();
    } catch (err) { toast(err.message, 'bad'); }
  };
  return (
    <div className="stack lg">
      <PageHead title={t('nav.requests', 'Leave & WFH')} subtitle={t('ui.requests_sub', 'Apply, see live policy checks, and track your requests.')} />
      <div className="grid cols-2">
        <Card>
          <Tabs value={tab} onChange={setTab} tabs={[{ value: 'leave', label: t('ui.apply_leave', 'Apply for leave') }, { value: 'wfh', label: t('ui.request_wfh', 'Request WFH') },
            ...(overtimeOn ? [{ value: 'overtime', label: t('ui.claim_overtime', 'Claim overtime') }] : [])]} />
          {tab === 'leave' ? <LeaveForm onSubmitted={reload} /> : tab === 'wfh' ? <WfhForm onSubmitted={reload} /> : <OvertimeForm onSubmitted={reload} />}
        </Card>
        <div className="stack lg">
          {loading && !data ? <Loading /> : error ? <ErrorBox error={error} /> : <>
            <Card title={t('ui.leave_balances', 'Leave balances')}><BalanceTable balances={data.balances} /></Card>
            <Card title={t('ui.my_requests', 'My requests')}>
              {data.leaveRequests.length + data.wfhRequests.length === 0 ? <Empty>{t('ui.no_requests', 'No requests yet.')}</Empty> : (
                <div className="table-wrap"><table className="table"><tbody>
                  {data.leaveRequests.map((r) => <tr key={r.id}><td>{r.leave_type}</td><td>{fmtDate(r.start_date)}{r.end_date !== r.start_date ? ` – ${fmtDate(r.end_date)}` : ''}</td>
                    <td className="num">{r.days}d</td><td><StatusBadge status={r.status} /></td>
                    <td>{['pending', 'approved'].includes(r.status) && <Button size="sm" onClick={() => cancel('leave', r.id)}>{t('ui.cancel', 'Cancel')}</Button>}</td></tr>)}
                  {data.wfhRequests.map((r) => <tr key={r.id}><td>WFH</td><td>{fmtDate(r.start_date)}{r.end_date !== r.start_date ? ` – ${fmtDate(r.end_date)}` : ''}</td>
                    <td className="num">{r.days}d</td><td><StatusBadge status={r.status} /></td>
                    <td>{['pending', 'approved'].includes(r.status) && <Button size="sm" onClick={() => cancel('wfh', r.id)}>{t('ui.cancel', 'Cancel')}</Button>}</td></tr>)}
                </tbody></table></div>
              )}
            </Card>
          </>}
        </div>
      </div>
    </div>
  );
}
