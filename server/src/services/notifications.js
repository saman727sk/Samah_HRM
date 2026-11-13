/**
 * Notifications (in-app + email outbox). Rows store an event key and
 * params; the text is rendered at read/send time from the translations
 * table ('notify.<event>.title' / '.body') in the recipient's language, so
 * HR can reword any template without a deploy.
 */
import { translator } from '../lib/i18n.js';
import { PRODUCT_NAME } from '../lib/product.js';
import { AppError } from '../lib/errors.js';

export async function hrUserIds(ctx) {
  const { rows } = await ctx.db.query(
    `select id from users where tenant_id = $1 and access_level = 'hr_admin' and is_active`, [ctx.tenant.id]);
  return rows.map((r) => r.id);
}

export async function userOfEmployee(ctx, employeeId) {
  if (!employeeId) return null;
  return (await ctx.db.one('select user_id from employees where id = $1 and tenant_id = $2', [employeeId, ctx.tenant.id]))?.user_id ?? null;
}

export async function notify(ctx, { userIds, event, params = {}, channels = ['in_app'] }) {
  const unique = [...new Set(userIds.filter(Boolean))];
  for (const userId of unique) {
    for (const channel of channels) {
      await ctx.db.query(
        `insert into notifications (tenant_id, user_id, channel, template_key, payload) values ($1, $2, $3, $4, $5)`,
        [ctx.tenant.id, userId, channel, event, params]);
    }
  }
  return unique.length;
}

function render(t, row) {
  const p = { ...row.payload };
  if (p.requestType) p.requestLabel = t(`request.${p.requestType}`);
  p.comment ??= '';
  return { title: t(`notify.${row.template_key}.title`, p), body: t(`notify.${row.template_key}.body`, p) };
}

export async function listNotifications(ctx, { unreadOnly = false, limit = 50 } = {}) {
  const { rows } = await ctx.db.query(
    `select * from notifications where tenant_id = $1 and user_id = $2 and channel = 'in_app'
        ${unreadOnly ? 'and read_at is null' : ''} order by created_at desc limit $3`,
    [ctx.tenant.id, ctx.actor.userId, Math.min(limit, 200)]);
  const t = await translator(ctx.db, ctx.tenant.id, ctx.locale ?? 'en');
  return rows.map((r) => ({ id: r.id, event: r.template_key, payload: r.payload, read: !!r.read_at, createdAt: r.created_at, ...render(t, r) }));
}

export async function markRead(ctx, id) {
  await ctx.db.query(
    `update notifications set read_at = now(), status = 'read' where id = $1 and tenant_id = $2 and user_id = $3 and read_at is null`,
    [id, ctx.tenant.id, ctx.actor.userId]);
}

/**
 * Sends queued emails through `transport.send({ to, subject, text })`.
 * The transport comes from emailTransportFromEnv (SMTP, or a log in dev).
 */
export async function dispatchEmails(db, transport, { limit = 100 } = {}) {
  const { rows } = await db.query(
    `select n.*, u.email, coalesce(u.locale, t.default_locale) as locale from notifications n
       join users u on u.id = n.user_id join tenants t on t.id = n.tenant_id
      where n.channel = 'email' and n.status = 'queued' order by n.created_at limit $1`, [limit]);
  let sent = 0;
  for (const row of rows) {
    const t = await translator(db, row.tenant_id, row.locale);
    const { title, body } = render(t, row);
    try {
      await transport.send({ to: row.email, subject: title, text: body });
      await db.query(`update notifications set status = 'sent', sent_at = now() where id = $1`, [row.id]);
      sent += 1;
    } catch {
      await db.query(`update notifications set status = 'failed' where id = $1`, [row.id]);
    }
  }
  return sent;
}

/** Dev: writes emails to the log. `showBody` prints the text too (it may hold sign-up links: never in production). */
export const logTransport = (log = console.log, { showBody = false } = {}) => ({
  send: async (m) => log(`[email] to=${m.to} subject="${m.subject}"${showBody ? `
${m.text}` : ''}`),
});

/**
 * A send that the email service refused: a 503 with a message people can act on, instead of
 * "Something went wrong". The service's own reason stays in the server log and in details.
 */
export const emailFailed = (to, reason, message) => new AppError(503, 'email_failed',
  message ?? `We couldn't send the email to ${to}. Check the address, or try again in a few minutes.`, { details: { reason } });

/**
 * Real email over SMTP (Gmail / Outlook / Zoho / your host's mail server,
 * or a provider's SMTP relay). Failed sends are logged and rethrown, so
 * dispatchEmails marks the notification 'failed'.
 */
export async function smtpTransport({ host, port = 587, secure = port === 465, user, pass, from }, log = console.error) {
  const { createTransport } = await import('nodemailer');
  const mailer = createTransport({ host, port, secure, auth: user ? { user, pass } : undefined });
  return {
    verify: () => mailer.verify(),
    send: async (m) => {
      try {
        await mailer.sendMail({ from: from || user, to: m.to, subject: m.subject, text: m.text });
      } catch (err) {
        log(`[email] could not send to ${m.to}: ${err.message}`);
        throw emailFailed(m.to, err.message);
      }
    },
  };
}

/**
 * Real email through Resend's HTTP API (resend.com): no SMTP port needed, so it works on
 * hosts that block outgoing mail ports. `from` must be on a domain verified in Resend;
 * until then only onboarding@resend.dev works, and only to the Resend account's own email.
 */
export const RESEND_TEST_FROM = 'onboarding@resend.dev';
export function resendTransport({ apiKey, from, fetchImpl = fetch }, log = console.error) {
  const send = async (m) => {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [m.to], subject: m.subject, text: m.text }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const reason = `Resend ${res.status}: ${body.message ?? res.statusText}`;
      log(`[email] could not send to ${m.to}: ${reason}`);
      // Until a domain is verified, Resend only delivers to the Resend account's own address.
      const testingOnly = /testing email|own email|verify a domain|domain is not verified|resend\.dev/i.test(body.message ?? '');
      throw emailFailed(m.to, reason, testingOnly
        ? `The email service can't deliver to ${m.to} yet (its sending domain is not verified). Please contact ${PRODUCT_NAME} or try again later.`
        : undefined);
    }
  };
  return {
    name: 'Resend',
    // A sending-only API key may not read anything, so the check is the key's shape; the test email proves the rest.
    verify: async () => { if (!/^re_\w{8,}/.test(apiKey)) throw new Error('RESEND_API_KEY should start with "re_" (copy it from resend.com → API Keys).'); },
    send,
  };
}

/** Which real email service server/.env sets up: 'Resend', the SMTP host, or null (emails are only logged). */
export function emailProvider(env = process.env) {
  if (env.RESEND_API_KEY) return 'Resend';
  if (env.SMTP_HOST) return env.SMTP_HOST;
  return null;
}
export const emailConfigured = (env = process.env) => emailProvider(env) !== null;

/** Resend when RESEND_API_KEY is set, else SMTP when SMTP_HOST is set, otherwise emails are only logged. */
export async function emailTransportFromEnv(log = console.log, { showBody = false } = {}) {
  const env = process.env;
  if (env.RESEND_API_KEY) {
    return resendTransport({ apiKey: env.RESEND_API_KEY.trim(), from: env.RESEND_FROM || env.SMTP_FROM || `${PRODUCT_NAME} <${RESEND_TEST_FROM}>` });
  }
  if (!env.SMTP_HOST) return logTransport(log, { showBody });
  const port = Number(env.SMTP_PORT ?? 587);
  return smtpTransport({
    host: env.SMTP_HOST, port, secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465,
    user: env.SMTP_USER, pass: env.SMTP_PASS, from: env.SMTP_FROM,
  });
}
