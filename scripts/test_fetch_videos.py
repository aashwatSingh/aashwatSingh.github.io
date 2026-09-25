import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fetch_videos import SyncAborted, entry_date, merge  # noqa: E402

TODAY = '2026-09-25'


def entry(vid, title=None, **extra):
    return {'id': vid, 'title': title or f'Title {vid}', **extra}


def known(vid, vtype='video', seq=1, **extra):
    return {'id': vid, 'type': vtype, 'title': f'Old {vid}', 'date': '2024-01-01',
            'date_approx': True, 'first_seen': '2024-01-02', 'seq': seq, **extra}


class MergeTest(unittest.TestCase):
    def test_backfill_assigns_increasing_seq_oldest_first(self):
        videos = merge([], {'video': [entry('c'), entry('b'), entry('a')], 'short': None, 'live': None}, TODAY)
        by_id = {v['id']: v for v in videos}
        self.assertEqual([by_id[x]['seq'] for x in 'abc'], [1, 2, 3])
        self.assertTrue(all(v['first_seen'] == TODAY for v in videos))
        self.assertTrue(all(v['type'] == 'video' for v in videos))

    def test_existing_video_keeps_history_and_refreshes_fields(self):
        old = known('a', seq=7, removed=True)
        videos = merge([old], {'video': [entry('a', 'New title', duration=600.0, view_count=1200)],
                               'short': [], 'live': []}, TODAY)
        (v,) = videos
        self.assertEqual(v['title'], 'New title')
        self.assertEqual(v['duration'], 600)
        self.assertEqual(v['views'], 1200)
        self.assertEqual(v['first_seen'], '2024-01-02')
        self.assertEqual(v['date'], '2024-01-01')
        self.assertEqual(v['seq'], 7)
        self.assertNotIn('removed', v)

    def test_new_videos_continue_after_existing_seq(self):
        videos = merge([known('a', seq=5)], {'video': [entry('b'), entry('a')], 'short': [], 'live': []}, TODAY)
        self.assertEqual({v['id']: v['seq'] for v in videos}, {'a': 5, 'b': 6})

    def test_missing_video_marked_removed_not_deleted(self):
        videos = merge([known('a'), known('b', seq=2)], {'video': [entry('b')], 'short': [], 'live': []}, TODAY)
        by_id = {v['id']: v for v in videos}
        self.assertTrue(by_id['a']['removed'])
        self.assertNotIn('removed', by_id['b'])

    def test_failed_secondary_tab_does_not_mark_removals(self):
        videos = merge([known('s', 'short'), known('v', seq=2)],
                       {'video': [entry('v')], 'short': None, 'live': None}, TODAY)
        self.assertNotIn('removed', {v['id']: v for v in videos}['s'])

    def test_video_moving_tabs_is_retyped_not_removed(self):
        videos = merge([known('x', 'live')], {'video': [entry('x')], 'short': [], 'live': []}, TODAY)
        (v,) = videos
        self.assertEqual(v['type'], 'video')
        self.assertNotIn('removed', v)

    def test_duplicate_id_across_tabs_keeps_first_tab(self):
        videos = merge([], {'video': [entry('x')], 'short': [entry('x')], 'live': []}, TODAY)
        self.assertEqual([(v['id'], v['type']) for v in videos], [('x', 'video')])

    def test_upcoming_premieres_are_skipped(self):
        videos = merge([], {'video': [entry('p', live_status='is_upcoming'), entry('a')],
                            'short': [], 'live': []}, TODAY)
        self.assertEqual([v['id'] for v in videos], ['a'])

    def test_failed_videos_tab_aborts(self):
        with self.assertRaises(SyncAborted):
            merge([known('a')], {'video': None, 'short': [], 'live': []}, TODAY)

    def test_suspiciously_short_videos_tab_aborts(self):
        existing = [known(f'v{i}', seq=i) for i in range(40)]
        with self.assertRaises(SyncAborted):
            merge(existing, {'video': [entry('v1')], 'short': [], 'live': []}, TODAY)

    def test_sorted_newest_first(self):
        videos = merge([], {'video': [entry('new', timestamp=1_790_000_000), entry('old', upload_date='20200101')],
                            'short': [], 'live': []}, TODAY)
        self.assertEqual([v['id'] for v in videos], ['new', 'old'])


class EntryDateTest(unittest.TestCase):
    def test_upload_date(self):
        self.assertEqual(entry_date({'upload_date': '20240315'}), '2024-03-15')

    def test_timestamp(self):
        self.assertEqual(entry_date({'timestamp': 0}), None)
        self.assertEqual(entry_date({'timestamp': 1_700_000_000}), '2023-11-14')

    def test_missing(self):
        self.assertIsNone(entry_date({}))

    def test_new_video_without_date_falls_back_to_today(self):
        (v,) = merge([], {'video': [entry('a')], 'short': [], 'live': []}, TODAY)
        self.assertEqual(v['date'], TODAY)


if __name__ == '__main__':
    unittest.main()
