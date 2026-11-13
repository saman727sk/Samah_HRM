/**
 * Online payment providers. The billing service only sees this interface:
 *   name
 *   createCheckout({ amount, currency, description, successUrl, cancelUrl, metadata, customerEmail }) -> { id, url }
 *   parseWebhook(rawBody, headers) -> { id, type, session } (throws if the signature is wrong)
 *       session: { id, paid, amount, currency, paymentId }   amounts in major units (e.g. rupees)
 *
 * Stripe Checkout hosts the card form, so card numbers never reach this
 * server. Configure with STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.
 */

// Currencies Stripe counts in whole units (no cents).
const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
// ...and the ones it counts in thousandths.
const THREE_DECIMAL = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);
const minorUnits = (currency) => { const c = currency.toUpperCase(); return ZERO_DECIMAL.has(c) ? 1 : THREE_DECIMAL.has(c) ? 1000 : 100; };
export const toMinor = (amount, currency) => Math.round(amount * minorUnits(currency));
export const fromMinor = (amount, currency) => amount / minorUnits(currency);

export async function stripeProvider({ secretKey, webhookSecret, client }) {
  const stripe = client ?? new (await import('stripe')).default(secretKey);
  return {
    name: 'stripe',
    async createCheckout({ amount, currency, description, successUrl, cancelUrl, metadata, customerEmail }) {
      const s = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{ quantity: 1, price_data: { currency: currency.toLowerCase(), unit_amount: toMinor(amount, currency), product_data: { name: description } } }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        customer_email: customerEmail || undefined,
        metadata,
        payment_intent_data: { metadata },
      });
      return { id: s.id, url: s.url };
    },
    parseWebhook(rawBody, headers) {
      const event = stripe.webhooks.constructEvent(rawBody, headers['stripe-signature'], webhookSecret);
      const o = event.data?.object ?? {};
      const session = o.object === 'checkout.session' ? {
        id: o.id, paid: o.payment_status === 'paid', currency: (o.currency ?? '').toUpperCase(),
        amount: o.amount_total == null ? null : fromMinor(o.amount_total, o.currency ?? 'usd'),
        paymentId: typeof o.payment_intent === 'string' ? o.payment_intent : o.payment_intent?.id ?? o.id,
      } : null;
      return { id: event.id, type: event.type, session, raw: event };
    },
  };
}

/** Stripe when STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are set; otherwise no online payments. */
export async function paymentProviderFromEnv(env = process.env) {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) return null;
  return stripeProvider({ secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET });
}
