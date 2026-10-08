/**
 * Fuzzy phrase scoring for tier-1 billing patterns (gap 13).
 *
 * Ports RapidFuzz's `token_set_ratio` semantics to TypeScript (zero deps):
 * tokenize -> lowercase -> canonicalize -> dedupe -> set ops. If one token
 * set is a subset of the other, the score is 100 regardless of intervening
 * words or order ("charged me twice" vs pattern "charged twice"). Explicit
 * token disagreement lowers the score. Returns a numeric score so the audit
 * trail can record `pattern, score, threshold` (gap doc WANT list).
 *
 * Stays deterministic: pure function, no network, no model.
 */

const NUMBER_CANON: Record<string, string> = {
  twice: "2x",
  x2: "2x",
  two: "2",
};

const NEGATION_TOKENS = new Set(["not", "no", "never", "nt", "didnt", "dont", "doesnt", "wasnt", "isnt"]);

/** Normalize raw text before tokenizing: case, contractions, number forms. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/(\d+)\s+times\b/g, "$1x")
    .replace(/['’]/g, "");
}

export function tokenize(text: string): string[] {
  return normalizeText(text)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((t) => NUMBER_CANON[t] ?? t);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** RapidFuzz fuzz.ratio: (la + lb - lev) / (la + lb) scaled to 0..100. */
function ratio(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 100;
  if (a.length === 0 || b.length === 0) return 0;
  return ((a.length + b.length - levenshtein(a, b)) / (a.length + b.length)) * 100;
}

/**
 * RapidFuzz token_set_ratio: compares the sorted intersection against each
 * side's intersection+remainder combination and takes the max ratio.
 */
export function tokenSetRatio(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  const inter = [...setA].filter((t) => setB.has(t)).sort();
  const remA = [...setA].filter((t) => !setB.has(t)).sort();
  const remB = [...setB].filter((t) => !setA.has(t)).sort();
  const t0 = inter.join(" ");
  const c1 = [...inter, ...remA].join(" ").trim();
  const c2 = [...inter, ...remB].join(" ").trim();
  return Math.max(ratio(t0, c1), ratio(t0, c2), ratio(c1, c2));
}

export interface PhrasePattern {
  phrase: string;
  threshold: number;
}

export interface PhraseHit {
  pattern: string;
  score: number;
  threshold: number;
}

/** Billing phrases scored by the fuzzy path (regex remains the fast path). */
export const BILLING_PHRASES: PhrasePattern[] = [
  { phrase: "charged twice", threshold: 85 },
  { phrase: "double charge", threshold: 85 },
  { phrase: "wrong amount", threshold: 85 },
  { phrase: "did not authorize", threshold: 85 },
  { phrase: "unauthorized charge", threshold: 85 },
];

/**
 * Negation guard (gap 13 unknown-unknown #1): a negation token within
 * `window` tokens before the first matched phrase token suppresses the hit,
 * so "I was not charged twice" does not bill. Phrases that themselves carry
 * a negation token ("did not authorize") are exempt.
 */
export function negatedBeforePhrase(text: string, phrase: string, window = 3): boolean {
  const phraseTokens = tokenize(phrase);
  if (phraseTokens.some((t) => NEGATION_TOKENS.has(t))) return false;
  const tokens = tokenize(text);
  const anchors = new Set(phraseTokens);
  for (let i = 0; i < tokens.length; i++) {
    if (!anchors.has(tokens[i])) continue;
    for (let j = Math.max(0, i - window); j < i; j++) {
      if (NEGATION_TOKENS.has(tokens[j])) return true;
    }
    return false;
  }
  return false;
}

/** Score every pattern against the text; return hits at/above threshold, best first. */
export function matchPhrases(text: string, patterns: PhrasePattern[]): PhraseHit[] {
  const hits: PhraseHit[] = [];
  for (const { phrase, threshold } of patterns) {
    const score = tokenSetRatio(text, phrase);
    if (score < threshold) continue;
    if (negatedBeforePhrase(text, phrase)) continue;
    hits.push({ pattern: phrase, score: Math.round(score * 10) / 10, threshold });
  }
  return hits.sort((x, y) => y.score - x.score);
}
