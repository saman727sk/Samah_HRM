/**
 * Every HR-managed list (no hardcoded enums). Items in use can't be deleted —
 * the server says so in plain language and HR disables them instead.
 */
import { lazy, Suspense, useState } from 'react';
import { del, get, patch, post } from '../../lib/api.js';
import { navigate, useApp } from '../../lib/app.jsx';
import { fmtDate, humanize } from '../../lib/format.js';
import { useConfirm } from '../../components/confirm.jsx';
import { PageHead } from '../../components/Layout.jsx';
import { Alert, Button, Card, Empty, ErrorBox, Input, Loading, Modal, Switch, useLoad } from '../../components/ui.jsx';

const GeofenceMap = lazy(() => import('../../components/GeofenceMap.jsx'));

const code = { key: 'code', label: 'Code', help: 'Short and permanent, e.g. SALES' };
const name = { key: 'name', label: 'Name' };
const ENTITIES = {
  departments: { label: 'Departments', fields: [code, name] },
  roles: { label: 'Roles / designations', fields: [code, name] },
  'employment-types': { label: 'Employment types', fields: [code, name] },
  locations: { label: 'Offices (geofences)', fields: [code, name, { key: 'address', label: 'Address' }, { key: 'lat', label: 'Latitude', type: 'number' },
    { key: 'lng', label: 'Longitude', type: 'number' }, { key: 'radius_m', label: 'Check-in radius (metres)', type: 'number' }], map: true },
  shifts: { label: 'Shifts', fields: [code, name], rules: 'shift.rules' },
  'leave-types': { label: 'Leave types', fields: [code, name, { key: 'color', label: 'Colour', type: 'color' }], rules: 'leave.type' },
  'holiday-calendars': { label: 'Holiday calendars', fields: [code, name, { key: 'is_default', label: 'Default calendar', type: 'bool' }] },
  holidays: { label: 'Public holidays', noCode: true, fields: [{ key: 'calendar_id', label: 'Calendar', type: 'ref', entity: 'holiday-calendars' },
    { key: 'date', label: 'Date', type: 'date' }, name, { key: 'is_optional', label: 'Optional holiday', type: 'bool' }, { key: 'note', label: 'Note' }] },
  'salary-components': { label: 'Salary components', fields: [code, name, { key: 'kind', label: 'Type', type: 'select', options: ['earning', 'deduction'] }] },
  'custom-fields': { label: 'Custom fields', noCode: true, fields: [
    { key: 'entity', label: 'Form', type: 'select', options: ['employee', 'leave_request', 'wfh_request'] }, { key: 'field_key', label: 'Field key', help: 'e.g. emergency_contact' },
    { key: 'label', label: 'Label' }, { key: 'field_type', label: 'Type', type: 'select', options: ['text', 'number', 'date', 'dropdown', 'file'] },
    { key: 'options', label: 'Dropdown options', type: 'list', help: 'Comma-separated' }, { key: 'required', label: 'Required', type: 'bool' }] },
  translations: { label: 'Labels & translations', noCode: true, noActive: true, fields: [
    { key: 'locale', label: 'Language', type: 'select', options: ['en', 'ur'] }, { key: 'key', label: 'Text key', help: 'e.g. status.wfh or nav.requests' },
    { key: 'value', label: 'Text' }] },
};

function ItemForm({ entity, spec, item, onClose, onSaved }) {
  const { toast } = useApp();
  const [v, setV] = useState(item ?? (spec.noActive ? {} : { is_active: true }));
  const [error, setError] = useState(null);
  const { data: refs } = useLoad(() => {
    const ref = spec.fields.find((f) => f.type === 'ref');
    return ref ? get(`/lookups/${ref.entity}`) : Promise.resolve([]);
  }, [entity]);
  const set = (k, x) => setV({ ...v, [k]: x });
  const [locating, setLocating] = useState(false);
  const [focus, setFocus] = useState(0);
  const [fix, setFix] = useState(null);
  /** Puts the office pin where this device is (stand inside the office). */
  const useMyLocation = () => {
    if (!navigator.geolocation) { toast('This browser cannot share its location.', 'bad'); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition((pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      setV((cur) => ({ ...cur, lat: Number(latitude.toFixed(6)), lng: Number(longitude.toFixed(6)) }));
      setFix(Math.round(accuracy));
      setFocus((n) => n + 1);
      setLocating(false);
    }, (err) => {
      setLocating(false);
      toast(err.code === 1 ? 'Location permission was denied. Allow it in the browser and try again.' : 'Could not get your location. Try again.', 'bad');
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  };
  const save = async () => {
    setError(null);
    try {
      const body = Object.fromEntries(Object.entries(v).filter(([k]) => spec.fields.some((f) => f.key === k) || k === 'is_active'));
      if (item) await patch(`/lookups/${entity}/${item.id}`, body); else await post(`/lookups/${entity}`, body);
      toast('Saved.'); onSaved();
    } catch (err) { setError(err); }
  };
  return (
    <Modal wide={spec.map} title={`${item ? 'Edit' : 'Add'} — ${spec.label}`} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" onClick={save}>Save</Button></>}>
      <div className="stack">
        <div className="form-grid">
          {spec.fields.map((f) => {
            const val = v[f.key];
            if (f.type === 'bool') return <div key={f.key} className="field"><span className="field-label">{f.label}</span><Switch label={val ? 'Yes' : 'No'} checked={val} onChange={(x) => set(f.key, x)} /></div>;
            if (f.type === 'select') return <Input key={f.key} as="select" label={f.label} value={val ?? ''} onChange={(e) => set(f.key, e.target.value)}><option value="">—</option>{f.options.map((o) => <option key={o} value={o}>{humanize(o)}</option>)}</Input>;
            if (f.type === 'ref') return <Input key={f.key} as="select" label={f.label} value={val ?? ''} onChange={(e) => set(f.key, e.target.value)}><option value="">—</option>{(refs ?? []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Input>;
            if (f.type === 'list') return <Input key={f.key} label={f.label} help={f.help} value={(val ?? []).join(', ')} onChange={(e) => set(f.key, e.target.value.split(',').map((x) => x.trim()).filter(Boolean))} />;
            return <Input key={f.key} label={f.label} help={f.help} type={f.type ?? 'text'} disabled={f.key === 'code' && item && ['leave-types', 'shifts'].includes(entity)}
              value={val ?? ''} onChange={(e) => set(f.key, f.type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value)} />;
          })}
        </div>
        {spec.map && (
          <div className="stack">
            <div className="row">
              <Button icon="map" onClick={useMyLocation} disabled={locating}>{locating ? 'Finding you…' : 'Use my current location'}</Button>
              <span className="small muted">Stand inside the office, or click the map to place the pin.</span>
            </div>
            {fix != null && (
              <Alert kind={fix > 100 ? 'warn' : 'good'}>
                Location accurate to about {fix} m.{fix > 100 ? ' Laptops without GPS guess from Wi-Fi, so this may be off. Check the pin is on the building, and drag the map or click to correct it.' : ''}
              </Alert>
            )}
            <Suspense fallback={<Loading />}><GeofenceMap lat={v.lat} lng={v.lng} radius={v.radius_m} focus={focus} onPick={(lat, lng) => setV({ ...v, lat, lng })} /></Suspense>
          </div>
        )}
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

export default function Lists({ query }) {
  const { toast } = useApp();
  const confirm = useConfirm();
  const entity = query.entity ?? 'departments';
  const spec = ENTITIES[entity];
  const { data, error, loading, reload } = useLoad(() => get(`/lookups/${entity}`), [entity]);
  const { data: calendars } = useLoad(() => (entity === 'holidays' ? get('/lookups/holiday-calendars') : Promise.resolve([])), [entity]);
  const [editing, setEditing] = useState(null);
  const toggle = async (item) => {
    if (item.is_active && !(await confirm({ title: `Disable “${item.name ?? item.label ?? item.key ?? 'this item'}”?`,
      message: 'It stays on existing records but is no longer offered for new ones. You can enable it again any time.', confirmLabel: 'Disable' }))) return;
    try { await patch(`/lookups/${entity}/${item.id}`, { is_active: !item.is_active }); reload(); } catch (err) { toast(err.message, 'bad'); }
  };
  const remove = async (item) => {
    if (!(await confirm({ title: `Delete “${item.name ?? item.label ?? item.key ?? 'this item'}”?`, danger: true, confirmLabel: 'Yes, delete', cancelLabel: 'No, keep it',
      message: 'This cannot be undone. If it is already used in records or rules, it will be refused: disable it instead.' }))) return;
    try { await del(`/lookups/${entity}/${item.id}`); toast('Deleted.'); reload(); } catch (err) { toast(err.message, 'bad'); }
  };
  const cols = spec.fields.filter((f) => !['help'].includes(f.key)).slice(0, 4);
  const cell = (item, f) => {
    const v = item[f.key];
    if (f.type === 'bool') return v ? 'Yes' : '—';
    if (f.type === 'date') return fmtDate(v);
    if (f.type === 'color') return <span style={{ display: 'inline-block', width: 14, height: 14, borderRadius: 4, background: v ?? 'transparent', border: '1px solid var(--border)' }} />;
    if (f.type === 'ref') return calendars?.find((c) => c.id === v)?.name ?? '—';
    if (Array.isArray(v)) return v.join(', ');
    return v ?? '—';
  };
  return (
    <div className="stack lg">
      <PageHead title="Lists & offices" subtitle="Add, rename or disable any list item. Items already used in records can only be disabled." />
      <div className="settings-layout">
        <Card className="flush" style={{ padding: 8 }}>
          {Object.entries(ENTITIES).map(([k, s]) => <a key={k} href={`#/settings/lists?entity=${k}`} className={`nav-link ${k === entity ? 'active' : ''}`}>{s.label}</a>)}
        </Card>
        <Card className="flush" title={spec.label} actions={<Button kind="primary" icon="plus" onClick={() => setEditing({})}>Add</Button>}>
          {loading && !data ? <Loading /> : error ? <ErrorBox error={error} /> : data.length === 0 ? <Empty>Nothing here yet.</Empty> : (
            <div className="table-wrap"><table className="table">
              <thead><tr>{cols.map((f) => <th key={f.key}>{f.label}</th>)}{!spec.noActive && <th>Active</th>}<th /></tr></thead>
              <tbody>{data.map((item) => (
                <tr key={item.id} style={{ opacity: item.is_active === false ? 0.55 : 1 }}>
                  {cols.map((f) => <td key={f.key}>{cell(item, f)}</td>)}
                  {!spec.noActive && <td><Switch label={item.is_active ? 'Active' : 'Disabled'} checked={item.is_active} onChange={() => toggle(item)} /></td>}
                  <td><div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                    {spec.rules && <Button size="sm" onClick={() => navigate(`/settings/policies?key=${spec.rules}&subject=${item.id}`)}>Rules</Button>}
                    <Button size="sm" onClick={() => setEditing(item)}>Edit</Button>
                    <Button size="sm" kind="danger" onClick={() => remove(item)}>Delete</Button>
                  </div></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
      </div>
      {editing && <ItemForm entity={entity} spec={spec} item={editing.id ? editing : null} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </div>
  );
}
