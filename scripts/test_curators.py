"""Checks that pitch/data/curators.json is well formed and stays pay-free."""

import datetime as dt
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'pitch' / 'data' / 'curators.json'
APP = ROOT / 'pitch' / 'app.js'

METHODS = {'email', 'form'}
GENRES = {'all-genres', 'hip-hop', 'rap', 'trap', 'drill', 'boom-bap', 'underground', 'lofi', 'christian', 'r&b'}
CHECKED_VIA = {'page', 'search'}
REQUIRED = ('id', 'name', 'kind', 'genres', 'method', 'contact', 'url', 'guidelines', 'lead_days',
            'released_ok', 'region', 'free_proof', 'free_note', 'checked', 'checked_via')
OPTIONAL = ('after_days', 'fields')
EMAIL = re.compile(r'^[^\s@]+@[^\s@]+\.[a-z]{2,}$')
SLUG = re.compile(r'^[a-z0-9]+(?:-[a-z0-9]+)*$')

# Pay-to-pitch marketplaces, or outlets that sell placement, priority or paid
# review. They are left out on purpose; this stops them creeping back in.
PAID = ('submithub', 'groover', 'playlistpush', 'playlist-push', 'musosoup', 'dailyplaylists',
        'pitchplaylists', 'submitlink', 'soundcampaign', 'indiemono', 'musicbloggersnetwork',
        'hotnewhiphop', 'rapzilla', 'anrfactory', 'soundcloud.com/premier')


def iso_date(value):
    return dt.date.fromisoformat(value)


class CuratorDirectoryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = json.loads(DATA.read_text(encoding='utf-8'))
        cls.curators = cls.data['curators']
        # Kinds the app knows how to render, read from the KINDS table in app.js.
        block = re.search(r'const KINDS = \[(.*?)\];', APP.read_text(encoding='utf-8'), re.S).group(1)
        cls.kinds = set(re.findall(r"id: '(\w+)'", block))

    def test_top_level(self):
        iso_date(self.data['updated'])
        self.assertGreaterEqual(len(self.curators), 20)

    def test_ids_are_unique_slugs(self):
        ids = [c['id'] for c in self.curators]
        self.assertEqual(len(ids), len(set(ids)), 'duplicate ids')
        for i in ids:
            self.assertRegex(i, SLUG)
            self.assertFalse(i.startswith('c-'), 'c- ids are reserved for curators people add themselves')

    def test_fields(self):
        updated = iso_date(self.data['updated'])
        for c in self.curators:
            with self.subTest(c['id']):
                for key in REQUIRED:
                    self.assertIn(key, c)
                self.assertFalse(set(c) - set(REQUIRED) - set(OPTIONAL), 'unknown keys')
                self.assertIn(c['kind'], self.kinds)
                self.assertIn(c['method'], METHODS)
                self.assertTrue(c['genres'])
                self.assertFalse(set(c['genres']) - GENRES, 'unknown genre tag')
                for key in ('name', 'guidelines', 'region', 'free_note'):
                    self.assertIsInstance(c[key], str)
                    self.assertTrue(c[key].strip())
                if c['method'] == 'email':
                    self.assertRegex(c['contact'], EMAIL)
                    self.assertEqual(c['contact'], c['contact'].lower())
                else:
                    self.assertTrue(c['contact'].startswith('https://'), c['contact'])
                for key in ('url', 'free_proof'):
                    self.assertTrue(c[key].startswith('https://'), c[key])
                self.assertLessEqual(iso_date(c['checked']), updated)
                self.assertIn(c['checked_via'], CHECKED_VIA)
                self.assertIsInstance(c['released_ok'], bool)
                if c['lead_days'] is not None:
                    self.assertIsInstance(c['lead_days'], int)
                    self.assertTrue(0 <= c['lead_days'] <= 365)
                if 'after_days' in c:
                    self.assertIsInstance(c['after_days'], int)
                    self.assertTrue(c['released_ok'], 'after_days only makes sense for outlets that take released music')
                for field in c.get('fields', []):
                    self.assertIsInstance(field['label'], str)
                    self.assertIsInstance(field['max'], int)
                    self.assertEqual(c['method'], 'form')

    def test_no_pay_to_pitch_outlets(self):
        for c in self.curators:
            text = ' '.join(str(c[k]) for k in ('id', 'name', 'contact', 'url', 'free_proof')).lower()
            for name in PAID:
                self.assertNotIn(name, text, f'{c["id"]} looks like a paid platform ({name})')


if __name__ == '__main__':
    unittest.main()
