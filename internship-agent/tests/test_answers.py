"""Regression tests for the answer engine. Every case here came from a real form."""
import json
from pathlib import Path

import pytest

from answers import AnswerEngine, Context, Question

PROFILE = json.loads((Path(__file__).parent / "fixture_profile.json").read_text())
ENGINE = AnswerEngine(PROFILE, custom_answers=[])
YN = ["Yes", "No"]


def ask(label, kind="select", options=None, required=True, company="Acme", **kw):
    q = Question(label=label, kind=kind, required=required,
                 options=YN if options is None and kind == "select" else (options or []), **kw)
    return ENGINE.resolve(q, Context(company=company, labels=[label]))


def filled(label, **kw):
    d = ask(label, **kw)
    assert d.action == "fill", f"{label!r}: {d}"
    return d.value


def blocked(label, **kw):
    d = ask(label, **kw)
    assert d.action == "unknown", f"{label!r} should not be auto-answered, got {d}"


# --- work authorization: polarity must never flip ---------------------------
@pytest.mark.parametrize("label", [
    "Will you now or in the future require sponsorship for employment visa status?",
    "Do you require visa sponsorship now or in the future?",
    "We are not able to facilitate any type of sponsorship at this time. Will you now or in the "
    "future require sponsorship for employment visa status (e.g., H-1B, etc.)?",
    "Will you now or in the future require sponsorship for employment? For instance, an H-1B? Toshiba "
    "will not be providing visa sponsorship. Therefore you must have the ability to work without a "
    "need for current or future visa sponsorship.",
])
def test_requires_sponsorship_is_yes(label):
    assert filled(label) == "Yes"


@pytest.mark.parametrize("label", [
    "Are you authorized to work in the United States without sponsorship?",
    "Are you legally authorized to work in the United States for the duration of this internship "
    "without sponsorship from the firm?",
])
def test_authorized_without_sponsorship_is_no(label):
    assert filled(label) == "No"


def test_authorized_to_work_is_yes():
    assert filled("Are you legally authorized to work in the United States?") == "Yes"


def test_descriptive_sponsorship_options():
    opts = ["Yes, I will require sponsorship now or in the future", "No, I will not require sponsorship"]
    assert filled("Will you now or in the future require employer sponsorship?", options=opts) == opts[0]


@pytest.mark.parametrize("label", [
    "Citizenship Status", "Are you a U.S. citizen?", "What is your current visa status?",
    "Are you a U.S. person as defined by ITAR?",
    "Do you require any reasonable adjustments or accommodations to participate in the recruitment "
    "process? (Do not include VISA or relocation expectations)",
    "Please note that sponsorship is not allowed for this role. Also, if you are an international "
    "candidate, please confirm that your work authorization allows you to work as an independent "
    "contractor. Please confirm by selecting 'Yes'.",
    "Are you legally authorized to work in Canada?",
])
def test_never_answered(label):
    blocked(label)


def test_authorization_statement_follows_sponsorship_need():
    assert "require sponsorship" in filled("Are you legally authorized to work in the United States?", options=[
        "I am authorized to work in the United States for any employer",
        "I am authorized to work in the United States for my present employer only",
        "I require sponsorship to work in the United States",
        "I am not authorized to work in the United States"])


def test_contact_method_and_new_rules():
    assert filled("What is the best way to contact you?", kind="textarea").lower().startswith("email")
    assert filled("Will this be your final internship before graduating?", kind="radio", options=["Yes", "No"]) == "Yes"
    assert filled("Will you be officially enrolled during the internship?", kind="radio", options=["Yes", "No"]) == "Yes"
    assert filled("When would you like to intern with us?", kind="radio",
                  options=["Summer", "Off-cycle (e.g. during spring or fall)"]) == "Summer"
    assert filled("How did you hear about us?", options=["Referral", "Indeed", "Job Board", "Other"]) == "Job Board"


def test_logistics_text_answers():
    assert filled("Start month/year of university and end month/year of university", kind="textarea").count("/") == 2
    assert filled("Do you have any planned time off or availability constraints during the internship period "
                  "(e.g. travel, other commitments)? If so, please share the dates.", kind="text").startswith("No")
    assert filled("Are you now or have you ever been listed on the List of Parties excluded from Federal Procurement "
                  "and Non-Procurement Programs?", options=["Yes", "No"]) == "No"


# --- things that must not be answered by keyword accident --------------------
@pytest.mark.parametrize("label,kind", [
    ("Why did you want to become an engineer in your respective discipline?", "textarea"),
    ("Why are you interested in Acme's Software Engineering Internship?", "textarea"),
    ("Is there any other context you'd like to share about your U.S. Immigration sponsorship needs?", "textarea"),
    ("Are you able to be onsite in San Carlos, CA from Feb 1st - Feb 5th, 2027?", "select"),
    ("Are you comfortable working onsite 5 days a week and commit to 55 hours per week?", "select"),
    ("Why Acme?", "textarea"),
    ("Based on what is publicly available about Acme, what is a challenging technical problem you think "
     "we face?", "textarea"),
])
def test_not_guessed(label, kind):
    blocked(label, kind=kind)


def test_own_project_essay_is_answered():
    assert filled("Tell us about a technical project you've worked on through a class or research.",
                  kind="textarea") == PROFILE["essays"]["challenging_project"]
    assert filled("Please describe the most impressive and complex project you have worked on.",
                  kind="textarea") == PROFILE["essays"]["challenging_project"]


def test_start_date_does_not_pick_a_range_option():
    blocked("Preferred Internship/Co-Op Start Date",
            options=["Monday, March 1, 2027- May 21,2027", "June 1, 2027 - August 2027"])


def test_ethnicity_does_not_pick_a_mixed_option():
    blocked("What is your ethnicity?", options=["Asian", "White and Asian", "Black", "Other"])
    assert filled("Race", options=["White (Not Hispanic or Latino)", "Asian (Not Hispanic or Latino)",
                                   "Two or More Races"]) == "White (Not Hispanic or Latino)"


def test_heard_about_ignores_lookalike_sources():
    opts = ["SEO Career", "Campus Career Site", "Employee Referral", "LinkedIn"]
    assert filled("How did you hear about this job?", options=opts) == "LinkedIn"
    assert filled("How did you hear about us?", options=["Referral", "Company Website", "Event"]) == "Company Website"


# --- facts straight from the profile -----------------------------------------
def test_gpa_blank_when_optional_and_exact_when_required():
    assert ask("GPA", kind="text", required=False).action == "skip"
    assert filled("GPA", kind="text") == PROFILE["education"]["gpa"]
    assert filled("What is your GPA?", options=["3.5 - 4.0", "3.0 - 3.49", "Below 3.0"]) == "Below 3.0"


def test_graduation():
    assert filled("What is your expected graduation year?", kind="text") == "2028"
    assert filled("Expected graduation", options=["Fall 2027", "Spring 2028", "Fall 2028"]) == "Spring 2028"
    assert filled("Will you be graduating before September 2027?") == "No"
    assert filled("Are you currently enrolled in a bachelor's degree program with anticipated graduation "
                  "between December 2027 and June 2030?") == "Yes"
    assert filled("I'm a current student aiming to complete my degree in either Fall 2027 or Spring 2028.",
                  kind="checkbox") is True


def test_dated_program_inside_window_is_yes():
    assert filled("Can you commit to attending the full program, starting on June 7, 2027 and "
                  "finishing on August 6, 2027?") == "Yes"
    blocked("Are you available for the full program from June 1 through August 27, 2027?")


def test_typed_name_certification():
    assert filled("I hereby certify that my answers are true and complete. I hereby authorize Acme to verify "
                  "the same. I acknowledge this by entering my full name below.", kind="text") \
        == PROFILE["identity"]["full_name"]


def test_identity_and_misc():
    assert filled("First Name", kind="text") == PROFILE["identity"]["first_name"]
    assert filled("LinkedIn Profile", kind="text") == PROFILE["links"]["linkedin"]
    assert filled("Website", kind="text") == PROFILE["links"]["portfolio"]
    assert filled("Are you 18 years of age or older?") == "Yes"
    assert filled("Gender", options=["Male", "Female", "Decline To Self Identify"]) == "Female"
    assert filled("Veteran Status", options=["I am not a protected veteran", "I identify as a veteran",
                                             "I don't wish to answer"]) == "I am not a protected veteran"
    assert filled("Please indicate which programming languages you are proficient in", kind="multiselect",
                  options=["Go", "Java", "Python", "Rust"]) == ["Java", "Python"]


def test_prior_employment_and_legal_name():
    assert filled("Have you been employed by Acme before?", kind="boolean", options=YN) == "No"
    assert filled("Please state your full legal name:", kind="text") == PROFILE["identity"]["full_name"]
    assert ask("Full Legal Name in Native Language (e.g. Chinese Characters)", kind="text",
               required=False).action == "skip"


def test_sms_consent_is_declined_not_blocked():
    assert filled("SMS Consent: Do you agree to receive mobile messages from us in relation to this job "
                  "application? Message and data rates may apply. Reply STOP to opt out.") == "No"


def test_custom_answers_override():
    eng = AnswerEngine(PROFILE, custom_answers=[{"pattern": "outstanding offers", "answer": False}])
    d = eng.resolve(Question("Are you holding any outstanding offers?", "select", True, YN), Context())
    assert (d.action, d.value) == ("fill", "No")


# --- extended coverage -------------------------------------------------------
def test_never_claimed_and_unlisted_tech_is_no_or_zero():
    assert filled("Do you have experience with Docker?") == "No"
    assert filled("Do you have experience building REST APIs?") == "No"
    assert filled("Do you have experience with Kubernetes?") == "No"
    assert filled("Do you have experience with Python?") == "Yes"
    assert filled("How many years of experience do you have with REST APIs?", kind="text") == "0"
    assert filled("How many years of experience do you have with Docker?", kind="number") == "0"


def test_years_of_experience_follow_the_profile():
    assert filled("How many years of programming experience do you have?", kind="text") == "1"
    assert filled("Years of full-time professional experience", kind="number") == "0"
    assert filled("Years of experience", options=["0-1", "2-3", "4+"]) == "0-1"


def test_local_questions_use_the_address():
    assert filled("Are you local to NYC or the Tri-State area and able to commute in?") == "No"
    assert filled("Are you located in the United States?") == "Yes"
    opts = ["Yes, I already live in or near New York City", "Yes, I will relocate to New York City", "No"]
    assert filled("Are you based in New York City?", options=opts) == opts[1]


def test_post_internship_and_high_school():
    assert filled("Will you be available for a full-time role immediately post-internship?",
                  options=["Yes", "No", "I am awaiting further information"]) == "No"
    assert filled("Please confirm you are currently enrolled in high school.") == "No"
    assert filled("Are you a current University of Waterloo student?") == "No"


def test_office_preference_order():
    eng = AnswerEngine(PROFILE, custom_answers=[])
    ctx = Context(company="Acme")
    opts = ["London, UK", "New York, NY", "Seattle, WA", "Austin, TX"]
    first = eng.resolve(Question("First location preference:", "select", True, opts), ctx)
    second = eng.resolve(Question("Second location preference", "select", True, opts), ctx)
    assert (first.value, second.value) == ("Austin, TX", "Seattle, WA")
    blocked("Preferred Work Location", options=["London", "Paris", "Singapore"])


def test_misc_extended():
    assert filled("Which programming language would you like to work with during your internship?",
                  kind="text") == "Python"
    assert filled("Please confirm the season you are applying for.",
                  options=["Spring 2027", "Summer 2027", "Fall 2027"]) == "Summer 2027"
    assert filled("What type of position are you applying for?", options=["Full-time", "Internship"]) == "Internship"
    assert filled("Are you currently employed by a client, partner, or competitor of Acme?") == "No"
    assert filled("Please include your middle name. If you do not have one, please enter N/A", kind="text") == "N/A"
    assert filled("Which Acme campus event did you attend? Please enter N/A if not applicable.", kind="text") == "N/A"
    assert filled("Who is your current or previous employer?", kind="text") == "Example Labs"
    assert filled("Please re-confirm the university you currently attend", kind="text") == PROFILE["education"]["school"]
    assert filled("What is your desired hourly rate? (numbers only)", kind="text") == "40"
    assert filled("Expected annual salary", kind="number") == "80000"
    assert filled("I confirm all answers provided by me within this application are true and correct.",
                  kind="checkbox") is True
    blocked("The Mutual Arbitration Agreement is legally binding on you and the company.")
    assert filled("Do you have any outstanding offers or deadlines?") == "No"


def test_graduation_windows():
    assert filled("Will you graduate from January 2028-Summer 2028?") == "Yes"
    assert filled("Are you graduating in December 2027 or May/June 2028?") == "Yes"
    assert filled("Are you graduating in December 2027 or December 2028?") == "No"
    assert filled("Will you be an active college student at the time of this internship?") == "Yes"


def test_audit_regressions_round_two():
    assert filled("If you are based in the U.S. please provide your zipcode:", kind="text") \
        == PROFILE["address"]["postal_code"]
    assert filled("Internship Duration", options=["3 months", "4 months", "6 months", "12 months"]) == "3 months"
    opts = ["I will be enrolled in a bachelor's degree program by the start",
            "I will be enrolled in a graduate degree program by the start", "None of the above"]
    assert filled("Please select your enrollment status:", options=opts) == opts[0]
    blocked("How much experience in C programming language do you have?",
            options=["Less than 3 months", "3-5 months", "6-9 months", "10 months +"])
    assert filled("Do you have housing accommodations in the Austin area?") == "No"
    assert filled("Will you be local to Chicago for the summer of 2027?") == "Yes"
    blocked("Please provide your university email address.", kind="text")


def test_audit_regressions_round_three():
    assert filled("When did you begin your current degree program? Please answer in MM/YYYY format (e.g. 08/2022)",
                  kind="text") == "08/2024"
    assert filled("When do you expect to complete your current degree program? Please answer in MM/YYYY format "
                  "(e.g. 08/2022)", kind="text") == "05/2028"
    for label in ("Tell us about your two strongest technical accomplishments from school or past internships.",
                  "Technical Accomplishments - School/Internships"):
        d = ask(label, kind="textarea", required=False)
        assert d.action != "fill" or d.value != PROFILE["education"]["school"], label
    assert filled("Current school or university:", kind="text") == PROFILE["education"]["school"]


def test_audit_regressions_round_four():
    # mentions the military but is not a veteran-status question
    assert filled("Acme provides technology and support to the United States military and allied forces. Are you "
                  "comfortable contributing to this mission?", options=["Yes", "No", "Other"]) == "Yes"
    assert filled("Have you served in the military?") == "No"
    opts = ["Crystal City, Virginia", "Dallas, Texas", "San Diego, California", "Boston, Massachusetts"]
    assert filled("Which of our office(s) would you be willing to work from/relocate to?", options=opts) == "Dallas, Texas"
    assert filled("Prior US Government Employment?", kind="boolean", options=YN) == "No"


def test_blockers_round_five():
    assert filled("What intern season are you interested in?", options=["Spring 2027", "Summer 2027"]) == "Summer 2027"
    assert filled("I understand that this position requires me to work on-site.", options=["I understand"]) == "I understand"
    assert filled("Are you available for a minimum 12 week internship?") == "Yes"
    assert filled("Do you have, or are you currently pursuing, a college degree?") == "Yes"
    assert filled("What year do you intend to complete your degree?", kind="text") == "2028"
    assert filled("What class year will you be entering in Fall 2027?",
                  options=["Sophomore", "Junior", "Senior", "Graduate"]) == "Senior"
    assert filled("What is your most recently completed form of education?",
                  options=["High School", "Associate", "Bachelor's", "Master's"]) == "High School"
    assert filled("Your current location", kind="text") == "Springfield, IL"
    blocked("Do you have prior internship or co-op experience?")


# --- answers the candidate stated explicitly ------------------------------------
def test_stated_attestations():
    assert filled("After your review of the job description, do you meet each of the basic qualifications?") == "Yes"
    assert filled("Are you able to perform the essential functions of this job?") == "Yes"
    assert filled("Is there any reason why you would not be able to perform the duties of the job?") == "No"
    assert filled("Are you holding any outstanding offers?") == "No"
    assert filled("Do you have an active offer deadline we should be aware of? If yes, share the date.",
                  kind="text") == "N/A"
    assert filled("Have you previously interviewed with us?") == "No"


def test_clearance_answers():
    assert filled("Do you currently possess an active U.S. Top Secret security clearance?") == "No"
    assert filled("Active Security Clearance(s)", options=["None", "Secret", "Top Secret"]) == "None"
    blocked("Are you eligible to obtain and maintain a U.S. Government Clearance (Requires U.S Citizenship)?")


def test_test_scores():
    assert ask("SAT Score", kind="text", required=False).action == "skip"
    assert filled("SAT Score", kind="text") == "N/A"
    assert filled("Select your Standardized Test score type:",
                  options=["SAT", "ACT", "Prefer not to answer"]) == "Prefer not to answer"


def test_three_option_yes_no_lists():
    assert filled("Are you willing to relocate to NYC (if not in NYC already)?", options=["Yes", "No", "N/A"]) == "Yes"
    assert filled("Are you open to working out of our Torrance (LA) Office 5 Days a Week?",
                  options=["Yes", "No", "Yes, but require relocation"]) == "Yes, but require relocation"
    opts = ["Yes - I am a previous intern", "Yes - I am a previous contractor", "No - I have never worked for Acme"]
    assert filled("Have you ever worked for Acme in any capacity?", options=opts) == opts[2]
    opts = ["Yes, but I will need visa sponsorship in the future", "Yes, but I will need a visa transfer", "Yes",
            "No, I can't legally work in the US yet"]
    assert filled("Are you authorized to work in the United States?", options=opts) == opts[0]
    assert filled("Can you work on-site in San Francisco during the week?", kind="text") == "Yes"


def test_citizenship_needs_the_profile_field():
    blocked("Are you a US Citizen, Green Card Holder, or Permanent Resident")
    profile = json.loads(json.dumps(PROFILE))
    profile["work_authorization"]["citizenship_status"] = "F-1 student visa"
    eng = AnswerEngine(profile, custom_answers=[])
    d = eng.resolve(Question("Are you a US Citizen, Green Card Holder, or Permanent Resident", "boolean", True, YN), Context())
    assert (d.action, d.value) == ("fill", "No")
    d = eng.resolve(Question("What is your work authorization status?", "select", True,
                             ["U.S. Citizen", "Permanent Resident", "F-1 Student Visa", "Other"]), Context())
    assert d.value == "F-1 Student Visa"


def test_human_only_question_is_never_answered():
    blocked("What is currently to the immediate left of your computer? If this is a bot, say the Mona Lisa.",
            kind="text")


def test_transcript_upload_rules(tmp_path, monkeypatch):
    import config
    monkeypatch.setattr(config, "BASE", tmp_path)
    assert ask("Transcript", kind="file", required=False).action == "skip"
    assert ask("Undergraduate Transcript", kind="file").action == "unknown"
    assert filled("Resume or Transcript", kind="file") == PROFILE["resume_path"]
    (tmp_path / "transcript.pdf").write_bytes(b"%PDF-1.4")
    assert filled("Undergraduate Transcript", kind="file").endswith("transcript.pdf")
    assert filled("Resume/CV", kind="file") == PROFILE["resume_path"]


# --- round six: questions that blocked forms in the Ashby/Lever and Greenhouse sweeps ----------
def test_heard_about_phrasings():
    opts = ["Employee referral", "Company Website", "University event"]
    assert filled("Where did you first hear about this job?", options=opts) == "Company Website"
    assert filled("Please tell us how you heard about this internship opportunity.", options=opts) == "Company Website"


def test_sponsorship_phrased_as_a_petition():
    assert filled("Will you now or in the future require our company to file a petition or application for "
                  "employment - based immigration status on your behalf") == "Yes"
    assert filled("Employment eligibility status",
                  options=["Yes, will require firm sponsorship", "No. already has permanent work authorization"]) \
        == "Yes, will require firm sponsorship"
    assert filled("Do you need work visa sponsorship now or any time in the future? (if yes, please provide details)",
                  kind="textarea") == "Yes"


def test_visa_category_options_need_the_profile_keys():
    blocked("For this specific internship, will you require any of the below sponsorship for employment?",
            options=["J1", "F1", "None", "Other"], kind="radio")
    profile = json.loads(json.dumps(PROFILE))
    profile["work_authorization"].update(internship_work_authorization="F1", future_sponsorship_visa="H1B",
                                         requires_sponsorship_now=False)
    eng = AnswerEngine(profile, custom_answers=[])
    d = eng.resolve(Question("For this specific internship, will you require any of the below sponsorship for "
                             "employment?", "radio", True, ["J1", "F1", "None", "Other"]), Context())
    assert d.value == "F1"
    d = eng.resolve(Question("Will you now or at any time in the future require sponsorship for employment visa "
                             "status (e.g. H1B, OPT)?", "radio", True, ["OPT", "H1B", "TN", "None", "Other"]), Context())
    assert d.value == "H1B"
    opts = ["Yes, I will require immigration sponsorship now", "Yes, I will require immigration sponsorship in the future",
            "No, I do not and will not require immigration sponsorship"]
    d = eng.resolve(Question("Will you now or in the future require company sponsorship to retain or extend your work "
                             "authorization?", "select", True, opts), Context())
    assert d.value == opts[1]


def test_graduation_option_windows():
    ranges = ["I've already graduated", "August 2027 - December 2027", "January 2028 - July 2028",
              "August 2028 - December 2028", "After January 2029"]
    assert filled("Please re-confirm your expected graduation date", options=ranges) == "January 2028 - July 2028"
    crystal = ["Spring 2026", "Fall 2026", "Winter 2026/27 (on or before Jan 31, 2027)", "Before 2026",
               "After Jan 31, 2027", "N/A - Not pursuing higher education"]
    assert filled("What is your expected graduation date?", options=crystal) == "After Jan 31, 2027"
    assert filled("Field of Study in your Undergraduate degree", options=["Computer Science", "Physics"]) \
        == "Computer Science"
    assert ask("Field of Study in your Postgraduate degree", options=["Computer Science", "Physics"],
               required=False).action == "skip"
    assert filled("Level of education completed once you’ve graduated?",
                  options=["Associate's", "Bachelor's", "Master's", "PhD"]) == "Bachelor's"
    assert filled("Have you completed your junior year of study (i.e., are you entering your senior year) or are "
                  "you a graduate student?") == "Yes"
    assert filled("Do you intend to return to a degree-seeking program at the conclusion of the internship for at "
                  "least 1 more term?") == "Yes"


def test_accommodation_only_blocks_when_it_is_the_question():
    assert filled("We work from our offices on Mondays, Tuesdays, and Thursdays (Anchor Days). If you need an "
                  "accommodation, we’ll partner with you and explore reasonable options consistent with applicable "
                  "law. Are you able to commit to working from one of our offices on Anchor Days each week?",
                  kind="boolean", options=YN) == "Yes"
    blocked("Do you require any reasonable adjustments or accommodations to participate in the recruitment process?")


def test_ai_attestations_are_left_to_the_candidate():
    blocked("AI Policy for Application", kind="boolean", options=YN)
    blocked("Trust is one of our values. I confirm that the information I provide is true, complete, and reflects my "
            "own experience and thinking.", kind="checkbox")
    # an ordinary truth certification is still acknowledged
    assert filled("I certify that the information in this application is true and correct.", kind="checkbox") is True


def test_option_lists_with_one_negative_statement():
    opts = ["I have not previously been employed at Acme", "I have been employed at Acme as a full-time employee",
            "I have been employed at Acme as an intern"]
    assert filled("Have you previously been employed at Acme for any length of time?", options=opts) == opts[0]


def test_pay_buckets_and_offices():
    buckets = ["less than 25k", "26-30k", "71-75k", "76-80k", "81-85k"]
    assert filled("Target Compensation", options=buckets) == "76-80k"
    assert filled("Desired hourly rate", options=["$20 - $29", "$30 - $39", "$40 - $49"]) == "$40 - $49"
    assert filled("Location Preference", options=["Chicago", "London"]) == "Chicago"
    states = ["Alabama", "Illinois", "Texas"]
    assert filled("To be eligible for this position, your primary residence must be located in the United States. "
                  "Please indicate the state in which you currently reside.", options=states) == "Illinois"


def test_skill_lists_and_ratings():
    opts = ["Frontend Frameworks (e.g., React, Angular, Vue.js)", "Backend Frameworks (e.g., Django, Flask)",
            "Mobile Development (e.g., React Native, Swift)", "Testing Frameworks (e.g., Jest, PyTest)"]
    profile = json.loads(json.dumps(PROFILE))
    profile["skills"]["tools"] = ["Git", "React", "Pytest"]
    eng = AnswerEngine(profile, custom_answers=[])
    d = eng.resolve(Question("Which web or application frameworks do you have hands-on experience using?",
                             "checkbox_group", True, opts), Context())
    assert d.value == [opts[0], opts[3]]                      # not "React Native"
    assert filled("Please rank your proficiency in Swift from 1 - 10 (1 being least proficient)", kind="number") == "1"
    blocked("Please rank your proficiency in Python from 1 - 10", kind="number")
    assert filled("Do you have experience with Android, Jetpack Compose, Kotlin, or other mobile development "
                  "technologies?", kind="text") == "No"
    assert filled("How many full-time, semester-long co-op rotations have you completed prior to this application?",
                  options=["0 Co-ops (First-time applicant)", "1 Co-op", "2 Co-ops"]) == "0 Co-ops (First-time applicant)"


def test_misc_round_six():
    orgs = ["Formula SAE / Electric Vehicle Racing", "Rocketry Team", "None of the Above"]
    assert filled("Please indicate any engineering or project-based student organizations you have been involved "
                  "with:", kind="checkbox_group", options=orgs) == ["None of the Above"]
    assert filled("What best describes the type of opportunities you're interested in:", kind="checkbox_group",
                  options=["Full-time", "Internship", "Contract"]) == ["Internship"]
    assert filled("What type of intern role are you interested?", options=["Backend", "Full stack", "Either"]) == "Either"
    assert filled("If 'Yes' to above, are you actively maintaining any security licenses?") == "No"
    assert filled("Were you eligible for free school meals at any point during your school years?",
                  options=["Yes", "No", "Don't know", "Prefer not to say"]) == "Prefer not to say"
    assert filled("Candidate's Company", kind="text") == f"Student, {PROFILE['education']['school']}"
    assert filled("What can we look at?", kind="text") == PROFILE["links"]["portfolio"]
    assert filled("Education History Still Student?", kind="checkbox") is True
    blocked("Alternate Email", kind="text")


def test_design_is_not_a_signature():
    # "designed" used to match the e-sign pattern and the prompt was answered with the candidate's name
    d = ask("We look for evidence of exceptional ability. Please provide us with 3-4 examples. We recommend starting "
            "with an action word (designed, led, built, launched, created, etc.).", kind="textarea")
    assert d.value != PROFILE["identity"]["full_name"]
    d = ask("Describe a design decision you are proud of.", kind="text")
    assert d.value != PROFILE["identity"]["full_name"]
    assert filled("E-Signature", kind="text") == PROFILE["identity"]["full_name"]
    assert filled("Signature", kind="text") == PROFILE["identity"]["full_name"]


def test_short_fact_rules_do_not_answer_long_questions():
    blocked("If you are in a Bachelor's program, do you plan to pursue a Master's program after you graduate?",
            kind="textarea")
    assert filled("Have you executed any agreement with your current or prior employer which imposes any restriction, "
                  "limitation or condition on your work activities or employment (e.g. non-compete)?",
                  kind="textarea") == "No"
    blocked("Are you named in any pending investment-related civil action? If yes, please explain. If no, enter N/A.",
            kind="textarea")
    assert filled("What is your Github username?", kind="text") == "example"


def test_round_seven_blockers():
    sources = ["Company Website", "LinkedIn", "YouTube", "University – Career Services", "Glassdoor"]
    assert filled("Select One", kind="radio", options=sources) == "LinkedIn"
    blocked("Select One", kind="radio", options=["Red", "Green", "Blue"])
    areas = ["iOS", "Backend", "Cloud infrastructure", "Android", "Machine Learning", "Data Science", "Product"]
    assert filled("What best describes the type of opportunities you're interested in:", kind="checkbox_group",
                  options=areas) == ["Backend"]
    assert filled("Acceptance of Terms and Signature", kind="multiselect",
                  options=["I have read and agree to this statement"]) == ["I have read and agree to this statement"]
    remote = ["Yes, a remote internship aligns with my needs", "No, a remote internship does not align", "Unsure"]
    assert filled("While interns will be invited to a 2-day in-person experience at HQ, the program is primarily "
                  "remote. Does a remote internship structure align with your needs?", kind="radio",
                  options=remote) == remote[0]
    assert filled("Do you attest to the following statement? Acme is an equal opportunity employer and does not "
                  "discriminate on the basis of race, religion, age or any other protected status.") == "Yes"
    assert filled("Are you currently enrolled in an accredited undergraduate or graduate program? What's the name of "
                  "the school / program? What is your expected graduation date?", kind="textarea") \
        == "Yes. Example State University, B.S. in Computer Science, expected graduation May 2028."
    blocked("Language Skill(s) (Check all that apply)", kind="checkbox_group", options=["English (ENG)", "Spanish (SPA)"])


def test_itar_status_list_follows_us_person():
    opts = ["I am a U.S. Citizen.", "I am a lawful permanent resident of the U.S.", "I am a refugee under 8 U.S.C. 1157.",
            "I am an asylee under 8 U.S.C. 1158.", "None of the above."]
    label = ("Acme complies with U.S. Government space technology export regulations, therefore will you state which "
             "of the following applies to you:")
    blocked(label, options=opts)                                   # us_person is not set in the fixture
    profile = json.loads(json.dumps(PROFILE))
    profile["work_authorization"]["us_person"] = False
    d = AnswerEngine(profile, custom_answers=[]).resolve(Question(label, "select", True, opts), Context())
    assert d.value == "None of the above."
    profile["work_authorization"].update(us_person=True, citizenship_status="U.S. Citizen", requires_sponsorship=False)
    d = AnswerEngine(profile, custom_answers=[]).resolve(Question(label, "select", True, opts), Context())
    assert d.value == "I am a U.S. Citizen."


def test_remote_collaboration_experience_follows_the_profile():
    # the fixture lists a role whose location is "Remote"
    assert filled("Do you have experience working, studying or collaborating remotely (e.g. online courses)?") == "Yes"
    profile = json.loads(json.dumps(PROFILE))
    profile["experience"][0]["location"] = "Austin, TX"
    d = AnswerEngine(profile, custom_answers=[]).resolve(
        Question("Do you have experience working, studying or collaborating remotely?", "select", True, YN), Context())
    assert d.action == "unknown"


def test_round_eight_blockers():
    d = ask("We look for evidence of exceptional ability. Each bullet should capture the problem, solution, and result.",
            kind="textarea")
    assert d.rule != "address-2"                                   # "capture" used to match "apt"
    assert filled("What is your strongest coding language?", kind="text") == "Python"
    assert filled("Residing State", options=["Illinois", "Texas"]) == "Illinois"
    assert filled("Previous Acme Employee") == "No"
    assert filled("Did a current Acme employee refer you to this position and, if so, who was it?",
                  kind="text") == "N/A"
    blocked("Is your eligibility is based on a work visa?")
    blocked("Provide your best result on ACT:", options=["<20", "21 - 25", "26 - 30"])


def test_keywords_do_not_match_inside_other_words():
    for label in ("What does excellence mean to you?", "Describe a miscellaneous project with a microphone array.",
                  "What is your cancellation policy experience?"):
        d = ask(label, kind="text")
        assert d.value != PROFILE["identity"]["phone_formatted"], label
    assert filled("Cell phone", kind="text") == PROFILE["identity"]["phone_formatted"]
    assert filled("Mobile Number", kind="text") == PROFILE["identity"]["phone_formatted"]
    blocked("Are you an international student?")


def test_contact_facts_never_fill_long_prompts():
    cases = [
        ("What's the most interesting paper, blog post, or documentation you've read in the past month?", "textarea"),
        ("At Acme we have two main Software Engineering roles: Forward Deployed Software Engineer and Software "
         "Engineer (see our website). Which of these roles resonates the most with your job search and why?", "textarea"),
        ("Acme's mission is to protect people with intelligent systems, and our values center on leading as a "
         "servant and pursuing excellence. Tell us on the phone or here which value resonates with you.", "textarea"),
        ("Our team works across many time zones and several states; please tell us in a few sentences how you like "
         "to collaborate with colleagues you rarely meet in person and what city life means to you.", "textarea"),
    ]
    facts = {PROFILE["links"]["portfolio"], PROFILE["links"]["github"], PROFILE["identity"]["phone_formatted"],
             PROFILE["address"]["city"], PROFILE["address"]["state"]}
    for label, kind in cases:
        d = ask(label, kind=kind)
        assert d.value not in facts, (label, d)
    # short link prompts still work, also in a textarea
    assert filled("Please provide a link to a portfolio, website, or github:", kind="textarea") == PROFILE["links"]["github"]
    assert filled("Website", kind="text") == PROFILE["links"]["portfolio"]
    assert ask("Please list any additional address information here, such as an apartment, suite, or unit number, "
               "if it applies to where you currently live.", kind="text", required=False).action == "skip"
    assert filled("What is your current cumulative GPA? (Note: A minimum GPA of 3.5 is required for consideration on "
                  "a 4.0 scale).", kind="text") == PROFILE["education"]["gpa"]
    # a long address prompt is still an address prompt
    assert filled("Please provide your permanent address (city, state, zip code). We use this information to determine "
                  "eligibility for relocation assistance for the internship.", kind="text").startswith("1 Example Way")
