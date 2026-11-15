import { useState } from 'react';
import { get, put } from '../lib/api.js';
import { useApp } from '../lib/app.jsx';
import { PageHead } from '../components/Layout.jsx';
import { Card, Empty, ErrorBox, Input, Loading, useLoad } from '../components/ui.jsx';

/** Every personal feature (the server's PERSONAL_MODULES); null module_access = all of them. */
const ALL = ['attendance', 'wfh', 'leave', 'payroll', 'tasks'];

/** A manager (with the "choose team features" right) ticks which features each person in their team can use. */
export default function TeamFeatures() {
  const { toast, session } = useApp();
  const { data, error, loading, reload } = useLoad(() => get('/access/team'), []);
  const [busy, setBusy] = useState(null);
  const [q, setQ] = useState('');
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;

  const has = (p, m) => (p.module_access ?? ALL).includes(m);
  const set = async (p, next) => {
    setBusy(p.id);
    try {
      await put(`/access/team/${p.id}/features`, { modules: next });
      toast(`Saved for ${p.full_name}. They were notified.`);
      await reload();
    } catch (e) { toast(e.message, 'bad'); } finally { setBusy(null); }
  };
  const toggle = (p, m) => {
    const cur = p.module_access ?? ALL;
    set(p, cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m]);
  };
  const people = data.people.filter((p) => p.id !== session.user.employeeId)
    .filter((p) => !q || `${p.full_name} ${p.employee_code} ${p.department ?? ''} ${p.role ?? ''}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="stack lg">
      <PageHead title="Team features" subtitle="Choose which features each person in your team can use. They see only what is ticked." />
      <Card className="flush">
        <div style={{ padding: 14 }}><Input placeholder="Search your team" aria-label="Search your team" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        {people.length === 0 ? <Empty>Nobody works under you yet.</Empty> : (
          <div className="table-wrap"><table className="table features-grid">
            <thead><tr><th>Person</th>{data.modules.map((m) => <th key={m.key} className="center">{m.label}</th>)}<th /></tr></thead>
            <tbody>{people.map((p) => (
              <tr key={p.id} className={busy === p.id ? 'is-busy' : ''}>
                <td><strong>{p.full_name}</strong><div className="small muted">{[p.role, p.department].filter(Boolean).join(' · ') || p.employee_code}{p.manager_name ? ` · under ${p.manager_name}` : ''}</div></td>
                {data.modules.map((m) => (
                  <td key={m.key} className="center">
                    <input type="checkbox" aria-label={`${m.label} for ${p.full_name}`} checked={has(p, m.key)} disabled={busy === p.id} onChange={() => toggle(p, m.key)} />
                  </td>
                ))}
                <td className="nowrap small">{p.module_access == null ? <span className="muted">All on</span>
                  : <button type="button" className="link" disabled={busy === p.id} onClick={() => set(p, null)}>Turn all on</button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <p className="small muted" style={{ margin: 0 }}>Only features your company has switched on are shown. Payslips = seeing their own payslips. HR can change these too.</p>
    </div>
  );
}
