/**
 * HR: payroll runs. A month moves Draft > In review > Approved > Locked;
 * drafts recalculate from live data, locked months never change.
 */
import { useState } from 'react';
import { del, download, get, post, qs } from '../lib/api.js';
import { navigate, useApp } from '../lib/app.jsx';
import { fmtDate, fmtMoney, monthLabel, shiftMonth, todayIn } from '../lib/format.js';
import { PageHead } from '../components/Layout.jsx';
import { PayslipModal } from '../components/Payslip.jsx';
import { Alert, Button, Card, Empty, ErrorBox, Input, Loading, Modal, Stat, StatusBadge, useLoad } from '../components/ui.jsx';

const STEPS = [['draft', 'Draft'], ['review', 'In review'], ['approved', 'Approved'], ['locked', 'Locked']];

function Steps({ status }) {
  const at = STEPS.findIndex(([s]) => s === status);
  return (
    <ol className="steps" aria-label="Payroll progress">
      {STEPS.map(([s, label], i) => <li key={s} className={i < at ? 'done' : i === at ? 'current' : ''} aria-current={i === at ? 'step' : undefined}>{label}</li>)}
    </ol>
  );
}

function RunList() {
  const { tz, toast } = useApp();
  const { data, error, loading } = useLoad(() => get('/payroll/runs'), []);
  const [picked, setPicked] = useState(null);
  // Suggest the oldest month (last month or this month) that has no run yet.
  const thisMonth = todayIn(tz).slice(0, 7);
  const suggested = [shiftMonth(thisMonth, -1), thisMonth].find((m) => !(data ?? []).some((r) => r.period_key === m)) ?? thisMonth;
  const period = picked ?? suggested;
  const setPeriod = setPicked;
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try { const run = await post('/payroll/runs', { period }); navigate(`/payroll${qs({ run: run.id })}`); }
    catch (err) { if (err.code === 'run_exists') navigate(`/payroll${qs({ run: err.details.runId })}`); else toast(err.message, 'bad'); }
    finally { setBusy(false); }
  };
  return (
    <div className="stack lg">
      <PageHead title="Payroll" subtitle="Run a month, review every payslip, approve, then lock it for good."
        actions={<>
          <Input type="month" aria-label="Payroll month" value={period} onChange={(e) => setPeriod(e.target.value)} />
          <Button kind="primary" icon="money" disabled={!period || busy} onClick={create}>{busy ? 'Calculating…' : `Run ${monthLabel(period)}`}</Button>
        </>} />
      <Card>
        {loading && !data ? <Loading /> : error ? <ErrorBox error={error} /> : data.length === 0 ? <Empty>No payroll yet. Pick a month and run it.</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Month</th><th>Status</th><th className="num">Employees</th><th className="num">Gross</th><th className="num">Net pay</th><th className="num">Warnings</th><th>Last calculated</th></tr></thead>
            <tbody>{data.map((r) => (
              <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/payroll${qs({ run: r.id })}`)}>
                <td><a href={`#/payroll?run=${r.id}`}>{monthLabel(r.period_key)}</a></td>
                <td><StatusBadge status={r.status} /></td>
                <td className="num">{r.totals.employees ?? 0}</td>
                <td className="num">{fmtMoney(r.totals.gross)}</td>
                <td className="num">{fmtMoney(r.totals.net)}</td>
                <td className="num">{r.warning_count || '—'}</td>
                <td className="small muted">{r.calculated_at ? new Date(r.calculated_at).toLocaleString() : '—'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}

const ACTION = {
  recalculate: { label: 'Recalculate', icon: 'refresh' },
  submit: { label: 'Send for review', icon: 'send', kind: 'primary' },
  approve: { label: 'Approve', icon: 'check', kind: 'primary', confirm: 'Approving freezes these payslips: attendance corrections, leave, overtime, salary and rule changes dated in this month are refused until the run is reopened. The bank file can then be exported.' },
  lock: { label: 'Lock payroll', icon: 'lock', kind: 'primary', confirm: 'Locking is permanent. The payslips are published to employees, loan installments are marked as deducted, and nothing in this month can change afterwards (corrections go into next month).' },
  reopen: { label: 'Reopen', icon: 'history', reason: true },
  delete: { label: 'Delete', icon: 'x', kind: 'danger', yes: 'Yes, delete', no: 'No, keep it', confirm: 'Delete this payroll run? Nothing is paid or published yet, so it can be run again.' },
};

function RunDetail({ id }) {
  const { session: { tenant }, toast } = useApp();
  const { data: run, error, loading, reload } = useLoad(() => get(`/payroll/runs/${id}`), [id]);
  const { data: cost } = useLoad(() => get(`/payroll/runs/${id}/department-cost`), [id, run?.calculated_at]);
  const [confirm, setConfirm] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [slip, setSlip] = useState(null);
  const [showAllWarnings, setShowAllWarnings] = useState(false);
  if (loading && !run) return <Loading />;
  if (error) return <ErrorBox error={error} />;

  const act = async (action) => {
    setBusy(true);
    try {
      if (action === 'delete') { await del(`/payroll/runs/${id}`); toast('Payroll run deleted.'); navigate('/payroll'); return; }
      await post(`/payroll/runs/${id}/${action}`, ACTION[action].reason ? { reason } : {});
      toast({ recalculate: 'Recalculated from the latest data.', submit: 'Sent for review.', approve: 'Approved. Payment files can be exported.', lock: 'Locked. Employees can now see their payslips.', reopen: 'Reopened as a draft.' }[action]);
      setConfirm(null); setReason(''); reload();
    } catch (err) { toast(err.message, 'bad'); } finally { setBusy(false); }
  };
  const t = run.totals;
  const exportable = ['approved', 'locked'].includes(run.status);
  const warnings = run.warnings ?? [];
  return (
    <div className="stack lg">
      <PageHead title={`Payroll · ${monthLabel(run.period_key)}`} subtitle={`${fmtDate(run.period_start)} – ${fmtDate(run.period_end)}`}
        actions={<>
          <Button kind="ghost" onClick={() => navigate('/payroll')}>← All runs</Button>
          {run.actions.map((a) => (
            <Button key={a} kind={ACTION[a].kind} icon={ACTION[a].icon} disabled={busy}
              onClick={() => (ACTION[a].confirm || ACTION[a].reason ? setConfirm(a) : act(a))}>{ACTION[a].label}</Button>
          ))}
        </>} />
      <Card>
        <div className="row between">
          <Steps status={run.status} />
          <div className="small muted">
            {[run.createdBy && `Prepared by ${run.createdBy}`, run.approvedBy && `approved by ${run.approvedBy}`,
              run.locked_at && `locked ${new Date(run.locked_at).toLocaleString()}`,
              run.status === 'draft' && run.calculated_at && `calculated ${new Date(run.calculated_at).toLocaleString()}`].filter(Boolean).join(' · ')}
          </div>
        </div>
      </Card>
      {run.status === 'locked' && <Alert kind="info" title="This month is locked">Its payslips, attendance, leave and rules can no longer change. Make any correction in the next payroll.</Alert>}
      <div className="grid cols-3">
        <Stat icon="users" label="Employees paid" value={t.employees ?? 0} />
        <Stat icon="money" label="Gross pay" value={fmtMoney(t.gross)} sub={tenant.currency} />
        <Stat icon="file" label="Deductions" value={fmtMoney(t.deductions)} sub={tenant.currency} />
        <Stat icon="check" label="Net pay" value={fmtMoney(t.net)} sub={`${tenant.currency} · to transfer`} />
        <Stat icon="shield" label="Employer contributions" value={fmtMoney(t.employerCost)} sub="On top of gross pay" />
      </div>
      {warnings.length > 0 && (
        <Alert kind="warn" title={`${warnings.length} thing${warnings.length === 1 ? '' : 's'} to check`}
          items={(showAllWarnings ? warnings : warnings.slice(0, 6)).map((w) => w.message)}>
          {warnings.length > 6 && <Button size="sm" kind="ghost" onClick={() => setShowAllWarnings(!showAllWarnings)}>{showAllWarnings ? 'Show fewer' : `Show all ${warnings.length}`}</Button>}
        </Alert>
      )}
      <div className="grid cols-2">
        <Card title="Payment files" actions={null}>
          <div className="stack">
            <p className="small muted">{exportable ? 'Download the salary transfer file for your bank and the cost report for finance.' : 'Available once the payroll is approved.'}</p>
            <div className="row">
              <Button icon="download" disabled={!exportable} onClick={() => download(`/payroll/runs/${id}/bank.csv`, `bank-transfer-${run.period_key}.csv`).catch((e) => toast(e.message, 'bad'))}>Bank transfer (CSV)</Button>
              <Button icon="download" onClick={() => download(`/payroll/runs/${id}/department-cost.csv`, `department-cost-${run.period_key}.csv`).catch((e) => toast(e.message, 'bad'))}>Department cost (CSV)</Button>
            </div>
          </div>
        </Card>
        <Card title="Cost by department">
          {!cost ? <Loading /> : cost.departments.length === 0 ? <Empty>No payslips.</Empty> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Department</th><th className="num">People</th><th className="num">Net pay</th><th className="num">Total cost</th></tr></thead>
              <tbody>{cost.departments.map((d) => <tr key={d.department}><td>{d.department}</td><td className="num">{d.headcount}</td><td className="num">{fmtMoney(d.net)}</td><td className="num">{fmtMoney(d.total_cost)}</td></tr>)}</tbody>
            </table></div>
          )}
        </Card>
      </div>
      <Card title="Payslips">
        {run.payslips.length === 0 ? <Empty>No payslips. Add salaries under Salaries & loans, then recalculate.</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Employee</th><th>Department</th><th className="num">Absent</th><th className="num">Late</th><th className="num">Unpaid leave</th><th className="num">Gross</th><th className="num">Deductions</th><th className="num">Net pay</th><th /></tr></thead>
            <tbody>{run.payslips.map((p) => (
              <tr key={p.id}>
                <td><button type="button" className="link" onClick={() => setSlip(p.id)}>{p.full_name}</button> <span className="small muted">{p.employee_code}</span></td>
                <td>{p.department ?? '—'}</td>
                <td className="num">{p.inputs.ABSENT_DAYS || '—'}</td>
                <td className="num">{p.inputs.LATE_COUNT || '—'}</td>
                <td className="num">{p.inputs.UNPAID_LEAVE_DAYS || '—'}</td>
                <td className="num">{fmtMoney(p.gross)}</td>
                <td className="num">{fmtMoney(p.deductions)}</td>
                <td className="num"><strong>{fmtMoney(p.net)}</strong></td>
                <td>{p.warning_count > 0 && <span className="badge warn" title="Has warnings">{p.warning_count} to check</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      {slip && <PayslipModal id={slip} onClose={() => setSlip(null)} />}
      {confirm && (
        <Modal title={ACTION[confirm].label} onClose={() => setConfirm(null)}
          footer={<><Button onClick={() => setConfirm(null)}>{ACTION[confirm].no ?? 'Cancel'}</Button>
            <Button kind={ACTION[confirm].kind ?? 'primary'} disabled={busy || (ACTION[confirm].reason && !reason.trim())} onClick={() => act(confirm)}>{ACTION[confirm].yes ?? ACTION[confirm].label}</Button></>}>
          {ACTION[confirm].confirm && <p>{ACTION[confirm].confirm}</p>}
          {ACTION[confirm].reason && <Input as="textarea" label="Why is it being reopened?" value={reason} onChange={(e) => setReason(e.target.value)} help="Saved in the audit log." />}
        </Modal>
      )}
    </div>
  );
}

export default function Payroll({ query }) {
  return query.run ? <RunDetail id={query.run} /> : <RunList />;
}
