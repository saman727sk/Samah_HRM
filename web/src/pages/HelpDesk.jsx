import { useEffect, useRef, useState } from 'react';
import { get, post } from '../lib/api.js';
import { navigate, useApp } from '../lib/app.jsx';
import { fmtDate } from '../lib/format.js';
import { PageHead } from '../components/Layout.jsx';
import { Button, Card, Empty, ErrorBox, Icon, Input, Loading, Modal, useLoad } from '../components/ui.jsx';

const STATUS = { open: ['warn', 'Waiting for HR'], answered: ['info', 'Answered'], closed: ['', 'Closed'] };
const STATUS_HR = { open: ['warn', 'Needs reply'], answered: ['info', 'Answered'], closed: ['', 'Closed'] };
const when = (iso) => {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : fmtDate(iso.slice(0, 10), { day: 'numeric', month: 'short' });
};

/** Help desk: employees ask HR; HR sees everyone's requests and answers them. ?id= opens one. */
export default function HelpDesk({ query = {} }) {
  const { can, toast } = useApp();
  const isHr = can('helpdesk'); // HR, or help desk staff
  const [filter, setFilter] = useState(isHr ? 'open' : '');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const list = useLoad(() => get(`/helpdesk?${new URLSearchParams({ ...(filter && { status: filter }), ...(q && { q }) })}`), [filter, q]);
  const selected = query.id ?? null;
  const open = (id) => navigate(`/helpdesk?id=${id}`);
  const labels = isHr ? STATUS_HR : STATUS;
  const counts = list.data?.counts ?? {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div className="stack lg">
      <PageHead title="Help desk" subtitle={isHr ? 'Questions from your employees. Reply here; they are notified by email and in the app.' : 'Ask HR about your salary, leave, attendance, documents or anything else.'}
        actions={<Button kind="primary" icon="plus" onClick={() => setCreating(true)}>{isHr ? 'New request' : 'Ask HR'}</Button>} />
      <div className="helpdesk">
        <Card className="flush helpdesk-list">
          <div className="helpdesk-filters">
            <div className="tabs" role="tablist">
              {[['open', labels.open[1]], ['answered', 'Answered'], ['closed', 'Closed'], ['', 'All']].map(([v, l]) => (
                <button key={v || 'all'} role="tab" className="tab" aria-selected={filter === v} onClick={() => setFilter(v)}>
                  {l}{(v ? counts[v] : total) ? ` (${v ? counts[v] : total})` : ''}
                </button>
              ))}
            </div>
            {isHr && <Input placeholder="Search name, subject or #" aria-label="Search requests" value={q} onChange={(e) => setQ(e.target.value)} />}
          </div>
          {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} /> : list.data.tickets.length === 0
            ? <Empty>{filter === 'open' && isHr ? 'Nothing waiting for a reply.' : 'No requests here.'}</Empty>
            : (
              <ul className="ticket-list">
                {list.data.tickets.map((tk) => (
                  <li key={tk.id}>
                    <button type="button" className={`ticket-row ${selected === tk.id ? 'active' : ''}`} onClick={() => open(tk.id)}>
                      <div className="row between" style={{ flexWrap: 'nowrap' }}>
                        <strong className="ticket-subject">{tk.subject}</strong>
                        <span className="small muted" style={{ flex: 'none' }}>{when(tk.last_message_at)}</span>
                      </div>
                      <div className="row between small" style={{ flexWrap: 'nowrap' }}>
                        <span className="muted">#{tk.number}{isHr ? ` · ${tk.employee_name}` : ''} · {tk.messages} {tk.messages === 1 ? 'message' : 'messages'}</span>
                        <span className={`badge ${labels[tk.status][0]}`}>{labels[tk.status][1]}</span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </Card>
        {selected
          ? <Thread key={selected} id={selected} onChanged={list.reload} />
          : <Card className="helpdesk-empty"><Empty><Icon name="chat" size={28} /><div>{list.data?.tickets.length ? 'Choose a request to read and reply.' : isHr ? 'Requests from employees appear here.' : 'Ask HR anything: they reply here and you get an email.'}</div></Empty></Card>}
      </div>
      {creating && <NewTicket categories={list.data?.categories ?? []} onClose={() => setCreating(false)}
        onDone={(tk) => { setCreating(false); setFilter(''); list.reload(); open(tk.id); toast(`Request #${tk.number} sent to HR.`); }} />}
    </div>
  );
}

function Thread({ id, onChanged }) {
  const { can, session, toast } = useApp();
  const isHr = can('helpdesk');
  const { data: tk, loading, error, reload } = useLoad(() => get(`/helpdesk/${id}`), [id]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [tk?.messages?.length]);
  if (loading && !tk) return <Card><Loading /></Card>;
  if (error) return <Card><ErrorBox error={error} /></Card>;
  const mine = (m) => (isHr && tk.employee_id !== session.user.employeeId ? m.from_hr : !m.from_hr);
  const send = async () => {
    setBusy(true);
    try { await post(`/helpdesk/${id}/messages`, { body: text }); setText(''); reload(); onChanged(); }
    catch (e) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };
  const setStatus = async (status) => {
    try { await post(`/helpdesk/${id}/status`, { status }); reload(); onChanged(); toast(status === 'closed' ? 'Request closed.' : 'Request reopened.'); }
    catch (e) { toast(e.message, 'bad'); }
  };
  return (
    <Card className="flush thread">
      <header className="thread-head">
        <div style={{ minWidth: 0 }}>
          <h2 className="ticket-subject">{tk.subject}</h2>
          <div className="small muted">#{tk.number} · {tk.categoryLabel}{isHr ? ` · ${tk.employee_name} (${tk.employee_code}${tk.department ? `, ${tk.department}` : ''})` : ''} · opened {fmtDate(tk.created_at.slice(0, 10))}</div>
        </div>
        {tk.status === 'closed'
          ? <Button size="sm" onClick={() => setStatus('open')}>Reopen</Button>
          : <Button size="sm" icon="check" onClick={() => setStatus('closed')}>{isHr ? 'Close' : 'Close, it\'s sorted'}</Button>}
      </header>
      <div className="thread-body">
        {tk.messages.map((m) => (
          <div key={m.id} className={`bubble ${mine(m) ? 'mine' : ''} ${m.from_hr ? 'hr' : ''}`}>
            <div className="bubble-meta">{m.from_hr ? `${m.author} · HR` : m.author} · {new Date(m.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</div>
            <div className="bubble-text">{m.body}</div>
          </div>
        ))}
        <div ref={end} />
      </div>
      <footer className="thread-reply">
        {tk.status === 'closed' && <div className="small muted">This request is closed. Writing a reply opens it again.</div>}
        <textarea className="input" rows={3} placeholder="Write a reply…" aria-label="Reply" value={text} maxLength={5000}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim()) send(); }} />
        <div className="row between">
          <span className="small muted">Ctrl + Enter to send</span>
          <Button kind="primary" icon="send" disabled={busy || !text.trim()} onClick={send}>Send</Button>
        </div>
      </footer>
    </Card>
  );
}

function NewTicket({ categories, onClose, onDone }) {
  const [f, setF] = useState({ category: '', subject: '', body: '' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try { onDone(await post('/helpdesk', f)); } catch (e) { setErr(e); setBusy(false); }
  };
  return (
    <Modal title="Ask HR" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" icon="send" disabled={busy} onClick={submit}>Send to HR</Button></>}>
      <div className="stack">
        <Input as="select" label="What is it about?" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
          <option value="">Choose…</option>
          {categories.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </Input>
        <Input label="Subject" placeholder="e.g. Overtime missing on my February payslip" maxLength={150} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} />
        <Input label="Your question" as="textarea" rows={5} maxLength={5000} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
        <p className="small muted" style={{ margin: 0 }}>Only HR can read it. You'll get an email and a notification when they reply.</p>
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}
