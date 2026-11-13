/* eslint-disable react/only-export-components */
/**
 * Every ISO 4217 currency the browser knows, with its name ("AED — UAE Dirham"):
 * the ones customers use most first, then all others alphabetically.
 */
import { Input } from './ui.jsx';

const FALLBACK = ['PKR', 'USD', 'EUR', 'GBP', 'AED', 'SAR', 'QAR', 'KWD', 'OMR', 'BHD', 'INR', 'BDT', 'LKR', 'NPR', 'AFN', 'CNY', 'JPY',
  'MYR', 'SGD', 'IDR', 'TRY', 'EGP', 'CAD', 'AUD', 'NZD', 'ZAR', 'NGN', 'KES', 'CHF', 'SEK', 'NOK', 'DKK', 'HKD', 'THB', 'PHP'];
const POPULAR = ['PKR', 'USD', 'EUR', 'GBP', 'AED', 'SAR', 'QAR', 'KWD', 'OMR', 'BHD', 'INR', 'BDT', 'CNY', 'MYR', 'TRY', 'CAD', 'AUD'];

const codes = (() => {
  try { return Intl.supportedValuesOf('currency'); } catch { return FALLBACK; }
})();
const names = (() => {
  try { return new Intl.DisplayNames(['en'], { type: 'currency' }); } catch { return null; }
})();
export const currencyName = (code) => names?.of(code) ?? code;
const label = (code) => `${code} — ${currencyName(code)}`;

const popular = POPULAR.filter((c) => codes.includes(c));
const others = codes.filter((c) => !popular.includes(c)).sort();

export default function CurrencySelect({ label: fieldLabel = 'Currency', value, onChange, ...rest }) {
  const known = codes.includes(value);
  return (
    <Input label={fieldLabel} as="select" value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...rest}>
      {!known && value && <option value={value}>{value}</option>}
      <optgroup label="Most used">{popular.map((c) => <option key={c} value={c}>{label(c)}</option>)}</optgroup>
      <optgroup label="All currencies">{others.map((c) => <option key={c} value={c}>{label(c)}</option>)}</optgroup>
    </Input>
  );
}
