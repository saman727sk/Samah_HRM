import { useState } from 'react';
import { post } from '../lib/api.js';
import AuthBackdrop from '../components/AuthBackdrop.jsx';
import { Alert, Button, ErrorBox, FullLogo, PasswordInput, PasswordStrength } from '../components/ui.jsx';

const MIN = 8;

/** Public: the page the emailed link opens; choose and confirm a new password. */
export default function ResetPassword({ query }) {
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(null);
  const mismatch = again.length > 0 && again !== pw;
  const ready = pw.length >= MIN && pw === again;
  const submit = async (e) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true); setErr(null);
    try { setDone(await post('/auth/password/reset', { token: query.token, password: pw })); }
    catch (x) { setErr(x); } finally { setBusy(false); }
  };
  if (!query.token) {
    return (
      <div className="login"><AuthBackdrop />
        <div className="card stack lg"><FullLogo /><Alert kind="bad" title="This link is incomplete">Open the link from the email again, or ask for a new one.</Alert>
          <a href="#/forgot" className="small">Ask for a new link</a></div>
      </div>
    );
  }
  return (
    <div className="login">
      <AuthBackdrop />
      {done ? (
        <div className="card stack lg">
          <FullLogo />
          <h1>Password changed</h1>
          <Alert kind="good" title="You can sign in with your new password">
            {done.email}{done.company ? ` · ${done.company}` : ''}. For your safety, you've been signed out on every other device.
          </Alert>
          <a href="#/" className="btn primary">Go to sign in</a>
        </div>
      ) : (
        <form className="card stack lg" onSubmit={submit}>
          <FullLogo />
          <div><h1>Choose a new password</h1><div className="muted small">Use the eye button to check what you typed.</div></div>
          <div>
            <PasswordInput label="New password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required autoFocus />
            <PasswordStrength value={pw} min={MIN} />
          </div>
          <PasswordInput label="Confirm new password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required
            error={mismatch ? "The two passwords don't match yet." : null} help={again && !mismatch ? '✓ Both passwords match' : null} />
          <ErrorBox error={err} />
          {err?.code === 'link_invalid' && <a href="#/forgot" className="small">Ask for a new link</a>}
          <Button kind="primary" type="submit" disabled={!ready || busy}>{busy ? 'Saving…' : 'Save new password'}</Button>
          <a href="#/" className="small">Back to sign in</a>
        </form>
      )}
    </div>
  );
}
