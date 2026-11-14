/**
 * @author eLeet Coderz (Team 3) - matches landing.html (AI-assistant marketing copy intentionally removed)
 * @description The public home page: what ProjectForge does, its main features, how roles work, and buttons
 *   to sign up or sign in.
 * @traces SE-FR-16, SE-FR-21, SE-FR-26, SE-FR-01, SE-FR-04, SE-FR-19
 */
import { Link } from 'react-router-dom';
import { useAuth } from '../features/auth/AuthProvider';
import { Icon, Logo } from '../shared/ui';

const FEATURES = [
  { icon: 'board', title: 'Boards & feature lists', text: 'Drag tasks across To Do, In Progress, Review and Done. Group them into feature lists and watch progress update live.' },
  { icon: 'target', title: 'Soft deadlines', text: 'Add personal checkpoints before the real due date so nothing sneaks up on you.' },
  { icon: 'dollar', title: 'Exact costs', text: 'Track bids, budgets, stage costs and expenses to the cent - visible only to owners and managers.' },
  { icon: 'clock', title: 'Time tracking', text: 'Start, pause and stop a timer on any task you own, or log hours by hand.' },
  { icon: 'chart', title: 'Efficiency reports', text: 'Compare estimated, assigned and actual hours per person. Members only ever see their own numbers.' },
  { icon: 'calendar', title: 'Calendar & spreadsheet export', text: 'Send deadlines to Google, Outlook or any .ics calendar and export data safely to Excel or Sheets.' },
];

const ROLES = [
  { role: 'Owner', icon: 'shield', text: 'Full control, including deleting the project and granting ownership.' },
  { role: 'Manager', icon: 'users', text: 'Plans the work: creates and assigns tasks, manages people, budgets and reports.' },
  { role: 'Member', icon: 'target', text: 'Does the work: updates their own tasks, logs their own time, joins the discussion.' },
];

export function LandingPage() {
  const { user } = useAuth();
  return (
    <div className="min-h-screen bg-canvas">
      <header className="sticky top-0 z-20 border-b border-line bg-surface/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link to="/" className="flex items-center gap-2.5 text-lg font-bold"><Logo className="h-9 w-9" /> ProjectForge</Link>
          <nav className="flex items-center gap-2">
            <a href="#features" className="btn-ghost hidden sm:inline-flex">Features</a>
            <a href="#roles" className="btn-ghost hidden sm:inline-flex">Roles</a>
            {user ? (
              <Link to="/dashboard" className="btn-primary">Open dashboard</Link>
            ) : (
              <>
                <Link to="/login" className="btn-secondary">Sign in</Link>
                <Link to="/signup" className="btn-primary">Get started</Link>
              </>
            )}
          </nav>
        </div>
      </header>

      <section className="relative overflow-hidden">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-20 lg:grid-cols-2">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-brand/30 bg-brand/10 px-3 py-1 text-xs font-semibold text-brand">
              <Icon name="check" className="h-3 w-3" /> For work, school and personal projects
            </span>
            <h1 className="mt-5 text-4xl font-extrabold leading-tight tracking-tight sm:text-5xl">
              Plan projects. Track every hour. <span className="text-brand">Ship on time.</span>
            </h1>
            <p className="mt-5 max-w-xl text-lg text-muted">
              ProjectForge brings tasks, deadlines, costs and time into one place, with permissions that match how real teams work.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to={user ? '/dashboard' : '/signup'} className="btn-primary px-5 py-3 text-base">{user ? 'Go to your dashboard' : 'Create your free account'}</Link>
              <Link to="/login" className="btn-secondary px-5 py-3 text-base">Try the demo</Link>
            </div>
          </div>
          <div className="card relative p-5 shadow-pop">
            <div className="mb-4 flex items-center justify-between">
              <p className="font-semibold">ProjectForge Platform</p>
              <span className="text-xs font-semibold text-ok">● Live</span>
            </div>
            {[['Planning', 100], ['Backend', 42.86], ['Frontend', 33.33], ['Testing', 0]].map(([name, pct]) => (
              <div key={name as string} className="mb-3">
                <div className="mb-1 flex justify-between text-xs text-muted"><span>{name}</span><span className="font-semibold text-ink">{(pct as number).toFixed(2)}%</span></div>
                <div className="h-2 rounded-full bg-surface-2"><div className="h-2 rounded-full bg-brand" style={{ width: `${pct}%` }} /></div>
              </div>
            ))}
            <div className="mt-5 grid grid-cols-3 gap-3 text-center">
              {[['Bid', '$48,500.00'], ['Budget', '$42,000.00'], ['Stages', '$36,870.85']].map(([k, v]) => (
                <div key={k} className="rounded-lg bg-surface-2 p-3"><p className="text-[10px] font-semibold uppercase text-muted">{k}</p><p className="text-sm font-bold">{v}</p></div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section id="features" className="border-y border-line bg-surface py-20">
        <div className="mx-auto max-w-6xl px-6">
          <h2 className="text-center text-3xl font-bold tracking-tight">Everything a project needs</h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-muted">Six tools that work together, from the first task to the final invoice.</p>
          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <div key={f.title} className="card p-6">
                <span className="inline-flex rounded-lg bg-brand/10 p-2.5 text-brand"><Icon name={f.icon} className="h-5 w-5" /></span>
                <h3 className="mt-4 font-semibold">{f.title}</h3>
                <p className="mt-2 text-sm text-muted">{f.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="roles" className="py-20">
        <div className="mx-auto max-w-6xl px-6">
          <h2 className="text-center text-3xl font-bold tracking-tight">The right access for every role</h2>
          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {ROLES.map((r) => (
              <div key={r.role} className="card p-6 text-center">
                <span className="mx-auto inline-flex rounded-full bg-accent/10 p-3 text-accent"><Icon name={r.icon} className="h-6 w-6" /></span>
                <h3 className="mt-4 text-lg font-semibold">{r.role}</h3>
                <p className="mt-2 text-sm text-muted">{r.text}</p>
              </div>
            ))}
          </div>
          <div className="mt-16 rounded-2xl bg-gradient-to-r from-indigo-600 to-violet-600 px-8 py-12 text-center text-white">
            <h2 className="text-2xl font-bold">Ready to forge your next project?</h2>
            <p className="mt-2 text-indigo-100">Free for students and small teams.</p>
            <Link to={user ? '/dashboard' : '/signup'} className="btn mt-6 bg-white px-6 py-3 text-indigo-700 hover:bg-indigo-50">Get started</Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-line py-8 text-center text-sm text-muted">
        ProjectForge · CS 3354.001 Team 3 · eLeet Coderz
      </footer>
    </div>
  );
}
