"""Build a reusable one-page cover_letter.pdf from candidate_profile.json (no company named).

    python make_cover_letter.py

Written from the profile's education, first experience and projects only. The agent uploads it only when a
form marks the cover letter as required (logistics.cover_letter_path in the profile points at it).
"""
from __future__ import annotations

import html
from playwright.sync_api import sync_playwright

import config


def letter_html(p: dict) -> str:
    ident, edu, links = p["identity"], p["education"], p.get("links") or {}
    job = (p.get("experience") or [{}])[0]
    projects = p.get("projects") or []
    solo = next((x for x in projects if "fullstack" in x.get("focus", [])), projects[0] if projects else None)
    contact = " | ".join(x for x in (ident["email"], ident.get("phone_formatted"), links.get("linkedin"),
                                     links.get("github")) if x)
    paras = [
        f"I am a {edu['major']} student at {edu['school']} (graduating {int(edu['grad_month']):02d}/{edu['grad_year']}) "
        f"applying for a Summer 2027 software engineering internship. I like taking slow, manual workflows and "
        f"turning them into software that is tested, measured and dependable, and I am looking for a team where I "
        f"can do that at production scale.",
        (f"As {job['title']} at {job['company']}, I " + job["bullets"][0][0].lower() + job["bullets"][0][1:] + " "
         + "I also " + job["bullets"][1][0].lower() + job["bullets"][1][1:]) if len(job.get("bullets") or []) > 1 else "",
        (f"{solo['name']} is my own project: I " + solo["detail"][0].lower() + solo["detail"][1:]) if solo else "",
        f"My coursework at {edu['school'].replace('The ', '')} includes {edu['coursework']}. Across these projects I work "
        f"mostly in {', '.join(p['skills']['languages'][:4])}, and I back changes with automated tests so that a fix "
        f"in one place does not quietly break another.",
        "I would welcome the chance to contribute to your engineering team this summer, and I am available full-time "
        "from May through August 2027. Thank you for your time and consideration.",
    ]
    body = "".join(f"<p>{html.escape(x)}</p>" for x in paras if x)
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>
      @page {{ size: Letter; margin: 1in; }}
      body {{ font-family: Georgia, 'Times New Roman', serif; font-size: 11.5pt; line-height: 1.45; color: #111; }}
      h1 {{ font-size: 18pt; margin: 0 0 2pt; }} .c {{ font-size: 10pt; color: #444; margin-bottom: 22pt; }}
      p {{ margin: 0 0 11pt; text-align: left; }}
    </style></head><body>
      <h1>{html.escape(ident['full_name'])}</h1><div class="c">{html.escape(contact)}</div>
      <p>Dear Hiring Team,</p>{body}
      <p>Sincerely,<br>{html.escape(ident['full_name'])}</p></body></html>"""


def main() -> None:
    profile = config.load_profile()
    out = config.BASE / "cover_letter.pdf"
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page()
        page.set_content(letter_html(profile))
        page.pdf(path=str(out), format="Letter", print_background=True)
        browser.close()
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
