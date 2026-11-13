/* eslint-disable react/only-export-components */
/** Small, accessible building blocks shared by every page. */
import { useEffect, useId, useState } from 'react';
import { useApp } from '../lib/app.jsx';
import { CountUp } from './motion.jsx';

const ICONS = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  send: 'M22 2 11 13M22 2l-7 20-4-9-9-4z',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  check: 'M20 6 9 17l-5-5',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
  chart: 'M3 3v18h18M7 15l4-4 3 3 5-6',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.54V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.54-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.54V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.54 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z',
  bell: 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42',
  moon: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  menu: 'M3 12h18M3 6h18M3 18h18',
  x: 'M18 6 6 18M6 6l12 12',
  plus: 'M12 5v14M5 12h14',
  alert: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  printer: 'M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z',
  map: 'M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0zM12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  home2: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  history: 'M3 3v5h5M3.05 13A9 9 0 1 0 6 5.3L3 8M12 7v5l4 2',
  money: 'M2 6h20v12H2zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 12h.01M18 12h.01',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  refresh: 'M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24M1 1l22 22',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
};

export function Icon({ name, size = 18, title }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d={ICONS[name]} />
    </svg>
  );
}

export const Button = ({ kind, size, icon, children, ...rest }) => (
  <button type="button" className={['btn', kind, size].filter(Boolean).join(' ')} {...rest}>
    {icon && <Icon name={icon} size={16} />}{children}
  </button>
);

export const Card = ({ title, actions, children, className = '', ...rest }) => (
  <section className={`card ${className}`} {...rest}>
    {(title || actions) && <header>{typeof title === 'string' ? <h2>{title}</h2> : title}<div className="row">{actions}</div></header>}
    {children}
  </section>
);

export const Stat = ({ label, value, sub, icon }) => (
  <div className="stat">
    <div className="label">{icon}{label}</div>
    <div className="value">{typeof value === 'number' ? <CountUp value={value} /> : value}</div>
    {sub && <div className="sub">{sub}</div>}
  </div>
);

export function Field({ label, help, error, children, htmlFor }) {
  return (
    <div className="field">
      {label && <label htmlFor={htmlFor}>{label}</label>}
      {children}
      {error ? <div className="error" role="alert">{error}</div> : help ? <div className="help">{help}</div> : null}
    </div>
  );
}

/** Labelled input that wires id/aria for accessibility. */
export function Input({ label, help, error, as = 'input', children, ...rest }) {
  const id = useId();
  const Tag = as;
  return (
    <Field label={label} help={help} error={error} htmlFor={id}>
      <Tag id={id} className="input" aria-invalid={error ? 'true' : undefined} {...rest}>{children}</Tag>
    </Field>
  );
}

/** A password field with a show / hide button, so people can check what they typed. */
export function PasswordInput({ label, help, error, ...rest }) {
  const id = useId();
  const [show, setShow] = useState(false);
  return (
    <Field label={label} help={help} error={error} htmlFor={id}>
      <div className="password-box">
        <input id={id} className="input" type={show ? 'text' : 'password'} aria-invalid={error ? 'true' : undefined} {...rest} />
        <button type="button" className="password-eye" onClick={() => setShow(!show)} aria-pressed={show} aria-controls={id}
          aria-label={show ? 'Hide password' : 'Show password'} title={show ? 'Hide password' : 'Show password'}>
          <Icon name={show ? 'eyeOff' : 'eye'} size={17} />
        </button>
      </div>
    </Field>
  );
}

/** How strong a new password is, with the rules it meets (shown while choosing one). */
export function PasswordStrength({ value = '', min = 8 }) {
  const rules = [
    [value.length >= min, `At least ${min} characters`],
    [/[a-z]/.test(value) && /[A-Z]/.test(value), 'Upper and lower case letters'],
    [/\d/.test(value), 'A number'],
    [/[^A-Za-z0-9]/.test(value), 'A symbol such as ! @ # $'],
  ];
  const score = value ? rules.filter(([ok]) => ok).length + (value.length >= 12 ? 1 : 0) : 0;
  const level = ['', 'Weak', 'Weak', 'Fair', 'Good', 'Strong'][score];
  return (
    <div className="pw-strength" aria-live="polite">
      <div className={`pw-bar s${score}`}><span /><span /><span /><span /><span /></div>
      {value && <div className="small"><strong>{level}</strong> password</div>}
      <ul>{rules.map(([ok, text]) => <li key={text} className={ok ? 'ok' : ''}>{text}</li>)}</ul>
    </div>
  );
}

export const Switch = ({ label, checked, onChange, disabled }) => (
  <label className="switch">
    <input type="checkbox" role="switch" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    <span>{label}</span>
  </label>
);

export function Modal({ title, onClose, children, footer, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header><h2>{title}</h2><button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button></header>
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" className="tab" aria-selected={value === t.value} onClick={() => onChange(t.value)}>{t.label}</button>
      ))}
    </div>
  );
}

export const PRODUCT_NAME = 'Samah HRM';

/** The full logo with the "Samah HRM" wordmark (web/public/logo-full.png), for the sign-in pages. */
// Two versions: the dark one has lighter greens so it reads on a dark page; CSS shows the one matching the theme.
export const FullLogo = () => (
  <div className="full-logo-wrap">
    <img src="/logo-full.png" alt={PRODUCT_NAME} className="full-logo on-light" />
    <img src="/logo-full-dark.png" alt="" aria-hidden="true" className="full-logo on-dark" />
    <span className="full-logo-sheen" aria-hidden="true" />
  </div>
);

/** The product's SA mark (web/public/logo.png), for small places. */
export const Logo = ({ size = 'md' }) => <img src="/logo.png" alt={PRODUCT_NAME} className={`brand-logo ${size}`} />;

/** Logo URL of a company row from the API (tenants.logo_updated_at), or null. */
export const companyLogoUrl = (row) => (row?.logo_updated_at ? `/api/logos/${row.id}?v=${Date.parse(row.logo_updated_at)}` : null);

/** A company's own logo, or its initials when it has none (company screens never show the platform's logo). */
export function CompanyLogo({ company, size = 'sm' }) {
  if (company?.logoUrl) return <img src={company.logoUrl} alt={company.name} className={`brand-logo ${size}`} />;
  const initials = (company?.name ?? '?').split(/s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return <span className={`company-mark ${size}`} aria-hidden="true">{initials}</span>;
}

export const Spinner = () => <span className="spinner" role="status" aria-label="Loading" />;
export const Loading = () => <div className="loading"><Spinner /></div>;
export const Empty = ({ children }) => <div className="empty">{children}</div>;

export function Alert({ kind = 'info', title, items, children }) {
  return (
    <div className={`alert ${kind}`} role={kind === 'bad' ? 'alert' : 'status'}>
      <Icon name={kind === 'good' ? 'check' : kind === 'info' ? 'info' : 'alert'} size={16} />
      <div>
        {title && <strong>{title}</strong>}
        {items?.length ? <ul>{items.map((x, i) => <li key={i}>{x}</li>)}</ul> : null}
        {title && children ? <div>{children}</div> : children}
      </div>
    </div>
  );
}

const STATUS = {
  present: ['good', 'status.in_office', 'In office', 'check'],
  wfh: ['info', 'status.wfh', 'Work from home', 'home2'],
  on_leave: ['violet', 'status.on_leave', 'On leave', 'calendar'],
  absent: ['bad', 'status.absent', 'Absent', 'x'],
  not_yet: ['', 'status.not_yet', 'Not checked in', 'clock'],
  holiday: ['', 'status.holiday', 'Holiday', 'calendar'],
  weekend: ['', 'status.weekend', 'Weekend', 'calendar'],
  not_employed: ['', 'status.not_employed', 'Not employed', 'x'],
  pending: ['warn', 'status.pending', 'Pending', 'clock'],
  approved: ['good', 'status.approved', 'Approved', 'check'],
  rejected: ['bad', 'status.rejected', 'Rejected', 'x'],
  cancelled: ['', 'status.cancelled', 'Cancelled', 'x'],
  draft: ['warn', 'status.draft', 'Draft', 'clock'],
  published: ['good', 'status.published', 'Published', 'check'],
  archived: ['', 'status.archived', 'Archived', 'history'],
  review: ['info', 'status.review', 'In review', 'inbox'],
  locked: ['violet', 'status.locked', 'Locked', 'lock'],
  active: ['good', 'status.active', 'Active', 'check'],
  closed: ['', 'status.closed', 'Closed', 'check'],
  scheduled: ['', 'status.scheduled', 'Scheduled', 'calendar'],
  deducted: ['good', 'status.deducted', 'Deducted', 'check'],
  skipped: ['', 'status.skipped', 'Skipped', 'x'],
  // Subscriptions, invoices and companies (billing)
  trialing: ['info', 'status.trialing', 'Trial', 'clock'],
  past_due: ['warn', 'status.past_due', 'Past due', 'alert'],
  unpaid: ['bad', 'status.unpaid', 'Unpaid (blocked)', 'lock'],
  expired: ['bad', 'status.expired', 'Trial ended', 'x'],
  open: ['warn', 'status.open', 'Open', 'clock'],
  paid: ['good', 'status.paid', 'Paid', 'check'],
  void: ['', 'status.void', 'Void', 'x'],
  suspended: ['bad', 'status.suspended', 'Suspended', 'lock'],
  inactive: ['', 'status.inactive', 'Inactive', 'x'],
};

/** Status shown as icon + text + colour (never colour alone). */
export function StatusBadge({ status }) {
  const { t } = useApp();
  const [kind, key, fallback, icon] = STATUS[status] ?? ['', `status.${status}`, status, 'info'];
  return <span className={`badge ${kind}`}><Icon name={icon} size={12} />{t(key, fallback)}</span>;
}

const FLAG_LABELS = {
  late: 'Late', half_day: 'Half day', short_hours: 'Short hours', overtime: 'Overtime', missed_checkout: 'Missed check-out',
  unverified_time: 'Unverified time', corrected: 'Corrected', insufficient_hours: 'Too few hours', open_session: 'Still open',
  worked_on_off_day: 'Worked on day off', worked_on_leave: 'Worked on leave', check_out_without_check_in: 'Out without in',
};
const FLAG_KIND = { late: 'warn', half_day: 'warn', short_hours: 'warn', missed_checkout: 'bad', unverified_time: 'bad', insufficient_hours: 'bad', overtime: 'info', corrected: 'violet' };

export function Flags({ flags }) {
  const { t } = useApp();
  if (!flags?.length) return null;
  return <span className="chips">{flags.map((f) => <span key={f} className={`badge ${FLAG_KIND[f] ?? ''}`}>{t(`flag.${f}`, FLAG_LABELS[f] ?? f)}</span>)}</span>;
}

/** Runs an async loader; returns { data, error, loading, reload }. */
export function useLoad(loader, deps) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    loader().then((data) => alive && setState({ data, error: null, loading: false }))
      .catch((error) => alive && setState({ data: null, error, loading: false }));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((x) => x + 1) };
}

export const ErrorBox = ({ error }) => error ? <Alert kind="bad" title={error.message} items={error.reasons} /> : null;
