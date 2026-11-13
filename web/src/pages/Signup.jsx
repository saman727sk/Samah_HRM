import { useState } from 'react';
import { post } from '../lib/api.js';
import AuthBackdrop from '../components/AuthBackdrop.jsx';
import CurrencySelect from '../components/CurrencySelect.jsx';
import TimezoneSelect from '../components/TimezoneSelect.jsx';
import { Alert, Button, ErrorBox, FullLogo, Input, PasswordInput, PasswordStrength } from '../components/ui.jsx';

const browserTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Karachi'; } catch { return 'Asia/Karachi'; } };

/** Public: a company registers itself. Nothing is created until the emailed link is opened. */
export default function Signup() {
  const [f, setF] = useState({ companyName: '', ownerName: '', email: '', password: '', phone: '', country: '', timezone: browserTz(), currency: 'PKR' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState(null);
  const [devLink, setDevLink] = useState(null); // only while email isn't set up (development)
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try { const r = await post('/auth/signup', f); setDevLink(r.devLink ?? null); setSentTo(f.email); } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  if (sentTo) {
    return (
      <div className="login">
      <AuthBackdrop />
        <div className="card stack lg">
          <FullLogo />
          <h1>Check your email</h1>
          <Alert kind="good">We sent a confirmation link to <strong>{sentTo}</strong>. Open it within 24 hours to create your company.</Alert>
          {devLink && (
            <Alert kind="info" title="Testing mode: email isn't set up yet">
              The email can't be delivered, so here is its link: <a href={devLink}>Confirm {sentTo}</a>. This only appears until SMTP is configured.
            </Alert>
          )}
          <p className="small muted" style={{ margin: 0 }}>Nothing arrived? Check spam, or <button type="button" className="link" onClick={() => setSentTo(null)}>sign up again</button> to get a new link.</p>
          <a href="#/" className="small">Back to sign in</a>
        </div>
      </div>
    );
  }
  return (
    <div className="login">
      <AuthBackdrop />
      <form className="card stack lg" style={{ width: 'min(560px, 100%)' }} onSubmit={submit}>
        <FullLogo />
        <div><h1>Create your company</h1><div className="muted small">Free trial, no card needed</div></div>
        <div className="form-grid">
          <Input label="Company name" value={f.companyName} onChange={set('companyName')} required autoComplete="organization" />
          <Input label="Your name" value={f.ownerName} onChange={set('ownerName')} required autoComplete="name" />
          <Input label="Work email" type="email" value={f.email} onChange={set('email')} required autoComplete="email" />
          <div><PasswordInput label="Password" value={f.password} onChange={set('password')} required autoComplete="new-password" />{f.password && <PasswordStrength value={f.password} />}</div>
          <Input label="Phone (optional)" type="tel" value={f.phone} onChange={set('phone')} autoComplete="tel" />
          <Input label="Country (optional)" value={f.country} onChange={set('country')} autoComplete="country-name" />
          <TimezoneSelect label="Time zone" help="Attendance and payroll dates use it" value={f.timezone} onChange={(timezone) => setF({ ...f, timezone })} />
          <CurrencySelect help="Salaries and payslips use it" value={f.currency} onChange={(currency) => setF({ ...f, currency })} />
        </div>
        <ErrorBox error={err} />
        <Button kind="primary" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Create company'}</Button>
        <div className="small muted">You become the company's HR admin. Already have an account? <a href="#/">Sign in</a></div>
      </form>
    </div>
  );
}
