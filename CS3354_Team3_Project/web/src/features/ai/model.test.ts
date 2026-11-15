/**
 * @author Aashwat Singh (ForgeAI)
 * @description Unit tests for the ForgeAI helpers: chip locking by role, engine labels that never present
 *   a local answer as Nemotron, the question length rule, and which suggested soft deadlines may be offered.
 * @traces SE-FR-09, SE-NFR-02, UC-05, UC-21
 */
import { describe, expect, it } from 'vitest';
import { AI_PROMPT_MAX, QUICK_ACTIONS, engineBadge, modelLabel, offerableSuggestions, promptError, quickActionsFor, suggestionKey, type AiSuggestion } from './model';

describe('ForgeAI helpers', () => {
  it('SE-NFR-02: the cost chip is locked for members and open for owners and managers', () => {
    expect(QUICK_ACTIONS.map((a) => a.label)).toEqual(['Summarize project health', 'List at-risk deadlines', 'Analyze hour efficiency', 'Summarize stage costs & expenses']);
    const locked = (role: 'owner' | 'manager' | 'member' | null) => quickActionsFor(role).filter((a) => a.locked).map((a) => a.id);
    expect(locked('owner')).toEqual([]);
    expect(locked('manager')).toEqual([]);
    expect(locked('member')).toEqual(['costs']);
    expect(locked(null)).toEqual(['costs']); // unknown role is treated as the least privileged
    expect(quickActionsFor('member')).toHaveLength(4); // still shown, so the refusal can be explained
  });

  it('names the model and never labels a local answer as Nemotron', () => {
    expect(modelLabel('nvidia/llama-3.3-nemotron-super-49b-v1')).toBe('Nemotron Super 49B');
    expect(modelLabel('nvidia/nemotron-mini-4b-instruct')).toBe('Nemotron Mini 4B Instruct');
    expect(modelLabel('meta/llama-3.1-70b-instruct')).toBe('Llama 3.1 70B Instruct');
    expect(modelLabel('')).toBe('');
    const live = engineBadge({ model: 'nvidia/llama-3.3-nemotron-super-49b-v1', mode: 'nvidia-nim' });
    expect(live).toMatchObject({ model: 'Nemotron Super 49B', mode: 'Live NIM', tone: 'ok', live: true });
    const local = engineBadge({ model: 'forgeai-local-engine', mode: 'local-fallback' });
    expect(local).toMatchObject({ model: 'Nemotron offline', mode: 'Local Engine', tone: 'warn', live: false });
    expect(local.description).toContain('Nothing was sent to NVIDIA');
    expect(engineBadge(null).mode).toBe('Local Engine'); // unknown status is shown as local, never as live
    // A local reply that (wrongly) carried the Nemotron model name is still shown as local.
    expect(engineBadge({ model: 'nvidia/llama-3.3-nemotron-super-49b-v1', mode: 'local-fallback' }).model).toBe('Nemotron offline');
  });

  it('UC-21: questions must be 1 to 2,000 characters after trimming', () => {
    expect(promptError('')).toBe('Ask ForgeAI a question');
    expect(promptError('   \n\t')).toBe('Ask ForgeAI a question');
    expect(promptError('x'.repeat(AI_PROMPT_MAX))).toBeUndefined();
    expect(promptError(`  ${'x'.repeat(AI_PROMPT_MAX)}  `)).toBeUndefined();
    expect(promptError('x'.repeat(AI_PROMPT_MAX + 1))).toBe('Questions are limited to 2,000 characters');
    expect(promptError('Summarize project health')).toBeUndefined();
  });

  it('UC-05: only suggestions before the final due date, not yet added, are offered in date order (SE-FR-09)', () => {
    const due = '2026-12-10T17:00:00Z';
    const s = (title: string, due_at: string, priority: AiSuggestion['priority']): AiSuggestion => ({ title, due_at, priority });
    const all = [s('Final check', '2026-12-08T10:00:00Z', 'high'), s('First pass', '2026-12-02T10:00:00Z', 'low'), s('Midpoint', '2026-12-05T10:00:00Z', 'medium')];
    expect(offerableSuggestions(all, due, new Set()).map((x) => x.priority)).toEqual(['low', 'medium', 'high']);
    expect(offerableSuggestions(all, due, new Set([suggestionKey(all[2])])).map((x) => x.title)).toEqual(['First pass', 'Final check']);
    const late = [...all, s('On the due date', due, 'high'), s('After', '2026-12-11T00:00:00Z', 'low')];
    expect(offerableSuggestions(late, due, new Set())).toHaveLength(3); // equal to or after the due date is dropped
    expect(offerableSuggestions(all, '2026-12-03T00:00:00Z', new Set()).map((x) => x.title)).toEqual(['First pass']); // due date moved earlier
    expect(offerableSuggestions(all, null, new Set())).toHaveLength(3);
    expect(suggestionKey(all[0])).not.toBe(suggestionKey(all[1]));
  });
});
