from ats import ADAPTERS, DEFAULT_ATS, adapter_for
from ats.workday import AUTH_STEP, REVIEW_STEP, WorkdayAdapter, step_name


def test_matches_only_workday_hosts():
    assert WorkdayAdapter.matches("https://acme.wd5.myworkdayjobs.com/External/job/Austin/SWE-Intern_R1")
    assert WorkdayAdapter.matches("https://wd3.myworkdaysite.com/recruiting/acme/careers/job/x")
    assert not WorkdayAdapter.matches("https://job-boards.greenhouse.io/acme/jobs/1")
    assert adapter_for("https://acme.wd1.myworkdayjobs.com/x/job/y").name == "Workday"


def test_workday_is_opt_in():
    assert "Workday" in ADAPTERS and "workday" not in DEFAULT_ATS.lower()
    assert WorkdayAdapter.create_accounts is False


def test_step_names():
    assert step_name("current step 1 of 6\nCreate Account/Sign In") == "Create Account/Sign In"
    assert step_name("current step 2 of 6 My Information") == "My Information"
    assert AUTH_STEP.search("Create Account/Sign In") and not AUTH_STEP.search("My Information")
    assert REVIEW_STEP.search("Review") and not REVIEW_STEP.search("My Experience")
