# ProjectForge

CS 3354.001 · Team 3 · **eLeet Coderz**: Jon Sorey, Tyler Gaines, Preethi Seereddy, Saaqib Shaik, Myoram Langwang, Aashwat Singh

A project management web app with Python FastAPI on the backend, React + TypeScript + Tailwind (Vite) on the frontend, and PostgreSQL / Supabase for storage. When no database is configured, it falls back to SQLite automatically, so the demo needs no setup.

## Quick start (zero config)

Requirements: Python 3.11+ and Node 18+.

```bash
cd backend
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

```bash
cd web
npm install
npm run dev          # http://localhost:5173 (proxies /api and /ws to :8000)
```

On first start the backend creates `backend/projectforge.db` and seeds the demo team. To run everything as one process, run `npm run build` in `web/`. `uvicorn app.main:app` then serves the built site at http://localhost:8000.

### Demo accounts

All demo accounts use the password `ProjectForge!1`.

| Username | Role on "ProjectForge Platform" | Notes |
|---|---|---|
| `jon` | Owner | |
| `tyler` | Manager | 2FA on. Demo code `123456` |
| `staff` | Member | Owner of "Personal Portfolio Site" |
| `preethi`, `saaqib`, `myoram`, `aashwat` | Member | |

When demo mode is on, the top bar has a **Quick Demo Role Switcher** (Jon · Owner / Tyler · Manager / Staff · Member). The reset-password page also has a **demo inbox** that shows the reset and unlock emails the server would send.

### Suggested live demo

1. Log in as `tyler` to show the password step, then the 2FA step (code `123456`).
2. Switch to **Jon · Owner**, open **Cost**, and show the separate Bid, Budget, Stage costs, and Expenses figures. Untick a stage to show **Total** change to **Subtotal**. (UC-01)
3. Switch to **Staff · Member** and open **Cost** again to show the server's 403 "Access denied" with no figures. Open **Charts** to show "Only your hours". (UC-01, UC-02)
4. On **Tasks** as Staff, show that there is no "New task" button and that other people's cards are locked. Switch to Tyler to create and assign a task. (UC-18)
5. Open a task and post `**hi** <script>alert(1)</script> @staff @nobody`. The script is stripped, a warning appears for `@nobody`, and Staff gets a live toast. (UC-21, UC-22)
6. On **Dashboard**, choose **Edit layout** and drag a widget onto another one. It snaps back. Then use **Restore default**. (UC-16, UC-17)
7. On **People**, try to demote the only owner. You get "Project must have at least one owner". (UC-20)

## Configuration

Copy `backend/.env.example` to `backend/.env`. With nothing set you get SQLite in demo mode. For Supabase:

1. In the Supabase SQL editor, run `supabase/migrations/0001_initial_schema.sql`. It creates the tables, indexes, the soft-deadline trigger, and the RLS policies. You can then optionally run `supabase/seed.sql`.
2. Set `DATABASE_URL` to the Supabase connection string, then set `JWT_SECRET` (32+ characters), `DEMO_MODE=false` and `ENVIRONMENT=production` for a real deployment.

If Postgres is unreachable and `DB_FALLBACK_TO_SQLITE=true`, the backend logs a warning and falls back to SQLite.

## Tests

```bash
cd backend && python -m pytest                     # 15 tests, UC-01..UC-22 and SE-NFR-01..12
TEST_DATABASE_URL=postgresql://user@host/db python -m pytest   # same suite on PostgreSQL
cd web && npm test                                 # 30 Vitest unit tests
cd web && npm run build                            # type-check + production build
```

Every test name carries the requirement IDs it verifies, for example `test_uc01_cost_access_and_subtotal_math_se_fr01_se_fr02_se_fr03_se_nfr01_se_nfr02`.

## RBAC matrix (enforced server-side in `backend/app/core/permissions.py`)

| Action | Owner | Manager | Member |
|---|:-:|:-:|:-:|
| View project, tasks, comments, soft deadlines | ✓ | ✓ | ✓ |
| Edit project, manage feature lists | ✓ | ✓ | |
| Delete project | ✓ | | |
| Invite / remove members, change roles | ✓ | ✓ (cannot grant or remove *owner*) | |
| Create tasks, change assignee | ✓ | ✓ | |
| Update / complete a task | ✓ | ✓ | own tasks only |
| Manage soft deadlines | ✓ | ✓ | on own tasks only |
| Bids, budgets, stage costs, expenses | ✓ | ✓ | 403 |
| Set estimated / assigned hours | ✓ | ✓ | |
| Log actual hours / timer | ✓ | ✓ | own tasks only |
| Performance report | team-wide | team-wide | own hours only |
| Calendar / spreadsheet export | all sheets | all sheets | no financial sheets, own hours only |

The project can never be left without an owner: demoting or removing the last owner returns HTTP 400 "Project must have at least one owner".

## Requirement traceability

| Area (owner) | Backend | Frontend | Requirements |
|---|---|---|---|
| Auth & settings (Tyler) | `routers/auth.py`, `routers/settings.py`, `core/security.py` | `features/auth`, `features/settings`, Login / SignUp / ResetPassword / Settings pages, `ThemeProvider` | UC-08..UC-11, SE-FR-11..15, SE-NFR-05/06 |
| Costs, time, reports (Jon) | `routers/costs.py`, `routers/time_tracking.py`, `routers/reports.py` | `features/costs`, `features/time-tracking`, `features/reports`, Costs / TimeTracking / Performance pages | UC-01..UC-04, SE-FR-01..05, SE-NFR-01/02 |
| Soft deadlines (Preethi) | `routers/soft_deadlines.py`, DB trigger | `features/soft-deadlines`, `services/apiClient.ts` (5 s timeout + retry) | UC-05..UC-07, SE-FR-06..10, SE-NFR-03/04 |
| Projects & exports (Saaqib) | `routers/projects.py`, `routers/exports.py`, `core/realtime.py` | `features/projects`, `features/export`, Projects / ProjectDetails / Calendar pages | UC-12..UC-15, SE-FR-16..20, SE-NFR-09/10 |
| Dashboard (Myoram) | `routers/dashboard.py` | `features/dashboard` (AABB `Widget.overlaps` / `moveTo`), Dashboard page | UC-16, UC-17, SE-FR-21..25, SE-NFR-07/08 |
| Tasks, members, collaboration (Aashwat) | `routers/tasks.py`, `routers/members.py`, `routers/collaboration.py`, `core/sanitizer.py` | `features/tasks`, `features/members`, `features/collaboration`, Board / TaskDetail / People / Notifications pages | UC-18..UC-22, SE-FR-26..30, SE-NFR-11/12 |

The requirement docs did not spell out SE-NFR-03, SE-NFR-05 and SE-NFR-06. This project traces them as follows (adjust if your SRS differs):

- SE-NFR-03: soft-deadline responsiveness
- SE-NFR-05: credential storage and hashing
- SE-NFR-06: brute-force protection

## Security notes

- Passwords are hashed with bcrypt and TOTP secrets are stored only on `user_profiles`. There are no UI-named tables (CWE-256). The migration also revokes client roles' read access to credential columns.
- `/api/auth/signup` and `/api/auth/login` are limited to 5 requests per 60 s per IP, with HTTP 429 `{"detail": "Try again later"}` (CWE-307). Login checks the lockout before checking the password. After 5 failures the account locks for 30 minutes and a signed, single-use unlock link is sent.
- Comments pass through an `nh3` sanitizer (no tags, no `on*=` handlers, no `javascript:` or `data:` links). The browser renders Markdown with a parser that never inserts raw HTML (CWE-79).
- Before `.xlsx` and Google Sheets export, every cell starting with `= + - @ \t \r` is prefixed with `'` (CWE-1236).
- Saves retried by the browser carry the same `Idempotency-Key`, so a timed-out request cannot be stored twice.

## Deviations from the requested file tree

- `backend/app/core/realtime.py` holds the WebSocket hub. Routers need to broadcast, and importing from `main.py` would be circular. `main.py` mounts the `/ws` endpoint.
- Extra shared modules: `web/src/shared/ui.tsx` (UI kit), `shared/format.ts`, `shared/useSave.ts` (Retry/Cancel state), feature sub-components, Vitest `*.test.ts` files, `web/public/logo.svg`, and `backend/pytest.ini`.
- **Visual reference:** the 15 HTML mockups and `assets/logo.png` were not available to the generator. The layout follows the names and descriptions of those screens: sidebar + top bar shell, cards, badges, tables and modals. `web/public/logo.svg` is a stand-in logo. Compare each page in `web/src/pages/` against its mockup and adjust Tailwind classes as needed.
