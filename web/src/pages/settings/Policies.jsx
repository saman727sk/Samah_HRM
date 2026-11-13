import { useEffect, useMemo, useState } from 'react';
import { del, get, patch, post, qs } from '../../lib/api.js';
import { navigate, useApp } from '../../lib/app.jsx';
import { fmtDate, humanize, todayIn } from '../../lib/format.js';
import { useConfirm } from '../../components/confirm.jsx';
import { PageHead } from '../../components/Layout.jsx';
import SettingForm from '../../components/SettingForm.jsx';
import { Alert, Button, Card, Empty, ErrorBox, Input, Loading, Modal, StatusBadge, Tabs, useLoad } from '../../components/ui.jsx';

const SECTIONS = [
  ['Attendance', ['attendance.calendar', 'attendance.rules', 'shift.rules']],
  ['Work from home', ['wfh.policy']],
  ['Leave', ['leave.type', 'leave.year', 'leave.rules']],
  ['Payroll', ['payroll.component', 'payroll.rules', 'payroll.tax']],
  ['Approval workflows', ['workflow.leave', 'workflow.wfh', 'workflow.attendance_correction', 'workflow.overtime']],
];
const SCOPE_ENTITY = { department: 'departments', employment_type: 'employment-types', role: 'roles', employee: 'employees' };
const SUBJECT_ENTITY = { leave_types: 'leave-types', shifts: 'shifts', salary_components: 'salary-components' };

function useLookups() {
  const { data } = useLoad(async () => {
    const [departments, roles, et, leaveTypes, shifts, employees, components] = await Promise.all([
      get('/lookups/departments'), get('/lookups/roles'), get('/lookups/employment-types'), get('/lookups/leave-types'), get('/lookups/shifts'), get('/employees'),
      get('/lookups/salary-components'),
    ]);
    return { departments, roles, 'employment-types': et, 'leave-types': leaveTypes, shifts, employees: employees.map((e) => ({ ...e, name: e.full_name })),
      'salary-components': components.map((c) => ({ ...c, name: `${c.name} (${c.code})` })) };
  }, []);
  return data;
}

const scopeName = (s, lookups) => {
  if (s.scope_type === 'company') return 'Company default';
  const row = lookups?.[SCOPE_ENTITY[s.scope_type]]?.find((x) => x.id === s.scope_id);
  return `${humanize(s.scope_type)}: ${row?.name ?? '…'}`;
};

/** Plain-language rendering of a diff value. */
const show = (v) => (v === undefined ? '—' : v === null ? 'none' : Array.isArray(v) ? (v.length ? v.map((x) => (typeof x === 'object' ? Object.values(x).join(' / ') : x)).join(', ') : '(empty)') : typeof v === 'object' ? JSON.stringify(v) : String(v));

function DiffTable({ changes, fields }) {
  const label = (p) => fields.find((f) => f.path === p)?.label ?? p;
  if (!changes.length) return <Empty>No differences.</Empty>;
  return (
    <table className="table"><thead><tr><th>Setting</th><th>Old</th><th>New</th></tr></thead>
      <tbody>{changes.map((c) => <tr key={c.path}><td>{label(c.path)}</td><td><span className="diff-old">{show(c.old)}</span></td><td><span className="diff-new">{show(c.new)}</span></td></tr>)}</tbody>
    </table>
  );
}

function PreviewPanel({ preview, fields }) {
  return (
    <div className="stack">
      {preview.summary.map((s, i) => <Alert key={i} kind={i === 0 ? 'info' : 'good'}>{s}</Alert>)}
      {!preview.validation.ok && <Alert kind="bad" title="Fix these before publishing" items={preview.validation.errors.map((e) => e.message)} />}
      {preview.employees.length > 0 && (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Employee</th><th>What changes</th><th>Effect</th></tr></thead>
          <tbody>{preview.employees.map((e) => (
            <tr key={e.employeeId}>
              <td>{e.name}<div className="small muted">{e.department}</div></td>
              <td className="small">{e.changes.slice(0, 4).map((c) => <div key={c.path}>{fields.find((f) => f.path === c.path)?.label ?? c.path}: <span className="diff-old">{show(c.old)}</span> → <span className="diff-new">{show(c.new)}</span></div>)}</td>
              <td className="small">{e.metrics.map((m) => <div key={m.key}>{m.label}: <strong>{m.old ?? '—'}</strong> → <strong>{m.new ?? '—'}</strong></div>)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <p className="small muted">{preview.payrollImpact.note}</p>
    </div>
  );
}

function History({ setting, fields, onRestored }) {
  const { toast } = useApp();
  const { data, loading, reload } = useLoad(() => get(`/settings/${setting.id}/versions`), [setting.id]);
  const [pick, setPick] = useState([]);
  const [diff, setDiff] = useState(null);
  useEffect(() => { setPick([]); setDiff(null); }, [setting.id]);
  const compare = async () => setDiff(await get(`/setting-versions/${pick[0]}/diff${qs({ against: pick[1] })}`));
  const restore = async (v) => {
    try { await post(`/setting-versions/${v.id}/restore`, {}); toast(`Version ${v.version} restored as a new draft. Review and publish it.`); reload(); onRestored(); }
    catch (err) { toast(err.message, 'bad'); }
  };
  if (loading && !data) return <Loading />;
  return (
    <div className="stack">
      <div className="table-wrap"><table className="table">
        <thead><tr><th /><th>Version</th><th>Status</th><th>In effect</th><th>Note</th><th /></tr></thead>
        <tbody>{data.map((v) => (
          <tr key={v.id}>
            <td><input type="checkbox" aria-label={`Compare version ${v.version}`} checked={pick.includes(v.id)}
              onChange={(e) => setPick(e.target.checked ? [...pick, v.id].slice(-2) : pick.filter((x) => x !== v.id))} /></td>
            <td className="num">v{v.version}</td><td><StatusBadge status={v.status} /></td>
            <td className="small">{v.effective_from ? `${fmtDate(v.effective_from)} → ${v.effective_to ? fmtDate(v.effective_to) : 'open'}` : '—'}</td>
            <td className="small muted">{v.change_note}</td>
            <td>{v.status !== 'draft' && <Button size="sm" icon="history" onClick={() => restore(v)}>Restore as draft</Button>}</td>
          </tr>
        ))}</tbody>
      </table></div>
      <div><Button disabled={pick.length !== 2} onClick={compare}>Compare selected</Button></div>
      {diff && <Card title={`v${diff.from?.version ?? '—'} → v${diff.to.version}`}><DiffTable changes={diff.changes} fields={fields} /></Card>}
    </div>
  );
}

function Editor({ def, setting, base, lookups, onChanged }) {
  const { toast, tz } = useApp();
  const [tab, setTab] = useState('edit');
  const [value, setValue] = useState(setting.draft?.value ?? setting.current?.value ?? {});
  const [dirty, setDirty] = useState(false);
  const [validation, setValidation] = useState(null);
  const [preview, setPreview] = useState(null);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const { data: templates } = useLoad(() => (setting.scope_type === 'company' ? get(`/settings/templates${qs({ key: def.key })}`) : Promise.resolve([])), [def.key, setting.scope_type]);
  // Reset only when a different setting/draft is shown (a list reload alone keeps validation & preview).
  useEffect(() => { setValue(setting.draft?.value ?? setting.current?.value ?? {}); setDirty(false); setValidation(null); setPreview(null); setError(null); },
    [setting.id, setting.draft?.id, setting.current?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const isCompany = setting.scope_type === 'company';
  const draft = setting.draft;
  const errorsByPath = Object.fromEntries((validation?.errors ?? []).map((e) => [e.path, e.message]));

  const confirm = useConfirm();
  const run = async (fn) => { setBusy(true); setError(null); try { await fn(); } catch (err) { setError(err); } finally { setBusy(false); } };
  const startDraft = () => run(async () => {
    await post('/setting-versions', { key: def.key, subjectId: setting.subject_id, scopeType: setting.scope_type, scopeId: setting.scope_id, value: setting.current?.value ?? {} });
    onChanged();
  });
  const save = () => run(async () => {
    await patch(`/setting-versions/${draft.id}`, { value });
    setDirty(false);
    setValidation(await post(`/setting-versions/${draft.id}/validate`, {}));
    onChanged();
  });
  const doPreview = (effectiveFrom) => run(async () => {
    if (dirty) { await patch(`/setting-versions/${draft.id}`, { value }); setDirty(false); }
    const p = await post(`/setting-versions/${draft.id}/preview`, { effectiveFrom });
    setPreview(p); setValidation(p.validation);
  });
  const discard = async () => (await confirm({ title: 'Discard this draft?', danger: true, confirmLabel: 'Yes, discard', cancelLabel: 'No, keep editing',
    message: 'Your unpublished changes are lost. The published rule stays as it is.' })) && run(async () => { await del(`/setting-versions/${draft.id}`); toast('Draft discarded.'); onChanged(); });
  const retire = async () => (await confirm({ title: 'Retire this override?', confirmLabel: 'Retire override',
    message: 'From today the company-wide rule applies to this group again. The override stays in the history.' })) && run(async () => { await post(`/settings/${setting.id}/retire`, {}); toast('Override retired; the company rule applies from today.'); onChanged(); });

  return (
    <Card>
      <div className="row between" style={{ marginBottom: 12 }}>
        <div>
          <h2>{scopeName(setting, lookups)}</h2>
          <div className="small muted">
            {setting.current ? `In effect: v${setting.current.version} since ${fmtDate(setting.current.effective_from)}` : 'Not in effect yet'}
            {setting.upcoming?.length ? ` · upcoming v${setting.upcoming[0].version} from ${fmtDate(setting.upcoming[0].effective_from)}` : ''}
          </div>
        </div>
        <div className="row">{draft ? <StatusBadge status="draft" /> : setting.current && <StatusBadge status="published" />}</div>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'edit', label: draft ? 'Edit draft' : 'Current rule' }, { value: 'history', label: 'History & rollback' }]} />
      {tab === 'history' ? <History setting={setting} fields={def.fields} onRestored={() => { onChanged(); setTab('edit'); }} /> : (
        <div className="stack">
          {!draft && <Alert kind="info">To change this rule, create a draft. Nothing changes for anyone until you publish it with an effective date.</Alert>}
          {draft && isCompany && templates?.length > 0 && (
            <div className="row">
              <select className="input" style={{ width: 'auto' }} aria-label="Start from template" defaultValue="" onChange={(e) => {
                const tpl = templates.find((x) => x.id === e.target.value);
                if (tpl) { setValue(structuredClone(tpl.value)); setDirty(true); toast(`Loaded "${tpl.name}". Save to keep it.`); }
                e.target.value = '';
              }}>
                <option value="">Start from a template…</option>
                {templates.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </div>
          )}
          <SettingForm fields={def.fields} value={value} onChange={(v) => { setValue(v); setDirty(true); }} inherited={isCompany ? undefined : base}
            lookups={lookups ?? {}} errors={errorsByPath} readOnly={!draft} />
          {validation && (validation.errors.length > 0 || validation.warnings.length > 0) && (
            <div className="stack">
              {validation.errors.length > 0 && <Alert kind="bad" title="Please fix" items={validation.errors.map((e) => e.message)} />}
              {validation.warnings.length > 0 && <Alert kind="warn" title="Check these" items={validation.warnings.map((w) => w.message)} />}
            </div>
          )}
          {validation?.ok && validation.warnings.length === 0 && !dirty && <Alert kind="good">The draft is valid.</Alert>}
          <ErrorBox error={error} />
          <div className="row">
            {!draft ? <Button kind="primary" disabled={busy} onClick={startDraft}>Edit (create draft)</Button> : <>
              <Button kind="primary" disabled={busy || !dirty} onClick={save}>Save draft</Button>
              <Button disabled={busy} onClick={() => doPreview(todayIn(tz))}>Preview impact</Button>
              <Button disabled={busy || dirty} onClick={() => setPublishing(true)}>Publish…</Button>
              <Button kind="danger" disabled={busy} onClick={discard}>Discard draft</Button>
            </>}
            <div className="spacer" />
            {!isCompany && setting.current && <Button kind="ghost" disabled={busy} onClick={retire}>Retire override</Button>}
          </div>
          {preview && <Card title="Preview — nothing has been saved"><PreviewPanel preview={preview} fields={def.fields} /></Card>}
        </div>
      )}
      {publishing && <PublishModal draft={draft} onClose={() => setPublishing(false)} onPreview={doPreview} preview={preview} fields={def.fields}
        onDone={() => { setPublishing(false); setPreview(null); onChanged(); }} />}
    </Card>
  );
}

function PublishModal({ draft, onClose, onDone, onPreview, preview, fields }) {
  const { tz, toast } = useApp();
  const today = todayIn(tz);
  const [date, setDate] = useState(today);
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  useEffect(() => { onPreview(date); }, [date]); // eslint-disable-line react-hooks/exhaustive-deps
  const publish = async () => {
    setError(null);
    try {
      const r = await post(`/setting-versions/${draft.id}/publish`, { effectiveFrom: date, changeNote: note || undefined });
      toast(`Published v${r.version.version}, effective ${fmtDate(date)}.`);
      onDone();
    } catch (err) { setError(err); }
  };
  return (
    <Modal wide title="Publish this change" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={preview && !preview.validation.ok} onClick={publish}>Publish</Button></>}>
      <div className="stack">
        <div className="form-grid">
          <Input label="Effective from" type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)}
            help="Past dates are not allowed: attendance, leave and locked payroll before this date are never recalculated." />
          <Input label="Change note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why is this changing?" />
        </div>
        {preview && <PreviewPanel preview={preview} fields={fields} />}
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

function AddOverride({ def, subjectId, lookups, onClose, onDone }) {
  const [type, setType] = useState(def.scopes.find((s) => s !== 'company'));
  const [id, setId] = useState('');
  const [error, setError] = useState(null);
  const create = async () => {
    try { await post('/setting-versions', { key: def.key, subjectId, scopeType: type, scopeId: id, value: {} }); onDone(); }
    catch (err) { setError(err); }
  };
  return (
    <Modal title="Add an override" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={!id} onClick={create}>Create draft</Button></>}>
      <div className="stack">
        <p className="small muted">An override changes only the fields you tick; everything else keeps following the company rule. Priority: employee &gt; role &gt; employment type &gt; department &gt; company.</p>
        <Input as="select" label="Applies to" value={type} onChange={(e) => { setType(e.target.value); setId(''); }}>
          {def.scopes.filter((s) => s !== 'company').map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
        </Input>
        <Input as="select" label="Which one" value={id} onChange={(e) => setId(e.target.value)}>
          <option value="">Choose…</option>
          {(lookups?.[SCOPE_ENTITY[type]] ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </Input>
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

export default function Policies({ query }) {
  const lookups = useLookups();
  const { data: defs } = useLoad(() => get('/settings/definitions'), []);
  const key = query.key ?? 'wfh.policy';
  const def = defs?.find((d) => d.key === key);
  const subjects = def?.subjectTable ? lookups?.[SUBJECT_ENTITY[def.subjectTable]] : null;
  const subjectId = def?.subjectTable ? (query.subject ?? subjects?.[0]?.id) : null;
  const { data: list, loading, error, reload } = useLoad(() => (def && (!def.subjectTable || subjectId) ? get(`/settings${qs({ key, subjectId })}`) : Promise.resolve(null)), [key, subjectId, def?.key]);
  const [selected, setSelected] = useState(null);
  const [adding, setAdding] = useState(false);
  const rows = useMemo(() => list ?? [], [list]);
  useEffect(() => {
    if (!rows.length) { setSelected(null); return; }
    setSelected((cur) => rows.find((r) => r.id === cur?.id) ?? rows[0]);
  }, [rows]);
  const base = rows.find((r) => r.scope_type === 'company')?.current?.value ?? {};
  const go = (k, s) => navigate(`/settings/policies${qs({ key: k, subject: s })}`);

  return (
    <div className="stack lg">
      <PageHead title="Policies & rules" subtitle="Every rule is data: edit a draft, preview who is affected, then publish with an effective date." />
      <div className="settings-layout">
        <Card className="flush" style={{ padding: 8 }}>
          {SECTIONS.map(([section, keys]) => (
            <div key={section}>
              <div className="nav-section">{section}</div>
              {keys.map((k) => {
                const d = defs?.find((x) => x.key === k);
                return d && <a key={k} href={`#/settings/policies?key=${k}`} className={`nav-link ${k === key ? 'active' : ''}`}>{d.label}</a>;
              })}
            </div>
          ))}
        </Card>
        <div className="stack">
          {!def || !lookups ? <Loading /> : <>
            <div className="row between">
              <h2>{def.label}</h2>
              {subjects && (
                <select className="input" style={{ width: 'auto' }} aria-label="Record" value={subjectId ?? ''} onChange={(e) => go(key, e.target.value)}>
                  {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}{s.is_active ? '' : ' (disabled)'}</option>)}
                </select>
              )}
            </div>
            <div className="grid" style={{ gridTemplateColumns: 'minmax(200px, 240px) 1fr', alignItems: 'start' }}>
              <Card className="flush" style={{ padding: 8 }}>
                <div className="scope-list">
                  {rows.map((r) => (
                    <button key={r.id} className="scope-item" aria-current={selected?.id === r.id} onClick={() => setSelected(r)}>
                      <span>{scopeName(r, lookups)}</span>
                      <span className="meta">{r.draft ? 'Draft pending · ' : ''}{r.current ? `v${r.current.version}` : 'not in effect'}</span>
                    </button>
                  ))}
                  {def.scopes.length > 1 && <Button size="sm" icon="plus" onClick={() => setAdding(true)}>Add override</Button>}
                </div>
              </Card>
              {loading && !list ? <Loading /> : error ? <ErrorBox error={error} /> : selected
                ? <Editor def={def} setting={selected} base={base} lookups={lookups} onChanged={reload} />
                : <Card><Empty>No rule yet.</Empty></Card>}
            </div>
          </>}
        </div>
      </div>
      {adding && <AddOverride def={def} subjectId={subjectId} lookups={lookups} onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
    </div>
  );
}
