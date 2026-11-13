/**
 * One payslip: earnings, deductions, net pay, attendance figures, and for
 * every line how it was worked out (formula + the values it used).
 */
import { useState } from 'react';
import { download, get } from '../lib/api.js';
import { useApp } from '../lib/app.jsx';
import { fmtDate, fmtMoney, monthLabel } from '../lib/format.js';
import { Alert, Button, CompanyLogo, ErrorBox, Loading, Modal, useLoad } from './ui.jsx';

function How({ line, currency }) {
  if (line.calculation === 'structure') {
    return <span className="small muted">From salary {fmtMoney(line.inputs.full, currency)}{line.inputs.proRated && line.inputs.PRORATE !== 1 ? ` × ${line.inputs.PRORATE} (part of the month)` : ''}</span>;
  }
  return (
    <span className="small muted">
      <code>{line.formula}</code>
      {Object.keys(line.inputs ?? {}).length > 0 && <> with {Object.entries(line.inputs).map(([k, v]) => <span key={k} className="mono"> {k}={fmtMoney(v)}</span>)}</>}
    </span>
  );
}

function Lines({ title, lines, total, currency, showHow }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>{title}</th><th className="num">Amount</th></tr></thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.code}>
              <td>{l.name}{showHow && <div><How line={l} currency={currency} /></div>}</td>
              <td className="num">{fmtMoney(l.amount)}</td>
            </tr>
          ))}
          <tr><td><strong>Total</strong></td><td className="num"><strong>{fmtMoney(total)}</strong></td></tr>
        </tbody>
      </table>
    </div>
  );
}

const FACTS = [
  ['WORKING_DAYS', 'Working days'], ['EMPLOYED_DAYS', 'Days employed'], ['PRESENT_DAYS', 'Present'], ['ABSENT_DAYS', 'Absent'],
  ['HALF_DAYS', 'Half days'], ['LATE_COUNT', 'Late arrivals'], ['PAID_LEAVE_DAYS', 'Paid leave'], ['UNPAID_LEAVE_DAYS', 'Unpaid leave'],
  ['OT_HOURS', 'Overtime hours'], ['OT_OFFDAY_HOURS', 'Overtime on days off'],
];

export function PayslipView({ slip }) {
  const { isHr } = useApp();
  const [showHow, setShowHow] = useState(isHr);
  const s = slip.summary;
  const shown = (kind) => s.lines.filter((l) => l.kind === kind && !l.hidden);
  const employer = shown('employer');
  const c = slip.companyDetails ?? { name: slip.company };
  return (
    <div className="stack">
      {/* The company's own letterhead (same as the PDF) */}
      <div className="letterhead">
        <CompanyLogo company={c} size="md" />
        <div>
          <strong style={{ fontSize: 17 }}>{c.name}</strong>
          {c.address && <div className="small muted">{c.address}</div>}
          {(c.phone || c.email) && <div className="small muted">{[c.phone, c.email].filter(Boolean).join('  ·  ')}</div>}
        </div>
      </div>
      <div className="row between">
        <div>
          <strong>{s.employee.name}</strong> <span className="muted">({s.employee.code})</span>
          <div className="small muted">{[s.employee.role, s.employee.department].filter(Boolean).join(' · ')} · {fmtDate(s.period.start)} – {fmtDate(s.period.end)}</div>
        </div>
        <label className="small row" style={{ gap: 6 }}><input type="checkbox" checked={showHow} onChange={(e) => setShowHow(e.target.checked)} /> Show how each line is worked out</label>
      </div>
      <div className="grid cols-2">
        <Lines title="Earnings" lines={shown('earning')} total={slip.gross} currency={slip.currency} showHow={showHow} />
        <Lines title="Deductions" lines={shown('deduction')} total={slip.deductions} currency={slip.currency} showHow={showHow} />
      </div>
      <div className="stat row between" style={{ background: 'var(--accent-soft)' }}>
        <div className="label">Net pay</div>
        <div className="value">{fmtMoney(slip.net, slip.currency)}</div>
      </div>
      {employer.length > 0 && <p className="small muted">Paid by the employer, not deducted from pay: {employer.map((l) => `${l.name} ${fmtMoney(l.amount)}`).join(', ')}.</p>}
      <div>
        <div className="field-label" style={{ marginBottom: 6 }}>Attendance this month</div>
        <div className="chips">{FACTS.filter(([k]) => k in s.inputs).map(([k, label]) => <span key={k} className="badge">{label}: <strong>{s.inputs[k]}</strong></span>)}</div>
      </div>
      {isHr && s.warnings?.length > 0 && <Alert kind="warn" title="Check before approving" items={s.warnings.map((w) => w.message)} />}
    </div>
  );
}

/** Loads a payslip by id and shows it in a dialog with a PDF download. */
export function PayslipModal({ id, onClose }) {
  const { toast } = useApp();
  const { data, error, loading } = useLoad(() => get(`/payroll/payslips/${id}`), [id]);
  const pdf = async () => {
    try { await download(`/payroll/payslips/${id}/pdf`, `payslip-${data.summary.employee.code}-${data.period_key}.pdf`); }
    catch (err) { toast(err.message, 'bad'); }
  };
  return (
    <Modal wide title={data ? `Payslip · ${monthLabel(data.period_key)}` : 'Payslip'} onClose={onClose}
      footer={<><Button onClick={onClose}>Close</Button><Button kind="primary" icon="download" disabled={!data} onClick={pdf}>Download PDF</Button></>}>
      {loading ? <Loading /> : error ? <ErrorBox error={error} /> : <PayslipView slip={data} />}
    </Modal>
  );
}
