import { useState } from 'react';
import { download, get, post, put, qs } from '../../lib/api.js';
import { useApp } from '../../lib/app.jsx';
import { humanize } from '../../lib/format.js';
import { useConfirm } from '../../components/confirm.jsx';
import { PageHead } from '../../components/Layout.jsx';
import { Alert, Button, Card, ErrorBox, Input, Loading, Switch, useLoad } from '../../components/ui.jsx';

const MODULE_HELP = {
  attendance: 'Check-in / check-out and daily attendance.',
  wfh: 'Work-from-home requests and WFH check-in.',
  leave: 'Leave requests, balances and the leave ledger.',
  payroll: 'Payroll runs and payslips.',
  auto_checkin: 'Mobile app checks people in automatically inside the office geofence.',
  selfie_verification: 'Selfie check for WFH check-in (a registered device is always accepted as the non-biometric alternative).',
  overtime: 'Overtime requests and payment.',
  loans: 'Loans and salary advances.',
  tasks: 'Daily tasks and work logs with files; blocked tasks alert the manager.',
};

export function Features() {
  const { toast } = useApp();
  const confirm = useConfirm();
  const { data, loading, error, reload } = useLoad(() => get('/features'), []);
  const set = async (m, enabled) => {
    if (!enabled && !(await confirm({ title: `Switch off ${humanize(m)}?`, confirmLabel: 'Switch off',
      message: 'Everyone in the company loses this feature immediately. Its data is kept and comes back when you switch it on again.' }))) return;
    try { await put(`/features/${m}`, { enabled }); toast(`${humanize(m)} ${enabled ? 'switched on' : 'switched off'}.`); reload(); }
    catch (err) { toast(err.message, 'bad'); }
  };
  return (
    <div className="stack lg">
      <PageHead title="Modules" subtitle="Switch features on or off for this company." />
      <Card className="flush">
        {loading && !data ? <Loading /> : error ? <ErrorBox error={error} /> : (
          <table className="table"><tbody>{data.map((f) => (
            <tr key={f.module_key}><td><strong>{humanize(f.module_key)}</strong><div className="small muted">{MODULE_HELP[f.module_key]}</div></td>
              <td style={{ width: 160 }}><Switch label={f.enabled ? 'On' : 'Off'} checked={f.enabled} onChange={(v) => set(f.module_key, v)} /></td></tr>
          ))}</tbody></table>
        )}
      </Card>
    </div>
  );
}

export function Transfer() {
  const { toast } = useApp();
  const [data, setData] = useState(null);
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const onFile = async (e) => {
    setReport(null); setError(null);
    try {
      const parsed = JSON.parse(await e.target.files[0].text());
      setData(parsed);
      setReport(await post('/settings-transfer/import', { data: parsed, dryRun: true }));
    } catch (err) { setError(err instanceof SyntaxError ? new Error('This file is not valid JSON.') : err); }
  };
  const apply = async () => {
    try { setReport(await post('/settings-transfer/import', { data, dryRun: false })); toast('Imported. Review the new drafts and publish them.'); }
    catch (err) { setError(err); }
  };
  return (
    <div className="stack lg">
      <PageHead title="Import / export settings" subtitle="Copy all lists and rules to another company, or keep a backup." />
      <div className="grid cols-2">
        <Card title="Export">
          <p className="muted">Downloads every list, module switch and the rules in effect today as JSON. Records are referenced by code, so the file works in another company.</p>
          <Button kind="primary" icon="download" onClick={() => download('/settings-transfer/export', 'hrm-settings.json').catch((e) => toast(e.message, 'bad'))}>Download settings</Button>
        </Card>
        <Card title="Import">
          <div className="stack">
            <p className="muted">Lists are added or updated by code. Rules arrive as <strong>drafts</strong>: nothing changes for employees until you review and publish them.</p>
            <Input type="file" accept="application/json,.json" label="Settings file" onChange={onFile} />
            <ErrorBox error={error} />
            {report && (
              <div className="stack">
                <Alert kind={report.dryRun ? 'info' : 'good'} title={report.dryRun ? 'Dry run — nothing saved yet' : 'Imported'}
                  items={[`Lists: ${report.lookups.created} new, ${report.lookups.updated} updated`, `Holidays added: ${report.holidays}`,
                    `Rules: ${report.drafts.length} new drafts, ${report.unchanged} already identical`]} />
                {report.drafts.length > 0 && <ul className="small">{report.drafts.map((d) => <li key={d.item}>{d.item}</li>)}</ul>}
                {report.skipped.length > 0 && <Alert kind="warn" title="Skipped" items={report.skipped.map((s) => `${s.item}: ${s.reason}`)} />}
                {report.dryRun && <div><Button kind="primary" onClick={apply}>Apply import</Button></div>}
                {!report.dryRun && <a href="#/settings/policies">Go to Policies to publish the drafts →</a>}
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

export function Audit() {
  const [entityType, setEntityType] = useState('');
  const { data, loading, error } = useLoad(() => get(`/audit${qs({ entityType, limit: 200 })}`), [entityType]);
  const [open, setOpen] = useState(null);
  return (
    <div className="stack lg">
      <PageHead title="Audit log" subtitle="Every change: who, when, old value and new value. Entries can never be edited or deleted." />
      <div className="row"><Input as="select" label="Filter" value={entityType} onChange={(e) => setEntityType(e.target.value)}>
        <option value="">Everything</option>
        {['setting_version', 'employee', 'leave_request', 'wfh_request_group', 'attendance_correction', 'feature_flag', 'departments', 'leave_types', 'locations'].map((x) => <option key={x} value={x}>{humanize(x)}</option>)}
      </Input></div>
      <Card className="flush">
        {loading && !data ? <Loading /> : error ? <ErrorBox error={error} /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>When</th><th>Action</th><th>Record</th><th /></tr></thead>
            <tbody>{data.map((a) => [
              <tr key={a.id}><td className="small">{new Date(a.created_at).toLocaleString()}</td><td>{humanize(a.action)}</td><td className="small muted">{humanize(a.entity_type)}</td>
                <td>{(a.old_value || a.new_value) && <Button size="sm" onClick={() => setOpen(open === a.id ? null : a.id)}>{open === a.id ? 'Hide' : 'Details'}</Button>}</td></tr>,
              open === a.id && <tr key={`${a.id}-d`}><td colSpan={4}><div className="grid cols-2">
                <div><h4>Old</h4><pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(a.old_value, null, 2)}</pre></div>
                <div><h4>New</h4><pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(a.new_value, null, 2)}</pre></div></div></td></tr>,
            ])}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}
