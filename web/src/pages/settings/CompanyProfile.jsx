import { useEffect, useRef, useState } from 'react';
import { del, get, patch, put } from '../../lib/api.js';
import { useApp } from '../../lib/app.jsx';
import { useConfirm } from '../../components/confirm.jsx';
import { PageHead } from '../../components/Layout.jsx';
import CurrencySelect from '../../components/CurrencySelect.jsx';
import { Button, Card, CompanyLogo, ErrorBox, Input, Loading, useLoad } from '../../components/ui.jsx';

const MAX_BYTES = 512 * 1024;

/** HR admins: the company's own name, contact details and logo, used on its screens and payslips. */
export default function CompanyProfile() {
  const { t, toast, reloadSession } = useApp();
  const { data, error, reload } = useLoad(() => get('/company'), []);
  const [f, setF] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const confirm = useConfirm();
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (data) setF({ name: data.name ?? '', contactEmail: data.contactEmail ?? '', phone: data.phone ?? '', address: data.address ?? '', country: data.country ?? '', currency: data.currency }); }, [data]);
  if (error) return <ErrorBox error={error} />;
  if (!data || !f) return <Loading />;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const save = async () => {
    setBusy(true); setErr(null);
    try { await patch('/company', f); toast('Company profile saved.'); await reloadSession(); reload(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const upload = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!['image/png', 'image/jpeg'].includes(file.type)) { toast('Choose a PNG or JPEG image.', 'bad'); return; }
    if (file.size > MAX_BYTES) { toast('The logo must be 512 KB or smaller. Save it smaller (about 500 pixels wide is plenty).', 'bad'); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      setBusy(true);
      try { await put('/company/logo', { dataUrl: reader.result }); toast('Logo updated.'); await reloadSession(); reload(); }
      catch (x) { toast(x.message, 'bad'); } finally { setBusy(false); }
    };
    reader.readAsDataURL(file);
  };
  const remove = async () => {
    if (!(await confirm({ title: 'Remove the company logo?', danger: true, confirmLabel: 'Yes, remove', cancelLabel: 'No, keep it',
      message: 'Screens and payslips show the company name and initials instead until you upload a new logo.' }))) return;
    setBusy(true);
    try { await del('/company/logo'); toast('Logo removed.'); await reloadSession(); reload(); } catch (x) { toast(x.message, 'bad'); } finally { setBusy(false); }
  };

  const company = { name: f.name || data.name, logoUrl: data.logoUrl };
  return (
    <div className="stack lg">
      <PageHead title={t('nav.company_profile', 'Company profile')} subtitle="Your company's name and logo appear on every screen your staff use and on their payslips." />
      <div className="grid cols-2">
        <Card title="Logo">
          <div className="stack">
            <div className="row" style={{ gap: 18 }}>
              <CompanyLogo company={company} size="xl" />
              <div className="stack" style={{ gap: 8 }}>
                <input ref={fileRef} type="file" accept="image/png,image/jpeg" hidden onChange={upload} />
                <Button kind="primary" icon="download" disabled={busy} onClick={() => fileRef.current?.click()}>{data.logoUrl ? 'Replace logo' : 'Upload logo'}</Button>
                {data.logoUrl && <Button disabled={busy} onClick={remove}>Remove</Button>}
              </div>
            </div>
            <p className="small muted" style={{ margin: 0 }}>PNG or JPEG, up to 512 KB. A transparent PNG about 500 pixels wide looks best on screens and payslips.</p>
          </div>
        </Card>
        <Card title="Details" actions={<Button kind="primary" disabled={busy} onClick={save}>Save</Button>}>
          <div className="stack">
            <Input label="Company name" value={f.name} onChange={set('name')} />
            <div className="form-grid">
              <Input label="Email" type="email" value={f.contactEmail} onChange={set('contactEmail')} />
              <Input label="Phone" type="tel" value={f.phone} onChange={set('phone')} />
            </div>
            <Input label="Address" as="textarea" rows={2} help="Printed under your name on payslips" value={f.address} onChange={set('address')} />
            <div className="form-grid">
              <Input label="Country" value={f.country} onChange={set('country')} />
              <CurrencySelect value={f.currency} onChange={(currency) => setF({ ...f, currency })} disabled={data.currencyLocked}
                help={data.currencyLocked ? `Fixed: payroll has run in ${data.currency}` : 'Salaries and payslips use it. It can change until the first payroll run.'} />
            </div>
            <ErrorBox error={err} />
          </div>
        </Card>
      </div>
      <Card title="Payslip letterhead preview">
        <div className="letterhead">
          <CompanyLogo company={company} size="md" />
          <div>
            <strong style={{ fontSize: 18 }}>{company.name}</strong>
            {f.address && <div className="small muted">{f.address}</div>}
            {(f.phone || f.contactEmail) && <div className="small muted">{[f.phone, f.contactEmail].filter(Boolean).join('  ·  ')}</div>}
          </div>
        </div>
        <p className="small muted" style={{ margin: '10px 0 0' }}>Saved changes appear on payslips straight away, on screen and in the PDF.</p>
      </Card>
    </div>
  );
}
