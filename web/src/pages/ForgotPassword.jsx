import { useState } from 'react';
import { post } from '../lib/api.js';
import AuthBackdrop from '../components/AuthBackdrop.jsx';
import { Alert, Button, ErrorBox, FullLogo, Input } from '../components/ui.jsx';

/** Public: ask for a password reset link by email. */
export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(null); // { email, devLinks }
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try { const r = await post('/auth/password/forgot', { email }); setDone({ email, devLinks: r.devLinks }); }
    catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <div className="login">
      <AuthBackdrop />
      {done ? (
        <div className="card stack lg">
          <FullLogo />
          <div><h1>Check your email</h1><div className="muted small">The link works once, for 1 hour.</div></div>
          <Alert kind="good">If <strong>{done.email}</strong> has an account, we've sent a link to choose a new password. Check spam if you don't see it in a minute.</Alert>
          {done.devLinks?.length > 0 && (
            <Alert kind="info" title="Testing mode: email isn't set up yet">
              The email can't be delivered, so here {done.devLinks.length === 1 ? 'is its link' : 'are its links'}:
              <ul style={{ margin: '6px 0 0' }}>{done.devLinks.map((l) => <li key={l.link}><a href={l.link}>Reset password{done.devLinks.length > 1 ? ` (${l.company})` : ''}</a></li>)}</ul>
              This only appears until SMTP is configured.
            </Alert>
          )}
          <div className="row between">
            <button type="button" className="link small" onClick={() => setDone(null)}>Send again</button>
            <a href="#/" className="small">Back to sign in</a>
          </div>
        </div>
      ) : (
        <form className="card stack lg" onSubmit={submit}>
          <FullLogo />
          <div><h1>Forgot your password?</h1><div className="muted small">Enter the email you sign in with and we'll send you a link to choose a new one.</div></div>
          <Input label="Email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          <ErrorBox error={err} />
          <Button kind="primary" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</Button>
          <a href="#/" className="small">Back to sign in</a>
        </form>
      )}
    </div>
  );
}
