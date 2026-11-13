/**
 * Each company's own identity: profile (name, address...), logo upload
 * (PNG/JPEG checked by content, size limit, HR only), public versioned logo
 * URL, and the company letterhead on payslip PDFs.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setup } from './helpers.js';
import { buildApp } from '../src/api/app.js';
import { DEMO_PASSWORD, seedDemo } from '../seed/demo.js';
import { renderPayslipPdf } from '../src/services/payslipPdf.js';

const png = await readFile(new URL('../seed/logos/acme.png', import.meta.url));
const otherPng = await readFile(new URL('../seed/logos/globex.png', import.meta.url));

describe('company profile and logo', () => {
  let t, app;
  const tokens = {};
  const call = async (who, method, url, body) => {
    const res = await app.inject({ method, url, payload: body, headers: { authorization: `Bearer ${tokens[who]}` } });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };

  before(async () => {
    t = await setup();
    await seedDemo(t.db, { rounds: 4, slug: 'globex' });
    app = buildApp({ db: t.db, clock: t.clock, jwtSecret: 'test-secret' });
    for (const [who, email] of [['hr', 'hr@acme.test'], ['ali', 'ali@acme.test'], ['globexHr', 'hr+globex@acme.test']]) {
      tokens[who] = JSON.parse((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: DEMO_PASSWORD } })).body).token;
    }
  });
  after(async () => { await app.close(); await t.close(); });

  test('HR edits the company profile; employees cannot', async () => {
    assert.equal((await call('ali', 'PATCH', '/api/company', { name: 'Hacked' })).status, 403);
    assert.equal((await call('hr', 'PATCH', '/api/company', { name: 'X' })).status, 400);
    const res = await call('hr', 'PATCH', '/api/company', { name: 'Acme Technologies', address: '12 Mall Road, Lahore', phone: '+92 42 111 222' });
    assert.equal(res.status, 200);
    assert.equal(res.body.address, '12 Mall Road, Lahore');
    assert.equal((await call('ali', 'GET', '/api/me')).body.tenant.name, 'Acme Technologies');
  });

  test('any ISO currency; it can change until the first payroll run', async () => {
    assert.equal((await call('hr', 'PATCH', '/api/company', { currency: 'XYZ' })).status, 400, 'not a real currency');
    const aed = await call('hr', 'PATCH', '/api/company', { currency: 'AED' });
    assert.equal(aed.status, 200);
    assert.equal(aed.body.currency, 'AED');
    assert.equal((await call('ali', 'GET', '/api/me')).body.tenant.currency, 'AED');
    assert.equal((await call('hr', 'GET', '/api/company')).body.currencyLocked, false);
    await t.db.query(`insert into payroll_runs (tenant_id, period_key, period_start, period_end, status) values ($1, '2026-01', '2026-01-01', '2026-01-31', 'draft')`, [t.tenant.id]);
    assert.equal((await call('hr', 'GET', '/api/company')).body.currencyLocked, true);
    const locked = await call('hr', 'PATCH', '/api/company', { currency: 'USD' });
    assert.equal(locked.status, 400);
    assert.match(locked.body.error.message, /first payroll run/);
    await t.db.query(`delete from payroll_runs where tenant_id = $1 and period_key = '2026-01'`, [t.tenant.id]);
    await call('hr', 'PATCH', '/api/company', { currency: 'PKR' });
  });

  test('payment amounts use each currency\'s own decimals (Stripe minor units)', async () => {
    const { toMinor, fromMinor } = await import('../src/services/payments.js');
    assert.equal(toMinor(9999, 'PKR'), 999900);
    assert.equal(toMinor(5000, 'JPY'), 5000);
    assert.equal(toMinor(12.345, 'KWD'), 12345);
    assert.equal(fromMinor(12345, 'kwd'), 12.345);
  });

  test('logos: PNG/JPEG only (by content), size limit, HR only', async () => {
    const svg = `data:image/png;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64')}`;
    assert.equal((await call('hr', 'PUT', '/api/company/logo', { dataUrl: svg })).status, 400, 'an SVG named .png is refused');
    const huge = Buffer.concat([png.subarray(0, 8), Buffer.alloc(600 * 1024)]);
    assert.equal((await call('hr', 'PUT', '/api/company/logo', { dataUrl: huge.toString('base64') })).status, 400);
    assert.equal((await call('ali', 'PUT', '/api/company/logo', { dataUrl: png.toString('base64') })).status, 403);
    const ok = await call('hr', 'PUT', '/api/company/logo', { dataUrl: `data:image/png;base64,${png.toString('base64')}` });
    assert.equal(ok.status, 200);
    assert.match(ok.body.logoUrl, new RegExp(`^/api/logos/${t.tenant.id}\\?v=\\d+$`));
  });

  test('each company has its own logo, served publicly with safe headers', async () => {
    await call('globexHr', 'PUT', '/api/company/logo', { dataUrl: otherPng.toString('base64') });
    const acmeUrl = (await call('ali', 'GET', '/api/me')).body.tenant.logoUrl;
    const globexUrl = (await call('globexHr', 'GET', '/api/me')).body.tenant.logoUrl;
    assert.notEqual(acmeUrl, globexUrl);
    const img = await app.inject({ url: acmeUrl }); // no session needed (<img> tags, PDF)
    assert.equal(img.statusCode, 200);
    assert.equal(img.headers['content-type'], 'image/png');
    assert.equal(img.headers['x-content-type-options'], 'nosniff');
    assert.ok(img.rawPayload.equals(png));
    assert.ok((await app.inject({ url: globexUrl })).rawPayload.equals(otherPng));
    assert.equal((await app.inject({ url: '/api/logos/not-a-company' })).statusCode, 404);
    assert.equal((await call('hr', 'DELETE', '/api/company/logo')).body.logoUrl, null);
    assert.equal((await app.inject({ url: acmeUrl })).statusCode, 404);
  });

  test('payslip PDFs carry the company letterhead and logo', async () => {
    const slip = {
      id: 'p1', period_key: '2026-02', gross: 100000, deductions: 10000, net: 90000, currency: 'PKR', locked_at: '2026-03-02T00:00:00Z',
      company: 'Acme Technologies', companyDetails: { name: 'Acme Technologies', address: '12 Mall Road, Lahore', phone: '+92 42 111 222' },
      summary: {
        employee: { name: 'Ali Raza', code: 'E003', joiningDate: '2022-02-01' }, period: { start: '2026-02-01', end: '2026-02-28' },
        inputs: { EMPLOYED_DAYS: 28, CALENDAR_DAYS: 28, WORKING_DAYS: 20, PRESENT_DAYS: 20, ABSENT_DAYS: 0, HALF_DAYS: 0, LATE_COUNT: 0,
          PAID_LEAVE_DAYS: 0, UNPAID_LEAVE_DAYS: 0, OT_HOURS: 0, OT_OFFDAY_HOURS: 0 },
        lines: [{ code: 'BASIC', name: 'Basic', kind: 'earning', amount: 100000 }, { code: 'TAX', name: 'Tax', kind: 'deduction', amount: 10000 }],
      },
    };
    const withLogo = await renderPayslipPdf(slip, { logo: { mime: 'image/png', buffer: png } });
    const without = await renderPayslipPdf(slip);
    assert.equal(withLogo.subarray(0, 5).toString(), '%PDF-');
    assert.match(withLogo.toString('latin1'), /\/Subtype \/Image/);
    assert.doesNotMatch(without.toString('latin1'), /\/Subtype \/Image/);
  });
});
