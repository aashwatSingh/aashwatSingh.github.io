/**
 * @author Tyler Gaines - matches profile.html
 * @description Profile and preferences: display name, username and avatar; light / dark theme; color-blind
 *   palettes with a live preview; the default project type for new projects; and two-factor authentication
 *   setup (secret + authenticator link, confirm with a 6-digit code) or removal.
 * @traces SE-FR-11, SE-FR-12, SE-FR-13, SE-FR-14, SE-FR-15
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTheme } from '../app/ThemeProvider';
import { useAuth } from '../features/auth/AuthProvider';
import { authController } from '../features/auth/authController';
import { MfaCodeInput } from '../features/auth/MfaCodeInput';
import { validateUsername } from '../features/auth/validation';
import { PROJECT_TYPES } from '../features/projects/model';
import { ColorBlindPicker, ThemeToggle } from '../features/settings/AccessibilityToggles';
import { settingsController } from '../features/settings/settingsController';
import type { MfaSetup, ProjectType } from '../shared/types';
import { Alert, Avatar, Badge, Card, Field, Icon, PageHeader, RetryBanner } from '../shared/ui';
import { toApiError, useSave } from '../shared/useSave';

function SecurityCard() {
  const { user, setUser } = useAuth();
  const [setup, setSetup] = useState<MfaSetup | null>(null);
  const [code, setCode] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!user) return null;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      setMessage({ tone: 'danger', text: toApiError(err).detail });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Security" actions={user.mfa_enabled ? <Badge tone="ok" icon="shield">2FA on</Badge> : <Badge tone="warn" icon="alert">2FA off</Badge>}>
      <div className="space-y-4">
        {message ? <Alert tone={message.tone} onClose={() => setMessage(null)}>{message.text}</Alert> : null}
        {user.mfa_enabled ? (
          <>
            <p className="text-sm text-muted">Two-factor authentication is protecting your account. Enter a current code to turn it off.</p>
            <MfaCodeInput value={code} onChange={setCode} disabled={busy} />
            <button type="button" className="btn-danger" disabled={busy || code.length !== 6} onClick={() => void run(async () => { setUser(await authController.mfaDisable(code)); setCode(''); setMessage({ tone: 'ok', text: 'Two-factor authentication turned off.' }); })}>
              Turn off 2FA
            </button>
          </>
        ) : setup ? (
          <>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
              <li>Open your authenticator app (Google Authenticator, 1Password, Authy…).</li>
              <li>Add an account with this secret key, or open the setup link on your phone.</li>
              <li>Enter the 6-digit code it shows.</li>
            </ol>
            <div className="rounded-lg bg-surface-2 p-3 font-mono text-sm tracking-widest">{setup.secret.match(/.{1,4}/g)?.join(' ')}</div>
            <a href={setup.otpauth_uri} className="text-xs font-semibold text-brand">Open in authenticator app →</a>
            <MfaCodeInput value={code} onChange={setCode} disabled={busy} />
            <button type="button" className="btn-primary" disabled={busy || code.length !== 6} onClick={() => void run(async () => { setUser(await authController.mfaEnable(code)); setSetup(null); setCode(''); setMessage({ tone: 'ok', text: 'Two-factor authentication is on.' }); })}>
              <Icon name="shield" /> Confirm and turn on
            </button>
          </>
        ) : (
          <>
            <p className="text-sm text-muted">Add a second step at sign-in with a 6-digit code from an authenticator app.</p>
            <button type="button" className="btn-primary" disabled={busy} onClick={() => void run(async () => setSetup(await authController.mfaSetup()))}><Icon name="shield" /> Set up two-factor authentication</button>
          </>
        )}
        <p className="border-t border-line pt-4 text-sm text-muted">Need a new password? <Link to="/reset-password" className="font-semibold text-brand">Send a reset link</Link></p>
      </div>
    </Card>
  );
}

export function SettingsPage() {
  const { user, setUser } = useAuth();
  const { theme, colorBlindMode, setTheme, setColorBlindMode } = useTheme();
  const [displayName, setDisplayName] = useState(user?.display_name ?? '');
  const [username, setUsername] = useState(user?.username ?? '');
  const [avatar, setAvatar] = useState(user?.avatar_url ?? '');
  const [projectType, setProjectType] = useState<ProjectType>(user?.default_project_type ?? 'work');
  const [saved, setSaved] = useState(false);
  const [usernameError, setUsernameError] = useState<string>();
  const [appearanceError, setAppearanceError] = useState<string | null>(null);

  const save = useSave(() => settingsController.updateProfile({ display_name: displayName, username, avatar_url: avatar, default_project_type: projectType }), (u) => { setUser(u); setSaved(true); });
  if (!user) return null;

  const submit = () => {
    const err = validateUsername(username);
    setUsernameError(err);
    setSaved(false);
    if (!err) void save.run();
  };

  const appearance = async (fn: () => Promise<void>) => {
    try {
      setAppearanceError(null);
      await fn();
    } catch (err) {
      setAppearanceError(toApiError(err).detail);
    }
  };

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Profile & settings" subtitle={`Signed in as ${user.email}`} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Profile" className="lg:col-span-2">
          <div className="space-y-4">
            <RetryBanner error={save.networkError} onRetry={save.retry} onCancel={save.cancel} busy={save.saving} />
            {save.error && !Object.keys(save.fieldErrors).length ? <Alert>{save.error.detail}</Alert> : null}
            {saved ? <Alert tone="ok" onClose={() => setSaved(false)}>Profile saved.</Alert> : null}
            <div className="flex items-center gap-4">
              <Avatar name={displayName || username} url={avatar || null} size="h-16 w-16" />
              <div className="text-sm text-muted">Member since {new Date(user.created_at).toLocaleDateString()}</div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Display name" htmlFor="st-name" error={save.fieldErrors.display_name}><input id="st-name" className="input" value={displayName} maxLength={80} onChange={(e) => setDisplayName(e.target.value)} /></Field>
              <Field label="Username" htmlFor="st-username" error={usernameError ?? save.fieldErrors.username}><input id="st-username" className="input" value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
            </div>
            <Field label="Avatar image URL" htmlFor="st-avatar" error={save.fieldErrors.avatar_url} hint="An https:// link to a square image, or leave blank for initials.">
              <input id="st-avatar" className="input" value={avatar} onChange={(e) => setAvatar(e.target.value)} placeholder="https://…" />
            </Field>
            <Field label="Default project type (mode)">
              <div className="flex gap-2">
                {PROJECT_TYPES.map((t) => (
                  <button key={t.value} type="button" onClick={() => setProjectType(t.value)} aria-pressed={projectType === t.value}
                    className={`flex flex-1 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold ${projectType === t.value ? 'border-brand bg-brand/10 text-brand' : 'border-line text-muted hover:bg-surface-2'}`}>
                    <Icon name={t.icon} /> {t.label}
                  </button>
                ))}
              </div>
            </Field>
            <div className="flex justify-end"><button type="button" className="btn-primary" onClick={submit} disabled={save.saving}>{save.saving ? 'Saving…' : 'Save profile'}</button></div>
          </div>
        </Card>
        <Card title="Appearance">
          <div className="space-y-5">
            {appearanceError ? <Alert>{appearanceError}</Alert> : null}
            <div><p className="label">Theme</p><ThemeToggle value={theme} onChange={(t) => void appearance(() => setTheme(t))} /></div>
          </div>
        </Card>
        <Card title="Color vision">
          <ColorBlindPicker value={colorBlindMode} onChange={(m) => void appearance(() => setColorBlindMode(m))} />
        </Card>
        <div className="lg:col-span-2"><SecurityCard /></div>
      </div>
    </div>
  );
}
