/**
 * HR: an employee's salary history (effective-dated revisions), bank
 * details for the transfer file, and loans / advances with their schedule.
 */
import { useState } from 'react';
import { del, get, post, put, qs } from '../lib/api.js';
import { navigate, useApp } from '../lib/app.jsx';
import { fmtDate, fmtMoney, monthLabel, shiftMonth, todayIn } from '../lib/format.js';
import { useConfirm } from '../components/confirm.jsx';
import { PageHead } from '../components/Layout.jsx';
import { Alert, Button, Card, Empty, ErrorBox, Input, Loading, Modal, StatusBadge, useLoad } from '../components/ui.jsx';

const total = (lines) => lines.filter((l) => l.kind === 'earning').reduce((s, l) => s + l.amount, 0);

function RevisionForm({ employeeId, current, components, frozenUntil, onDone, onClose }) {
  const { toast } = useApp();
  const minDate = frozenUntil ? new Date(Date.parse(`${frozenUntil}T00:00:00Z`) + 86400000).toISOString().slice(0, 10) : undefined;
  const [from, setFrom] = useState(minDate ?? '');
  const [amounts, setAmounts] = useState(() => Object.fromEntries((current?.lines ?? []).map((l) => [l.code, l.amount])));
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  const save = async () => {
    setError(null);
    try {
      const lines = Object.fromEntries(Object.entries(amounts).filter(([, v]) => v !== '' && v != null));
      await post(`/payroll/employees/${employeeId}/salary`, { effectiveFrom: from, lines, note: note || null });
      toast('Salary revision saved.'); onDone();
    } catch (err) { setError(err); }
  };
  return (
    <Modal title="New salary revision" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={!from} onClick={save}>Save revision</Button></>}>
      <div className="stack">
        <Input label="Effective from" type="date" min={minDate} value={from} onChange={(e) => setFrom(e.target.value)}
          help={frozenUntil ? `Payroll is approved/locked up to ${fmtDate(frozenUntil)}, so the earliest date is ${fmtDate(minDate)}. A revision starting mid-month is pro-rated by days.` : 'A revision starting mid-month is pro-rated by days.'} />
        <div className="form-grid">
          {components.map((c) => (
            <Input key={c.code} label={`${c.name} (${c.code})`} type="number" min="0" step="any" value={amounts[c.code] ?? ''}
              onChange={(e) => setAmounts({ ...amounts, [c.code]: e.target.value === '' ? '' : Number(e.target.value) })} />
          ))}
        </div>
        <Input label="Note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Annual increment 2026" />
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

function BankForm({ employeeId, payment, onDone }) {
  const { toast } = useApp();
  const [f, setF] = useState({ bankName: payment?.bank_name ?? '', accountTitle: payment?.account_title ?? '', iban: payment?.iban ?? '' });
  const [error, setError] = useState(null);
  const save = async (e) => {
    e.preventDefault(); setError(null);
    try { await put(`/payroll/employees/${employeeId}/payment`, f); toast('Bank details saved.'); onDone(); } catch (err) { setError(err); }
  };
  return (
    <form className="stack" onSubmit={save}>
      <div className="form-grid">
        <Input label="Bank" value={f.bankName} onChange={(e) => setF({ ...f, bankName: e.target.value })} />
        <Input label="Account title" value={f.accountTitle} onChange={(e) => setF({ ...f, accountTitle: e.target.value })} />
      </div>
      <Input label="IBAN" value={f.iban} className="input mono" onChange={(e) => setF({ ...f, iban: e.target.value })} placeholder="PK36SCBL0000001123456702"
        help="Checked with the IBAN checksum. Only HR and payroll exports can read it." />
      <ErrorBox error={error} />
      <div><Button kind="primary" type="submit">Save bank details</Button></div>
    </form>
  );
}

function LoanForm({ employeeId, onDone, onClose }) {
  const { tz, toast } = useApp();
  const [f, setF] = useState({ kind: 'loan', principal: '', installmentAmount: '', startPeriod: shiftMonth(todayIn(tz).slice(0, 7), 1), note: '' });
  const [error, setError] = useState(null);
  const n = f.principal && f.installmentAmount ? Math.ceil(Number(f.principal) / Number(f.installmentAmount)) : null;
  const save = async () => {
    setError(null);
    try {
      await post('/payroll/loans', { employeeId, kind: f.kind, principal: Number(f.principal), installmentAmount: Number(f.installmentAmount), startPeriod: f.startPeriod, note: f.note || null });
      toast('Loan added. Installments will be deducted in payroll.'); onDone();
    } catch (err) { setError(err); }
  };
  return (
    <Modal title="New loan or advance" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" onClick={save} disabled={!f.principal || !f.installmentAmount}>Add</Button></>}>
      <div className="stack">
        <div className="form-grid">
          <Input as="select" label="Type" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="loan">Loan</option><option value="advance">Salary advance</option></Input>
          <Input label="First deduction month" type="month" value={f.startPeriod} onChange={(e) => setF({ ...f, startPeriod: e.target.value })} />
          <Input label="Amount given" type="number" min="1" value={f.principal} onChange={(e) => setF({ ...f, principal: e.target.value })} />
          <Input label="Monthly installment" type="number" min="1" value={f.installmentAmount} onChange={(e) => setF({ ...f, installmentAmount: e.target.value })} />
        </div>
        {n && <Alert kind="info">{n} monthly installment{n === 1 ? '' : 's'}, from {monthLabel(f.startPeriod)} to {monthLabel(shiftMonth(f.startPeriod, n - 1))}.</Alert>}
        <Input label="Note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

function Loans({ employeeId, loans, loansOn, onChange }) {
  const { toast } = useApp();
  const [adding, setAdding] = useState(false);
  const confirm = useConfirm();
  const run = (p) => p.then(() => onChange()).catch((err) => toast(err.message, 'bad'));
  const stop = async (l) => {
    if (await confirm({ title: 'Stop this loan?', danger: true, confirmLabel: 'Stop loan', cancelLabel: 'Keep it',
      message: 'No more installments will be deducted. Amounts already deducted stay recovered; the rest is no longer collected through payroll.' })) run(post(`/payroll/loans/${l.id}/cancel`, {}));
  };
  const skip = async (i) => {
    if (await confirm({ title: `Skip the ${i.period_key} installment?`, confirmLabel: 'Skip it',
      message: 'Nothing is deducted that month; the schedule moves one month later.' })) run(post(`/payroll/loan-installments/${i.id}/skip`, {}));
  };
  return (
    <Card title="Loans & advances" actions={loansOn && <Button size="sm" icon="plus" onClick={() => setAdding(true)}>New</Button>}>
      {!loansOn && <Alert kind="info">The Loans module is switched off (Settings → Modules), so nothing is deducted.</Alert>}
      {loans.length === 0 ? <Empty>No loans or advances.</Empty> : loans.map((l) => (
        <div key={l.id} className="stack" style={{ gap: 6, paddingBottom: 12, marginBottom: 12, borderBottom: '1px solid var(--border)' }}>
          <div className="row between">
            <div><strong>{l.kind === 'advance' ? 'Salary advance' : 'Loan'}</strong> {fmtMoney(l.principal)} · {fmtMoney(l.installment_amount)}/month <StatusBadge status={l.status} /></div>
            <div className="row">
              <span className="small muted">Recovered {fmtMoney(l.recovered)} · left {fmtMoney(l.outstanding)}</span>
              {l.status === 'active' && <Button size="sm" kind="danger" onClick={() => stop(l)}>Stop</Button>}
            </div>
          </div>
          <div className="chips">
            {l.installments.map((i) => (
              <span key={i.id} className={`badge ${i.status === 'deducted' ? 'good' : ''}`} title={i.status}>
                {i.period_key}: {fmtMoney(i.amount)} {i.status === 'deducted' ? '✓' : i.status === 'skipped' ? '(skipped)' : ''}
                {i.status === 'scheduled' && l.status === 'active' && <button type="button" className="link small" onClick={() => skip(i)} aria-label={`Skip ${i.period_key}`}>skip</button>}
              </span>
            ))}
          </div>
          {l.note && <div className="small muted">{l.note}</div>}
        </div>
      ))}
      {adding && <LoanForm employeeId={employeeId} onClose={() => setAdding(false)} onDone={() => { setAdding(false); onChange(); }} />}
    </Card>
  );
}

export default function Salaries({ query }) {
  const { session, toast } = useApp();
  const { data: employees } = useLoad(() => get('/employees'), []);
  const { data: components } = useLoad(async () => {
    const [list, rules] = await Promise.all([get('/lookups/salary-components'), get(`/settings${qs({ key: 'payroll.component' })}`)]);
    // Salary-structure components (BASIC, HRA, ...): formula components are worked out by payroll.
    const formula = new Set(rules.filter((s) => s.scope_type === 'company' && s.current?.value?.calculation === 'formula').map((s) => s.subject_id));
    return list.filter((c) => c.is_active && !formula.has(c.id));
  }, []);
  const employeeId = query.employee ?? employees?.[0]?.id;
  const { data, error, loading, reload } = useLoad(() => (employeeId ? get(`/payroll/employees/${employeeId}/salary`) : Promise.resolve(null)), [employeeId]);
  const [revising, setRevising] = useState(false);
  const confirm = useConfirm();
  const removeLatest = async (s) => {
    if (!(await confirm({ title: 'Remove this salary revision?', danger: true, confirmLabel: 'Yes, remove', cancelLabel: 'No, keep it',
      message: `The salary from ${s.effective_from} is deleted and the previous salary applies again. Payroll not yet locked will use the previous amounts.` }))) return;
    try { await del(`/payroll/salary-structures/${s.id}`); toast('Revision removed.'); reload(); } catch (err) { toast(err.message, 'bad'); }
  };
  const current = data?.structures[0];
  return (
    <div className="stack lg">
      <PageHead title="Salaries & loans" subtitle="Salary revisions take effect from a date; paid months are never changed."
        actions={employees && (
          <select className="input" style={{ width: 'auto' }} aria-label="Employee" value={employeeId ?? ''} onChange={(e) => navigate(`/salaries${qs({ employee: e.target.value })}`)}>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.full_name} ({e.employee_code})</option>)}
          </select>
        )} />
      {loading && !data ? <Loading /> : error ? <ErrorBox error={error} /> : !data ? <Empty>No employees.</Empty> : (
        <div className="grid cols-2">
          <Card title="Salary" actions={<Button size="sm" icon="plus" onClick={() => setRevising(true)} disabled={!components}>New revision</Button>}>
            {!current ? <Empty>No salary yet. Add the first revision from the joining date ({fmtDate(data.employee.joiningDate)}).</Empty> : (
              <div className="stack">
                <div className="stat"><div className="label">Monthly salary (earnings)</div><div className="value">{fmtMoney(total(current.lines), session.tenant.currency)}</div>
                  <div className="sub">Since {fmtDate(current.effective_from)}{current.note ? ` · ${current.note}` : ''}</div></div>
                <table className="table"><tbody>{current.lines.map((l) => <tr key={l.code}><td>{l.name}</td><td className="small muted">{l.kind}</td><td className="num">{fmtMoney(l.amount)}</td></tr>)}</tbody></table>
                {data.structures.length > 0 && (
                  <details>
                    <summary className="small">History ({data.structures.length} revision{data.structures.length === 1 ? '' : 's'})</summary>
                    <table className="table"><thead><tr><th>From</th><th>To</th><th className="num">Monthly</th><th /></tr></thead>
                      <tbody>{data.structures.map((s, i) => (
                        <tr key={s.id}><td>{fmtDate(s.effective_from)}</td><td>{s.effective_to ? fmtDate(s.effective_to) : 'now'}</td><td className="num">{fmtMoney(total(s.lines))}</td>
                          <td>{i === 0 && (!data.frozenUntil || s.effective_from > data.frozenUntil) && <Button size="sm" kind="ghost" onClick={() => removeLatest(s)}>Remove</Button>}</td></tr>
                      ))}</tbody></table>
                  </details>
                )}
              </div>
            )}
          </Card>
          <Card title="Bank details"><BankForm key={`${employeeId}-${data.payment?.updated_at ?? ''}`} employeeId={employeeId} payment={data.payment} onDone={reload} /></Card>
          <Loans employeeId={employeeId} loans={data.loans} loansOn={session.modules?.includes('loans')} onChange={reload} />
        </div>
      )}
      {revising && <RevisionForm employeeId={employeeId} current={current} components={components} frozenUntil={data.frozenUntil}
        onClose={() => setRevising(false)} onDone={() => { setRevising(false); reload(); }} />}
    </div>
  );
}
