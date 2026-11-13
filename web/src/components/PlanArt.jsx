/* eslint-disable react/only-export-components */
/**
 * Small illustrations for subscription plans, in the Samah gold and green:
 * a gift (free trial), a seedling (starter), a rocket (professional),
 * a tower with a crown (enterprise) and a diamond (any other plan).
 * Decorative: hidden from screen readers.
 */
const G = '#c99f42';      // gold
const GL = '#ecd08a';     // light gold
const GR = '#1f8a5b';     // green
const GRL = '#6fc497';    // light green
const INK = '#5a3f0c';    // dark outline

const ART = {
  gift: (
    <>
      <rect x="22" y="38" width="56" height="40" rx="5" fill={G} />
      <rect x="18" y="28" width="64" height="14" rx="4" fill={GL} />
      <rect x="46" y="28" width="8" height="50" fill={GR} />
      <path d="M50 28c-6-12-22-14-22-4 0 6 12 6 22 4zM50 28c6-12 22-14 22-4 0 6-12 6-22 4z" fill={GR} />
      <circle cx="30" cy="54" r="2" fill={GL} /><circle cx="68" cy="62" r="2" fill={GL} />
    </>
  ),
  seedling: (
    <>
      <path d="M30 70h40l-5 14H35z" fill={G} /><rect x="27" y="64" width="46" height="8" rx="3" fill={GL} />
      <path d="M50 64V40" stroke={GR} strokeWidth="4" strokeLinecap="round" />
      <path d="M50 46c-2-12-14-18-24-14 2 12 12 18 24 14z" fill={GRL} />
      <path d="M50 40c2-14 14-22 26-18-2 14-14 22-26 18z" fill={GR} />
    </>
  ),
  rocket: (
    <>
      <path d="M50 12c14 10 18 28 14 46H36c-4-18 0-36 14-46z" fill={GL} />
      <circle cx="50" cy="34" r="7" fill={GR} stroke={INK} strokeWidth="2" />
      <path d="M36 50l-10 14 12-2zM64 50l10 14-12-2z" fill={G} />
      <path d="M42 58h16l-3 8h-10z" fill={G} />
      <path className="plan-flame" d="M44 66c2 8 4 12 6 16 2-4 4-8 6-16z" fill={GR} />
    </>
  ),
  tower: (
    <>
      <path d="M38 34l4-12 8 8 8-8 4 12z" fill={G} />
      <rect x="34" y="34" width="32" height="48" rx="3" fill={GL} />
      {[42, 52, 62, 72].map((y) => <g key={y}><rect x="40" y={y - 2} width="7" height="6" rx="1" fill={GR} /><rect x="53" y={y - 2} width="7" height="6" rx="1" fill={GR} /></g>)}
      <rect x="18" y="56" width="16" height="26" rx="2" fill={G} /><rect x="66" y="50" width="16" height="32" rx="2" fill={G} />
    </>
  ),
  diamond: (
    <>
      <path d="M30 34h40l12 14-32 32-32-32z" fill={GL} />
      <path d="M30 34l8 14h24l8-14M38 48l12 32 12-32" fill="none" stroke={G} strokeWidth="3" strokeLinejoin="round" />
      <path d="M18 48h64" stroke={GR} strokeWidth="3" />
    </>
  ),
};

/** Which picture a plan gets: by its code, otherwise by its place in the price order. */
export function planArtKind(plan, index = 0) {
  const code = String(plan?.code ?? '').toLowerCase();
  if (/trial|free/.test(code) || (plan?.price_monthly === 0 && plan?.trial_days > 0)) return 'gift';
  if (/start|basic|lite/.test(code)) return 'seedling';
  if (/pro|business|growth/.test(code)) return 'rocket';
  if (/enterprise|premium|ultimate/.test(code)) return 'tower';
  return ['seedling', 'rocket', 'tower', 'diamond'][index % 4];
}

export default function PlanArt({ kind = 'diamond' }) {
  return (
    <svg viewBox="0 0 100 92" className={`plan-art plan-art-${kind}`} aria-hidden="true" focusable="false">
      <circle cx="50" cy="50" r="40" fill={GL} opacity="0.22" />
      {ART[kind] ?? ART.diamond}
      <path className="plan-spark" d="M84 18l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" fill={G} />
      <path className="plan-spark s2" d="M14 26l1.5 3.5 3.5 1.5-3.5 1.5L14 36l-1.5-3.5L9 31l3.5-1.5z" fill={GR} />
    </svg>
  );
}
