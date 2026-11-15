import { useState } from 'react';
import { post, setToken } from '../lib/api.js';
import { useApp } from '../lib/app.jsx';
import { Alert, Button, ErrorBox, Modal, PasswordInput } from './ui.jsx';

/**
 * HR gives everyone without a login an Employee login with one starting password, which HR passes
 * on to them (no emails are sent). Each person changes it after signing in.
 */
export function BulkLoginsDialog({ count, onClose, onDone }) {
  const { toast } = useApp();
  const [password, setPassword] = useState('');
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await post('/employees/logins', { password });
      setResult(r);
      toast(`${r.created} ${r.created === 1 ? 'login' : 'logins'} created.`);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  if (result) {
    return (
      <Modal title="Logins created" onClose={onDone} footer={<Button kind="primary" onClick={onDone}>Done</Button>}>
        <div className="stack">
          <Alert kind="good" title={`${result.created} ${result.created === 1 ? 'person' : 'people'} can now sign in`}>
            They sign in with their email and the starting password you set. Tell them to change it from the menu under their name (Change password).
          </Alert>
          {result.noEmail.length > 0 && <Alert kind="warn" title="No email, so no login">{result.noEmail.join(', ')}. Add their email on their employee record, then run this again.</Alert>}
          {result.failed.length > 0 && <Alert kind="bad" title="Not done" items={result.failed.map((f) => `${f.name}: ${f.reason}`)} />}
        </div>
      </Modal>
    );
  }
  return (
    <Modal title={`Give logins to everyone (${count})`} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" icon="lock" disabled={busy || password.length < 8} onClick={save}>Create logins</Button></>}>
      <div className="stack">
        <p className="small" style={{ margin: 0 }}>Everyone active without a login gets an <strong>Employee</strong> login with their work email: they see only their own
          attendance, leave, tasks and payslips. No emails are sent.</p>
        <PasswordInput label="Starting password for everyone" autoComplete="new-password" help="At least 8 characters. Give it to them yourself; each person changes it after signing in."
          value={password} onChange={(e) => setPassword(e.target.value)} />
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}

/** Change my own password (the current one is checked). */
export function ChangePasswordDialog({ onClose }) {
  const { toast } = useApp();
  const [f, setF] = useState({ currentPassword: '', newPassword: '', repeat: '' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const mismatch = f.repeat && f.repeat !== f.newPassword;
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await post('/me/password', { currentPassword: f.currentPassword, newPassword: f.newPassword });
      if (r.token) setToken(r.token); // this session stays signed in; others end
      toast('Password changed.');
      onClose();
    } catch (e) { setErr(e); setBusy(false); }
  };
  return (
    <Modal title="Change password" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button kind="primary" disabled={busy || !f.currentPassword || f.newPassword.length < 8 || f.repeat !== f.newPassword} onClick={save}>Change password</Button></>}>
      <div className="stack">
        <PasswordInput label="Current password" autoComplete="current-password" value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} />
        <PasswordInput label="New password" autoComplete="new-password" help="At least 8 characters" value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} />
        <PasswordInput label="New password again" autoComplete="new-password" error={mismatch ? 'The two passwords are different.' : undefined}
          value={f.repeat} onChange={(e) => setF({ ...f, repeat: e.target.value })} />
        <p className="small muted" style={{ margin: 0 }}>You stay signed in here; you are signed out on other devices.</p>
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}
