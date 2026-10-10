/**
 * Gap 13 — fuzzy billing-phrase matching.
 *
 * Ports RapidFuzz's token_set_ratio (MIT) to dependency-free TypeScript:
 *   normalize -> tokenize -> lowercase -> dedupe -> sort -> set ops
 * A phrase scores 100 when its token set is a SUBSET of the text's token set,
 * regardless of extra or intervening words. That is exactly the concrete bug:
 * BILLING_RE required the literal sequence "charged" + whitespace + "twice",
 * so the most natural phrasing — "charged me twice" — silently missed and the
 * claim fell through to P3.
 *
 * Borrowing decisions (see testlabs-fleet/gap-fixes/claimfix-billing-phrase-match.md):
 * - BORROW: RapidFuzz token_set_ratio algorithm; compromise normalization-first
 *   staging; flashtext-style alias canonicalization; spaczz per-pattern
 *   thresholds (min_r) and overlap resolution (highest score wins primary,
 *   all hits kept).
 * - VERIFY (not built): nlp.js best-substring search on typo-heavy samples;
 *   threshold values against the torture pack.
 * - SKIP: Fuse bitap (wrong problem — no token slop); any Python/ML dependency;
 *   WRatio and the weighted-scorer zoo.
 */

const NUMBER_ALIASES: Record<string, string> = {
  twice: "2x",
  double: "2x",
  x2: "2x",
  two: "2",
  one: "1",
  once: "1x",
};

const CONTRACTION_RULES: Array<[RegExp, string]> = [
  [/\bwon't\b/g, "will not"],
  [/\bcan't\b/g, "can not"],
  [/n't\b/g, " not"], // didn't -> did not, wasn't -> was not, ...
];

/** "2 times" / "two times" -> "2x" so they align with "twice". */
const NUMBER_TIMES_RE = /\b(\d+)\s+times?\b/g;

function normalize(s: string): string {
  let out = s.toLowerCase();
  for (const [re, rep] of CONTRACTION_RULES) out = out.replace(re, rep);
  const words = out
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => NUMBER_ALIASES[w] ?? w);
  return words.join(" ").replace(NUMBER_TIMES_RE, "$1x");
}

/** Lowercased, punctuation-stripped, number-canonicalized tokens. */
export function tokenize(s: string): string[] {
  return normalize(s).split(/\s+/).filter(Boolean);
}

function uniqueSorted(tokens: string[]): string[] {
  return [...new Set(tokens)].sort();
}

/**
 * RapidFuzz token_set_ratio port. Returns 0-100.
 * 100 when one token set is a subset of the other (extra words tolerated,
 * word order ignored); explicit disagreement lowers the score.
 */
export function tokenSetRatio(a: string, b: string): number {
  const t1 = uniqueSorted(tokenize(a));
  const t2 = uniqueSorted(tokenize(b));
  if (t1.length === 0 || t2.length === 0) return 0;
  const set2 = new Set(t2);
  const inter = t1.filter((t) => set2.has(t));
  if (inter.length === 0) return 0;
  const setInter = new Set(inter);
  const rem1 = t1.filter((t) => !setInter.has(t));
  const rem2 = t2.filter((t) => !setInter.has(t));
  const diff1 = [...inter, ...rem1];
  const diff2 = [...inter, ...rem2];
  const base = (x: string[], y: string[]): number => {
    const ys = new Set(y);
    const common = x.filter((t) => ys.has(t)).length;
    return (2 * common) / (x.length + y.length);
  };
  return 100 * Math.max(base(inter, diff1), base(inter, diff2), base(diff1, diff2));
}

export interface PhrasePattern {
  phrase: string;
  /** Minimum token_set_ratio (0-100) for a hit. Per-pattern (spaczz min_r). */
  threshold: number;
}

export interface PhraseHit {
  pattern: string;
  score: number;
  threshold: number;
}

const NEGATION_TOKENS = new Set([
  "not",
  "never",
  "no",
  "none",
  "without",
  "neither",
  "nor",
  "cannot",
  "cant",
  "dont",
  "wont",
  "didnt",
  "doesnt",
  "isnt",
  "arent",
  "wasnt",
  "werent",
  "hasnt",
  "havent",
  "couldnt",
  "shouldnt",
]);

const NEGATION_WINDOW = 3;

/**
 * True when a negation token appears within NEGATION_WINDOW tokens BEFORE the
 * earliest occurrence of any phrase token in the text ("I was not charged
 * twice"). Exported so the exact-regex fast path in rules.ts applies the same
 * guard — a negated exact match ("not charged twice") must not bill either.
 */
export function negatedBeforePhrase(text: string, phrase: string): boolean {
  const tokens = tokenize(text);
  return negatedBefore(tokens, new Set(tokenize(phrase)));
}

/** True when a negation token appears within NEGATION_WINDOW tokens BEFORE
 * the earliest matched phrase token ("I was not charged twice"). */
function negatedBefore(textTokens: string[], phraseTokenSet: Set<string>): boolean {
  let earliest = -1;
  for (let i = 0; i < textTokens.length; i++) {
    if (phraseTokenSet.has(textTokens[i])) {
      earliest = i;
      break;
    }
  }
  if (earliest === -1) return false;
  for (let i = Math.max(0, earliest - NEGATION_WINDOW); i < earliest; i++) {
    if (NEGATION_TOKENS.has(textTokens[i])) return true;
  }
  return false;
}

/**
 * Score each pattern against the text; keep hits at/above threshold.
 * Overlap resolution (spaczz SpaczzRuler): highest score first, all hits kept.
 *
 * Negation guard applies to MULTI-token phrases only: "I was not charged
 * twice" must not bill. Single-token patterns (e.g. "refund") are exempt —
 * "I did not get a refund" is still a billing complaint, and negation-scope
 * resolution is its own sub-problem (see gap report, unknown-unknown #1).
 */
export function matchPhrases(text: string, patterns: PhrasePattern[]): PhraseHit[] {
  const tokens = tokenize(text);
  const hits: PhraseHit[] = [];
  for (const { phrase, threshold } of patterns) {
    const score = tokenSetRatio(phrase, text);
    if (score < threshold) continue;
    const phraseTokens = tokenize(phrase);
    if (phraseTokens.length > 1 && negatedBefore(tokens, new Set(phraseTokens))) {
      continue;
    }
    hits.push({ pattern: phrase, score: Math.round(score), threshold });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits;
}

/** Billing phrase patterns (thresholds per pattern; VERIFY against torture pack). */
export const BILLING_PHRASES: PhrasePattern[] = [
  { phrase: "charged twice", threshold: 85 },
  { phrase: "double charge", threshold: 85 },
  { phrase: "wrong amount", threshold: 85 },
  { phrase: "did not authorize", threshold: 85 },
  { phrase: "unauthorized charge", threshold: 85 },
  { phrase: "refund", threshold: 100 },
];
