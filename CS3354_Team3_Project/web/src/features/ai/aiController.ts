/**
 * @author Aashwat Singh (ForgeAI)
 * @description Calls the ForgeAI endpoints for one project: which engine is active, ask a question, and
 *   suggest soft deadlines for a task. Requests wait up to 20 seconds (the server may wait 15 for
 *   Nemotron) and are not retried automatically, so one question is never billed twice.
 * @traces SE-NFR-02, SE-NFR-11, UC-05, UC-21
 */
import { api } from '../../services/apiClient';
import { AI_TIMEOUT_MS, type AiChatReply, type AiStatus, type AiSuggestReply } from './model';

const options = { timeoutMs: AI_TIMEOUT_MS, retry: false } as const;

export const aiController = {
  status: (projectId: string) => api.get<AiStatus>(`/api/projects/${projectId}/ai/status`),
  chat: (projectId: string, prompt: string, taskId?: string) =>
    api.post<AiChatReply>(`/api/projects/${projectId}/ai/chat`, taskId ? { prompt, task_id: taskId } : { prompt }, options),
  suggestSoftDeadlines: (projectId: string, taskId: string) =>
    api.post<AiSuggestReply>(`/api/projects/${projectId}/ai/suggest-soft-deadlines`, { task_id: taskId }, options),
};
