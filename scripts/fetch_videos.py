#!/usr/bin/env python3
"""Sync the @Hamza97 upload list into hamza/data/videos.json.

Uses yt-dlp in flat-playlist mode, so no API key is needed and only the channel
tab pages are fetched (not every video page). Existing entries are merged, never
deleted: videos that disappear from a successfully fetched tab get
``removed: true`` so the tracker can hide them without losing your notes.
"""

import datetime as dt
import json
import sys
from pathlib import Path

CHANNEL_URL = 'https://www.youtube.com/@Hamza97'
TABS = {'video': 'videos', 'short': 'shorts', 'live': 'streams'}
OUT_PATH = Path(__file__).resolve().parent.parent / 'hamza' / 'data' / 'videos.json'

# If the long-form tab suddenly returns fewer than this share of the videos we
# already know about, assume YouTube served a partial page and keep the old data.
MIN_VIDEO_RATIO = 0.5


class SyncAborted(Exception):
    pass


def fetch_tab(tab):
    """Return the flat-playlist info dict for one channel tab."""
    import yt_dlp

    opts = {
        'extract_flat': 'in_playlist',
        'skip_download': True,
        'quiet': True,
        'no_warnings': True,
        'extractor_args': {'youtubetab': {'approximate_date': ['']}},
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        return ydl.extract_info(f'{CHANNEL_URL}/{tab}', download=False)


def entry_date(entry):
    """Best available YYYY-MM-DD for a flat entry, or None."""
    upload_date = entry.get('upload_date')
    if upload_date and len(upload_date) == 8:
        return f'{upload_date[:4]}-{upload_date[4:6]}-{upload_date[6:]}'
    ts = entry.get('timestamp') or entry.get('release_timestamp')
    if ts:
        return dt.datetime.fromtimestamp(ts, dt.timezone.utc).date().isoformat()
    return None


def merge(existing, fetched_by_tab, today):
    """Merge freshly fetched tab entries into the existing video list.

    existing: list of video dicts from the previous videos.json.
    fetched_by_tab: {type: [flat entries, newest first] or None if the fetch failed}.
    today: ISO date string used for first_seen and as a date fallback.
    Returns the merged list, sorted newest first.
    """
    by_id = {v['id']: dict(v) for v in existing}
    next_seq = max((v.get('seq', 0) for v in existing), default=0) + 1

    fetched_videos = fetched_by_tab.get('video')
    if fetched_videos is None:
        raise SyncAborted('the /videos tab could not be fetched')
    known_videos = sum(1 for v in existing if v.get('type') == 'video' and not v.get('removed'))
    if known_videos >= 20 and len(fetched_videos) < known_videos * MIN_VIDEO_RATIO:
        raise SyncAborted(
            f'/videos returned {len(fetched_videos)} entries but {known_videos} are already known')

    claimed = set()
    for vtype in TABS:
        entries = fetched_by_tab.get(vtype)
        if entries is None:
            continue
        entries = [e for e in entries
                   if e.get('id') and e.get('live_status') != 'is_upcoming' and e['id'] not in claimed]
        claimed.update(e['id'] for e in entries)

        # Walk oldest -> newest so newly seen videos get increasing seq numbers.
        for entry in reversed(entries):
            vid = entry['id']
            video = by_id.get(vid)
            if video is None:
                date = entry_date(entry)
                video = by_id[vid] = {
                    'id': vid,
                    'type': vtype,
                    'date': date or today,
                    'date_approx': True,
                    'first_seen': today,
                    'seq': next_seq,
                }
                next_seq += 1
            video.pop('removed', None)
            video['type'] = vtype
            if entry.get('title'):
                video['title'] = entry['title']
            for src, dst in (('duration', 'duration'), ('view_count', 'views')):
                if entry.get(src) is not None:
                    video[dst] = int(entry[src])

    # Only trust an absence when the tab the video belongs to was fetched.
    for video in by_id.values():
        if fetched_by_tab.get(video.get('type')) is not None and video['id'] not in claimed:
            video['removed'] = True

    return sorted(by_id.values(), key=lambda v: (v.get('date') or '', v.get('seq', 0)), reverse=True)


def load_existing(path):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def write_json(path, data):
    # One video per line keeps nightly diffs small and readable.
    lines = ['{']
    for key in ('channel', 'updated'):
        lines.append(f'  {json.dumps(key)}: {json.dumps(data[key], ensure_ascii=False)},')
    lines.append('  "videos": [')
    rows = [f'    {json.dumps(v, ensure_ascii=False, sort_keys=True)}' for v in data['videos']]
    lines.append(',\n'.join(rows))
    lines.append('  ]')
    lines.append('}')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('\n'.join(line for line in lines if line) + '\n')


def main():
    previous = load_existing(OUT_PATH)
    channel = previous.get('channel') or {}
    fetched = {}
    for vtype, tab in TABS.items():
        try:
            info = fetch_tab(tab)
        except Exception as err:  # yt-dlp raises many error types
            print(f'warning: could not fetch /{tab}: {err}', file=sys.stderr)
            fetched[vtype] = None
            continue
        fetched[vtype] = [e for e in (info.get('entries') or []) if e]
        print(f'/{tab}: {len(fetched[vtype])} entries')
        if vtype == 'video':
            channel = {
                'id': info.get('channel_id') or channel.get('id'),
                'handle': info.get('uploader_id') or channel.get('handle') or '@Hamza97',
                'title': info.get('channel') or channel.get('title'),
                'url': CHANNEL_URL,
            }

    today = dt.date.today().isoformat()
    try:
        videos = merge(previous.get('videos') or [], fetched, today)
    except SyncAborted as err:
        print(f'error: {err}; keeping the existing file', file=sys.stderr)
        return 1

    if videos == previous.get('videos') and channel == previous.get('channel'):
        print('no changes')
        return 0

    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')
    write_json(OUT_PATH, {'channel': channel, 'updated': now, 'videos': videos})
    active = sum(1 for v in videos if not v.get('removed'))
    print(f'wrote {len(videos)} videos ({active} active) to {OUT_PATH}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
