/**
 * @author Tyler Gaines - matches login.html (+ 2FA step)
 * @description Sign-in screen. Step 1: email/username and password, with clear messages for wrong details,
 *   a locked account (with how to unlock) and too many attempts. Step 2 (when 2FA is on): the 6-digit code.
 *   Opening an unlock link from the lockout email unlocks the account right here. Demo mode lists the
 *   seeded accounts and the demo code.
 * @traces SE-FR-11, UC-09, UC-10
 */
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../services/apiClient';
import { useAuth } from '../features/auth/AuthProvider';
import { AuthLayout } from '../features/auth/AuthLayout';
import { authController } from '../features/auth/authController';
import { MfaCodeInput } from '../features/auth/MfaCodeInput';
import { isValidMfaCode } from '../features/auth/validation';
import { Alert, Field, Icon } from '../shared/ui';

export function LoginPage() {
  const { login, verifyMfa, pendingMfa, cancelMfa, demoMode } = useAuth();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/dashboard';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ tone: 'danger' | 'warn'; title: string; text?: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const token = params.get('unlock_token');
    if (!token) return;
    authController
      .unlock(token)
      .then((r) => setNotice(r.message))
      .catch((e: ApiError) => setError({ tone: 'danger', title: e.detail }))
      .finally(() => {
        params.delete('unlock_token');
        setParams(params, { replace: true });
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const describe = (err: unknown) => {
    const e = err instanceof ApiError ? err : null;
    if (e?.status === 423) setError({ tone: 'warn', title: 'Account locked', text: e.detail });
    else if (e?.status === 429) setError({ tone: 'warn', title: 'Too many attempts', text: 'Try again later (limit: 5 attempts per minute).' });
    else setError({ tone: 'danger', title: e?.detail ?? 'Sign in failed' });
  };

  const submitPassword = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const response = await login(email.trim(), password);
      if (!response.mfa_required) navigate(from, { replace: true });
      else setCode('');
    } catch (err) {
      describe(err);
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!isValidMfaCode(code)) {
      setError({ tone: 'danger', title: 'Enter all 6 digits' });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await verifyMfa(code);
      navigate(from, { replace: true });
    } catch (err) {
      describe(err);
      setCode('');
      if (err instanceof ApiError && err.status === 401 && err.detail.includes('expired')) cancelMfa();
    } finally {
      setBusy(false);
    }
  };

  if (pendingMfa) {
    return (
      <AuthLayout title="Two-factor verification" subtitle="Enter the 6-digit code from your authenticator app.">
        <form className="space-y-5" onSubmit={submitCode}>
          {error ? <Alert tone={error.tone} title={error.title}>{error.text}</Alert> : null}
          <MfaCodeInput value={code} onChange={setCode} disabled={busy} />
          {demoMode ? <Alert tone="info">Demo mode: the code <span className="font-mono font-bold">123456</span> is accepted.</Alert> : null}
          <button type="submit" className="btn-primary w-full py-2.5" disabled={busy || code.length !== 6}>
            <Icon name="shield" /> {busy ? 'Verifying…' : 'Verify and sign in'}
          </button>
          <button type="button" className="btn-ghost w-full" onClick={() => { cancelMfa(); setError(null); }}>
            Use a different account
          </button>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Sign in to your ProjectForge account."
      footer={<>New here? <Link to="/signup" className="font-semibold text-brand">Create an account</Link></>}
    >
      <form className="space-y-4" onSubmit={submitPassword} noValidate>
        {notice ? <Alert tone="ok">{notice}</Alert> : null}
        {error ? <Alert tone={error.tone} title={error.title}>{error.text}</Alert> : null}
        <Field label="Email or username" htmlFor="login-email">
          <input id="login-email" className="input" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="Password" htmlFor="login-password">
          <div className="relative">
            <input id="login-password" className="input pr-10" type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted hover:text-ink" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'}>
              <Icon name={show ? 'eye-off' : 'eye'} />
            </button>
          </div>
        </Field>
        <div className="flex justify-end">
          <Link to="/reset-password" className="text-sm font-semibold text-brand">Forgot password?</Link>
        </div>
        <button type="submit" className="btn-primary w-full py-2.5" disabled={busy || !email || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      {demoMode ? (
        <div className="mt-6 rounded-xl border border-dashed border-warn/60 bg-warn/5 p-4 text-sm">
          <p className="font-semibold">Demo accounts</p>
          <p className="mt-1 text-muted">Password for all: <span className="font-mono text-ink">ProjectForge!1</span></p>
          <div className="mt-3 flex flex-wrap gap-2">
            {[['jon', 'Jon · Owner'], ['tyler', 'Tyler · Manager (2FA)'], ['staff', 'Staff · Member']].map(([u, label]) => (
              <button key={u} type="button" className="btn-secondary py-1 text-xs" onClick={() => { setEmail(u); setPassword('ProjectForge!1'); }}>
                {label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </AuthLayout>
  );
}
