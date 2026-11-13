/**
 * Checks the email settings in server/.env (Resend or SMTP) by sending one email.
 *   npm run email:test -- you@example.com
 */
import { PRODUCT_NAME } from '../lib/product.js';
import { emailProvider, emailTransportFromEnv } from './notifications.js';

const to = process.argv[2];
if (!to?.includes('@')) {
  console.error('Usage: npm run email:test -- you@example.com');
  process.exit(1);
}
const provider = emailProvider();
if (!provider) {
  console.error('Neither RESEND_API_KEY nor SMTP_HOST is set in server/.env, so emails are only written to the log. See server/.env.example.');
  process.exit(1);
}
const transport = await emailTransportFromEnv();
try {
  await transport.verify();
  await transport.send({ to, subject: `${PRODUCT_NAME} test email`, text: `Email is set up correctly (${provider}). ${PRODUCT_NAME} emails will be delivered from this address.` });
  console.log(`Sent a test email to ${to} through ${provider}.`);
} catch (err) {
  console.error(`Email check failed (${provider}): ${err.message}`);
  if (provider === 'Resend' && /domain|testing emails|own email/i.test(err.message)) {
    console.error('Until you verify a domain at resend.com/domains, Resend only delivers to the email address of your Resend account, from onboarding@resend.dev.');
  }
  process.exit(1);
}
