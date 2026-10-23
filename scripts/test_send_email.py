import json
import smtplib
import sys
import tempfile
import unittest
from email import message_from_bytes
from email.policy import default
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from send_email import SetupError, build_message, main, settings  # noqa: E402

EMAIL = {'subject': 'Lock In · Tuesday: The phone', 'text': 'Today’s challenge: phone in another room.\n'}
ENV = {'LOCKIN_GMAIL_ADDRESS': 'me@example.com', 'LOCKIN_GMAIL_APP_PASSWORD': 'abcd efgh ijkl mnop'}


class FakeSMTP:
    """Stands in for smtplib.SMTP_SSL and records what was sent."""
    sent = []
    fail_login = False

    def __init__(self, host, port, context=None, timeout=None):
        self.host, self.port = host, port

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def login(self, user, password):
        if FakeSMTP.fail_login:
            raise smtplib.SMTPAuthenticationError(535, b'bad credentials')
        self.user, self.password = user, password

    def send_message(self, msg):
        FakeSMTP.sent.append((self.host, self.port, self.user, self.password, msg))


class SettingsTest(unittest.TestCase):
    def test_strips_app_password_spaces_and_defaults_recipient_to_sender(self):
        self.assertEqual(settings(ENV), ('me@example.com', 'abcdefghijklmnop', 'me@example.com'))

    def test_separate_recipient(self):
        self.assertEqual(settings({**ENV, 'LOCKIN_EMAIL_TO': 'other@example.com'})[2], 'other@example.com')

    def test_names_missing_secrets(self):
        with self.assertRaisesRegex(SetupError, 'LOCKIN_GMAIL_APP_PASSWORD'):
            settings({'LOCKIN_GMAIL_ADDRESS': 'me@example.com', 'LOCKIN_GMAIL_APP_PASSWORD': '  '})


class BuildMessageTest(unittest.TestCase):
    def test_utf8_subject_and_body_survive_the_round_trip(self):
        raw = build_message(EMAIL, 'me@example.com', 'me@example.com').as_bytes()
        parsed = message_from_bytes(raw, policy=default)
        self.assertEqual(parsed['Subject'], EMAIL['subject'])
        self.assertEqual(parsed['From'], 'Lock In <me@example.com>')
        self.assertEqual(parsed.get_content(), EMAIL['text'])
        self.assertTrue(raw.isascii(), 'headers and body are encoded for transport')

    def test_rejects_an_empty_email(self):
        with self.assertRaises(ValueError):
            build_message({'subject': '', 'text': 'x'}, 'me@example.com', 'me@example.com')


class MainTest(unittest.TestCase):
    def setUp(self):
        FakeSMTP.sent, FakeSMTP.fail_login = [], False
        tmp = tempfile.NamedTemporaryFile('w', suffix='.json', delete=False, encoding='utf-8')
        json.dump(EMAIL, tmp)
        tmp.close()
        self.path = tmp.name
        self.addCleanup(Path(self.path).unlink)

    def test_sends_through_gmail_ssl(self):
        self.assertEqual(main(['send_email.py', self.path], ENV, FakeSMTP), 0)
        [(host, port, user, password, msg)] = FakeSMTP.sent
        self.assertEqual((host, port, user, password), ('smtp.gmail.com', 465, 'me@example.com', 'abcdefghijklmnop'))
        self.assertEqual(msg['To'], 'me@example.com')

    def test_missing_secrets_fail_without_sending(self):
        self.assertEqual(main(['send_email.py', self.path], {}, FakeSMTP), 1)
        self.assertEqual(FakeSMTP.sent, [])

    def test_rejected_login_fails(self):
        FakeSMTP.fail_login = True
        self.assertEqual(main(['send_email.py', self.path], ENV, FakeSMTP), 1)


if __name__ == '__main__':
    unittest.main()
