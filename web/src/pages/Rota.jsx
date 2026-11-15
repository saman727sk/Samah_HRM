import { useState } from 'react';
import { get, post, put } from '../lib/api.js';
import { useApp } from '../lib/app.jsx';
import { fmtDate, todayIn } from '../lib/format.js';
import { useConfirm } from '../components/confirm.jsx';
import { PageHead } from '../components/Layout.jsx';
import { Alert, Button, Card, Empty, ErrorBox, Input, Loading, useLoad } from '../components/ui.jsx';

const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const key = (employeeId, date) => `${employeeId}|${date}`;
/** A cell's value as the select shows it: '' = usual shift, 'off', or a shift id. */
const cellValue = (e) => (!e ? '' : e.is_off ? 'off' : e.shift_id);

/**
 * Rota planner: a manager's people (HR: everyone) as rows, the 7 days of a week as columns.
 * Each cell: the person's usual shift, another shift, or Off. Saved together with "Save rota".
 */
export default function Rota() {
  const { t, tz, toast, isHr } = useApp();
  const confirm = useConfirm();
  const [week, setWeek] = useState(() => todayIn(tz));
  const [dept, setDept] = useState('');
  const [edits, setEdits] = useState({}); // key -> '' | 'off' | shiftId
  const [busy, setBusy] = useState(false);
  const { data: r, loading, error, reload } = useLoad(() => get(`/rota?week=${week}${dept ? `&departmentId=${dept}` : ''}`), [week, dept]);
  const { data: departments } = useLoad(() => (isHr ? get('/lookups/departments') : Promise.resolve([])), [isHr]);
  const dirty = Object.keys(edits).length;

  const go = async (n) => {
    if (dirty && !(await confirm({ title: 'Leave without saving?', message: `${dirty} changed ${dirty === 1 ? 'cell is' : 'cells are'} not saved yet.`, confirmLabel: 'Discard changes', danger: true }))) return;
    setEdits({});
    setWeek(n === 0 ? todayIn(tz) : addDays(r?.weekStart ?? week, 7 * n));
  };
  if (loading && !r) return <Loading />;
  if (error) return <ErrorBox error={error} />;

  const stored = new Map(r.entries.map((e) => [key(e.employee_id, e.date), e]));
  const shiftById = new Map(r.shifts.map((s) => [s.id, s]));
  const value = (p, d) => edits[key(p.id, d.date)] ?? cellValue(stored.get(key(p.id, d.date)));
  const setCell = (p, d, v) => {
    const k = key(p.id, d.date);
    const original = cellValue(stored.get(k));
    setEdits((cur) => {
      const next = { ...cur };
      if (v === original) delete next[k]; else next[k] = v;
      return next;
    });
  };
  const save = async () => {
    setBusy(true);
    try {
      const changes = Object.entries(edits).map(([k, v]) => {
        const [employeeId, date] = k.split('|');
        return { employeeId, date, ...(v === 'off' ? { off: true } : v ? { shiftId: v } : {}) };
      });
      const res = await put('/rota', { changes });
      toast(`Rota saved. ${res.changedPeople} ${res.changedPeople === 1 ? 'person was' : 'people were'} notified.`);
      setEdits({}); reload();
    } catch (e) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };
  const copyLastWeek = async () => {
    if (!(await confirm({ title: 'Copy last week\'s rota?', confirmLabel: 'Copy',
      message: `This week (${fmtDate(r.weekStart)} – ${fmtDate(r.weekEnd)}) becomes a copy of last week for the ${r.people.length} people shown. You can change it before and after.` }))) return;
    setBusy(true);
    try {
      const res = await post('/rota/copy', { fromWeek: addDays(r.weekStart, -7), toWeek: r.weekStart, departmentId: dept || null });
      toast(`Copied. ${res.changedPeople} ${res.changedPeople === 1 ? 'person' : 'people'} with changes were notified.`);
      setEdits({}); reload();
    } catch (e) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };
  const usual = (p) => shiftById.get(p.shift_id);
  const label = (s) => (s ? `${s.name}${s.start ? ` ${s.start}–${s.end}` : ''}` : 'No shift');
  const today = todayIn(tz);
  const activeShifts = r.shifts.filter((s) => s.is_active !== false);

  return (
    <div className="stack lg">
      <PageHead title={t('nav.rota', 'Rota')} subtitle={`${fmtDate(r.weekStart, { day: 'numeric', month: 'short' })} – ${fmtDate(r.weekEnd)} · ${r.people.length} ${r.people.length === 1 ? 'person' : 'people'}`}
        actions={<>
          <Button aria-label="Previous week" onClick={() => go(-1)}>‹</Button>
          <Button onClick={() => go(0)}>This week</Button>
          <Button aria-label="Next week" onClick={() => go(1)}>›</Button>
          <Button icon="refresh" disabled={busy || dirty > 0} title={dirty ? 'Save or discard your changes first' : ''} onClick={copyLastWeek}>Copy last week</Button>
          <Button kind="primary" icon="check" disabled={busy || !dirty} onClick={save}>{dirty ? `Save rota (${dirty})` : 'Saved'}</Button></>} />

      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="chips rota-legend">
          <span className="badge">Usual shift</span>
          {activeShifts.map((s) => <span key={s.id} className="badge info">{label(s)}</span>)}
          <span className="badge rota-off-badge">Off</span>
        </div>
        {isHr && (
          <div style={{ minWidth: 220 }}>
            <Input as="select" aria-label="Department" value={dept} onChange={(e) => { setEdits({}); setDept(e.target.value); }}>
              <option value="">All departments</option>
              {(departments ?? []).filter((d) => d.is_active !== false).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Input>
          </div>
        )}
      </div>
      {r.days.some((d) => d.locked) && <Alert kind="info">Days in an approved payroll period are locked and can't be changed.</Alert>}
      {activeShifts.length < 2 && <Alert kind="info">Only one shift exists. Add more (e.g. Morning, Evening, Night) under Settings &gt; Lists &amp; offices &gt; Shifts, then set their times under Policies &amp; rules.</Alert>}

      <Card className="flush">
        {r.people.length === 0 ? <Empty>{r.canPlanEveryone ? 'No active employees in this selection.' : 'Nobody reports to you yet.'}</Empty> : (
          <div className="table-wrap"><table className="table rota-grid">
            <thead><tr>
              <th>Person</th>
              {r.days.map((d) => (
                <th key={d.date} className={`${d.weekend ? 'is-weekend' : ''} ${d.date === today ? 'is-today' : ''}`}>
                  <div>{fmtDate(d.date, { weekday: 'short' })}</div><div className="rota-date">{fmtDate(d.date, { day: 'numeric', month: 'short' })}</div>
                  {d.holiday && <div className="rota-holiday" title={d.holiday}>{d.holiday}</div>}
                </th>
              ))}
            </tr></thead>
            <tbody>{r.people.map((p) => (
              <tr key={p.id}>
                <td className="rota-person"><strong>{p.full_name}</strong><div className="small muted">{[p.role, p.department].filter(Boolean).join(' · ') || p.employee_code}</div>
                  <div className="small muted" title={label(usual(p))}>Usual: {usual(p)?.name ?? 'no shift'}</div></td>
                {r.days.map((d) => {
                  const v = value(p, d);
                  const changed = key(p.id, d.date) in edits;
                  const kind = v === 'off' ? 'off' : v ? 'shift' : d.weekend ? 'rest' : 'usual';
                  return (
                    <td key={d.date} className={`rota-cell ${kind} ${changed ? 'changed' : ''} ${d.weekend ? 'is-weekend' : ''}`}>
                      <select className="input" aria-label={`${p.full_name}, ${fmtDate(d.date, { weekday: 'long', day: 'numeric', month: 'long' })}`}
                        value={v} disabled={d.locked} onChange={(e) => setCell(p, d, e.target.value)}>
                        <option value="">{d.weekend ? 'Weekend' : 'Usual'}</option>
                        {r.shifts.filter((s) => s.is_active !== false || s.id === v).map((s) => <option key={s.id} value={s.id} title={label(s)}>{s.name}</option>)}
                        <option value="off">Off</option>
                      </select>
                    </td>
                  );
                })}
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <p className="small muted" style={{ margin: 0 }}>
        The rota shift is used for attendance that day (late and half day are judged against it). Off is a rest day, like a weekend.
        People are notified when their rota changes{r.canPlanEveryone ? '' : '; you can plan everyone who reports to you, directly or through their managers'}.
      </p>
    </div>
  );
}
