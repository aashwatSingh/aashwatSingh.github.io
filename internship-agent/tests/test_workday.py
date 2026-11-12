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


def test_host_checks_reject_spoofed_urls():
    from urls import host_matches
    import scraper
    spoofed = ["https://evil.example\\@acme.wd5.myworkdayjobs.com/en-US/careers/job/x",
               "https://attackermyworkdayjobs.com/x/job/y",
               "https://acme.wd5.myworkdayjobs.com@evil.example/x",
               "javascript://acme.wd5.myworkdayjobs.com/%0aalert(1)"]
    for url in spoofed:
        assert not WorkdayAdapter.matches(url), url
        assert scraper.detect_ats(url) != "Workday", url
    assert not host_matches("https://clever.co/jobs", "lever.co")
    assert not host_matches("https://evil.example\\@jobs.lever.co/acme/x", "lever.co")
    assert adapter_for("https://evil.example\\@jobs.lever.co/acme/00000000-0000-0000-0000-000000000000") is None
    assert host_matches("https://jobs.eu.lever.co/acme/x", "lever.co")
    assert host_matches("https://ACME.wd5.myworkdayjobs.com./x", "myworkdayjobs.com")
