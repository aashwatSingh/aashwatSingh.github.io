"""Host checks for posting URLs that come from public listing sources (untrusted input)."""
from __future__ import annotations

from urllib.parse import urlparse


def host_matches(url: str, *domains: str) -> bool:
    """True only when the browser will really load one of these domains (or a subdomain of one).

    Rejects what Python and Chromium parse differently: a backslash anywhere (Chromium reads it as
    '/', so 'https://evil.com\\@x.myworkdayjobs.com' loads evil.com), credentials before '@', and
    non-web schemes. Requires a dot boundary, so 'evilmyworkdayjobs.com' or 'clever.co' do not pass.
    """
    url = (url or "").strip()
    if "\\" in url:
        return False
    try:
        p = urlparse(url)
        host = (p.hostname or "").lower().rstrip(".")
    except ValueError:
        return False
    if p.scheme not in ("http", "https") or "@" in p.netloc or not host:
        return False
    return any(host == d or host.endswith("." + d) for d in domains)
