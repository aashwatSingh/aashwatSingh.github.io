/**
 * @author Preethi Seereddy
 * @description The soft-deadline rule, checked instantly in the browser before saving: a soft deadline is
 *   valid only if it is strictly earlier than the task's final due date (the server checks it again).
 * @traces SE-FR-06, SE-FR-09, UC-05, UC-06
 */

export const SOFT_DEADLINE_ERROR = "Soft deadline must be earlier than the task's final due date.";
export const NEEDS_DUE_DATE = 'Add a final due date to this task before setting soft deadlines.';

/** true iff t_soft < t_final (O(1)). */
export function validateSoftDeadlineDate(softDateIso: string | null | undefined, taskDueDateIso: string | null | undefined): boolean {
  if (!softDateIso || !taskDueDateIso) return false;
  const soft = new Date(softDateIso).getTime();
  const final = new Date(taskDueDateIso).getTime();
  if (Number.isNaN(soft) || Number.isNaN(final)) return false;
  return soft < final;
}

export function softDeadlineError(softDateIso: string | null | undefined, taskDueDateIso: string | null | undefined): string | null {
  if (!taskDueDateIso) return NEEDS_DUE_DATE;
  if (!softDateIso) return 'Choose a date and time';
  return validateSoftDeadlineDate(softDateIso, taskDueDateIso) ? null : SOFT_DEADLINE_ERROR;
}
