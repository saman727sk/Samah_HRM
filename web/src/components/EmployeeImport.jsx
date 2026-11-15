import { useState } from 'react';
import { download, post } from '../lib/api.js';
import { useApp } from '../lib/app.jsx';
import { Alert, Button, ErrorBox, Icon, Modal, Stat, Switch } from './ui.jsx';

/** What each recognised column becomes (server: services/employeeImport.js). */
const FIELD_LABELS = {
  employee_code: 'Employee code', full_name: 'Full name', first_name: 'First name', last_name: 'Last name', email: 'Email', phone: 'Phone',
  department: 'Department', role: 'Role', employment_type: 'Employment type', manager: 'Manager', joining_date: 'Joining date',
  probation_end_date: 'Probation end', exit_date: 'Exit date', status: 'Status', shift: 'Shift', location: 'Office', login: 'Login', access_level: 'Access level',
};

/** Excel saves "CSV" in the computer's own code page unless "CSV UTF-8" is chosen: read both. */
async function readText(file) {
  const bytes = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('windows-1252').decode(bytes); }
}

/** People > Import: template, choose a CSV, preview (nothing saved), then import. */
export default function EmployeeImport({ onClose, onDone }) {
  const { toast } = useApp();
  const [file, setFile] = useState(null); // { name, csv }
  const [opts, setOpts] = useState({ createMissing: true, loginsForAll: false, sendInvites: true });
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const pick = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setErr(null); setPreview(null);
    if (/\.pdf$/i.test(f.name)) { setErr(new Error('A PDF is a printed page, not data. Open it in Excel (Data > Get Data > From PDF) and save the table as CSV, then choose that file.')); return; }
    if (/\.(xlsx?|ods|numbers)$/i.test(f.name)) { setErr(new Error('Save the spreadsheet as CSV first (Excel: File > Save As > "CSV UTF-8"), then choose that file.')); return; }
    if (f.size > 10 * 1024 * 1024) { setErr(new Error('The file is larger than 10 MB. Split it into smaller files.')); return; }
    setFile({ name: f.name, csv: await readText(f) });
  };
  const run = async (dryRun) => {
    setBusy(true); setErr(null);
    try {
      const r = await post('/employees/import', { csv: file.csv, dryRun, ...opts });
      if (dryRun) setPreview(r); else setResult(r);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const template = () => download('/employees/import-template.csv', 'employees-template.csv').catch((e) => toast(e.message, 'bad'));

  if (result) {
    return (
      <Modal title="Import finished" onClose={() => onDone(result)} wide footer={<Button kind="primary" onClick={() => onDone(result)}>Done</Button>}>
        <div className="stack">
          <div className="grid stats">
            <Stat icon="plus" label="Added" value={result.added} />
            <Stat icon="refresh" label="Updated" value={result.updated} />
            <Stat icon="alert" label="Skipped (problems)" value={result.failed} />
            <Stat icon="lock" label="Logins created" value={result.logins} />
          </div>
          {result.logins > 0 && (result.invitesSent > 0
            ? <Alert kind="good">{result.invitesSent} {result.invitesSent === 1 ? 'person was' : 'people were'} emailed a link to choose their password (valid 7 days).{result.invitesFailed > 0 && ` ${result.invitesFailed} emails could not be sent: they can use "Forgot password" on the sign-in page.`}</Alert>
            : opts.sendInvites && <Alert kind="info">No emails were sent. People with a login can use "Forgot password" on the sign-in page to set their password.</Alert>)}
          {result.failed > 0 && <Problems rows={result.rows} />}
        </div>
      </Modal>
    );
  }

  const ok = preview ? preview.added + preview.updated : 0;
  return (
    <Modal title="Import employees from CSV" onClose={onClose} wide footer={<>
      <Button onClick={preview ? () => setPreview(null) : onClose}>{preview ? 'Back' : 'Cancel'}</Button>
      {preview
        ? <Button kind="primary" icon="check" disabled={busy || ok === 0} onClick={() => run(false)}>{busy ? 'Importing…' : `Import ${ok} ${ok === 1 ? 'employee' : 'employees'}`}</Button>
        : <Button kind="primary" disabled={busy || !file} onClick={() => run(true)}>{busy ? 'Checking…' : 'Check file'}</Button>}
    </>}>
      {!preview ? (
        <div className="stack">
          <ol className="import-steps">
            <li><strong>Get the template</strong> or use your own file: column names like "Emp ID", "Designation" or "DOJ" are understood.
              <div><Button size="sm" icon="download" onClick={template}>Download template</Button></div></li>
            <li><strong>Save it as CSV.</strong> In Excel: File &gt; Save As &gt; "CSV UTF-8". A PDF list: Excel &gt; Data &gt; Get Data &gt; From PDF, then save as CSV.</li>
            <li><strong>Choose the file and check it.</strong> Nothing is saved until you press Import.</li>
          </ol>
          <label className="file-drop">
            <input type="file" accept=".csv,text/csv,.txt,.pdf,.xlsx,.xls" onChange={pick} hidden />
            <span><Icon name="file" size={18} /> {file ? <><strong>{file.name}</strong> · {file.csv.split(/\r?\n/).filter((l) => l.trim()).length - 1} rows · click to choose another</> : 'Click to choose a CSV file'}</span>
          </label>
          <div className="stack" style={{ gap: 10 }}>
            <Switch label="Add departments, roles and employment types that don't exist yet" checked={opts.createMissing} onChange={(v) => setOpts({ ...opts, createMissing: v })} />
            <Switch label='Create a login for everyone with an email (otherwise only rows with Login = "yes")' checked={opts.loginsForAll} onChange={(v) => setOpts({ ...opts, loginsForAll: v })} />
            <Switch label="Email new logins a link to choose their password" checked={opts.sendInvites} onChange={(v) => setOpts({ ...opts, sendInvites: v })} />
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            A row whose employee code already exists updates that person (only the cells that are filled in). Rows without a code get the next free one.
            Dates like 15/03/2024 are read day first. The manager can be an employee code, email or name.
          </p>
          <ErrorBox error={err} />
        </div>
      ) : (
        <div className="stack">
          <div className="grid stats">
            <Stat icon="plus" label="Will be added" value={preview.added} />
            <Stat icon="refresh" label="Will be updated" value={preview.updated} />
            <Stat icon="alert" label="Problems (skipped)" value={preview.failed} />
            <Stat icon="lock" label="Logins" value={preview.logins} />
          </div>
          <div>
            <div className="field-label" style={{ marginBottom: 6 }}>How your columns were read</div>
            <div className="chips">
              {preview.columns.filter((c) => c.header).map((c) => (
                <span key={c.header} className={`badge ${c.field ? 'info' : ''}`} title={c.field ? `Read as ${FIELD_LABELS[c.field]}` : 'Not used'}>
                  {c.header}{c.field && FIELD_LABELS[c.field].toLowerCase() !== c.header.toLowerCase() ? ` → ${FIELD_LABELS[c.field]}` : ''}{!c.field && ' (ignored)'}
                </span>
              ))}
            </div>
          </div>
          {Object.entries(preview.created).length > 0 && (
            <Alert kind="info" title="These will be added to your lists">
              {Object.entries(preview.created).map(([k, names]) => `${FIELD_LABELS[k]}: ${[...new Set(names)].join(', ')}`).join(' · ')}
            </Alert>
          )}
          {preview.failed > 0 && <Problems rows={preview.rows} />}
          <details>
            <summary className="small" style={{ cursor: 'pointer' }}>See every row ({preview.rows.length})</summary>
            <div className="table-wrap" style={{ maxHeight: 320, marginTop: 8 }}><table className="table">
              <thead><tr><th>Row</th><th>Code</th><th>Name</th><th>Result</th><th>Notes</th></tr></thead>
              <tbody>{preview.rows.map((r) => (
                <tr key={r.line}><td>{r.line}</td><td className="mono">{r.code ?? 'new code'}</td><td>{r.name ?? '—'}</td>
                  <td>{r.action === 'added' ? <span className="badge good">Add</span> : r.action === 'updated' ? <span className="badge info">Update</span> : <span className="badge bad">Skip</span>}</td>
                  <td className="small">{r.error ?? r.notes.join(' · ')}</td></tr>
              ))}</tbody>
            </table></div>
          </details>
          {ok > 0 && preview.failed > 0 && <p className="small muted" style={{ margin: 0 }}>You can import the {ok} good rows now and fix the others in your file, then import it again: rows already imported are just updated.</p>}
          <ErrorBox error={err} />
        </div>
      )}
    </Modal>
  );
}

function Problems({ rows }) {
  const bad = rows.filter((r) => r.action === 'failed');
  return (
    <div>
      <div className="field-label" style={{ marginBottom: 6 }}>Rows with problems ({bad.length})</div>
      <div className="table-wrap" style={{ maxHeight: 260 }}><table className="table">
        <thead><tr><th>Row</th><th>Name</th><th>Problem</th></tr></thead>
        <tbody>{bad.map((r) => <tr key={r.line}><td>{r.line}</td><td>{r.name ?? '—'}</td><td className="small">{r.error}</td></tr>)}</tbody>
      </table></div>
    </div>
  );
}
