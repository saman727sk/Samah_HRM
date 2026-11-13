/**
 * Currencies: every ISO 4217 code the runtime knows (PKR, USD, EUR, AED,
 * SAR, GBP, INR, JPY, KWD...). Companies pay salaries in theirs; plans are
 * priced in theirs.
 */
const KNOWN = new Set((() => {
  try { return Intl.supportedValuesOf('currency'); } catch { return []; }
})());

export const isCurrency = (code) => typeof code === 'string' && (KNOWN.size ? KNOWN.has(code) : /^[A-Z]{3}$/.test(code));

export const CURRENCY_HELP = 'Choose a currency from the list (an ISO code such as PKR, USD, EUR, AED or SAR).';
