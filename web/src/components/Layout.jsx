import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { get, post } from '../lib/api.js';
import { navigate, useApp } from '../lib/app.jsx';
import { fmtDate, fmtMoney } from '../lib/format.js';
import { Alert, CompanyLogo, Icon, Logo, PRODUCT_NAME } from './ui.jsx';
import { useConfirm } from './confirm.jsx';
import { GlitterField } from './motion.jsx';

function NavLink({ to, icon, label, active, count, onClick }) {
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
    else if (n.event.startsWith('ticket_')) navigate(n.payload?.ticketId ? `/helpdesk?id=${n.payload.ticketId}` : '/helpdesk');
    else if (n.event === 'rota_changed') navigate('/');
    else if (n.event === 'task_blocked') navigate('/tasks?view=log&scope=team');
    else if (n.event.startsWith('task_')) navigate(n.payload?.taskId ? `/tasks?task=${n.payload.taskId}` : '/tasks');
    else if (n.event === 'tasks_today') navigate('/tasks');
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

/** The page name shown in the top bar (PageHead hides a heading that only repeats it). */
const PageTitle = createContext(null);

/** The HR settings pages (shown as their own section of the sidebar). */
const settingsLinks = (t) => [
  ['#/settings/policies', 'settings', t('nav.policies', 'Policies & rules')],
  ['#/settings/lists', 'list', t('nav.lists', 'Lists & offices')],
  ['#/settings/features', 'check', t('nav.features', 'Modules')],
  ['#/settings/transfer', 'download', t('nav.transfer', 'Import / export')],
  ['#/settings/audit', 'history', t('nav.audit', 'Audit log')],
  ['#/billing', 'money', t('nav.subscription', 'Subscription')],
  ['#/settings/company', 'home2', t('nav.company_profile', 'Company profile')],
];

/** Is this link the current page? The most specific link wins, so "/admin" is not lit on "/admin/plans". */
const isActive = (to, current, exact) => (to === '#/' || exact ? current === (to.slice(1) || '/') : current.startsWith(to.slice(1)));

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
  const [helpOpen, setHelpOpen] = useState(0); // help desk requests waiting for HR
  useEffect(() => {
    if (!isHr || session.subscription?.blocked) return;
    get('/helpdesk/open-count').then((x) => setHelpOpen(x.open)).catch(() => {});
  }, [isHr, route.path, session.subscription?.blocked]);
  const has = (m) => !!session.modules?.includes(m);
  const [tasksDue, setTasksDue] = useState(0); // my assigned tasks due today or overdue
  const tasksOn = has('tasks') && !session.subscription?.blocked && !!session.employee;
  useEffect(() => {
    if (!tasksOn) return;
    get('/assigned-tasks/me').then((x) => setTasksDue(x.tasks.filter((tk) => tk.due_date <= x.today).length)).catch(() => {});
  }, [tasksOn, route.path]);
  const close = () => setMenu(false);
  const payrollOn = has('payroll');
  const p = route.path;
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  const name = session.employee?.full_name ?? session.user.accessLevel;
  // Who is signed in where: "HR admin · Acme" (the platform owner has no company).
  const role = { super_admin: 'Super admin', hr_admin: 'HR admin', manager: 'Manager', employee: 'Employee' }[session.user.accessLevel] ?? '';
  const place = session.tenant ? `${role} · ${session.tenant.name}` : `${role} · ${PRODUCT_NAME}`;
  const initials = name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

  // Same pages and permissions as before; shown in the sidebar, grouped by who they are for: [section title, links].
  const blocked = session.subscription?.blocked;
  const groups = level === 'super_admin'
    ? [[t('nav.menu', 'Menu'), [
      ['#/admin', 'chart', 'Dashboard', 0, true],
      ['#/admin/companies', 'shield', 'Companies'],
      ['#/admin/plans', 'list', 'Plans'],
      ['#/admin/billing', 'money', 'Billing'],
      ['#/admin/settings', 'settings', 'Settings'],
    ]]]
    : blocked ? (isHr ? [[t('nav.menu', 'Menu'), [['#/billing', 'money', t('nav.subscription', 'Subscription')]]]] : [])
    : [
      [t('nav.menu', 'Menu'), [
        ['#/', 'home', t('nav.my_dashboard', 'Dashboard')],
        ...(has('attendance') ? [['#/attendance', 'clock', t('nav.attendance', 'Attendance')]] : []),
        ...(has('leave') || has('wfh') ? [['#/requests', 'send', t('nav.requests', 'Leave & WFH')]] : []),
        ...(has('tasks') ? [['#/tasks', 'tasks', t('nav.tasks', 'Daily tasks'), tasksDue]] : []),
        ...(payrollOn ? [['#/payslips', 'file', t('nav.payslips', 'Payslips')]] : []),
        ['#/helpdesk', 'chat', t('nav.helpdesk', 'Help desk'), helpOpen],
      ]],
      ...(isManager ? [[t('nav.team_section', 'Team'), [
        ['#/team', 'users', t('nav.team', 'Team')],
        ['#/approvals', 'inbox', t('nav.approvals', 'Approvals'), pending],
        ...(has('attendance') ? [['#/rota', 'grid', t('nav.rota', 'Rota')]] : []),
      ]]] : []),
      ...(isHr ? [[t('nav.hr_section', 'HR'), [
        ['#/hr', 'chart', t('nav.hr_dashboard', 'HR dashboard')],
        ['#/employees', 'users', t('nav.employees', 'People')],
        ...(payrollOn ? [['#/payroll', 'money', t('nav.payroll', 'Payroll')], ['#/salaries', 'list', t('nav.salaries', 'Salaries & loans')]] : []),
      ]], [t('nav.settings_section', 'Settings'), settingsLinks(t)]] : []),
    ];
  // The page title in the top bar: the label of the current page's link (the longest match).
  // The platform owner's home page ("/") is their dashboard.
  const here = level === 'super_admin' && p === '/' ? '/admin' : p;
  const current = groups.flatMap(([, links]) => links).filter(([to, , , , exact]) => isActive(to, here, exact))
    .sort((a, b) => b[0].length - a[0].length)[0];
  const title = current?.[2] ?? PRODUCT_NAME;

  return (
    <div className={`shell ${level === 'super_admin' ? 'owner' : ''}`}>
      <aside className={`sidebar no-print ${menu ? 'open' : ''}`} aria-label="Main">
        <a href="#/" className="side-brand" onClick={close}>
          {session.tenant ? <CompanyLogo company={session.tenant} /> : <Logo size="sm" />}<span className="brand-name">{session.tenant?.name ?? PRODUCT_NAME}</span>
        </a>
        <nav className="side-nav">
          {groups.map(([heading, links]) => (
            <div key={heading} role="group" aria-label={heading}>
              <div className="side-label">{heading}</div>
              {links.map(([to, icon, label, count]) => (
                <NavLink key={to} to={to} icon={icon} label={label} count={count} active={current?.[0] === to} onClick={close} />
              ))}
            </div>
          ))}
        </nav>
        <div className="side-user">
          <span className="avatar" aria-hidden="true">{initials}</span>
          <span className="user-name" title={`${name} · ${place}`}>{name}<small>{place}</small></span>
          <button className="icon-btn" aria-label={t('ui.sign_out', 'Sign out')} title={t('ui.sign_out', 'Sign out')} onClick={signOut}><Icon name="logout" /></button>
        </div>
        {session.tenant && <div className="side-powered">Powered by {PRODUCT_NAME}</div>}
      </aside>
      <div className={`side-backdrop ${menu ? 'open' : ''}`} onClick={close} aria-hidden="true" />
      <div className="main-col">
        <header className="topbar no-print">
          <button className="icon-btn round menu-btn" aria-label="Menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><Icon name="menu" /></button>
          <h1 className="topbar-title">{title}</h1>
          <div className="topbar-tools">
            <select className="input tool-select" aria-label={t('ui.language', 'Language')} value={locale} onChange={(e) => setLocale(e.target.value)}>
              <option value="en">English</option>
              <option value="ur">اردو</option>
            </select>
            <button className="icon-btn round" aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'} onClick={() => setTheme(dark ? 'light' : 'dark')}>
              <Icon name={dark ? 'sun' : 'moon'} />
            </button>
            {session.tenant && <Notifications />}
            <span className="top-user" title={`${name} · ${place}`}><span className="avatar">{initials}</span>
              <span className="user-name">{name}<small>{role}</small></span></span>
          </div>
        </header>
        <main className="content" id="main"><SubscriptionBanner sub={session.subscription} isHr={isHr} t={t} />
          {/* keyed by page, so every page change replays the entrance animation */}
          <div key={p} className="page-enter"><PageTitle.Provider value={title}>{children}</PageTitle.Provider></div>
        </main>
      </div>
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
  // The top bar already shows the page's name: the same words here are kept for screen readers only.
  const barTitle = useContext(PageTitle);
  const same = typeof title === 'string' && title === barTitle;
  return (
    <div className="page-head">
      <GlitterField count={12} seed={11} className="head-glitter no-print" />
      <div><h1 className={same ? 'sr-only' : undefined}>{typeof title === 'string' ? <span className="gold-text">{title}</span> : title}</h1>{subtitle && <p>{subtitle}</p>}</div>
      {actions && <div className="row no-print">{actions}</div>}
    </div>
  );
}
