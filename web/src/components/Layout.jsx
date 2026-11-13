import { useEffect, useRef, useState } from 'react';
import { get, post } from '../lib/api.js';
import { navigate, useApp } from '../lib/app.jsx';
import { fmtDate, fmtMoney } from '../lib/format.js';
import { Alert, CompanyLogo, Icon, Logo, PRODUCT_NAME } from './ui.jsx';
import { useConfirm } from './confirm.jsx';
import { GlitterField } from './motion.jsx';

function NavLink({ to, icon, label, current, count, exact, onClick }) {
  const active = to === '#/' || exact ? current === (to.slice(1) || '/') : current.startsWith(to.slice(1));
  return (
    <a href={to} className={`nav-link ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} onClick={onClick}>
      <Icon name={icon} />{label}{count ? <span className="count">{count}</span> : null}
    </a>
  );
}

function Notifications() {
  const { t } = useApp();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const ref = useRef(null);
  const load = () => get('/notifications').then(setItems).catch(() => {});
  useEffect(() => { load(); const id = setInterval(load, 60_000); return () => clearInterval(id); }, []);
  useEffect(() => {
    const close = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const unread = items.filter((n) => !n.read).length;
  const openNote = async (n) => {
    if (!n.read) { await post(`/notifications/${n.id}/read`).catch(() => {}); load(); }
    if (n.event === 'payslip_ready') navigate('/payslips');
    else if (n.event.startsWith('billing_')) navigate('/billing');
    else if (n.payload?.requestType) navigate(n.event === 'approval_needed' || n.event === 'request_escalated' ? '/approvals' : '/requests');
    setOpen(false);
  };
  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button className="icon-btn round" aria-label={`${t('ui.notifications', 'Notifications')} (${unread} unread)`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="bell" />{unread > 0 && <span className="dot" />}
      </button>
      {open && (
        <div className="dropdown" role="menu">
          {items.length === 0 && <div className="empty">{t('ui.no_notifications', 'No notifications yet.')}</div>}
          {items.map((n) => (
            <div key={n.id} className={`note ${n.read ? '' : 'unread'}`} role="menuitem" tabIndex={0} onClick={() => openNote(n)} onKeyDown={(e) => e.key === 'Enter' && openNote(n)}>
              <div style={{ fontWeight: 600 }}>{n.title}</div>
              <div className="small muted">{n.body}</div>
              <div className="small muted">{new Date(n.createdAt).toLocaleString()}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Settings links live in one "Settings" menu, like the top-right button in the header. */
function SettingsMenu({ current, t, onNavigate }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const close = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const links = [
    ['#/settings/policies', 'settings', t('nav.policies', 'Policies & rules')],
    ['#/settings/lists', 'list', t('nav.lists', 'Lists & offices')],
    ['#/settings/features', 'check', t('nav.features', 'Modules')],
    ['#/settings/transfer', 'download', t('nav.transfer', 'Import / export')],
    ['#/settings/audit', 'history', t('nav.audit', 'Audit log')],
    ['#/billing', 'money', t('nav.subscription', 'Subscription')],
    ['#/settings/company', 'home2', t('nav.company_profile', 'Company profile')],
  ];
  const active = current.startsWith('/settings') || current === '/billing';
  return (
    <div className="menu-wrap" ref={ref}>
      <button type="button" className={`pill-btn ${active ? 'active' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="settings" size={16} />{t('nav.settings_section', 'Settings')}
      </button>
      {open && (
        <div className="dropdown menu" role="menu">
          {links.map(([to, icon, label]) => (
            <a key={to} href={to} role="menuitem" className={`menu-item ${current.startsWith(to.slice(1)) ? 'active' : ''}`}
              onClick={() => { setOpen(false); onNavigate(); }}><Icon name={icon} size={16} />{label}</a>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Layout({ route, children }) {
  const { session, logout, t, locale, setLocale, theme, setTheme, isHr, isManager, level } = useApp();
  const confirm = useConfirm();
  const signOut = async () => {
    if (await confirm({ title: t('ui.sign_out_q', 'Sign out?'), message: t('ui.sign_out_msg', 'You will need your email and password to sign in again.'),
      confirmLabel: t('ui.sign_out_yes', 'Yes, sign out'), cancelLabel: t('ui.sign_out_no', 'No, stay signed in') })) logout();
  };
  const [menu, setMenu] = useState(false);
  const [pending, setPending] = useState(0);
  useEffect(() => {
    if (!isManager) return;
    get('/approvals').then((x) => setPending(x.length)).catch(() => {});
  }, [isManager, route.path]);
  const close = () => setMenu(false);
  const payrollOn = session.modules?.includes('payroll');
  const p = route.path;
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  const name = session.employee?.full_name ?? session.user.accessLevel;
  // Who is signed in where: "HR admin · Acme" (the platform owner has no company).
  const role = { super_admin: 'Super admin', hr_admin: 'HR admin', manager: 'Manager', employee: 'Employee' }[session.user.accessLevel] ?? '';
  const place = session.tenant ? `${role} · ${session.tenant.name}` : `${role} · ${PRODUCT_NAME}`;
  const initials = name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

  // Same pages and permissions as before; shown as pills, grouped by who they are for.
  const blocked = session.subscription?.blocked;
  const groups = level === 'super_admin'
    ? [[
      ['#/admin', 'chart', 'Dashboard', 0, true],
      ['#/admin/companies', 'shield', 'Companies'],
      ['#/admin/plans', 'list', 'Plans'],
      ['#/admin/billing', 'money', 'Billing'],
      ['#/admin/settings', 'settings', 'Settings'],
    ]]
    : blocked ? (isHr ? [[['#/billing', 'money', t('nav.subscription', 'Subscription')]]] : [])
    : [
      [
        ['#/', 'home', t('nav.my_dashboard', 'Dashboard')],
        ['#/attendance', 'clock', t('nav.attendance', 'Attendance')],
        ['#/requests', 'send', t('nav.requests', 'Leave & WFH')],
        ...(payrollOn ? [['#/payslips', 'file', t('nav.payslips', 'Payslips')]] : []),
      ],
      ...(isManager ? [[
        ['#/team', 'users', t('nav.team', 'Team')],
        ['#/approvals', 'inbox', t('nav.approvals', 'Approvals'), pending],
      ]] : []),
      ...(isHr ? [[
        ['#/hr', 'chart', t('nav.hr_dashboard', 'HR dashboard')],
        ['#/employees', 'users', t('nav.employees', 'People')],
        ...(payrollOn ? [['#/payroll', 'money', t('nav.payroll', 'Payroll')], ['#/salaries', 'list', t('nav.salaries', 'Salaries & loans')]] : []),
      ]] : []),
    ];

  return (
    <div className={`shell platform ${level === 'super_admin' ? 'owner' : ''}`}>
      <header className={`appbar ${groups.flat().length > 5 ? 'two-row' : ''}`}>
        <a href="#/" className="brand-pill" onClick={close}>
          {session.tenant ? <CompanyLogo company={session.tenant} /> : <Logo size="sm" />}<span className="brand-name">{session.tenant?.name ?? PRODUCT_NAME}</span>
        </a>
        <button className="icon-btn round menu-btn" aria-label="Menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><Icon name="menu" /></button>
        <div className="appbar-break" aria-hidden="true" />
        <nav className={`topnav ${menu ? 'open' : ''}`} aria-label="Main">
          {groups.map((links, i) => (
            <div className="topnav-group" key={i}>
              {links.map(([to, icon, label, count, exact]) => <NavLink key={to} to={to} icon={icon} label={label} count={count} exact={exact} current={p} onClick={close} />)}
            </div>
          ))}
        </nav>
        <div className="appbar-tools">
          {isHr && !blocked && <SettingsMenu current={p} t={t} onNavigate={close} />}
          <select className="input pill-select" aria-label={t('ui.language', 'Language')} value={locale} onChange={(e) => setLocale(e.target.value)}>
            <option value="en">English</option>
            <option value="ur">اردو</option>
          </select>
          <button className="icon-btn round" aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'} onClick={() => setTheme(dark ? 'light' : 'dark')}>
            <Icon name={dark ? 'sun' : 'moon'} />
          </button>
          {session.tenant && <Notifications />}
          <span className="user-pill" title={`${name} · ${place}`}><span className="avatar">{initials}</span>
            <span className="user-name">{name}<small>{place}</small></span></span>
          <button className="icon-btn round" aria-label={t('ui.sign_out', 'Sign out')} onClick={signOut}><Icon name="logout" /></button>
        </div>
      </header>
      <main className="content" id="main"><SubscriptionBanner sub={session.subscription} isHr={isHr} t={t} />
        {/* keyed by page, so every page change replays the entrance animation */}
        <div key={p} className="page-enter">{children}</div>
      </main>
      {session.tenant && <footer className="powered no-print">Powered by {PRODUCT_NAME}</footer>}
    </div>
  );
}

/** Trial ending, overdue invoice or scheduled cancellation (blocked companies get a full page instead). */
function SubscriptionBanner({ sub, isHr, t }) {
  if (!sub || sub.blocked) return null;
  const link = isHr && <> <a href="#/billing">{t('billing.see_subscription', 'See subscription')}</a></>;
  let kind, text;
  if (sub.status === 'past_due' && sub.overdue) {
    kind = 'warn';
    text = t('billing.banner_overdue', 'Invoice {number} ({amount}) was due on {date}. Access will be paused if it stays unpaid.',
      { number: sub.overdue.number, amount: fmtMoney(sub.overdue.amountDue, sub.overdue.currency), date: fmtDate(sub.overdue.dueOn) });
  } else if (sub.status === 'trialing' && sub.trialDaysLeft <= 7) {
    kind = 'info';
    text = t('billing.banner_trial', 'Free trial: {days} days left (ends {date}).', { days: sub.trialDaysLeft, date: fmtDate(sub.trialEndsOn) });
  } else if (sub.cancelAtPeriodEnd) {
    kind = 'info';
    text = t('billing.banner_cancel', 'Your subscription ends on {date}.', { date: fmtDate(sub.currentPeriodEnd) });
  }
  if (!text) return null;
  return <div className="no-print" style={{ marginTop: 12 }}><Alert kind={kind}>{text}{link}</Alert></div>;
}

export function PageHead({ title, subtitle, actions }) {
  return (
    <div className="page-head">
      <GlitterField count={12} seed={11} className="head-glitter no-print" />
      <div><h1>{typeof title === 'string' ? <span className="gold-text">{title}</span> : title}</h1>{subtitle && <p>{subtitle}</p>}</div>
      {actions && <div className="row no-print">{actions}</div>}
    </div>
  );
}
