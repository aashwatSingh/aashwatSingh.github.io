# ADR 005: ForgeAI, the Nemotron-backed assistant from the landing-page wireframe

- **Status:** Proposed. Needs team sign-off, because the team README lists the wireframe's AI assistant as out of scope ("Do not build it; treat the copy as placeholder text").
- **Owner:** Aashwat Singh. Financial scope rules: Jon Sorey. Soft-deadline rules: Preethi Seereddy.
- **Traces:** SE-NFR-02, SE-NFR-11 (the two requirements it must never weaken), SE-NFR-01, SE-NFR-06, SE-FR-05, SE-FR-06, SE-FR-09, SE-FR-28, UC-01, UC-02, UC-05, UC-21.

## Context

`landing.html` (Saaqib's wireframe) advertises an "AI assistant", and no functional requirement defines one. This build now implements it as **ForgeAI**. No `SE-FR` covers the assistant itself, so this record is the proposal to add it; until the team accepts it, treat ForgeAI as an optional extra that can be removed without touching any requirement.

An assistant is the easiest place in the product to leak data: it reads many tables at once and writes free text. The design below is built around that risk.

## Decision

ForgeAI does two things, both for **current members of one project**:

| Endpoint | What it returns |
| --- | --- |
| `POST /api/projects/{project_id}/ai/chat` | A short Markdown answer about the project |
| `POST /api/projects/{project_id}/ai/suggest-soft-deadlines` | Three suggested soft deadlines for one task (nothing is saved) |
| `GET /api/projects/{project_id}/ai/status` | Which engine will answer, so the UI can say so first |

### 1. The model only ever sees a role-scoped snapshot (SE-NFR-02, SE-NFR-11)

The server first checks membership with the shared `require_project_role()` helper (403 otherwise), then builds a small snapshot of facts from the database. What goes into it depends on the caller's role:

| In the snapshot | Owner / Manager | Member |
| --- | --- | --- |
| Project name, status, deadline, completion %, task counts, overdue and upcoming task and soft deadlines | Yes | Yes |
| Hours | Whole team: estimated, assigned, actual per person | Their own only |
| Bid, budget, stage costs and total, expenses | Yes | **Never loaded** |

For a member the financial tables are not queried at all, so there is nothing to leak, whatever the question says and whatever the model does. A test records the SQL of a member's request and fails if `stage_costs`, `expenses` or `project_financials` appears.

A member who asks about costs, budgets, bids or expenses gets a fixed, polite refusal with no numbers. That refusal is produced on the server before any data is gathered and is never sent to the model. The word check behind it is only a courtesy: a question that slips past it still gets an answer built from a snapshot with no financial data.

A `task_id` must belong to the project in the URL; another project's task is answered exactly like a task that does not exist (404). Suggestions require the same permission as creating a soft deadline: owner, manager, or the task's assignee.

### 2. Two engines, one contract

| | NVIDIA NIM (`mode: "nvidia-nim"`) | Local engine (`mode: "local-fallback"`) |
| --- | --- | --- |
| When | `NVIDIA_API_KEY` is set and the call succeeds within 15 seconds | No key, non-HTTPS address, timeout, any error, or an unusable reply |
| Who answers | `NEMOTRON_MODEL` at `NEMOTRON_BASE_URL/chat/completions` | Rules in `backend/app/routers/ai.py`, computed from the same snapshot |
| Data leaving the server | The snapshot and the question, over HTTPS | None |
| Money | Quoted from exact decimal strings in the snapshot | Exact `Decimal` sums (ADR 004) |

The feature therefore works with no key and no network, and gives the same numbers every time. Every response says which engine produced it, and the UI shows it on each answer ("Nemotron Super 49B · Live NIM" or "Nemotron offline · Local Engine"). A local answer is never labelled as coming from Nemotron.

### 3. The model is never trusted

- **Its text is cleaned** by the same sanitizer as comments before it is returned (no HTML, no script or `data:` links, hidden reasoning blocks removed), and the browser renders it with the safe Markdown renderer.
- **Its dates are re-checked.** A suggestion set is used only if it has exactly three items, one of each priority (`low`, `medium`, `high`), with distinct dates later than now and strictly earlier than the task's due date (UC-05). Otherwise the local engine's dates (25 %, 50 % and 75 % of the time left) are used. When a suggestion is added, the normal soft-deadline endpoint validates it again.
- **Project text is data, not instructions.** Task titles and descriptions inside the snapshot could contain "ignore previous instructions". The system prompt tells the model to ignore them, but the real protection is point 1: the model holds nothing the caller could not already see, and it has no tools and cannot change anything.
- A task whose due date has passed, or is less than an hour away, gets a clear 422 instead of suggestions.

### 4. Abuse limits

- Questions are 1 to 2,000 characters after trimming (422 otherwise); request bodies over 1 MB are refused.
- Each person may make 20 AI requests per minute across both endpoints (`AI_RATE_LIMIT_REQUESTS`), enforced by the same bounded sliding-window limiter as log-in.
- The database connection is released before the model is called, so slow answers cannot exhaust the pool.
- The API key is read from the environment only, sent only to the configured HTTPS address, never logged and never returned. Redirects are not followed.

## Consequences

- **Privacy:** with a key configured, project names, task titles, deadlines, hours with display names and (for owners and managers) financial figures are sent to NVIDIA. No email addresses, passwords or tokens are included. The drawer says so whenever live mode is active. Leave the key empty if that is not acceptable.
- **Cost:** live mode uses the key owner's NVIDIA quota; the rate limit bounds it per person.
- **Wording:** the wireframe says "Turn an idea into a task plan". ForgeAI summarizes and plans soft deadlines; it does not create tasks.
- The landing page shows the "Nemotron AI Copilot" card again, in place of the Time tracking card that had replaced it.

## How it is verified

- `backend/tests/test_forgeai.py`: non-members get 403 on every AI endpoint; another project's task id is refused; a member's cost questions get the refusal, with no digits and no financial query; owners and managers get the exact stage-cost total; suggestions are three, one of each priority, strictly before the due date; a faked NVIDIA endpoint shows that a member's request contains no financial field or amount, that the reply is cleaned, and that 13 kinds of upstream failure fall back to the local engine.
- `web/src/features/ai/model.test.ts`: chip locking by role, engine labels, question length, which suggestions may be offered.
- Playwright: the drawer, the member refusal, Retry / Cancel, focus and Escape, and the "Suggest with Nemotron" flow, with no console or page errors.

**Not verified:** a call to the real NVIDIA service. No API key was available in the build environment, so the live path has only been exercised against a stand-in that mimics NVIDIA's response format.

## Open points for sign-off

- Accept ForgeAI into scope (and add a requirement for it), or keep it as an optional demo feature.
- Decide whether sending role-scoped project facts to NVIDIA is acceptable, or whether the local engine should be the only mode.
- Confirm that members may ask ForgeAI about deadlines of tasks assigned to other people (they can already see those tasks on the board).
