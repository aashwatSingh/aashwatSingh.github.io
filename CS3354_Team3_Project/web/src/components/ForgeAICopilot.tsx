/**
 * @author Aashwat Singh (ForgeAI); panel styling follows the ProjectForge mockup tokens
 * @description The ForgeAI slide-over panel. It opens from the sidebar's "ForgeAI (Nemotron)" button and
 *   answers questions about the project currently selected. Four quick-action chips cover the common
 *   questions; the cost chip carries a lock for members, and if a member uses it the server's refusal is
 *   shown as a normal, clearly labelled answer. Each answer shows which engine produced it
 *   ("Nemotron Super 49B · Live NIM" or "Local Engine"), is rendered with the same safe Markdown renderer
 *   as comments, and a failed request keeps the question and offers Retry or Cancel. The panel traps
 *   keyboard focus, closes on Escape and uses the theme tokens, so it follows dark, light and the
 *   colour-blind palettes.
 * @traces SE-FR-28, SE-NFR-02, SE-NFR-04, SE-NFR-05, SE-NFR-11, UC-21
 */
import { useEffect, useRef, useState } from 'react';
import { aiController } from '../features/ai/aiController';
import { EnginePills } from '../features/ai/EnginePills';
import { AI_PROMPT_MAX, promptError, quickActionsFor, type AiChatReply, type AiStatus } from '../features/ai/model';
import { SafeMarkdown } from '../features/collaboration/SafeMarkdown';
import { useProjectScope } from '../features/projects/ProjectScope';
import type { ApiError } from '../services/apiClient';
import { Alert, Icon, RetryBanner, RoleBadge, Spinner, useDialogFocus } from '../shared/ui';
import { toApiError } from '../shared/useSave';

interface Message {
  id: number;
  from: 'user' | 'forgeai';
  text: string;
  reply?: AiChatReply;
}

/** Sidebar entry that opens the panel. */
export function ForgeAIButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      className="flex h-11 w-full items-center gap-2.5 rounded-btn px-3 text-left text-[15px] font-medium text-nav transition hover:bg-surface hover:text-ink"
    >
      {/* The sparkle badge doubles as the row's icon so the full label fits the 240px sidebar. */}
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-deep text-accent-tint" aria-hidden>
        <Icon name="sparkle" className="h-3.5 w-3.5" />
      </span>
      <span className="whitespace-nowrap">ForgeAI (Nemotron)</span>
    </button>
  );
}

export function ForgeAICopilot({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { currentProject } = useProjectScope();
  const projectId = currentProject?.id ?? null;
  const role = currentProject?.my_role ?? null;
  const panel = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLFormElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // A question that got no answer (offline, timeout, server fault): kept so Retry can resend it.
  const [failure, setFailure] = useState<{ error: ApiError; prompt: string } | null>(null);

  useDialogFocus(open, panel, onClose, composer);

  // A different project (or person) starts a fresh conversation: answers never carry over between projects.
  useEffect(() => {
    setMessages([]);
    setFailure(null);
    setProblem(null);
    setStatus(null);
  }, [projectId, role]);

  useEffect(() => {
    if (!open || !projectId) return;
    let current = true;
    aiController.status(projectId).then((s) => current && setStatus(s)).catch(() => undefined);
    return () => {
      current = false;
    };
  }, [open, projectId]);

  useEffect(() => {
    if (open) end.current?.scrollIntoView?.({ block: 'end' });
  }, [messages, busy, failure, open]);

  if (!open) return null;

  const ask = async (prompt: string, isRetry = false) => {
    if (!projectId || busy) return;
    const invalid = promptError(prompt);
    if (invalid) {
      setProblem(invalid);
      return;
    }
    const question = prompt.trim();
    setProblem(null);
    setFailure(null);
    if (!isRetry) setMessages((list) => [...list, { id: nextId.current++, from: 'user', text: question }]);
    setDraft('');
    setBusy(true);
    try {
      const reply = await aiController.chat(projectId, question);
      setStatus({ model: reply.model, mode: reply.mode, role_scope: reply.role_scope });
      setMessages((list) => [...list, { id: nextId.current++, from: 'forgeai', text: reply.reply, reply }]);
    } catch (err) {
      const error = toApiError(err);
      // No answer at all -> Retry / Cancel with the question kept. A refusal from the server (too many
      // requests, no access, invalid question) explains itself and is shown as a message.
      if (error.isConnectivity || error.status >= 500) setFailure({ error, prompt: question });
      else setProblem(error.status === 429 ? 'ForgeAI is busy. Wait a minute and try again.' : error.detail);
    } finally {
      setBusy(false);
    }
  };

  const chips = quickActionsFor(role);
  const remaining = AI_PROMPT_MAX - draft.trim().length;

  return (
    <div className="fixed inset-0 z-50" data-testid="forgeai-overlay">
      <div className="absolute inset-0 bg-black/60" onMouseDown={onClose} aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="ForgeAI copilot"
        className="absolute inset-y-0 right-0 flex w-full max-w-[460px] flex-col border-l border-line bg-surface-2 shadow-pop"
      >
        <header className="border-b border-line px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-deep text-accent"><Icon name="sparkle" className="h-5 w-5" /></span>
              <div>
                <h2 className="text-lg font-bold leading-6 text-ink">ForgeAI</h2>
                <p className="text-[13px] leading-5 text-muted">Project copilot</p>
              </div>
            </div>
            <button type="button" className="btn-ghost p-2" onClick={onClose} aria-label="Close ForgeAI"><Icon name="x" /></button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <EnginePills status={status} />
            {role ? <RoleBadge role={role} /> : null}
          </div>
          <p className="mt-2 text-[13px] leading-5 text-muted">
            {currentProject ? <>Answers about <span className="font-semibold text-body">{currentProject.name}</span> use only what your role can see.</> : 'Select a project to ask about it.'}
            {status?.mode === 'nvidia-nim' ? ' Those facts are sent to NVIDIA to be answered.' : null}
          </p>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4" aria-live="polite" aria-busy={busy}>
          {!projectId ? (
            <Alert tone="info">Create or join a project, then ask ForgeAI about its progress, deadlines and hours.</Alert>
          ) : messages.length === 0 && !busy ? (
            <div className="rounded-btn border border-dashed border-line-strong p-4 text-sm text-body">
              <p className="font-semibold text-ink">Ask about this project</p>
              <p className="mt-1 text-[13px] text-muted">Pick a quick action below or type a question. Cost questions need the Owner or Manager role.</p>
            </div>
          ) : null}
          {messages.map((m) =>
            m.from === 'user' ? (
              <div key={m.id} className="flex justify-end">
                <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-brand px-4 py-2.5 text-sm font-medium text-brand-ink">{m.text}</p>
              </div>
            ) : (
              <article key={m.id} className={`rounded-2xl rounded-bl-md border px-4 py-3 ${m.reply?.restricted ? 'border-warn/40 bg-warn/10' : 'border-line bg-surface'}`} aria-label="ForgeAI answer">
                {m.reply?.restricted ? (
                  <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-[0.06em] text-warn"><Icon name="lock" className="h-3.5 w-3.5" /> Owner or Manager only</p>
                ) : null}
                <SafeMarkdown source={m.text} className="text-body [&_strong]:text-ink" />
                <footer className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-2.5">
                  <EnginePills status={m.reply ?? null} />
                  {m.reply ? <span className="text-xs text-muted">{m.reply.role_scope} view</span> : null}
                </footer>
              </article>
            ),
          )}
          {busy ? <Spinner label="ForgeAI is working…" /> : null}
          <RetryBanner
            error={failure?.error ?? null}
            busy={busy}
            title="ForgeAI did not answer."
            hint="Your question is kept - retry now or cancel."
            onRetry={() => failure && void ask(failure.prompt, true)}
            onCancel={() => setFailure(null)}
          />
          <div ref={end} />
        </div>

        <div className="border-t border-line px-5 py-4">
          <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Quick actions">
            {chips.map((chip) => (
              <button
                key={chip.id}
                type="button"
                disabled={!projectId || busy}
                onClick={() => void ask(chip.prompt)}
                title={chip.locked ? 'Needs the Owner or Manager role. ForgeAI will explain.' : undefined}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-semibold transition disabled:opacity-50 ${
                  chip.locked ? 'border-line text-muted hover:border-warn/50 hover:text-warn' : 'border-line-strong text-body hover:border-brand hover:text-ink'
                }`}
              >
                {chip.locked ? <Icon name="lock" className="h-3.5 w-3.5" /> : null}
                {chip.label}
                {chip.locked ? <span className="sr-only"> (Owner or Manager only)</span> : null}
              </button>
            ))}
          </div>
          <form
            ref={composer}
            onSubmit={(e) => {
              e.preventDefault();
              void ask(draft);
            }}
          >
            <label htmlFor="forgeai-question" className="sr-only">Question for ForgeAI</label>
            <textarea
              id="forgeai-question"
              className="input min-h-[72px] resize-none"
              placeholder="Ask about progress, deadlines or hours…"
              value={draft}
              maxLength={AI_PROMPT_MAX}
              disabled={!projectId}
              aria-invalid={!!problem}
              aria-describedby="forgeai-help"
              onChange={(e) => {
                setDraft(e.target.value);
                if (problem) setProblem(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void ask(draft);
                }
              }}
            />
            <div className="mt-2 flex items-center justify-between gap-3">
              <p id="forgeai-help" className={`text-xs ${problem ? 'font-medium text-danger' : 'text-muted'}`} role={problem ? 'alert' : undefined}>
                {problem ?? `Enter to send · ${remaining.toLocaleString('en-US')} characters left`}
              </p>
              <button type="submit" className="btn-primary btn-sm" disabled={!projectId || busy}>
                <Icon name="sparkle" /> {busy ? 'Asking…' : 'Ask'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
