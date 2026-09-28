// Pitch templates. {placeholders} are filled from the Kit; a line whose
// placeholders all come out empty is dropped, so optional details vanish
// cleanly instead of leaving "For fans of ." behind.

const EMAIL = {
  subject: '{artist} – "{track}"{featuring} ({genre})',
  body: `Hi {greet},

I'm {artist}, {intro}. My {type} "{track}"{featuring} {released}.

{hook}
For fans of {similar}.

Listen: {link}

{story}

{bio}

Thanks for listening either way,
{artist}
{contact}
{socials}`,
};

export const TEMPLATES = {
  playlist: {
    ...EMAIL,
    body: EMAIL.body.replace('Listen: {link}', 'I think it would sit well next to what you already play.\n\nListen: {link}'),
  },
  blog: {
    subject: 'Submission: {artist} – "{track}"{featuring}',
    body: EMAIL.body.replace('Listen: {link}', "If it fits, I'd love a feature, review or premiere.\n\nListen: {link}"),
  },
  radio: {
    subject: 'For airplay: {artist} – "{track}"{featuring}',
    body: EMAIL.body.replace('Listen: {link}', 'Submitting it for airplay consideration.\n\nListen: {link}'),
  },
  youtube: EMAIL,
  community: EMAIL,
  showcase: EMAIL,
  // Streaming editors take a short description in a form, not an email.
  official: {
    subject: '',
    body: `{hook} {story}

{artist} is {intro}. {similar_sentence}`,
  },
};

export const FOLLOW_UP = {
  subject: 'Following up: {artist} – "{track}"',
  body: `Hi {greet},

Following up on "{track}" by {artist}, which I sent {sent}. No pressure at all; here's the link again in case it got buried: {link}

Thanks for your time,
{artist}
{contact}`,
};

const PLACEHOLDER = /\{(\w+)\}/g;

export function fill(template, vars) {
  const lines = template.split('\n').filter((line) => {
    const keys = [...line.matchAll(PLACEHOLDER)].map((m) => m[1]);
    return !keys.length || keys.some((k) => String(vars[k] ?? '').trim());
  });
  return lines
    .join('\n')
    .replace(PLACEHOLDER, (_, k) => String(vars[k] ?? '').trim())
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ {2,}/g, ' ')
    .trim();
}
