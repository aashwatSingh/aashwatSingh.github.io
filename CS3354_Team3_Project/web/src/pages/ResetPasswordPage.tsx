/**
 * @author Tyler Gaines - matches reset-password.html
 * @description Password reset. Without a token: ask for the email and always show the same neutral message
 *   (so nobody can test which emails have accounts). With a token from the email link: choose a new strong
 *   password. In demo mode a "demo inbox" shows the reset / unlock emails the server would have sent.
 * @traces UC-11, UC-10, SE-NFR-05
 */
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../features/auth/AuthProvider';
import { AuthLayout } from '../features/auth/AuthLayout';
import { authController } from '../features/auth/authController';
import { passwordRules, validatePassword } from '../features/auth/validation';
import type { OutboxMessage } from '../shared/types';
import { relativeTime } from '../shared/format';
import { Alert, Field, Icon } from '../shared/ui';
import { toApiError } from '../shared/useSave';

function DemoInbox() {
  const [messages, setMessages] = useState<OutboxMessage[] | null>(null);
  const load = () => authController.devOutbox().then(setMessages).catch(() => setMessages([]));
  return (
    <div className="mt-6 rounded-xl border border-dashed border-warn/60 bg-warn/5 p-4 text-sm">
      <div className="flex items-center justify-between">
        <p className="font-semibold">Demo inbox</p>
        <button type="button" className="btn-secondary py-1 text-xs" onClick={() => void load()}><Icon name="refresh" className="h-3 w-3" /> Check email</button>
      </div>
      <p className="mt-1 text-xs text-muted">No email server is needed for the class demo - sent messages appear here.</p>
      {messages && messages.length === 0 ? <p className="mt-3 text-xs text-muted">No messages yet.</p> : null}
      <ul className="mt-3 space-y-2">
        {(messages ?? []).slice(0, 5).map((m) => (
          <li key={m.sent_at + m.link} className="rounded-lg border border-line bg-surface p-3">
            <p className="font-semibold">{m.subject}</p>
            <p className="text-xs text-muted">To {m.to} · {relativeTime(m.sent_at)}</p>
            {m.link ? <a href={m.link.replace(/^https?:\/\/[^/]+/, '')} className="mt-1 inline-block text-xs font-semibold text-brand">Open link →</a> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ResetPasswordPage() {
  const { demoMode } = useAuth();
  const [params] = useSearchParams();
  const token = params.get('token');
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const request = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setMessage((await authController.requestReset(email.trim())).message);
    } catch (err) {
      setError(toApiError(err).detail);
    } finally {
      setBusy(false);
    }
  };

  const confirmReset = async (e: FormEvent) => {
    e.preventDefault();
    const problem = validatePassword(password) ?? (password !== confirm ? 'Passwords do not match' : undefined);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setMessage((await authController.confirmReset(token!, password)).message);
      setTimeout(() => navigate('/login'), 1800);
    } catch (err) {
      const apiErr = toApiError(err);
      setError(apiErr.errors.new_password ?? apiErr.detail);
    } finally {
      setBusy(false);
    }
  };

  if (token) {
    return (
      <AuthLayout title="Choose a new password" subtitle="Reset links work once and expire after 30 minutes." footer={<Link to="/login" className="font-semibold text-brand">Back to sign in</Link>}>
        <form className="space-y-4" onSubmit={confirmReset}>
          {message ? <Alert tone="ok">{message}</Alert> : null}
          {error ? <Alert>{error}</Alert> : null}
          <Field label="New password" htmlFor="rp-new">
            <input id="rp-new" className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <ul className="grid grid-cols-2 gap-1 text-xs">
            {passwordRules(password).map((r) => (
              <li key={r.id} className={`flex items-center gap-1.5 ${r.met ? 'text-ok' : 'text-muted'}`}><Icon name={r.met ? 'check' : 'x'} className="h-3 w-3" /> {r.label}</li>
            ))}
          </ul>
          <Field label="Confirm new password" htmlFor="rp-confirm">
            <input id="rp-confirm" className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          <button type="submit" className="btn-primary w-full py-2.5" disabled={busy || !!message}>{busy ? 'Saving…' : 'Update password'}</button>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Reset your password" subtitle="Enter your account email and we'll send you a reset link." footer={<Link to="/login" className="font-semibold text-brand">Back to sign in</Link>}>
      <form className="space-y-4" onSubmit={request}>
        {message ? <Alert tone="ok">{message}</Alert> : null}
        {error ? <Alert>{error}</Alert> : null}
        <Field label="Email" htmlFor="rp-email">
          <input id="rp-email" className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <button type="submit" className="btn-primary w-full py-2.5" disabled={busy || !email}>{busy ? 'Sending…' : 'Send reset link'}</button>
      </form>
      {demoMode ? <DemoInbox /> : null}
    </AuthLayout>
  );
}
