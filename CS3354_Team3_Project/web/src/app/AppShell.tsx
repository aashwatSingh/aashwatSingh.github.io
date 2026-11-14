/**
 * @author eLeet Coderz (Team 3) - layout from dashboard.html; demo switcher: Jon Sorey; bell: Aashwat Singh
 * @description The frame around every signed-in screen: the left sidebar navigation, the top bar with the
 *   project switcher, live-connection dot, the Quick Demo Role Switcher (Jon = Owner, Tyler = Manager,
 *   Staff = Member, demo mode only), theme toggle and notification bell, plus pop-up toasts for live
 *   notifications.
 * @traces SE-FR-14, SE-FR-29, SE-NFR-12, UC-01, UC-02, UC-18, UC-22
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../features/auth/AuthProvider';
import { authController } from '../features/auth/authController';
import { notificationController } from '../features/collaboration/commentController';
import { ProjectPicker, ProjectScopeProvider, useProjectScope } from '../features/projects/ProjectScope';
import { realtime, useRealtime } from '../services/realtimeClient';
import type { DemoUser, Notification } from '../shared/types';
import { Avatar, Icon, Logo, RoleBadge } from '../shared/ui';
import { useTheme } from './ThemeProvider';

const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
  { to: '/projects', label: 'Projects', icon: 'folder' },
  { to: '/board', label: 'Tasks', icon: 'board' },
  { to: '/calendar', label: 'Calendar', icon: 'calendar' },
  { to: '/time', label: 'Time Tracking', icon: 'clock' },
  { to: '/performance', label: 'Charts', icon: 'chart' },
  { to: '/costs', label: 'Cost', icon: 'dollar' },
  { to: '/people', label: 'People', icon: 'users' },
  { to: '/notifications', label: 'Notifications', icon: 'bell' },
  { to: '/settings', label: 'Profile', icon: 'settings' },
];

function DemoRoleSwitcher() {
  const { user, demoSwitch } = useAuth();
  const [users, setUsers] = useState<DemoUser[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    authController.demoUsers().then(setUsers).catch(() => setUsers([]));
  }, []);
  if (users.length === 0) return null;
  return (
    <div className="hidden items-center gap-1 rounded-lg border border-dashed border-warn/60 bg-warn/5 p-1 xl:flex" aria-label="Quick demo role switcher">
      <span className="px-1.5 text-[10px] font-bold uppercase tracking-wider text-warn">Demo</span>
      {users.map((u) => (
        <button
          key={u.username}
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await demoSwitch(u.username);
            } finally {
              setBusy(false);
            }
          }}
          aria-pressed={user?.username === u.username}
          className={`rounded-md px-2 py-1 text-xs font-semibold transition ${user?.username === u.username ? 'bg-surface text-ink shadow-card' : 'text-muted hover:text-ink'}`}
          title={`Sign in as ${u.display_name}`}
        >
          {u.display_name.split(' ')[0]} · {u.label}
        </button>
      ))}
    </div>
  );
}

function CurrentRole() {
  const { currentProject } = useProjectScope();
  return currentProject ? <RoleBadge role={currentProject.my_role} /> : null;
}

function Sidebar({ unread, onNavigate }: { unread: number; onNavigate?: () => void }) {
  const { user, logout } = useAuth();
  return (
    <div className="flex h-full flex-col">
      <Link to="/dashboard" className="flex items-center gap-2.5 px-5 py-5 text-lg font-bold" onClick={onNavigate}>
        <Logo className="h-9 w-9" /> ProjectForge
      </Link>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3" aria-label="Main">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={onNavigate}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${isActive ? 'bg-brand/10 text-brand' : 'text-muted hover:bg-surface-2 hover:text-ink'}`
            }
          >
            <Icon name={item.icon} className="h-[18px] w-[18px]" />
            <span className="flex-1">{item.label}</span>
            {item.to === '/notifications' && unread > 0 ? (
              <span className="rounded-full bg-danger px-1.5 py-0.5 text-[10px] font-bold text-white">{unread > 99 ? '99+' : unread}</span>
            ) : null}
          </NavLink>
        ))}
      </nav>
      {user ? (
        <div className="m-3 flex items-center gap-3 rounded-xl border border-line p-3">
          <Avatar name={user.display_name || user.username} url={user.avatar_url} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{user.display_name}</p>
            <p className="truncate text-xs text-muted">@{user.username}</p>
          </div>
          <button type="button" className="btn-ghost p-1.5" onClick={logout} aria-label="Sign out" title="Sign out">
            <Icon name="logout" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Toasts({ items, onDismiss }: { items: Notification[]; onDismiss: (id: string) => void }) {
  const navigate = useNavigate();
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2" aria-live="polite">
      {items.map((n) => (
        <div key={n.id} className="card pointer-events-auto flex items-start gap-3 p-3 shadow-pop">
          <span className="rounded-lg bg-brand/10 p-2 text-brand"><Icon name="bell" /></span>
          <button type="button" className="min-w-0 flex-1 text-left text-sm" onClick={() => { onDismiss(n.id); if (n.link) navigate(n.link); }}>
            <span className="block font-semibold">New notification</span>
            <span className="line-clamp-2 text-muted">{n.message}</span>
          </button>
          <button type="button" className="text-muted hover:text-ink" onClick={() => onDismiss(n.id)} aria-label="Dismiss notification"><Icon name="x" /></button>
        </div>
      ))}
    </div>
  );
}

export function AppShell() {
  const { user, demoMode } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [unread, setUnread] = useState(0);
  const [toasts, setToasts] = useState<Notification[]>([]);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [connected, setConnected] = useState(realtime.connected);
  const location = useLocation();

  const refreshUnread = useCallback(() => {
    notificationController.list(true).then((r) => setUnread(r.unread_count)).catch(() => undefined);
  }, []);

  useEffect(() => refreshUnread(), [refreshUnread, user?.id, location.pathname]);
  useEffect(() => realtime.onStatus(setConnected), []);
  useRealtime('notification', (n: Notification) => {
    setUnread((u) => u + 1);
    setToasts((t) => [n, ...t].slice(0, 3));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== n.id)), 6000);
  });

  return (
    <ProjectScopeProvider key={user?.id}>
      <div className="flex min-h-screen">
        <aside className="sticky top-0 hidden h-screen w-64 shrink-0 border-r border-line bg-surface lg:block">
          <Sidebar unread={unread} />
        </aside>
        {mobileOpen ? (
          <div className="fixed inset-0 z-40 lg:hidden">
            <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
            <aside className="absolute inset-y-0 left-0 w-64 border-r border-line bg-surface">
              <Sidebar unread={unread} onNavigate={() => setMobileOpen(false)} />
            </aside>
          </div>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-surface/90 px-4 py-3 backdrop-blur sm:px-6">
            <button type="button" className="btn-ghost p-2 lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
              <Icon name="menu" />
            </button>
            <ProjectPicker />
            <CurrentRole />
            <span className="flex-1" />
            {demoMode ? <DemoRoleSwitcher /> : null}
            <span className={`hidden items-center gap-1.5 text-xs sm:flex ${connected ? 'text-ok' : 'text-muted'}`} title={connected ? 'Live updates connected' : 'Reconnecting…'}>
              <span className={`h-2 w-2 rounded-full ${connected ? 'bg-ok' : 'bg-muted'}`} />
              {connected ? 'Live' : 'Offline'}
            </span>
            <button type="button" className="btn-ghost p-2" onClick={() => void toggleTheme()} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
            </button>
            <Link to="/notifications" className="btn-ghost relative p-2" aria-label={`Notifications, ${unread} unread`}>
              <Icon name="bell" />
              {unread > 0 ? <span className="absolute right-1 top-1 h-2.5 w-2.5 rounded-full bg-danger ring-2 ring-surface" /> : null}
            </Link>
            {user ? (
              <Link to="/settings" aria-label="Profile">
                <Avatar name={user.display_name || user.username} url={user.avatar_url} />
              </Link>
            ) : null}
          </header>
          <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-6 lg:px-8">
            <Outlet key={user?.id} />
          </main>
        </div>
      </div>
      <Toasts items={toasts} onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </ProjectScopeProvider>
  );
}
