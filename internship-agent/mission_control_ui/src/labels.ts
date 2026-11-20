// Plain-English names for the runner's result reasons (ats/*.py, unblock.py).

const REASONS: Record<string, string> = {
  UNANSWERED_REQUIRED: "Required question the profile can't answer",
  PRESUBMIT_CHECK: "Required field still empty before Submit",
  VALIDATION_ERROR: "The form rejected an answer",
  CAPTCHA: "CAPTCHA",
  REJECTED_BY_ATS: "Refused as spam / bot",
  WORKDAY_LOGIN: "Workday sign-in needed",
  WORKDAY_ACCOUNT: "Workday account or e-mail verification",
  WORKDAY_RETURNED: "Workday sent Submit back to an earlier page",
  WORKDAY_REVIEW_ERRORS: "Workday Review page shows an error",
  WORKDAY_READY_FOR_REVIEW: "Stopped at Workday Review",
  WORKDAY_PAGE: "A Workday page did not advance",
  EMAIL_VERIFICATION_CODE: "E-mailed code not entered",
  UNCONFIRMED: "No confirmation e-mail arrived",
  NO_CONFIRMATION: "No confirmation after Submit",
  FORM_NOT_FOUND: "Application form did not load",
  TIMEOUT: "Timed out",
};

export const reasonLabel = (reason: string) => REASONS[reason] ?? reason.replace(/_/g, " ").toLowerCase();

