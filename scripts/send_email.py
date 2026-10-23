"""Send the Lock In email written by lockin_email.mjs through Gmail.

Usage: python scripts/send_email.py email.json

Reads the Gmail address from LOCKIN_GMAIL_ADDRESS and a Google app password (not your
normal password) from LOCKIN_GMAIL_APP_PASSWORD. Sends to LOCKIN_EMAIL_TO if it's set,
otherwise to the Gmail address itself. The workflow passes these in from repository secrets.
"""

import json
import os
import smtplib
import ssl
import sys
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

SMTP_HOST = 'smtp.gmail.com'
SMTP_PORT = 465


class SetupError(Exception):
    pass


def settings(env):
    """The sender, app password and recipient, or SetupError naming what's missing."""
    user = (env.get('LOCKIN_GMAIL_ADDRESS') or '').strip()
    # Google shows app passwords in groups of four; the spaces aren't part of it.
    password = (env.get('LOCKIN_GMAIL_APP_PASSWORD') or '').replace(' ', '').strip()
    missing = [name for name, value in (('LOCKIN_GMAIL_ADDRESS', user),
                                        ('LOCKIN_GMAIL_APP_PASSWORD', password)) if not value]
    if missing:
        raise SetupError(f'Missing repository secret(s): {", ".join(missing)}. '
                         'Add them under Settings → Secrets and variables → Actions.')
    return user, password, (env.get('LOCKIN_EMAIL_TO') or '').strip() or user


def build_message(email, sender, to):
    if not email.get('subject') or not email.get('text'):
        raise ValueError('The email needs a subject and text')
    msg = EmailMessage()
    msg['Subject'] = email['subject']
    msg['From'] = f'Lock In <{sender}>'
    msg['To'] = to
    msg['Date'] = formatdate()
    msg['Message-ID'] = make_msgid(domain=sender.rpartition('@')[2] or None)
    # Quoted-printable keeps the curly quotes and "·" 7-bit clean for any mail server.
    msg.set_content(email['text'], cte='quoted-printable')
    return msg


def send(msg, user, password, smtp=smtplib.SMTP_SSL):
    with smtp(SMTP_HOST, SMTP_PORT, context=ssl.create_default_context(), timeout=60) as server:
        server.login(user, password)
        server.send_message(msg)


def main(argv, env, smtp=smtplib.SMTP_SSL):
    if len(argv) != 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    with open(argv[1], encoding='utf-8') as f:
        email = json.load(f)
    try:
        user, password, to = settings(env)
        send(build_message(email, user, to), user, password, smtp)
    except SetupError as e:
        print(f'::error::{e}', file=sys.stderr)
        return 1
    except smtplib.SMTPAuthenticationError:
        print('::error::Gmail rejected the login. Check that LOCKIN_GMAIL_APP_PASSWORD is a current '
              'app password for LOCKIN_GMAIL_ADDRESS (changing your Google password revokes them).',
              file=sys.stderr)
        return 1
    print(f'Sent "{email["subject"]}"')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv, os.environ))
