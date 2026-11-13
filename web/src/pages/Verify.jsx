import { useEffect, useRef, useState } from 'react';
import { post } from '../lib/api.js';
import AuthBackdrop from '../components/AuthBackdrop.jsx';
import { navigate, useApp } from '../lib/app.jsx';
import { Alert, FullLogo, Loading, PRODUCT_NAME } from '../components/ui.jsx';

/** Public: the link from the sign-up email. Creates the company, then signs the owner in. */
export default function Verify({ query }) {
  const { signInWithToken } = useApp();
  const [state, setState] = useState({ status: 'working' });
  const once = useRef(false); // the link works only once: never send it twice (e.g. React strict mode)
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    post('/auth/signup/verify', { token: query.token })
      .then(async (r) => {
        if (r.token) { await signInWithToken(r.token); navigate('/'); } else setState({ status: 'done', ...r });
      })
      .catch((error) => setState({ status: 'error', error }));
  }, [query.token, signInWithToken]);
  return (
    <div className="login">
      <AuthBackdrop />
      <div className="card stack lg">
        <FullLogo />
        <h1>Confirming your email</h1>
        {state.status === 'working' && <Loading />}
        {state.status === 'done' && (state.pending
          ? <Alert kind="good" title="Email confirmed">{state.company} is now waiting for approval by {PRODUCT_NAME}. We'll email {state.email} as soon as it is approved, then you can sign in.</Alert>
          : <Alert kind="good" title={`${state.company} is ready`}>Sign in with {state.email} and the password you chose.</Alert>)}
        {state.status === 'error' && <Alert kind="bad" title={state.error.message} />}
        {state.status !== 'working' && <a href="#/" className="small">{state.status === 'done' ? 'Sign in' : 'Back to sign in'}</a>}
        {state.status === 'error' && <a href="#/signup" className="small">Sign up again</a>}
      </div>
    </div>
  );
}
