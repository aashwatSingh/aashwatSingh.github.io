// The messages Lock In shows. Firm but fair: hold the standard, never pile on.
// Tags match the weak spots and ambitions chosen in setup. 'miss', 'streak',
// 'urge' and 'monday' only appear in their own moment (see CONTEXT_TAGS in logic.js).
// Add your own freely; keep them short enough to read in one breath.

const T = (tags, text) => ({ tags: tags.split(' '), text });

export const TRUTHS = [
  // Phone & scrolling
  T('phone', 'Your phone is a slot machine built by people who get paid when you lose time. You can’t out-willpower that. Put it in another room.'),
  T('phone', 'The first hour sets the price of the day. Spend it on your own plans before someone else’s feed spends it for you.'),
  T('phone', 'Every scroll is a small vote for the person you said you were done being.'),
  T('phone', 'Boredom isn’t a problem to fix with your phone. It’s the doorway to the work you keep avoiding.'),
  T('phone', 'You don’t need a detox. You need distance: phone face down, across the room, for every block.'),
  T('phone', 'Nothing on that screen is going to get you an offer or a friend. Close it and go get one.'),
  T('phone', 'Notice the reach. The half-second before you unlock it is where the day is won or lost.'),
  T('phone', 'Checked it just now? Fine. The rule isn’t “never”. It’s “not first, and not during”.'),
  T('phone', 'Feeds are designed to feel urgent. Almost nothing on them is.'),
  T('phone', 'Your attention is the one thing you own that every app wants. Stop giving it away for free.'),

  // Putting off hard work
  T('procrastination', 'You don’t need to feel ready. You need to open the file. Starting is the hard part, and it takes two minutes.'),
  T('procrastination', 'Motivation shows up after you start, not before. Do the first step badly and let momentum do the rest.'),
  T('procrastination', 'The task you’re avoiding is smaller than the dread you’ve built around it.'),
  T('procrastination', '“Later” is a decision to do it tired.'),
  T('procrastination', 'Make the first step stupidly small: open the tab, write one line, run the first test. Keep going only if you want to.'),
  T('procrastination', 'Planning feels like progress because it carries none of the risk. At some point the plan has to touch reality.'),
  T('procrastination', 'Ten focused minutes beat a perfect afternoon that never starts.'),
  T('procrastination', 'You already know what to do. The only open question today is when.'),
  T('procrastination', 'Hard things don’t get easier by waiting. They get easier by doing them again and again.'),
  T('procrastination', 'Treat your One Thing like a class you can’t skip. Show up, sit down, start.'),

  // Strong start, then fall off
  T('falloff', 'Missing once is an accident. Missing twice is the start of a new habit. Never miss twice.'),
  T('falloff', 'You don’t need a perfect week. You need to stop letting one bad day turn into a bad week.'),
  T('falloff', 'On a bad day, do the minimum. A minimum day keeps the chain alive, and the chain is the point.'),
  T('falloff', 'Consistency isn’t intensity. It’s showing up on the days you don’t feel like it, even at half power.'),
  T('falloff', 'Starting strong is easy. Week three is where it gets decided, and week three is made of boring days.'),
  T('falloff', 'Don’t restart on Monday. Restart at the next hour.'),
  T('falloff', 'The goal isn’t to never fall off. It’s to get back on faster every time.'),
  T('falloff', 'Your routine doesn’t need more ambition. It needs a floor you can hit on your worst day.'),
  T('falloff', 'Motivation fades in a week. Identity lasts. Act like someone who keeps their word, especially when it’s inconvenient.'),
  T('falloff', 'A streak is just proof that you kept a promise. Keep today’s.'),

  // Watching more than doing
  T('watching', 'Another video won’t change you. Using the last one will.'),
  T('watching', 'If it wasn’t worth writing down, was it worth the hour?'),
  T('watching', 'Learning that never turns into action is entertainment with better branding.'),
  T('watching', 'You’ve heard enough advice to last a year. Pick one lesson and live it today.'),
  T('watching', 'The guy in the video already did the work. Watching him do it doesn’t transfer the results.'),
  T('watching', 'Watch the lesson after the work, as a reward. Never instead of it.'),
  T('watching', 'Information is cheap. Execution is rare. Be rare.'),
  T('watching', 'Your next level isn’t in the next upload. It’s in the thing you’ve been told ten times and haven’t done.'),
  T('watching', 'Input feels productive because it’s comfortable. Output feels uncomfortable because it’s real.'),

  // Internship
  T('internship', 'Summer internship recruiting runs through the fall. Every application today is a ticket you can actually buy.'),
  T('internship', 'Rejections are the price of the offer. Pay it in bulk.'),
  T('internship', 'Nobody is checking whether you applied today. That’s exactly why it counts.'),
  T('internship', 'You can’t control the reply. You control the volume and the quality. Work both.'),
  T('internship', 'Interviews reward reps. One problem a day for a hundred days beats a panicked weekend.'),
  T('internship', 'You’ve shipped a whole project on your own. You can send three applications before lunch.'),
  T('internship', 'Your résumé is a record of what you did when nobody made you. Add a line to it.'),
  T('internship', 'Silence from a company isn’t a verdict on you. It’s a numbers game. Keep playing it.'),
  T('internship', 'The best time to prepare for the interview was before you got it. The second best time is today.'),
  T('internship', 'A “no” this week is information. Adjust, send the next one, keep moving.'),

  // Confidence & social life
  T('social', 'Confidence isn’t a feeling you wait for. It’s evidence you collect, one awkward rep at a time.'),
  T('social', 'The awkwardness you’re afraid of lasts ten seconds. The regret lasts a lot longer.'),
  T('social', 'Most people are waiting for someone else to start the conversation. Be that someone.'),
  T('social', 'You don’t need a great opener. “Hey, what are you working on?” has started more friendships than any line.'),
  T('social', 'Presence beats performance. Look people in the eye, ask a real question, listen to the answer.'),
  T('social', 'Every rep makes the next one cheaper. The first ten are the expensive ones.'),
  T('social', 'Nobody remembers your awkward moment. They’re too busy worrying about their own.'),
  T('social', 'Be the one who says hi first. It costs nothing and it changes rooms.'),

  // Mondays
  T('monday', 'New week. Don’t plan it perfectly; plan the first move. What’s the One Thing that makes this week a win?'),
  T('monday', 'Monday isn’t a fresh start. It’s a continuation. Carry last week’s best day forward.'),
  T('monday', 'Set this week’s floor, not its ceiling: the minimum you’ll hit every single day.'),

  // The day after a slip
  T('miss', 'Yesterday slipped. That’s allowed once. Today decides whether it was a blip or a pattern.'),
  T('miss', 'You missed a day. Don’t punish yourself and don’t explain it away. Just keep today’s promise.'),
  T('miss', 'One miss doesn’t define you. Two in a row starts to. Do the minimum today if that’s all you’ve got.'),
  T('miss', 'The comeback is the skill. Anyone can keep a streak going when it’s easy.'),
  T('miss', 'Shame is what makes people quit. Skip the shame and do the next right thing.'),
  T('miss', 'Yesterday is gone. Get one commitment done in the next hour and you’re back.'),

  // Streak milestones
  T('streak', 'This is where most people start coasting. Don’t.'),
  T('streak', 'You’re starting to become someone who does this. Not someone who tries to.'),
  T('streak', 'This isn’t motivation anymore. It’s who you are.'),
  T('streak', 'Look at that chain. Every link is a day you didn’t feel like it and did it anyway.'),
  T('streak', 'Long streaks feel fragile. They aren’t. You have a floor. Use it on the hard days.'),

  // The "About to slip?" button
  T('urge', 'This urge passes in about ten minutes whether you feed it or not. Let it pass.'),
  T('urge', 'You’re not bored. You’re avoiding something. Name it, then do two minutes of it.'),
  T('urge', 'Future you is watching this exact moment. Give them ten seconds to be proud of.'),
  T('urge', 'The feed will still be there tonight. This hour won’t.'),
  T('urge', 'Wanting the easy thing is normal. Choosing the hard thing anyway is the whole game.'),
  T('urge', 'Ten seconds of discomfort now, or another lost hour. You’re choosing either way.'),
];

// Social reps, easiest first. The suggested level rises one rung every 5 reps you log.
export const SOCIAL_LADDER = [
  { name: 'Warm-up', reps: [
    'Say hi to someone you’d normally walk past.',
    'Ask a classmate what they thought of today’s lecture.',
    'Thank someone by name and hold eye contact while you do it.',
    'Reply to a group chat with something real, not just a reaction.',
  ] },
  { name: 'Start', reps: [
    'Start a conversation with someone before class begins.',
    'Ask a question out loud in lecture or office hours.',
    'Invite someone to grab food after class.',
    'Text an old friend you’ve lost touch with and suggest meeting up.',
  ] },
  { name: 'Show up', reps: [
    'Go to a club or org meeting and talk to two people there.',
    'Sit with people you don’t know at lunch and join in.',
    'Walk up to a career fair booth and introduce yourself first.',
    'Ask someone for a 15-minute coffee chat about their work.',
  ] },
  { name: 'Lead', reps: [
    'Organize something small: a study group, a gym session, a meal.',
    'Message an engineer on LinkedIn with one specific, thoughtful question.',
    'Introduce two people who should know each other.',
    'Speak first in a group conversation instead of waiting for an opening.',
  ] },
  { name: 'Own the room', reps: [
    'Go to an event alone and leave with a new contact.',
    'Ask someone out, or say the thing you’ve been holding back.',
    'Give a short talk, demo or presentation somewhere.',
    'Host something and invite people to it.',
  ] },
];

// Choices for setup. Ambitions also steer which messages show up.
export const WEAK_SPOTS = [
  { tag: 'phone', label: 'Phone & scrolling' },
  { tag: 'procrastination', label: 'Putting off hard work' },
  { tag: 'falloff', label: 'Strong start, then fall off' },
  { tag: 'watching', label: 'Watching more than doing' },
];

export const AMBITIONS = [
  { tag: 'internship', label: 'Land the internship' },
  { tag: 'social', label: 'Confidence & social life' },
];

export const WHY_DRAFT = 'By next summer I want an internship I earned, not one I hoped for. And I want to be someone who walks into any room and talks to anyone. I’m done being someone who knows exactly what to do and doesn’t do it.';
