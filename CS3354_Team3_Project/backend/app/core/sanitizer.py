"""
@author: Aashwat Singh (Markdown comments), Saaqib Shaik (spreadsheet export)
@description: Cleans untrusted text before it is stored or exported. sanitize_markdown() removes every HTML
    tag (and the entire contents of <script>, <iframe>, <object>, <embed> and <style>), inline on*= event
    handlers and javascript:/data:/vbscript: links from comments while keeping normal Markdown such as
    **bold**, *italic*, `code`, lists and @mentions. sanitize_spreadsheet_cell() stops "formula injection"
    by making cells that start with = + - @ tab or carriage return plain text in Excel / Google Sheets.
@traces: SE-FR-20, SE-FR-28, UC-15, UC-21
"""

from __future__ import annotations

import html
import re
from typing import Any

import nh3

_DANGEROUS_CONTENT_TAGS = {"script", "style", "iframe", "object", "embed", "noscript", "template", "svg", "math", "frameset", "frame", "applet"}
_TAG_LIKE = re.compile(r"<\s*/?\s*[A-Za-z!?]")
_DANGEROUS_SCHEME = re.compile(r"^(?:javascript|data|vbscript|file)\s*:", re.IGNORECASE)
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_REFERENCE_LINK = re.compile(r"^(\s{0,3}\[[^\]\n]+\]:\s*)(\S+)(.*)$", re.MULTILINE)
_MAX_PASSES = 5


def _strip_html(text: str) -> str:
    """Removes all tags with nh3 (an HTML5 parser, not regex) and decodes entities, to a fixed point."""
    for _ in range(_MAX_PASSES):
        cleaned = nh3.clean(
            text,
            tags=set(),
            attributes={},
            clean_content_tags=_DANGEROUS_CONTENT_TAGS,
            strip_comments=True,
        )
        cleaned = html.unescape(cleaned)
        if cleaned == text and not _TAG_LIKE.search(cleaned):
            return cleaned
        text = cleaned
        if not _TAG_LIKE.search(text):
            return text
    # Pathological nesting: escape whatever angle brackets remain so no tag can survive.
    return text.replace("<", "‹").replace(">", "›")


def _is_dangerous_url(url: str) -> bool:
    # Browsers drop tabs, newlines and control characters inside URLs ("java\tscript:" runs as script).
    normalized = re.sub(r"[\s\x00-\x1f\x7f]+", "", _CONTROL_CHARS.sub("", html.unescape(url))).strip("<>")
    return bool(_DANGEROUS_SCHEME.match(normalized))


def _neutralize_inline_links(text: str) -> str:
    """Replaces dangerous targets of [label](target) links, handling nested parentheses in O(L)."""
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        j = text.find("](", i)
        if j == -1:
            out.append(text[i:])
            break
        out.append(text[i : j + 2])
        k = j + 2
        depth = 1
        while k < n and depth > 0:
            ch = text[k]
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0:
                    break
            elif ch == "\n":
                break
            k += 1
        target = text[j + 2 : k]
        if _is_dangerous_url(target):
            out.append("#")
        else:
            out.append(target)
        i = k
    return "".join(out)


def _neutralize_reference_links(text: str) -> str:
    def repl(match: re.Match[str]) -> str:
        if _is_dangerous_url(match.group(2)):
            return f"{match.group(1)}#"
        return match.group(0)

    return _REFERENCE_LINK.sub(repl, text)


_BARE_SCRIPT_SCHEME = re.compile(r"(?i)\b(javascript|vbscript)(\s*):")
_BARE_DATA_URL = re.compile(r"(?i)\b(data)(\s*):(?=\s*[a-z]+/[a-z0-9.+-]+\s*[;,])")


def _neutralize_bare_schemes(text: str) -> str:
    """Breaks remaining bare javascript:/vbscript:/data:<mime> URLs so Markdown auto-linkers ignore them.

    The colon becomes U+2236 (RATIO), which looks alike but is not a URL scheme separator. Ordinary prose
    such as "Data: 5 rows" is left untouched.
    """
    text = _BARE_SCRIPT_SCHEME.sub(lambda m: f"{m.group(1)}{m.group(2)}∶", text)
    return _BARE_DATA_URL.sub(lambda m: f"{m.group(1)}{m.group(2)}∶", text)


def sanitize_markdown(raw_text: str) -> str:
    """Returns Markdown that contains no HTML elements, event handlers or script URLs."""
    if raw_text is None:
        return ""
    text = str(raw_text).replace("\r\n", "\n").replace("\r", "\n")
    text = _CONTROL_CHARS.sub("", text)
    text = _strip_html(text)
    text = _neutralize_inline_links(text)
    text = _neutralize_reference_links(text)
    text = _neutralize_bare_schemes(text)
    return text.strip()


_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def sanitize_spreadsheet_cell(val: Any) -> Any:
    """Prefixes formula-like strings with a single quote so spreadsheets treat them as text (CWE-1236)."""
    if isinstance(val, str) and val.startswith(_FORMULA_PREFIXES):
        return "'" + val
    return val
