// Topic guesses from video titles. The first matching topic wins, so the more
// specific topics come first and the broad "Mindset" bucket comes last.
// A keyword ending in * matches any word that starts with it; otherwise it
// must match a whole word or phrase. Edit freely: you can override any
// video's topic in the app, and overrides always beat these rules.
export const TOPICS = [
  { name: 'Dating & Women', hue: 350, keywords: [
    'women', 'woman', 'girl*', 'gf', 'dating', 'date', 'dates', 'relationship*', 'flirt*', 'rizz*',
    'wife', 'marri*', 'marry', 'virgin*', 'crush', 'breakup', 'break up', 'ex', 'simp*', 'love',
    'female*', 'her', 'she', 'sex*', 'body count', 'approach*', 'attraction'] },
  { name: 'Looks & Style', hue: 280, keywords: [
    'looksmax*', 'looks', 'handsome', 'attractive', 'ugly', 'skin*', 'hair*', 'beard', 'jaw*', 'face',
    'style', 'dress*', 'outfit*', 'clothes', 'fashion', 'posture', 'height', 'mog*', 'glow up', 'glow-up',
    'aesthetic*', 'appearance', 'grooming', 'fragrance', 'cologne'] },
  { name: 'Fitness & Health', hue: 145, keywords: [
    'gym*', 'workout*', 'lift*', 'muscle*', 'fitness', 'body', 'fat', 'lean', 'diet*', 'eat*', 'food',
    'sleep*', 'testosterone', 'health*', 'cardio', 'run', 'running', 'steroid*', 'natty', 'abs',
    'calisthenics', 'bulk*', 'protein', 'physique', 'strength', 'train', 'training', 'boxing', 'mma'] },
  { name: 'Money & Career', hue: 45, keywords: [
    'money', 'rich', 'wealth*', 'business*', 'entrepreneur*', 'job', 'jobs', 'career*', 'invest*',
    'income', 'broke', 'million*', 'salary', 'hustle', 'side hustle', 'freelanc*', 'sales', 'poor',
    'financ*', 'university', 'uni', 'college', 'degree', 'school', 'work from home', 'ecom*', 'crypto',
    'startup*', 'agency', 'earn*', 'fired', 'boss'] },
  { name: 'Discipline & Habits', hue: 20, keywords: [
    'disciplin*', 'habit*', 'dopamine', 'routine*', 'productiv*', 'lazy', 'laziness', 'procrastinat*',
    'motivat*', 'focus*', 'monk', 'monk mode', 'porn', 'nofap', 'fap', 'addict*', 'detox', 'phone',
    'morning*', 'schedule', 'study*', 'consisten*', 'grind*', 'work ethic', 'willpower', 'goal*',
    '5am', '4am', 'time', 'waste*', 'wasting', 'hard work', 'hardwork*', 'quit*', 'self control'] },
  { name: 'Social Skills', hue: 195, keywords: [
    'social*', 'friend*', 'charism*', 'conversation*', 'talk*', 'awkward', 'introvert*', 'extrovert*',
    'network*', 'party', 'speak*', 'speech', 'voice', 'eye contact', 'people', 'likeable', 'likable',
    'humour', 'humor', 'funny', 'banter', 'family', 'parents', 'dad', 'mum', 'mom'] },
  { name: 'Mindset & Confidence', hue: 230, keywords: [
    'confiden*', 'mindset*', 'masculin*', 'alpha', 'beta', 'sigma', 'self esteem', 'self-esteem',
    'anxiety', 'anxious', 'depress*', 'lonel*', 'purpose', 'stoic*', 'mental*', 'fear*', 'ego',
    'men', 'man', 'life', 'happ*', 'meaning*', 'success*', 'winner*', 'loser*', 'weak*', 'strong*',
    'high value', 'self improvement', 'self-improvement', 'improve*', 'respect*', 'overthink*',
    'insecur*', 'regret*', 'god', 'faith', 'religio*', 'islam', 'wisdom', 'advice', 'lesson*'] },
];

export const OTHER = { name: 'Other', hue: 60 };
export const ALL_TOPICS = [...TOPICS, OTHER];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const MATCHERS = TOPICS.map((topic) => {
  const parts = topic.keywords.map((k) =>
    k.endsWith('*') ? `${escapeRe(k.slice(0, -1))}[\\w']*` : escapeRe(k));
  return { name: topic.name, re: new RegExp(`(?:^|[^\\w])(?:${parts.join('|')})(?![\\w])`, 'i') };
});

const cache = new Map();

export function guessTopic(title) {
  if (!title) return OTHER.name;
  let topic = cache.get(title);
  if (!topic) {
    const text = title.replace(/[’‘]/g, "'");
    topic = MATCHERS.find((m) => m.re.test(text))?.name ?? OTHER.name;
    cache.set(title, topic);
  }
  return topic;
}

export function topicHue(name) {
  return (ALL_TOPICS.find((t) => t.name === name) ?? OTHER).hue;
}
