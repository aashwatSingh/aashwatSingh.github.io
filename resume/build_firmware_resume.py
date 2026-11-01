"""Build the firmware / embedded version of Aashwat Singh's resume as a .docx.

Layout mirrors the original Word resume (Times New Roman, ruled section headings,
bold entry titles with right-aligned italic dates). Convert to PDF with:

    soffice --headless --convert-to pdf resume/Aashwat_Singh_Resume_Firmware.docx --outdir resume
"""

from pathlib import Path

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt

FONT = "Times New Roman"
BODY = 10.5
OUT = Path(__file__).with_name("Aashwat_Singh_Resume_Firmware.docx")

doc = Document()
sec = doc.sections[0]
sec.page_width, sec.page_height = Inches(8.5), Inches(11)
sec.left_margin = sec.right_margin = Inches(0.6)
sec.top_margin = Inches(0.4)
sec.bottom_margin = Inches(0.35)
TEXT_WIDTH = sec.page_width - sec.left_margin - sec.right_margin

normal = doc.styles["Normal"]
normal.font.name = FONT
normal.font.size = Pt(BODY)
normal.element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
normal.paragraph_format.space_before = Pt(0)
normal.paragraph_format.space_after = Pt(0)
normal.paragraph_format.line_spacing = 1.0


def para(align=None, before=0, after=0):
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.space_before, pf.space_after = Pt(before), Pt(after)
    if align is not None:
        p.alignment = align
    return p


def run(p, text, bold=False, italic=False, size=BODY):
    r = p.add_run(text)
    r.bold, r.italic = bold, italic
    r.font.size = Pt(size)
    r.font.name = FONT
    return r


def rich(p, text, size=BODY):
    """Add text where **segments** are bold."""
    for i, chunk in enumerate(text.split("**")):
        if chunk:
            run(p, chunk, bold=bool(i % 2), size=size)


def bottom_rule(p):
    pPr = p._p.get_or_add_pPr()
    pBdr = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    for k, v in {"w:val": "single", "w:sz": "6", "w:space": "1", "w:color": "000000"}.items():
        bottom.set(qn(k), v)
    pBdr.append(bottom)
    pPr.append(pBdr)


def heading(text):
    p = para(before=5, after=2)
    run(p, text, bold=True, size=BODY)
    bottom_rule(p)


def entry(title, date, tech=None):
    p = para(before=2)
    p.paragraph_format.tab_stops.add_tab_stop(TEXT_WIDTH, WD_TAB_ALIGNMENT.RIGHT)
    rich(p, title)
    if tech:
        run(p, f" | {tech}", italic=True)
    run(p, "\t" + date, italic=True)


def bullet(text):
    p = para()
    pf = p.paragraph_format
    pf.left_indent = Inches(0.42)
    pf.first_line_indent = Inches(-0.2)
    pf.tab_stops.add_tab_stop(Inches(0.42))
    run(p, "●\t", size=7)
    rich(p, text)


def line(text):
    rich(para(), text)


# ---------------------------------------------------------------- header
run(para(WD_ALIGN_PARAGRAPH.CENTER), "Aashwat Singh", bold=True, size=24)
run(
    para(WD_ALIGN_PARAGRAPH.CENTER),
    "Frisco, TX 75035 | (469) 922-8519 | aashwat.singh@utdallas.edu",
)
run(
    para(WD_ALIGN_PARAGRAPH.CENTER),
    "linkedin.com/in/aashwat-singh/ | github.com/aashwatSingh | portfolio-site-topaz-three-67.vercel.app",
)

# ---------------------------------------------------------------- education
heading("EDUCATION")
entry("**Bachelor of Science in Computer Science** | University of Texas at Dallas, Richardson, TX", "Expected May 2028")
line(
    "Relevant Coursework: Computer Architecture & Assembly Language (MIPS), Digital Logic & Circuits, "
    "Digital Systems Lab, Data Structures & Algorithms, Programming Paradigms, Software Engineering, "
    "Discrete Math, Linear Algebra"
)

# ---------------------------------------------------------------- profile
heading("PROFILE")
line(
    "Computer Science student seeking a Summer 2027 firmware / embedded software internship. Writes low-level "
    "code in MIPS assembly and C/C++, designs and debugs sequential logic on real TTL hardware, and verifies "
    "digital designs in Verilog. Comfortable working at the register and memory-layout level, reading chip "
    "pinouts, and backing code with tests and tooling carried over from ML and backend projects."
)

# ---------------------------------------------------------------- skills
heading("TECHNICAL SKILLS")
line("**Languages:** C, C++, MIPS Assembly, Verilog, Python, Java, Rust, SQL, TypeScript")
line(
    "**Embedded & Hardware:** MARS (MIPS simulator), Logisim Evolution, Verilog testbenches, 74LS-series TTL logic, "
    "breadboard prototyping, FSM design, fixed-point & two's-complement arithmetic"
)
line("**Tools & Testing:** Git, GitHub Actions CI, pytest, property-based testing, Docker")
line("**Software & ML:** FastAPI, Node.js, PostgreSQL, React, Pandas, Scikit-Learn, OpenCV, LLM integration (Claude API)")

# ---------------------------------------------------------------- projects
heading("PROJECTS")
entry("**Black Hole: Strategy Game in MIPS Assembly**", "Spring 2026", tech="MIPS, MARS")
bullet(
    "Wrote a 4-module, ~330-line turn-based game in pure MIPS assembly with no macros, linking modules through "
    "**.globl** symbols and a **jal / jr $ra** subroutine calling convention with arguments in $a0 and results in $v0."
)
bullet(
    "Packed the 21-cell triangular board into a flat 21-byte array, encoding piece owner and value in a single byte "
    "(1–10 player, 11–20 computer), and resolved 2D pyramid neighbors through a 21×6 byte lookup table in the data segment."
)
bullet(
    "Implemented bounds and occupied-cell input validation, a random-move opponent with collision retry (syscall 42), "
    "an adjacency-scoring win check, and an ASCII pyramid renderer driven by nested row/column loops."
)

entry("**4-Bit Accumulator ALU**", "Fall 2026", tech="74LS74, 74LS283, breadboard")
bullet(
    "Built a 4-bit accumulator (A ← A + B) from two 74LS74 dual D flip-flops and a 74LS283 adder, feeding each sum "
    "bit back to its flip-flop's D input, with shared clock/clear lines and carry-out driven to an LED."
)
bullet(
    "Characterized edge-triggered D (74LS74) and JK (74LS107) flip-flops on hardware, confirming asynchronous "
    "active-low PRESET/CLEAR, JK toggle mode, and the invalid PRESET = CLEAR = 0 state."
)

entry("**Predictive NBA Analytics Platform**", "July 2026 - August 2026", tech="Python, Pandas, Scikit-Learn")
bullet(
    "Built an end-to-end Python pipeline modeling 700+ NBA stat records to predict multi-variable performance "
    "metrics, isolating train/test sets to eliminate structural data leakage."
)
bullet("Benchmarked and tuned Linear Regression against a Random Forest Regressor, reaching a verified 91.8% accuracy.")

entry("**WashBuddy Full-Stack Application**", "September 2025", tech="React, Node.js, MongoDB, Gemini")
bullet(
    "Integrated a 4-person team's AI laundry-sorting app, wiring the Gemini frontend to a MongoDB API and configuring "
    "backend classification so clothes grouped correctly; won Best Hack for Beginners at HackWesTX VI."
)

# ---------------------------------------------------------------- experience
heading("PROFESSIONAL EXPERIENCE")
entry("**AI / Computer Vision Extern — Outamation**", "Jan 2026 - March 2026")
bullet(
    "Built a Python ML pipeline (PyMuPDF, OpenCV, LlamaIndex) extracting structured financial data from mortgage documents, achieving 95% "
    "extraction accuracy and reducing manual review time by 75%."
)
entry("**AI/ML Research Trainee — CRA**", "July 2025 - August 2025")
bullet(
    "Applied OCR and computer vision to documents that arrive as scans and photographs rather than clean digital "
    "files, in an intensive program covering supervised learning, NLP, and computer vision."
)

# ---------------------------------------------------------------- research
heading("RESEARCH & LEADERSHIP")
entry("**Lead Researcher — Web3 Acceleration Association**", "Jan 2025 - Dec 2025")
bullet(
    "Led a research team analyzing 100+ blockchain transactions to evaluate a decentralized token's transaction "
    "security; co-authored and presented the resulting paper to a non-engineering audience."
)
entry("**Student Researcher — AIMD**", "September 2026 - Present")
bullet(
    "Developing Project Wall-E, an edge-AI triage proposal for rural primary care, for the UT Dallas AI in Medicine "
    "Case Competition (HIMSS27)."
)

doc.save(OUT)
print(OUT)
