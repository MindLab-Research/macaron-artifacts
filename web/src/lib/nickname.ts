// Deterministic three-word session nickname, à la claude-cli's
// `groovy-doodling-rainbow`. Same sessionId always maps to the same nickname
// (fnv-1a hash → wordlist indices), so it's a stable human-friendly label
// for URLs and status bars.

const ADJECTIVES = [
  'groovy', 'nimble', 'sunny', 'plucky', 'gentle', 'brisk', 'cozy', 'humble',
  'jaunty', 'radiant', 'silky', 'clever', 'dreamy', 'earnest', 'ferny',
  'glimmer', 'honeyed', 'iridescent', 'jovial', 'lively', 'mellow', 'noble',
  'obliging', 'peppy', 'quaint', 'ruddy', 'spry', 'tender', 'unruffled',
  'velvet', 'whimsical', 'zesty', 'amber', 'blithe', 'candid', 'dapper',
];

const VERBS = [
  'doodling', 'tinkering', 'wandering', 'humming', 'sailing', 'gliding',
  'strumming', 'sprouting', 'flickering', 'weaving', 'drifting', 'brewing',
  'rustling', 'spinning', 'twirling', 'unfurling', 'basking', 'churning',
  'dancing', 'echoing', 'floating', 'gathering', 'hopping', 'idling',
  'jumping', 'kindling', 'leaping', 'meandering', 'nesting', 'polishing',
];

const NOUNS = [
  'rainbow', 'ember', 'meadow', 'brook', 'harbor', 'orchard', 'thicket',
  'willow', 'canyon', 'lantern', 'compass', 'terrace', 'ripple', 'pebble',
  'clover', 'ridge', 'lagoon', 'plume', 'quill', 'sparrow', 'trellis',
  'ivy', 'juniper', 'kestrel', 'linnet', 'moss', 'nettle', 'opal', 'poppy',
  'quartz', 'runner', 'saffron', 'thyme', 'umber', 'violet', 'wren',
];

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function sessionNickname(sessionId: string): string {
  if (!sessionId) return '';
  const h = fnv1a(sessionId);
  const a = ADJECTIVES[h % ADJECTIVES.length]!;
  const v = VERBS[Math.floor(h / ADJECTIVES.length) % VERBS.length]!;
  const n = NOUNS[Math.floor(h / (ADJECTIVES.length * VERBS.length)) % NOUNS.length]!;
  return `${a}-${v}-${n}`;
}
