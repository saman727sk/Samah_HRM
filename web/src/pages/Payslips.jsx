/** Employee: payslips of locked payroll months, viewable and downloadable as PDF. */
import { useState } from 'react';
import { get } from '../lib/api.js';
import { useApp } from '../lib/app.jsx';
import { fmtMoney, monthLabel } from '../lib/format.js';
import { PageHead } from '../components/Layout.jsx';
import { PayslipModal } from '../components/Payslip.jsx';
import { Button, Card, Empty, ErrorBox, Loading, useLoad } from '../components/ui.jsx';

export default function Payslips({ query }) {
  const { t, session } = useApp();
  const { data, error, loading } = useLoad(() => get('/payroll/payslips/mine'), []);
  const [open, setOpen] = useState(query.id ?? null);
  return (
    <div className="stack lg">
      <PageHead title={t('nav.payslips', 'My payslips')} subtitle={t('ui.payslips_sub', 'Your payslips appear here once HR locks the month’s payroll.')} />
      <Card>
        {loading && !data ? <Loading /> : error ? <ErrorBox error={error} /> : data.length === 0 ? <Empty>{t('ui.no_payslips', 'Payslips appear here after payroll is locked.')}</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{t('ui.month', 'Month')}</th><th className="num">{t('ui.gross', 'Gross')}</th><th className="num">{t('ui.deductions', 'Deductions')}</th><th className="num">{t('ui.net_pay', 'Net pay')}</th><th /></tr></thead>
            <tbody>{data.map((p) => (
              <tr key={p.id}>
                <td>{monthLabel(p.period_key)}</td>
                <td className="num">{fmtMoney(p.gross)}</td>
                <td className="num">{fmtMoney(p.deductions)}</td>
                <td className="num"><strong>{fmtMoney(p.net, session.tenant.currency)}</strong></td>
                <td><Button size="sm" icon="file" onClick={() => setOpen(p.id)}>{t('ui.view', 'View')}</Button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      {open && <PayslipModal id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
