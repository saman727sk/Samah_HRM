/* eslint-disable react/only-export-components */
/**
 * Every IANA time zone the browser knows, grouped by region (Asia, Europe, America...),
 * each shown as "Karachi — UTC+05:00". The most used ones come first.
 * The city comes first so typing a letter on the closed list jumps to it.
 */
import { Input } from './ui.jsx';

const FALLBACK = ['Asia/Karachi', 'Asia/Dubai', 'Asia/Riyadh', 'Asia/Qatar', 'Asia/Kolkata', 'Asia/Dhaka', 'Asia/Shanghai', 'Asia/Singapore',
  'Asia/Kuala_Lumpur', 'Asia/Tokyo', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Istanbul', 'America/New_York', 'America/Chicago',
  'America/Denver', 'America/Los_Angeles', 'America/Toronto', 'Australia/Sydney', 'Africa/Cairo', 'Africa/Johannesburg', 'Africa/Lagos', 'UTC'];
const POPULAR = ['Asia/Karachi', 'Asia/Dubai', 'Asia/Riyadh', 'Asia/Qatar', 'Asia/Kuwait', 'Asia/Muscat', 'Asia/Bahrain', 'Asia/Kolkata',
  'Asia/Dhaka', 'Europe/London', 'America/New_York', 'America/Toronto', 'Australia/Sydney', 'UTC'];
const REGIONS = ['Asia', 'Europe', 'Africa', 'America', 'Australia', 'Pacific', 'Atlantic', 'Indian', 'Antarctica', 'Other'];
const REGION_LABEL = { America: 'Americas', Indian: 'Indian Ocean', Atlantic: 'Atlantic', Pacific: 'Pacific', Other: 'Other' };

const zones = (() => {
  try {
    const list = Intl.supportedValuesOf('timeZone');
    return list.includes('UTC') ? list : [...list, 'UTC'];
  } catch { return FALLBACK; }
})();

/** "GMT+05:00" -> "UTC+05:00" (current offset, so it follows daylight saving). */
export function utcOffset(tz) {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value ?? '';
    return part === 'GMT' ? 'UTC±00:00' : part.replace('GMT', 'UTC');
  } catch { return ''; }
}
/** "America/Argentina/Buenos_Aires" -> "Buenos Aires (Argentina)" */
const place = (tz) => {
  const parts = tz.split('/');
  if (parts.length === 1) return tz === 'UTC' ? 'UTC (Coordinated Universal Time)' : tz;
  const city = parts.at(-1).replace(/_/g, ' ');
  return parts.length > 2 ? `${city} (${parts.slice(1, -1).join(', ').replace(/_/g, ' ')})` : city;
};
export const timezoneLabel = (tz) => `${place(tz)} — ${utcOffset(tz)}`;
const regionOf = (tz) => { const r = tz.split('/')[0]; return REGIONS.includes(r) ? r : 'Other'; };

const popular = POPULAR.filter((z) => zones.includes(z));
const groups = REGIONS.map((r) => ({
  region: r,
  zones: zones.filter((z) => regionOf(z) === r).sort((a, b) => place(a).localeCompare(place(b))),
})).filter((g) => g.zones.length);

export default function TimezoneSelect({ label: fieldLabel = 'Timezone', value, onChange, ...rest }) {
  const known = zones.includes(value);
  return (
    <Input label={fieldLabel} as="select" value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...rest}>
      {!value && <option value="" disabled>Choose a time zone</option>}
      {!known && value && <option value={value}>{value}</option>}
      <optgroup label="Most used">{popular.map((z) => <option key={`p-${z}`} value={z}>{timezoneLabel(z)}</option>)}</optgroup>
      {groups.map((g) => (
        <optgroup key={g.region} label={REGION_LABEL[g.region] ?? g.region}>
          {g.zones.map((z) => <option key={z} value={z}>{timezoneLabel(z)}</option>)}
        </optgroup>
      ))}
    </Input>
  );
}
