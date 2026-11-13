import { useEffect, useState } from 'react';
import { get, put } from '../../lib/api.js';
import { useApp } from '../../lib/app.jsx';
import { fmtDate, humanize } from '../../lib/format.js';
import { useConfirm } from '../../components/confirm.jsx';
import { PageHead } from '../../components/Layout.jsx';
import { Button, Empty, ErrorBox, Icon, Input, Loading, Switch, useLoad } from '../../components/ui.jsx';

export default function PlatformSettings() {
  const [tab, setTab] = useState('billing');
  return (
    <div className="stack lg settings-page">
      <PageHead title={<span className="gold-text">Platform settings</span>} subtitle="How companies join, pay and are reminded, and everything you have done." />
      <div className="view-toggle settings-tabs" role="tablist" aria-label="Settings sections">
        <button type="button" role="tab" aria-selected={tab === 'billing'} aria-pressed={tab === 'billing'} onClick={() => setTab('billing')}><Icon name="settings" size={15} />Rules</button>
        <button type="button" role="tab" aria-selected={tab === 'audit'} aria-pressed={tab === 'audit'} onClick={() => setTab('audit')}><Icon name="history" size={15} />Audit log</button>
      </div>
      <div key={tab} className="page-enter">{tab === 'billing' ? <BillingSettings /> : <PlatformAudit />}</div>
    </div>
  );
}

/** A titled group of settings with an icon. */
function Section({ icon, title, text, children, index = 0 }) {
  return (
    <section className="setting-section" style={{ '--i': index }}>
      <header>
        <span className="setting-icon"><Icon name={icon} size={18} /></span>
        <div><h2>{title}</h2><p>{text}</p></div>
      </header>
      <div className="setting-body">{children}</div>
    </section>
  );
}

/** One on/off setting: what it does on the left, the switch on the right. */
function ToggleRow({ title, text, checked, onChange }) {
  return (
    <div className="toggle-row">
      <div><strong>{title}</strong><span>{text}</span></div>
      <Switch label={<span className="sr-only">{title}</span>} checked={checked} onChange={onChange} />
    </div>
  );
}

function BillingSettings() {
  const { toast } = useApp();
  const confirm = useConfirm();
  const settings = useLoad(() => get('/admin/billing-settings'), []);
  const plans = useLoad(() => get('/admin/plans'), []);
  const [f, setF] = useState(null);
  const [saved, setSaved] = useState(null); // what the server has, to know about unsaved changes
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (settings.data) { setF(settings.data); setSaved(settings.data); } }, [settings.data]);
  if (settings.error) return <ErrorBox error={settings.error} />;
  if (!f) return <Loading />;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const dirty = JSON.stringify(f) !== JSON.stringify(saved);
  const save = async () => {
    if (saved.signupRequiresApproval !== false && f.signupRequiresApproval === false && f.signupEnabled !== false && !(await confirm({
      title: 'Let new companies in without approval?', danger: true, confirmLabel: 'Turn approval off',
      message: 'Anyone who signs up and confirms an email can start using the system immediately, without you reviewing them first.' }))) return;
    if (saved.loginOtp === true && f.loginOtp !== true && !(await confirm({
      title: 'Turn off the sign-in code?', danger: true, confirmLabel: 'Turn it off',
      message: 'Anyone who knows or guesses a password could then sign in. Keep it on unless email is not working.' }))) return;
    if (saved.loginOtp !== true && f.loginOtp === true && !(await confirm({
      title: 'Turn on the sign-in code?', confirmLabel: 'Turn it on',
      message: 'Everyone, including you, will need a code from their email to sign in. Make sure your own login email is a real inbox you can open, and that email (SMTP) is set up.' }))) return;
    setBusy(true);
    try { const next = await put('/admin/billing-settings', f); setF(next); setSaved(next); setErr(null); toast('Settings saved.'); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <div className="stack lg">
      <div className="settings-grid">
        <Section index={0} icon="users" title="Joining & signing in" text="Public sign-up, whether you review new companies first, and the emailed sign-in code.">
          <ToggleRow title="Companies can sign up themselves" text="Shows “Create a company account” on the sign-in page."
            checked={f.signupEnabled !== false} onChange={(on) => setF({ ...f, signupEnabled: on })} />
          <ToggleRow title="I approve new companies first" text="A new company can't sign in until you approve it under Companies."
            checked={f.signupRequiresApproval !== false} onChange={(on) => setF({ ...f, signupRequiresApproval: on })} />
          <ToggleRow title="Email a code at sign-in (OTP)" text="After the password, everyone (you too) enters a 6-digit code sent to their email. Needs working email."
            checked={f.loginOtp === true} onChange={(on) => setF({ ...f, loginOtp: on })} />
        </Section>

        <Section index={1} icon="calendar" title="Free trial" text="The plan every new company starts on, and when they are reminded it ends.">
          <Input label="Plan for new companies" as="select" value={f.trialPlanCode} onChange={set('trialPlanCode')}>
            {(plans.data ?? []).filter((p) => p.status === 'active').map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
          </Input>
          <Input label="Remind them this many days before the trial ends" type="number" min="0" max="30" value={f.trialReminderDays} onChange={set('trialReminderDays')} />
        </Section>

        <Section index={2} icon="file" title="Invoices & tax" text="When invoices fall due, how long companies keep working after that, and tax on new invoices.">
          <div className="form-grid">
            <Input label="Days to pay an invoice" type="number" min="0" max="90" value={f.invoiceDueDays} onChange={set('invoiceDueDays')} />
            <Input label="Grace days after the due date" type="number" min="0" max="90" help="Then the company is paused" value={f.graceDays} onChange={set('graceDays')} />
            <Input label="Tax rate (%)" type="number" min="0" max="100" step="0.01" value={f.taxRate} onChange={set('taxRate')} />
            <Input label="Tax name on invoices" value={f.taxLabel} onChange={set('taxLabel')} />
          </div>
          <div className="setting-note"><Icon name="info" size={14} />An invoice due on day 7 with 7 grace days: past due from day 8 (still working), paused from day 15.</div>
        </Section>

        <Section index={3} icon="money" title="Getting paid" text="What companies see on their Subscription page so they can reach you and pay.">
          <Input label="Support / billing email" type="email" value={f.supportEmail ?? ''} onChange={set('supportEmail')} />
          <Input label="Payment instructions" as="textarea" rows={4} help="E.g. bank account title, IBAN, and the invoice number as the payment reference"
            value={f.paymentInstructions ?? ''} onChange={set('paymentInstructions')} />
        </Section>
      </div>
      <ErrorBox error={err} />
      {dirty && (
        <div className="save-bar" role="region" aria-label="Unsaved changes">
          <span><Icon name="alert" size={16} />You have unsaved changes</span>
          <div className="row" style={{ gap: 8 }}>
            <Button disabled={busy} onClick={() => { setF(saved); setErr(null); }}>Discard</Button>
            <Button kind="primary" icon="check" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Colour of an audit entry by what kind of action it was. */
const tone = (action) => {
  if (/rejected|suspended|deleted|voided|cancel/.test(action)) return 'bad';
  if (/approved|reactivated|payment_recorded|resumed/.test(action)) return 'good';
  if (action.startsWith('plan.')) return 'info';
  if (action.startsWith('billing.') || action.startsWith('subscription.')) return 'gold';
  return 'muted';
};

function PlatformAudit() {
  const { data, loading, error } = useLoad(() => get('/admin/audit'), []);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data.length) return <Empty>Nothing yet.</Empty>;
  // Grouped by day, newest first
  const days = [];
  for (const a of data) {
    const day = a.created_at.slice(0, 10);
    if (days.at(-1)?.day !== day) days.push({ day, items: [] });
    days.at(-1).items.push(a);
  }
  return (
    <div className="timeline">
      {days.map((d) => (
        <section key={d.day} className="timeline-day">
          <h3>{fmtDate(d.day, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</h3>
          <ol>
            {d.items.map((a) => (
              <li key={a.id} className={`tl-item tone-${tone(a.action)}`}>
                <span className="tl-dot" aria-hidden="true" />
                <div className="tl-card">
                  <div className="row between" style={{ gap: 8 }}>
                    <strong>{humanize(a.action.replace('.', ': '))}</strong>
                    <span className="small muted">{new Date(a.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  <div className="small muted">
                    {a.company ?? 'Platform'} · {a.actor_email ?? 'System'}{a.meta?.reason ? ` · “${a.meta.reason}”` : ''}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
