/**
 * Renders any setting from the field list the server derives from its
 * validators (GET /settings/definitions). No setting-specific UI code.
 *
 * Override mode (department / role / employee scopes): each field shows the
 * inherited value until "Override" is ticked; only ticked fields are saved.
 */
import { useRef, useState } from 'react';
import { get, post } from '../lib/api.js';
import { fmtMoney, getPath, humanize, setPath, WEEKDAYS } from '../lib/format.js';
import { Alert, Button, Icon, Switch, useLoad } from './ui.jsx';

// Formula builder data (values, functions, components) is the same for every field; load it once.
let metaPromise = null;
const loadMeta = () => (metaPromise ??= get('/payroll/formula/meta').catch((err) => { metaPromise = null; throw err; }));

function FormulaInput({ id, value, onChange, disabled }) {
  const ref = useRef(null);
  const { data: meta } = useLoad(loadMeta, []);
  const { data: employees } = useLoad(() => (disabled ? Promise.resolve([]) : get('/employees')), [disabled]);
  const [employeeId, setEmployeeId] = useState('');
  const [period, setPeriod] = useState('');
  const [result, setResult] = useState(null);
  const insert = (text) => {
    const el = ref.current;
    const v = value ?? '';
    const start = el?.selectionStart ?? v.length;
    const end = el?.selectionEnd ?? v.length;
    onChange(v.slice(0, start) + text + v.slice(end));
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(start + text.length, start + text.length); });
  };
  const test = async () => {
    try { setResult(await post('/payroll/formula/test', { formula: value ?? '', employeeId: employeeId || null, period: period || null })); }
    catch (err) { setResult({ ok: false, error: err.message }); }
  };
  const groups = meta ? [
    ['Attendance & salary', Object.entries(meta.inputs)],
    ['Totals', Object.entries(meta.totals)],
    ['Components', meta.components.map((c) => [c.code, `${c.name} (${c.kind})`])],
    ['Full monthly salary amounts', meta.components.filter((c) => c.calculation === 'structure').map((c) => [`STRUCT_${c.code}`, `${c.name} before pro-rating`])],
    ['Payroll variables', Object.entries(meta.variables).map(([k, v]) => [k, String(v)])],
    ['Functions', Object.entries(meta.functions).map(([k, help]) => [`${k}(`, help])],
  ] : [];
  return (
    <div className="stack" style={{ gap: 6 }}>
      <textarea id={id} ref={ref} className="input formula" spellCheck={false} disabled={disabled} value={value ?? ''}
        placeholder="e.g. round(ABSENT_DAYS * DAILY_RATE)" onChange={(e) => { onChange(e.target.value === '' ? null : e.target.value); setResult(null); }} />
      {!disabled && meta && (
        <details>
          <summary className="small">Insert a value or function</summary>
          <div className="stack" style={{ gap: 6, marginTop: 6 }}>
            {groups.filter(([, items]) => items.length).map(([label, items]) => (
              <div key={label}>
                <div className="small muted">{label}</div>
                <div className="formula-names">{items.map(([name, help]) => (
                  <button key={name} type="button" className="chip" title={help} onClick={() => insert(name)}>{name}</button>
                ))}</div>
              </div>
            ))}
            <div className="small muted">Operators: + − * / % ^, comparisons &lt; &lt;= &gt; &gt;= == !=, and / or / not. A comparison gives 1 or 0.</div>
          </div>
        </details>
      )}
      {!disabled && (
        <div className="row" style={{ gap: 8 }}>
          <select className="input" style={{ width: 'auto' }} aria-label="Test with employee" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">Check only</option>
            {(employees ?? []).map((e) => <option key={e.id} value={e.id}>Test with {e.full_name}</option>)}
          </select>
          {employeeId && <input className="input" style={{ width: 'auto' }} type="month" aria-label="Test month" value={period} onChange={(e) => setPeriod(e.target.value)} />}
          <Button size="sm" onClick={test} disabled={!value}>Test formula</Button>
        </div>
      )}
      {result && (result.ok
        ? <Alert kind="good" title={result.value !== undefined ? `= ${fmtMoney(result.value)} for ${result.employee}, ${result.period}` : result.note ?? 'The formula is valid.'}>
            {result.values && Object.keys(result.values).length > 0 && <div className="mono">{Object.entries(result.values).map(([k, v]) => `${k} = ${fmtMoney(v)}`).join(' · ')}</div>}
          </Alert>
        : <Alert kind="bad" title={result.error} />)}
    </div>
  );
}

/** Named formulas, e.g. DAILY_RATE = MONTHLY_SALARY / CALENDAR_DAYS. */
function FormulaMap({ value, onChange, disabled }) {
  const entries = Object.entries(value ?? {});
  const update = (i, k, v) => onChange(Object.fromEntries(entries.map((e, j) => (j === i ? [k, v] : e))));
  const toValue = (s) => (/^-?\d+(\.\d+)?$/.test(s.trim()) ? Number(s) : s);
  return (
    <div className="stack" style={{ gap: 6 }}>
      {entries.length > 0 && (
        <table className="table">
          <thead><tr><th>Name</th><th>Formula or number</th><th /></tr></thead>
          <tbody>{entries.map(([k, v], i) => (
            <tr key={i}>
              <td style={{ width: 200 }}><input className="input mono" aria-label="Variable name" disabled={disabled} value={k}
                onChange={(e) => update(i, e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''), v)} /></td>
              <td><input className="input mono" aria-label={`Formula for ${k}`} disabled={disabled} value={String(v)} onChange={(e) => update(i, k, toValue(e.target.value))} /></td>
              <td><button type="button" className="icon-btn" disabled={disabled} aria-label="Remove variable"
                onClick={() => onChange(Object.fromEntries(entries.filter((_, j) => j !== i)))}><Icon name="x" size={16} /></button></td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {!disabled && <div><Button size="sm" icon="plus" onClick={() => onChange({ ...(value ?? {}), [`VAR_${entries.length + 1}`]: 0 })}>Add variable</Button></div>}
    </div>
  );
}

function NumberInput({ value, onChange, f, disabled, id }) {
  return (
    <input id={id} className="input" type="number" disabled={disabled} min={f.min} max={f.max} step={f.type === 'int' ? 1 : 'any'}
      value={value ?? ''} placeholder={f.nullable ? 'Empty = none' : undefined}
      onChange={(e) => onChange(e.target.value === '' ? (f.nullable ? null : undefined) : Number(e.target.value))} />
  );
}

function Chips({ options, value = [], onChange, disabled }) {
  return (
    <div className="chips">
      {options.map((o) => {
        const on = value.includes(o.value);
        return <button key={String(o.value)} type="button" className="chip" aria-pressed={on} disabled={disabled}
          onClick={() => onChange(on ? value.filter((x) => x !== o.value) : [...value, o.value])}>{o.label}</button>;
      })}
    </div>
  );
}

function Rows({ f, value = [], onChange, disabled }) {
  const cols = f.columns ?? [];
  const blank = Object.fromEntries(cols.map((c) => [c.key, c.type === 'int' || c.type === 'num' ? 0 : c.type === 'select' ? c.options[0] : '']));
  const update = (i, k, v) => onChange(value.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <div className="stack" style={{ gap: 6 }}>
      {value.length > 0 && (
        <table className="table">
          <thead><tr>{cols.map((c) => <th key={c.key}>{c.label}</th>)}<th /></tr></thead>
          <tbody>{value.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c.key}>
                  {c.type === 'select'
                    ? <select className="input" disabled={disabled} value={r[c.key]} aria-label={c.label} onChange={(e) => update(i, c.key, e.target.value)}>{c.options.map((o) => <option key={o} value={o}>{humanize(o)}</option>)}</select>
                    : <input className="input" disabled={disabled} aria-label={c.label} type={c.type === 'date' ? 'date' : c.type === 'int' || c.type === 'num' ? 'number' : 'text'}
                      value={r[c.key] ?? ''} onChange={(e) => update(i, c.key, c.type === 'int' || c.type === 'num' ? Number(e.target.value) : e.target.value)} />}
                </td>
              ))}
              <td><button type="button" className="icon-btn" disabled={disabled} aria-label="Remove row" onClick={() => onChange(value.filter((_, j) => j !== i))}><Icon name="x" size={16} /></button></td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {!disabled && <div><Button size="sm" icon="plus" onClick={() => onChange([...value, blank])}>Add</Button></div>}
    </div>
  );
}

function FieldInput({ f, value, onChange, disabled, lookups, id }) {
  switch (f.type) {
    case 'bool': return <Switch label={value ? 'Yes' : 'No'} checked={value} onChange={onChange} disabled={disabled} />;
    case 'int': case 'num': return <NumberInput id={id} f={f} value={value} onChange={onChange} disabled={disabled} />;
    case 'select': return (
      <select id={id} className="input" disabled={disabled} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        {value == null && <option value="">—</option>}
        {f.options.map((o) => <option key={o} value={o}>{humanize(o)}</option>)}
      </select>
    );
    case 'time': return <input id={id} className="input" type="time" disabled={disabled} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'date': return <input id={id} className="input" type="date" disabled={disabled} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'text': return <input id={id} className="input" disabled={disabled} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'weekdays': return <Chips disabled={disabled} value={value} onChange={(v) => onChange([...v].sort())} options={[1, 2, 3, 4, 5, 6, 0].map((d) => ({ value: d, label: WEEKDAYS[d] }))} />;
    case 'multi': return <Chips disabled={disabled} value={value} onChange={onChange} options={f.options.map((o) => ({ value: o, label: humanize(o) }))} />;
    case 'refs': return <Chips disabled={disabled} value={value} onChange={onChange} options={(lookups[f.entity] ?? []).map((r) => ({ value: r.id, label: r.name }))} />;
    case 'rows': return <Rows f={f} value={value} onChange={onChange} disabled={disabled} />;
    case 'formula': return <FormulaInput id={id} value={value} onChange={onChange} disabled={disabled} />;
    case 'formula-map': return <FormulaMap value={value} onChange={onChange} disabled={disabled} />;
    default: return <code>{JSON.stringify(value)}</code>;
  }
}

export default function SettingForm({ fields, value, onChange, inherited, lookups = {}, errors = {}, readOnly }) {
  const override = inherited !== undefined && inherited !== null;
  return (
    <div>
      {fields.map((f, i) => {
        const own = getPath(value, f.path);
        const isSet = own !== undefined;
        const shown = override && !isSet ? getPath(inherited, f.path) : own;
        const heading = f.group && f.group !== fields[i - 1]?.group ? <div className="group-title">{f.groupLabel ?? humanize(f.group)}</div> : null;
        const id = `f-${f.path}`;
        const wide = ['rows', 'weekdays', 'multi', 'refs', 'formula', 'formula-map'].includes(f.type);
        return (
          <div key={f.path}>
            {heading}
            <div className={`field override-field ${override && isSet ? 'on' : ''}`} style={{ marginBottom: 14, maxWidth: wide ? 'none' : 420 }}>
              <div className="row between">
                <label htmlFor={id} className="field-label">{f.label}</label>
                {override && !readOnly && (
                  <label className="small row" style={{ gap: 6 }}>
                    <input type="checkbox" checked={isSet} onChange={(e) => onChange(setPath(value, f.path, e.target.checked ? structuredClone(getPath(inherited, f.path) ?? null) : undefined))} />
                    Override
                  </label>
                )}
              </div>
              <FieldInput id={id} f={f} value={shown} lookups={lookups} disabled={readOnly || (override && !isSet)}
                onChange={(v) => onChange(setPath(value, f.path, v === undefined && !override ? null : v))} />
              {errors[f.path] ? <div className="error" role="alert">{errors[f.path]}</div>
                : override && !isSet ? <div className="help">Inherited from the company rule</div>
                  : f.help ? <div className="help">{f.help}</div> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
