#!/usr/bin/env python3
"""Check that every link in pitch/data/curators.json still resolves.

Dead links (404/410, unknown host, refused connection) fail the run, so GitHub
emails the repo owner. Many sites block bots or rate-limit, so 401/403/429,
5xx and timeouts are only reported as warnings.
"""

import json
import socket
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / 'pitch' / 'data' / 'curators.json'
TIMEOUT = 20
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (compatible; free-pitch-link-check; +https://aashwatsingh.github.io/pitch/)',
    'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
}
DEAD = {404, 410}


def links():
    data = json.loads(DATA.read_text(encoding='utf-8'))
    seen = {}
    for c in data['curators']:
        for key in ('url', 'free_proof', 'contact'):
            url = c.get(key, '')
            if url.startswith('https://'):
                seen.setdefault(url, c['id'])
    return seen


def check(url):
    """Return (status, detail) where status is 'ok', 'warn' or 'dead'."""
    for method in ('HEAD', 'GET'):
        req = urllib.request.Request(url, method=method, headers=HEADERS)
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
                return 'ok', str(res.status)
        except urllib.error.HTTPError as err:
            # Some servers reject HEAD outright; retry those with GET.
            if method == 'HEAD' and err.code in {400, 403, 404, 405, 406, 429, 501}:
                continue
            return ('dead' if err.code in DEAD else 'warn'), f'HTTP {err.code}'
        except urllib.error.URLError as err:
            reason = err.reason
            if isinstance(reason, socket.gaierror):
                return 'dead', f'unknown host ({reason})'
            if isinstance(reason, ConnectionRefusedError):
                return 'dead', 'connection refused'
            return 'warn', str(reason)
        except (TimeoutError, socket.timeout):
            return 'warn', 'timed out'
        except Exception as err:  # noqa: BLE001 - report anything unexpected without crashing the run
            return 'warn', repr(err)
    return 'warn', 'no response'


def main():
    urls = links()
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = dict(zip(urls, pool.map(check, urls)))
    dead = 0
    for url, (status, detail) in sorted(results.items(), key=lambda kv: kv[1][0]):
        owner = urls[url]
        if status == 'dead':
            dead += 1
            print(f'::error title=Dead curator link::{owner}: {url} ({detail})')
        elif status == 'warn':
            print(f'::warning title=Unverified curator link::{owner}: {url} ({detail})')
        else:
            print(f'ok   {owner}: {url} ({detail})')
    print(f'\nChecked {len(urls)} links: {dead} dead.')
    return 1 if dead else 0


if __name__ == '__main__':
    sys.exit(main())
