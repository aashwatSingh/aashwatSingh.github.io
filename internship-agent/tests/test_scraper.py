import json

import scraper


def job(**kw):
    base = dict(company="Acme", title="Software Engineer Intern", url="https://job-boards.greenhouse.io/acme/jobs/1",
                locations=["Austin, TX"], terms=["Summer 2027"], category="Software", degrees=["Bachelor's"])
    base.update(kw)
    return scraper.make_job(**base)


def test_eligible_listing_is_pending():
    j = job()
    assert j["status"] == "pending" and j["ats"] == "Greenhouse" and j["ats_job_id"] == "1"


def test_prequalification_skips():
    assert job(terms=["Summer 2026"])["status"] == "skipped_ineligible"
    assert job(sponsorship="U.S. Citizenship is Required")["status_detail"] == "requires U.S. citizenship"
    assert job(degrees=["PhD"])["status"] == "skipped_ineligible"
    assert job(title="PhD Intern - Software Engineer")["status"] == "skipped_ineligible"
    assert job(title="Marketing Intern", category="Software")["status_detail"] == "non-software role"
    assert job(locations=["Toronto, ON, Canada"])["status_detail"] == "outside the United States"
    assert job(title="Hardware Design Intern", category="Hardware")["status"] == "skipped_ineligible"
    assert job(sponsorship="Does Not Offer Sponsorship")["status"] == "pending"      # kept, just sorted later


def test_clean_url_drops_tracking_only():
    assert scraper.clean_url("http://acme.com/job?gh_jid=5&utm_source=Simplify&ref=Simplify") \
        == "https://acme.com/job?gh_jid=5"


def test_detect_ats():
    assert scraper.detect_ats("https://acme.wd5.myworkdayjobs.com/x/job/1") == "Workday"
    assert scraper.detect_ats("https://acme.com/careers?gh_jid=12") == "Greenhouse"
    assert scraper.detect_ats("https://jobs.ashbyhq.com/acme/abc") == "Ashby"


def test_parse_listings_json_skips_inactive():
    data = [
        {"company_name": "A", "title": "Software Engineer Intern", "url": "https://jobs.lever.co/a/0f6a1b2c-0000-4000-8000-000000000001/apply?utm_source=Simplify",
         "active": True, "is_visible": True, "terms": ["Summer 2027"], "locations": ["NYC"], "category": "Software"},
        {"company_name": "B", "title": "Software Engineer Intern", "url": "https://b.com/1", "active": False,
         "is_visible": True, "terms": ["Summer 2027"]},
    ]
    jobs = scraper.parse_listings_json(json.dumps(data), "test")
    assert len(jobs) == 1 and jobs[0]["ats"] == "Lever" and "utm_source" not in jobs[0]["url"]


def test_parse_readme_table():
    html = '''
## 💻 Software Engineering Internship Roles
<table><tbody>
<tr>
<td><strong><a href="https://simplify.jobs/c/Acme">Acme</a></strong></td>
<td>Backend Engineer Intern</td>
<td>Austin, TX</td>
<td><div align="center"><a href="https://jobs.ashbyhq.com/acme/0f6a1b2c-0000-4000-8000-000000000001/application?utm_source=Simplify&ref=Simplify"><img src="x" alt="Apply"></a> <a href="https://simplify.jobs/p/abc"><img src="y" alt="Simplify"></a></div></td>
<td>0d</td>
</tr>
<tr>
<td>↳</td>
<td>Frontend Engineer Intern 🇺🇸</td>
<td>Remote in USA</td>
<td><div align="center"><a href="https://acme.com/jobs/2"><img src="x" alt="Apply"></a></div></td>
<td>1d</td>
</tr>
<tr>
<td><strong>Closed Co</strong></td>
<td>Software Intern</td>
<td>NYC</td>
<td><div align="center">🔒</div></td>
<td>3d</td>
</tr>
</tbody></table>'''
    jobs = scraper.parse_readme_tables(html, "readme")
    assert [(j["company"], j["status"]) for j in jobs] == [("Acme", "pending"), ("Acme", "skipped_ineligible")]
    assert jobs[0]["category"] == "Software" and jobs[0]["ats"] == "Ashby"


def test_merge_keeps_existing_status():
    existing = job()
    existing["status"] = "applied"
    queue, added = scraper.merge_into_queue([existing], [job(), job(url="https://job-boards.greenhouse.io/acme/jobs/2")])
    assert added == 1 and queue[0]["status"] == "applied"


def test_parse_pipe_tables_reads_only_usa_internships():
    md = """## 2027 USA SWE Internships :books:
### Other
| Company | Position | Location | Salary | Posting | Age |
|---|---|---|---|---|---|
| <a href="https://acme.com"><strong>Acme</strong></a> | Software Engineer Intern - Summer 2027 | Austin, TX +2 | $50/hr | <a href="https://jobs.ashbyhq.com/acme/0f6a1b2c-0000-4000-8000-000000000001"><img src="x" alt="Apply" width="70"/></a> | 4d |
| <a href="https://b.com"><strong>Beta</strong></a> | Software Engineer - Intern - PhD | San Jose, CA | $60/hr | <a href="https://b.com/1"><img src="x" alt="Apply"/></a> | 4d |
## 2027 USA New Grad Positions
| Company | Position | Location | Salary | Posting | Age |
|---|---|---|---|---|---|
| <a href="https://c.com"><strong>Gamma</strong></a> | Software Engineer New Grad | NYC | $150k | <a href="https://c.com/1"><img src="x" alt="Apply"/></a> | 1d |
"""
    jobs = scraper.parse_pipe_tables(md, "speedy", "Software")
    assert [(j["company"], j["status"]) for j in jobs] == [("Acme", "pending"), ("Beta", "skipped_ineligible")]
    assert jobs[0]["locations"] == ["Austin, TX"] and jobs[0]["ats"] == "Ashby"


def test_board_tokens_from_any_listing():
    found = scraper.board_tokens([
        {"url": "https://job-boards.greenhouse.io/Acme/jobs/1", "company": "Acme"},
        {"url": "https://jobs.ashbyhq.com/beta.ai/0f6a1b2c-0000-4000-8000-000000000001", "company_name": "Beta"},
        {"url": "https://acme.wd5.myworkdayjobs.com/x/job/1", "company": "Acme"},
    ])
    assert found["Greenhouse"] == {"acme": "Acme"} and found["Ashby"] == {"beta.ai": "Beta"} and not found["Lever"]


def test_other_cohorts_are_skipped():
    assert job(title="High School Software Intern")["status"] == "skipped_ineligible"
    assert job(title="Software Engineer Intern - Summer 2026")["status"] == "skipped_ineligible"
