/**
 * Background of the sign-in pages: a large Samah HRM logo with a golden
 * sheen sweeping across it, and twinkling glitter drifting upwards.
 * Purely decorative (hidden from screen readers); all motion stops when the
 * visitor's system asks for reduced motion (see index.css).
 */
import { GlitterField } from './motion.jsx';

export default function AuthBackdrop() {
  return (
    <div className="auth-backdrop" aria-hidden="true">
      <div className="auth-glow" />
      <div className="auth-logo">
        <img src="/logo-full.png" alt="" className="auth-logo-img on-light" />
        <img src="/logo-full-dark.png" alt="" className="auth-logo-img on-dark" />
        <div className="auth-logo-sheen" />
      </div>
      <GlitterField count={42} />
    </div>
  );
}
