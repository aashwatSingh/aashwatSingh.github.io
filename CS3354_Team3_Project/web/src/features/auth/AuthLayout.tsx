/**
 * @author Tyler Gaines
 * @description The split-screen frame shared by the login, sign-up and reset-password screens: brand panel
 *   with the logo on the left, the form card on the right (stacked on phones).
 * @traces UC-08, UC-09, UC-11
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon, Logo } from '../../shared/ui';

const POINTS = [
  { icon: 'board', text: 'Boards, lists and soft deadlines that keep work on track' },
  { icon: 'dollar', text: 'Exact bids, budgets and stage costs - visible only to managers' },
  { icon: 'clock', text: 'Timers and efficiency reports for every teammate' },
];

export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <aside className="relative hidden overflow-hidden bg-gradient-to-br from-indigo-600 via-indigo-700 to-violet-700 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <Link to="/" className="flex items-center gap-3 text-lg font-bold">
          <Logo className="h-10 w-10 rounded-xl ring-2 ring-white/30" /> ProjectForge
        </Link>
        <div>
          <h2 className="text-3xl font-bold leading-tight">Plan it. Track it. Ship it.</h2>
          <ul className="mt-8 space-y-4">
            {POINTS.map((p) => (
              <li key={p.text} className="flex items-start gap-3 text-indigo-100">
                <span className="rounded-lg bg-white/15 p-2">
                  <Icon name={p.icon} className="h-4 w-4" />
                </span>
                {p.text}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-sm text-indigo-200">CS 3354.001 · Team 3 · eLeet Coderz</p>
        <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-white/10" />
        <div className="pointer-events-none absolute -bottom-32 right-12 h-96 w-96 rounded-full bg-white/5" />
      </aside>
      <main className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-md">
          <Link to="/" className="mb-8 flex items-center gap-2 font-bold lg:hidden">
            <Logo /> ProjectForge
          </Link>
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
          <div className="mt-8">{children}</div>
          {footer ? <div className="mt-6 text-center text-sm text-muted">{footer}</div> : null}
        </div>
      </main>
    </div>
  );
}
