import { useState } from 'react';
import { get, post, qs } from '../../lib/api.js';
import { useApp } from '../../lib/app.jsx';
import { PageHead } from '../../components/Layout.jsx';
import { InvoiceTable, PaymentModal, PaymentTable, ReasonModal, SubmissionTable } from '../../components/billing.jsx';
import { useConfirm } from '../../components/confirm.jsx';
import { fmtMoney, humanize } from '../../lib/format.js';
import { Card, ErrorBox, Input, Loading, Tabs, useLoad } from '../../components/ui.jsx';
import { RefundDialog } from './Company.jsx';

/** Every company's invoices and payments: record payments, void invoices, refunds. */
export default function Billing() {
  const { toast } = useApp();
  const confirm = useConfirm();
  const [tab, setTab] = useState('verify');
  const [status, setStatus] = useState('open');
  const invoices = useLoad(() => (tab === 'invoices' ? get(`/admin/invoices${qs({ status })}`) : Promise.resolve(null)), [tab, status]);
  const payments = useLoad(() => (tab === 'payments' ? get('/admin/payments') : Promise.resolve(null)), [tab]);
  const reports = useLoad(() => get('/admin/payment-submissions'), [tab]);
  const toVerify = (reports.data ?? []).filter((r) => r.status === 'pending').length;
  const [dialog, setDialog] = useState(null);
  const close = () => setDialog(null);
  const done = (msg) => { if (msg) toast(msg); close(); invoices.reload(); payments.reload(); reports.reload(); };
  const confirmReport = async (r) => {
    if (!(await confirm({ title: `Confirm ${r.company}'s payment?`, confirmLabel: 'Yes, money received', cancelLabel: 'Not yet',
      message: `Only confirm once ${fmtMoney(r.amount, r.currency)} (${r.reference ?? humanize(r.method)}) is in your account. It is recorded as paid${r.kind === 'plan' ? `, and the ${r.plan_name} plan starts today` : ` on ${r.invoice_number}`}.` }))) return;
    try {
      const res = await post(`/admin/payment-submissions/${r.id}/confirm`);
      done(res.short > 0 ? `Confirmed. ${fmtMoney(res.short, r.currency)} is still due on ${res.invoice}.` : `Confirmed: ${res.invoice} is paid.`);
    } catch (e) { toast(e.message, 'bad'); }
  };
  const current = tab === 'invoices' ? invoices : tab === 'payments' ? payments : reports;
  return (
    <div className="stack lg">
      <PageHead title="Billing" subtitle="Invoices are issued automatically; record payments here as they arrive." />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'verify', label: `To verify${toVerify ? ` (${toVerify})` : ''}` }, { value: 'invoices', label: 'Invoices' }, { value: 'payments', label: 'Payments & refunds' }]} />
      {tab === 'verify' && <p className="muted small" style={{ margin: 0 }}>Payments companies say they have made. Check the receipt and your bank account, then confirm (the invoice is cleared) or reject with a reason (the company is told).</p>}
      {tab === 'invoices' && (
        <div style={{ maxWidth: 240 }}>
          <Input label="Show" as="select" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="open">Open (awaiting payment)</option><option value="paid">Paid</option><option value="void">Void</option><option value="">All</option>
          </Input>
        </div>
      )}
      <Card className="flush">
        {current.loading && !current.data ? <Loading /> : current.error ? <ErrorBox error={current.error} /> : tab === 'verify'
          ? <SubmissionTable owner rows={reports.data ?? []} proofPath={(x) => `/admin/payment-submissions/${x.id}/proof`}
            onConfirm={confirmReport} onReject={(r) => setDialog({ kind: 'rejectReport', report: r })} />
          : tab === 'invoices'
          ? <InvoiceTable invoices={invoices.data ?? []} showCompany empty={status === 'open' ? 'Nothing is awaiting payment.' : 'No invoices.'}
            onPay={(inv) => setDialog({ kind: 'pay', invoice: inv })} onVoid={(inv) => setDialog({ kind: 'void', invoice: inv })} />
          : <PaymentTable payments={payments.data ?? []} showCompany onRefund={(p) => setDialog({ kind: 'refund', payment: p })} />}
      </Card>
      {dialog?.kind === 'pay' && <PaymentModal invoice={dialog.invoice} onClose={close} onDone={() => done()} />}
      {dialog?.kind === 'void' && (
        <ReasonModal title={`Void ${dialog.invoice.number}`} action="Void invoice" danger onClose={close}
          onSubmit={(reason) => post(`/admin/invoices/${dialog.invoice.id}/void`, { reason }).then(() => done('Invoice voided.'))} />
      )}
      {dialog?.kind === 'rejectReport' && (
        <ReasonModal title={`Reject ${dialog.report.company}'s payment`} label="Reason (the company sees it)" action="Reject payment" danger onClose={close}
          onSubmit={(reason) => post(`/admin/payment-submissions/${dialog.report.id}/reject`, { reason }).then(() => done('Payment rejected; the company has been told.'))}>
          <p className="small muted" style={{ margin: 0 }}>E.g. "No transfer with this reference reached our account". They can send it again.</p>
        </ReasonModal>
      )}
      {dialog?.kind === 'refund' && <RefundDialog payment={dialog.payment} onClose={close} onDone={() => done('Refund recorded.')} />}
    </div>
  );
}
