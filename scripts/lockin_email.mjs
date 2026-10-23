// Writes today's Lock In email as JSON ({ subject, text }) for scripts/send_email.py.
// Run by .github/workflows/lockin-email.yml. The messages come from lockin/truths.js, so
// anything you add there also reaches your inbox.
//
//   node scripts/lockin_email.mjs                      morning email for right now
//   node scripts/lockin_email.mjs night 2026-10-23     a given email and date
//   SCHEDULE='43 12 * * *' node scripts/lockin_email.mjs
//
// With SCHEDULE (the cron that started the workflow) it prints nothing if that cron isn't
// today's send time. GitHub schedules in UTC, so each email is scheduled at both of
// Central time's UTC offsets and only the one that matches the season sends.
import { pathToFileURL } from 'node:url';
import { TRUTHS, SOCIAL_LADDER } from '../lockin/truths.js';

export const SITE = 'https://aashwatsingh.github.io/lockin/';
export const TIME_ZONE = 'America/Chicago';
/** Local hour each email goes out (the workflow's crons, read in Central time). */
export const SLOT_HOURS = { morning: 7, night: 22 };

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const byTag = (tag) => TRUTHS.filter((t) => t.tags.includes(tag)).map((t) => t.text);

// One focus per weekday, indexed like Date#getDay(). Each challenge is finishable today.
export const FOCUS = [
  { name: 'Weekly review', tag: 'falloff', link: `${SITE}#progress`,
    intro: 'Today is the weekly review. Look at the week as it was, not as you meant it to be.',
    challenges: [
      'Open Progress and read this week honestly: kept days, applications sent, focus hours. Write down one change for next week.',
      'Find the day this week that slipped and name what caused it. Set one rule that stops it next week.',
      'Read your proof file, then set Monday’s One Thing and its 2-minute first step before you sleep.',
      'Send one application today, even on a Sunday, then put Monday’s first deep-work block on your calendar.',
    ] },
  { name: 'Plan the week', tag: 'monday',
    intro: 'New week. Plan the first move, not the whole thing.',
    challenges: [
      'Write this week’s floor: the minimum you’ll hit every single day. Then do today’s minimum before noon.',
      'Pick this week’s One Thing and do its first 2-minute step before lunch.',
      'Put a 50-minute deep-work block on your calendar for every weekday this week. Do the first one today.',
      'List the 15 applications you’ll send this week and send the first 3 today.',
    ] },
  { name: 'The phone', tag: 'phone',
    intro: 'Today is about the phone, and you won’t win that fight by trying harder.',
    challenges: [
      'Put your phone in another room for one 50-minute deep-work block. Get it back when the block ends.',
      'No phone for the first hour you’re awake. If that hour is already gone, no phone until your first block is done.',
      'Move the app you open without thinking off your home screen, and charge your phone outside your bedroom tonight.',
      'Phone face down across the room for every block today. Count how many times you reach for it.',
    ] },
  { name: 'The first step', tag: 'procrastination',
    intro: 'Today is about starting. Not planning, not finishing. Starting.',
    challenges: [
      'Name the task you’ve been avoiding and do 2 minutes of it before 10 am. Keep going only if you want to.',
      'Start a 10-minute focus timer on your One Thing right after you read this.',
      'Open the hardest thing on your list and write one line of it before lunch.',
      'Break your One Thing into steps small enough that the first takes two minutes. Do that step now.',
    ] },
  { name: 'Internship push', tag: 'internship',
    intro: 'Today is about the internship. Volume and quality, both.',
    challenges: [
      'Send 3 internship applications before you open anything fun.',
      'Do 1 interview problem and send 2 applications. Write down what tripped you up on the problem.',
      'Follow up on one application you sent more than a week ago, then send two new ones.',
      'Rewrite the top project line on your résumé for one role you really want, and apply to it today.',
      'Find one engineer at a DFW company you’d want to intern at and send them one short, specific question.',
    ] },
  { name: 'One social rep', tag: 'social',
    intro: 'Today is about one social rep. Ten seconds of awkward is the whole price.',
    // The first three rungs of the ladder in the app; your logged level lives in your browser.
    challenges: SOCIAL_LADDER.slice(0, 3).flatMap((rung) => rung.reps) },
  { name: 'Do, don’t watch', tag: 'watching',
    intro: 'Today is about doing, not watching.',
    challenges: [
      'No new lessons until you’ve used one you already watched. Write down what you did with it.',
      'Finish one deep-work block before you watch anything today. The lesson is the reward.',
      'Pick one takeaway you wrote this month and act on it before tonight.',
      'Spend the time you’d spend watching on building: one real commit to a project you care about.',
    ] },
];

const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
});

/** The Central-time date (YYYY-MM-DD) and hour for a moment in time. */
export function centralTime(date) {
  const p = Object.fromEntries(PARTS.formatToParts(date).map(({ type, value }) => [type, value]));
  return { dateKey: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

/**
 * Which email a scheduled run should send, from its cron ("M H * * *", in UTC) and the
 * time it actually started (runs can start late). Returns { slot, dateKey } or null.
 */
export function slotForSchedule(cron, now) {
  const [minute, hour] = String(cron).trim().split(/\s+/).map(Number);
  if (!Number.isInteger(minute) || !Number.isInteger(hour)) throw new Error(`Unrecognised schedule: ${cron}`);
  let due = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute);
  if (due > now.getTime()) due -= 864e5; // a run delayed past midnight UTC belongs to yesterday
  const local = centralTime(new Date(due));
  const slot = Object.keys(SLOT_HOURS).find((s) => SLOT_HOURS[s] === local.hour);
  return slot ? { slot, dateKey: local.dateKey } : null;
}

const dayNumber = (dateKey) => {
  const [y, m, d] = dateKey.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 864e5;
};
const weekdayOf = (dateKey) => (dayNumber(dateKey) + 4) % 7; // 1970-01-01 was a Thursday
// Rotate by week, so each weekday's messages all come round before any repeats.
const rotate = (list, n) => list[n % list.length];

/** The email for a slot on a Central-time date (YYYY-MM-DD). */
export function composeEmail(slot, dateKey) {
  const day = dayNumber(dateKey);
  const weekday = WEEKDAYS[weekdayOf(dateKey)];
  if (slot === 'morning') {
    const focus = FOCUS[weekdayOf(dateKey)];
    const week = Math.floor(day / 7);
    return {
      subject: `Lock In · ${weekday}: ${focus.name}`,
      text: [
        focus.intro,
        rotate(byTag(focus.tag), week),
        `Today’s challenge: ${rotate(focus.challenges, week)}`,
        'Hit at least the minimum on every commitment and the day is kept. Never miss twice.',
        [`Open Lock In: ${focus.link || SITE}`, `About to slip? ${SITE}#slip`].join('\n'),
      ].join('\n\n'),
    };
  }
  if (slot === 'night') {
    return {
      subject: `Lock In · ${weekday} night: close the day`,
      text: [
        'Close the day before you sleep. It takes ninety seconds:',
        [
          '- Mark anything still open. The minimum counts.',
          '- One win: something you did, not something you watched.',
          '- One lesson.',
          '- Tomorrow’s One Thing, and its 2-minute first step.',
        ].join('\n'),
        rotate(byTag('falloff'), day),
        `Close the day: ${SITE}#review`,
      ].join('\n\n'),
    };
  }
  throw new Error(`Unknown email: ${slot} (use morning or night)`);
}

function main() {
  const now = new Date();
  const schedule = process.env.SCHEDULE?.trim();
  let slot = process.argv[2] || process.env.SLOT || 'morning';
  let dateKey = process.argv[3] || centralTime(now).dateKey;
  if (schedule) {
    const due = slotForSchedule(schedule, now);
    if (!due) {
      console.error(`"${schedule}" isn't a send time in Central time today; the other schedule sends it.`);
      return;
    }
    ({ slot, dateKey } = due);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new Error(`Bad date: ${dateKey} (use YYYY-MM-DD)`);
  process.stdout.write(`${JSON.stringify(composeEmail(slot, dateKey))}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
