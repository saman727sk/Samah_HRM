import { useEffect } from 'react';
import { AppProvider, useApp, useRoute } from './lib/app.jsx';
import { track } from './lib/firebase.js';
import Layout from './components/Layout.jsx';
import { ConfirmProvider } from './components/confirm.jsx';
import { Alert, Empty, Loading } from './components/ui.jsx';
import Login from './pages/Login.jsx';
import Signup from './pages/Signup.jsx';
import Verify from './pages/Verify.jsx';
import ForgotPassword from './pages/ForgotPassword.jsx';
import ResetPassword from './pages/ResetPassword.jsx';
import MyDashboard from './pages/MyDashboard.jsx';
import Attendance from './pages/Attendance.jsx';
import Requests from './pages/Requests.jsx';
import Tasks from './pages/Tasks.jsx';
import Team from './pages/Team.jsx';
import TeamFeatures from './pages/TeamFeatures.jsx';
import TeamsAccess from './pages/settings/TeamsAccess.jsx';
import Approvals from './pages/Approvals.jsx';
import HrDashboard from './pages/HrDashboard.jsx';
import Employees from './pages/Employees.jsx';
import Policies from './pages/settings/Policies.jsx';
import Lists from './pages/settings/Lists.jsx';
import { Audit, Features, Transfer } from './pages/settings/Misc.jsx';
import Payroll from './pages/Payroll.jsx';
import Salaries from './pages/Salaries.jsx';
import Payslips from './pages/Payslips.jsx';
import Subscription from './pages/Subscription.jsx';
import CompanyProfile from './pages/settings/CompanyProfile.jsx';
import AdminDashboard from './pages/admin/AdminDashboard.jsx';
import Companies from './pages/admin/Companies.jsx';
import Company from './pages/admin/Company.jsx';
import Plans from './pages/admin/Plans.jsx';
import AdminBilling from './pages/admin/Billing.jsx';
import PlatformSettings from './pages/admin/PlatformSettings.jsx';
import Rota from './pages/Rota.jsx';
import HelpDesk from './pages/HelpDesk.jsx';

const ROUTES = [
  ['/', MyDashboard], ['/attendance', Attendance], ['/requests', Requests], ['/tasks', Tasks],
  ['/team', Team, 'manager'], ['/approvals', Approvals, 'perm:team.approve'], ['/rota', Rota, 'perm:team.rota'],
  ['/team/features', TeamFeatures, 'perm:team.access'], ['/settings/access', TeamsAccess, 'hr'], ['/helpdesk', HelpDesk],
  ['/payslips', Payslips],
  ['/hr', HrDashboard, 'hr'], ['/employees', Employees, 'hr'], ['/payroll', Payroll, 'perm:payroll'], ['/salaries', Salaries, 'perm:payroll'],
  ['/settings/policies', Policies, 'hr'], ['/settings/lists', Lists, 'hr'], ['/settings/features', Features, 'hr'],
  ['/settings/transfer', Transfer, 'hr'], ['/settings/audit', Audit, 'hr'], ['/settings/company', CompanyProfile, 'hr'],
  ['/billing', Subscription, 'hr'],
  ['/admin', AdminDashboard, 'super'], ['/admin/companies', Companies, 'super'], ['/admin/companies/detail', Company, 'super'],
  ['/admin/plans', Plans, 'super'], ['/admin/billing', AdminBilling, 'super'], ['/admin/settings', PlatformSettings, 'super'],
];

/** Shown to non-HR users while the company's subscription is inactive (HR sees the Subscription page). */
function Paused({ status }) {
  const { t } = useApp();
  const text = {
    expired: t('billing.paused_trial', "Your company's free trial has ended. Your HR admin can choose a plan; your data is kept."),
    unpaid: t('billing.paused_unpaid', 'Access is paused until an invoice is paid. Please contact your HR admin.'),
    cancelled: t('billing.paused_cancelled', "Your company's subscription was cancelled. Please contact your HR admin."),
  }[status];
  return <div style={{ maxWidth: 640, margin: '40px auto' }}><Alert kind="bad" title={t('billing.paused', 'The HRM is paused for your company')}>{text}</Alert></div>;
}

function Routed() {
  const { session, booting, isHr, isManager, level, can } = useApp();
  const route = useRoute();
  useEffect(() => { if (session) track('page_view', { page_path: route.path, page_title: route.path }); }, [route.path, session]);
  if (booting) return <Loading />;
  if (!session) {
    if (route.path === '/signup') return <Signup />;
    if (route.path === '/verify') return <Verify query={route.query} />;
    if (route.path === '/forgot') return <ForgotPassword />;
    if (route.path === '/reset') return <ResetPassword query={route.query} />;
    return <Login />;
  }
  const home = level === 'super_admin' ? AdminDashboard : MyDashboard;
  const match = ROUTES.find(([p]) => p === route.path);
  const allowed = !match?.[2] || (match[2] === 'hr' && isHr) || (match[2] === 'manager' && isManager) || (match[2] === 'super' && level === 'super_admin')
    || (match[2].startsWith('perm:') && (match[2].startsWith('perm:team.') ? isManager : true) && can(match[2].slice(5)));
  const sub = session.subscription;
  // The server refuses everything but billing while blocked; show why instead of failing pages.
  const Page = sub?.blocked ? (isHr ? Subscription : null)
    : route.path === '/' ? home : match && allowed ? match[1] : null;
  return (
    <Layout route={route}>
      {sub?.blocked && !isHr ? <Paused status={sub.status} />
        : Page ? <Page query={route.query} /> : <Empty>This page doesn't exist or you don't have access to it.</Empty>}
    </Layout>
  );
}

export default function App() {
  return <AppProvider><ConfirmProvider><Routed /></ConfirmProvider></AppProvider>;
}
