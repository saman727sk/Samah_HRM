import { useEffect, useRef, useState } from 'react';
import { useApp } from '../lib/app.jsx';
import AuthBackdrop from '../components/AuthBackdrop.jsx';
import { Alert, Button, FullLogo, Icon, Input, PRODUCT_NAME, PasswordInput } from '../components/ui.jsx';

export default function Login() {
  const { login, verifyOtp, resendOtp, provider, resetPassword, signupEnabled, toast } = useApp();
  const [otp, setOtp] = useState(null); // the second step: { challenge, email, expiresIn, company, devCode? }
  const [notice, setNotice] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // The email has a login in several companies: the server lists the ones this password opens.
  const [companies, setCompanies] = useState(null);
  const signIn = async (tenantId) => {
    setBusy(true);
    setError(null);
    try {
      const me = await login(email, password, tenantId);
      if (me?.otp) { setOtp(me.otp); setCompanies(null); return; }
      if (me) toast(me.tenant ? `Signed in to ${me.tenant.name}` : `Signed in to ${PRODUCT_NAME} as super admin`);
    } catch (err) {
      if (err.code === 'choose_company') setCompanies(err.details?.companies ?? []);
      else setError(err.message);
    } finally { setBusy(false); }
  };
  const submit = (e) => { e.preventDefault(); signIn(); };
  const edit = (setter) => (e) => { setter(e.target.value); setCompanies(null); };
  const forgot = async () => {
    setError(null); setNotice(null);
    if (!email) { setError('Enter your email first, then click "Forgot password?".'); return; }
    try { await resetPassword(email); setNotice(`If ${email} has an account, a password reset link is on its way.`); }
    catch (err) { setError(err.message); }
  };
  if (otp) {
    return (
      <div className="login">
        <AuthBackdrop />
        <OtpStep otp={otp} setOtp={setOtp} verifyOtp={verifyOtp} resendOtp={resendOtp} toast={toast}
          onBack={() => { setOtp(null); setPassword(''); }} />
      </div>
    );
  }
  return (
    <div className="login">
      <AuthBackdrop />
      <form className="card stack lg" onSubmit={submit}>
        <FullLogo />
        <div><h1>Sign in</h1><div className="muted small">Attendance, leave & payroll</div></div>
        {error && <Alert kind="bad">{error}</Alert>}
        {notice && <Alert kind="good">{notice}</Alert>}
        <Input label="Email" type="email" autoComplete="username" value={email} onChange={edit(setEmail)} required />
        <PasswordInput label="Password" autoComplete="current-password" value={password} onChange={edit(setPassword)} required />
        {companies ? (
          <div className="stack" role="group" aria-labelledby="choose-company">
            <div id="choose-company"><strong>Which company?</strong>
              <div className="small muted">{email} has a login in {companies.length} companies. Choose the one to sign in to.</div></div>
            {companies.map((c) => (
              <Button key={c.id} kind="primary" disabled={busy} onClick={() => signIn(c.id)}>{c.name}</Button>
            ))}
            <button type="button" className="link small" onClick={() => setCompanies(null)}>Use a different email</button>
          </div>
        ) : <Button kind="primary" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>}
        {provider === 'firebase'
          ? <button type="button" className="link small" onClick={forgot}>Forgot password?</button>
          : <a href="#/forgot" className="small forgot-link">Forgot password?</a>}
        {signupEnabled && <div className="small">New here? <a href="#/signup">Create a company account</a></div>}
      </form>
    </div>
  );
}

const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** Second step: the 6-digit code emailed after the password was right. */
function OtpStep({ otp, setOtp, verifyOtp, resendOtp, toast, onBack }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sentAt, setSentAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const input = useRef(null);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  useEffect(() => { input.current?.focus(); }, [sentAt]);
  const elapsed = Math.floor((now - sentAt) / 1000);
  const left = Math.max(0, otp.expiresIn - elapsed);
  const resendIn = Math.max(0, 30 - elapsed);

  const submit = async (value = code) => {
    if (busy || value.length !== 6) return;
    setBusy(true); setError(null);
    try {
      const me = await verifyOtp(otp.challenge, value);
      if (me) toast(me.tenant ? `Signed in to ${me.tenant.name}` : `Signed in to ${PRODUCT_NAME} as super admin`);
    } catch (err) {
      setError(err.message); setCode(''); setBusy(false);
      if (['otp_expired', 'otp_locked'].includes(err.code)) setTimeout(onBack, 3000); // a new sign-in is needed
      else setTimeout(() => input.current?.focus(), 0);
    }
  };
  const type = (e) => {
    const v = e.target.value.replace(/\D/g, '').slice(0, 6);
    setCode(v); setError(null);
    if (v.length === 6) submit(v); // typed or pasted the whole code
  };
  const resend = async () => {
    setError(null);
    try {
      const r = await resendOtp(otp.challenge);
      setOtp({ ...otp, ...r }); setSentAt(Date.now()); setNow(Date.now()); setCode('');
      toast(`A new code was sent to ${r.email}`);
    } catch (err) { setError(err.message); }
  };

  return (
    <form className="card stack lg otp-card" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <FullLogo />
      <div className="otp-head">
        <span className="otp-icon" aria-hidden="true"><Icon name="shield" size={26} /></span>
        <h1>Check your email</h1>
        <div className="muted small">
          We sent a 6-digit code to <strong>{otp.email}</strong>{otp.company ? <> for <strong>{otp.company}</strong></> : null}. Enter it to finish signing in.
        </div>
      </div>
      {otp.devCode && (
        <Alert kind="info" title="Testing mode (email is not set up)">
          Your code is <strong className="mono">{otp.devCode}</strong>. Once SMTP is set in server/.env, it arrives by email only.
        </Alert>
      )}
      {error && <Alert kind="bad">{error}</Alert>}
      <label className="otp-field">
        <span className="sr-only">6-digit code</span>
        <input ref={input} className="otp-input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*"
          maxLength={6} value={code} onChange={type} disabled={busy || left === 0} aria-describedby="otp-timer" />
        <span className="otp-slots" aria-hidden="true">
          {Array.from({ length: 6 }, (_, i) => (
            <span key={i} className={`otp-slot${i < code.length ? ' filled' : ''}${i === code.length && !busy ? ' current' : ''}`}>{code[i] ?? ''}</span>
          ))}
        </span>
      </label>
      <div id="otp-timer" className={`small otp-timer${left < 60 ? ' low' : ''}`}>
        {left > 0 ? <>Code expires in <strong>{mmss(left)}</strong></> : 'This code has expired. Ask for a new one.'}
      </div>
      <Button kind="primary" type="submit" disabled={busy || code.length !== 6 || left === 0}>{busy ? 'Checking…' : 'Verify and sign in'}</Button>
      <div className="row between small">
        <button type="button" className="link" onClick={onBack}>← Back to sign in</button>
        <button type="button" className="link" disabled={resendIn > 0} onClick={resend}>
          {resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}
        </button>
      </div>
    </form>
  );
}
