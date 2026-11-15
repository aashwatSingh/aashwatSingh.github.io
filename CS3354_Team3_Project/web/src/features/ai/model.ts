/**
 * @author Aashwat Singh (ForgeAI)
 * @description Plain helpers for the ForgeAI copilot: the shapes the server returns, the four quick-action
 *   chips (the cost chip is marked "locked" for members, because the server refuses cost questions from
 *   them), friendly names for the engine that answered ("Nemotron Super 49B · Live NIM" or "Local Engine"),
 *   and the question length rule. No network calls here, so everything is unit-tested directly.
 * @traces SE-FR-09, SE-NFR-02, SE-NFR-11, UC-05, UC-21
 */
import type { Role, SoftDeadlinePriority } from '../../shared/types';
import { isManager } from '../../shared/permissions';

export type AiMode = 'nvidia-nim' | 'local-fallback';

export interface AiStatus {
  model: string;
  mode: AiMode;
  role_scope: Role;
}

export interface AiChatReply extends AiStatus {
  reply: string;
  /** True for the "financial data needs Owner or Manager" refusal. */
  restricted: boolean;
}

export interface AiSuggestion {
  title: string;
  due_at: string;
  priority: SoftDeadlinePriority;
}

export interface AiSuggestReply {
  suggestions: AiSuggestion[];
  model: string;
  mode: AiMode;
}

export const AI_PROMPT_MAX = 2000;
export const AI_TIMEOUT_MS = 20_000; // the server waits up to 15 s for Nemotron before answering locally

export interface QuickAction {
  id: 'health' | 'deadlines' | 'hours' | 'costs';
  label: string;
  prompt: string;
  /** Needs Owner or Manager: cost data is never sent to members (SE-NFR-02). */
  managerOnly?: boolean;
}

export const QUICK_ACTIONS: readonly QuickAction[] = [
  { id: 'health', label: 'Summarize project health', prompt: 'Summarize project health' },
  { id: 'deadlines', label: 'List at-risk deadlines', prompt: 'List at-risk deadlines' },
  { id: 'hours', label: 'Analyze hour efficiency', prompt: 'Analyze hour efficiency' },
  { id: 'costs', label: 'Summarize stage costs & expenses', prompt: 'Summarize stage costs & expenses', managerOnly: true },
];

/** Every chip is shown to everyone; `locked` tells the UI to add a lock, the server does the refusing. */
export function quickActionsFor(role: Role | null | undefined): (QuickAction & { locked: boolean })[] {
  return QUICK_ACTIONS.map((action) => ({ ...action, locked: !!action.managerOnly && !isManager(role) }));
}

/** "nvidia/llama-3.3-nemotron-super-49b-v1" -> "Nemotron Super 49B". Unknown names are shown tidied up. */
export function modelLabel(model: string): string {
  const name = model.split('/').pop() ?? model;
  const tokens = name.split('-').filter(Boolean);
  const start = tokens.findIndex((t) => t.toLowerCase() === 'nemotron');
  const kept = (start >= 0 ? tokens.slice(start) : tokens).filter((t) => !/^v\d+(\.\d+)*$/i.test(t));
  const words = kept.map((t) => (/^\d+(\.\d+)?[a-z]$/i.test(t) ? t.toUpperCase() : t.charAt(0).toUpperCase() + t.slice(1)));
  return words.join(' ') || model;
}

export interface EngineBadge {
  model: string;
  mode: string;
  tone: 'ok' | 'warn';
  live: boolean;
  /** One sentence for screen readers and tooltips. */
  description: string;
}

/**
 * What to show for the engine behind an answer. A local answer is never labelled as coming from Nemotron:
 * the model pill then reads "Nemotron offline".
 */
export function engineBadge(status: Pick<AiStatus, 'model' | 'mode'> | null | undefined): EngineBadge {
  if (status?.mode === 'nvidia-nim') {
    const model = modelLabel(status.model);
    return { model, mode: 'Live NIM', tone: 'ok', live: true, description: `Answered by ${model} through NVIDIA NIM from the project facts your role can see.` };
  }
  return { model: 'Nemotron offline', mode: 'Local Engine', tone: 'warn', live: false, description: 'Answered on this server by the built-in rule engine. Nothing was sent to NVIDIA.' };
}

/** Returns the problem with a question, or undefined when it can be sent. Mirrors the server's rule. */
export function promptError(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return 'Ask ForgeAI a question';
  if (trimmed.length > AI_PROMPT_MAX) return `Questions are limited to ${AI_PROMPT_MAX.toLocaleString('en-US')} characters`;
  return undefined;
}

/**
 * Suggestions that can still be offered: in date order, strictly before the task's final due date and not
 * already added. The server validates the same rule; this keeps a stale suggestion from being offered.
 */
export function offerableSuggestions(suggestions: AiSuggestion[], taskDueDate: string | null, added: ReadonlySet<string>): AiSuggestion[] {
  const due = taskDueDate ? new Date(taskDueDate).getTime() : Number.NaN;
  return suggestions
    .filter((s) => !added.has(suggestionKey(s)))
    .filter((s) => Number.isNaN(due) || new Date(s.due_at).getTime() < due)
    .sort((a, b) => new Date(a.due_at).getTime() - new Date(b.due_at).getTime());
}

export function suggestionKey(s: AiSuggestion): string {
  return `${s.priority}|${s.due_at}|${s.title}`;
}
