/**
 * Horizontal stacked bar chart (part-to-whole per row).
 * - Validated categorical slots (--series-1..4) in fixed order, never cycled.
 * - 2px surface gaps between segments; 4px rounded data-end; legend always shown;
 *   direct labels inside segments wide enough to hold them.
 * - Whole row is the hover/focus target; tooltip lists every series.
 * - "Table" toggle gives a non-visual view (and relief for low-contrast slots).
 */
import { useState } from 'react';
import { Button } from './ui.jsx';

export default function StackedBars({ rows, series, labelKey, unit = '', title }) {
  const [view, setView] = useState('chart');
  const [hover, setHover] = useState(null);
  const max = Math.max(1, ...rows.map((r) => series.reduce((s, x) => s + (r[x.key] ?? 0), 0)));
  return (
    <div className="stack">
      <div className="row between">
        <div className="legend" aria-hidden={view === 'table'}>
          {series.map((s, i) => <span key={s.key}><i style={{ background: `var(--series-${i + 1})` }} />{s.label}</span>)}
        </div>
        <Button size="sm" onClick={() => setView(view === 'chart' ? 'table' : 'chart')} aria-pressed={view === 'table'}>{view === 'chart' ? 'Table' : 'Chart'}</Button>
      </div>
      {view === 'table' ? (
        <div className="table-wrap"><table className="table">
          <caption className="sr-only">{title}</caption>
          <thead><tr><th>{labelKey.label}</th>{series.map((s) => <th key={s.key} className="num">{s.label}</th>)}<th className="num">Total</th></tr></thead>
          <tbody>{rows.map((r) => {
            const total = series.reduce((s, x) => s + (r[x.key] ?? 0), 0);
            return <tr key={r[labelKey.key]}><td>{r[labelKey.key]}</td>{series.map((s) => <td key={s.key} className="num">{r[s.key] ?? 0}</td>)}<td className="num">{total}</td></tr>;
          })}</tbody>
        </table></div>
      ) : (
        <div className="chart" role="img" aria-label={`${title}. Use the Table button for exact numbers.`} onMouseLeave={() => setHover(null)}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(90px, max-content) 1fr', gap: '10px 12px', alignItems: 'center' }}>
            {rows.map((r, ri) => {
              const total = series.reduce((s, x) => s + (r[x.key] ?? 0), 0);
              const segs = series.map((s, i) => ({ ...s, i, v: r[s.key] ?? 0 })).filter((s) => s.v > 0);
              return [
                <div key={`l${ri}`} className="small" style={{ color: 'var(--text-2)' }}>{r[labelKey.key]}</div>,
                <div key={`b${ri}`} tabIndex={0} onMouseEnter={() => setHover(ri)} onFocus={() => setHover(ri)} onBlur={() => setHover(null)}
                  style={{ position: 'relative', padding: '4px 0', outline: 'none' }} aria-label={`${r[labelKey.key]}: ${segs.map((s) => `${s.label} ${s.v}${unit}`).join(', ')}`}>
                  <div className="bar-track" style={{ display: 'flex', gap: 2, width: `${(total / max) * 100}%`, minWidth: total ? 4 : 0, height: 22, '--i': ri }}>
                    {segs.map((s, si) => (
                      <div key={s.key} style={{
                        flex: `${s.v} 0 0`, background: `var(--series-${s.i + 1})`, minWidth: 3,
                        borderStartEndRadius: si === segs.length - 1 ? 4 : 0, borderEndEndRadius: si === segs.length - 1 ? 4 : 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
                        color: s.i === 3 ? '#0b0b0b' : '#fff', fontSize: 11, fontWeight: 600, opacity: hover == null || hover === ri ? 1 : 0.55,
                      }}>{(s.v / max) > 0.08 ? s.v : ''}</div>
                    ))}
                  </div>
                  {hover === ri && (
                    <div className="tooltip" style={{ top: '100%', insetInlineStart: 0 }}>
                      <strong>{r[labelKey.key]}</strong>
                      {segs.map((s) => <div key={s.key} className="row between"><span><i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: `var(--series-${s.i + 1})`, marginInlineEnd: 6 }} />{s.label}</span><span className="num">{s.v}{unit}</span></div>)}
                      <div className="row between muted"><span>Total</span><span className="num">{total}{unit}</span></div>
                    </div>
                  )}
                </div>,
              ];
            })}
          </div>
        </div>
      )}
    </div>
  );
}
