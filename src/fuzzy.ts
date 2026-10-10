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
  /** TL-016: set when the hit needed bounded character-level typo tolerance. */
  typoTolerant?: boolean;
}

export const NEGATION_TOKENS = new Set([
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
  // Spanish guard tokens used by the TL-015 localized P1 phrase sets.
  "nunca",
  "jamas",
  "tampoco",
  "ni",
  "sin",
]);

export const NEGATION_WINDOW = 3;

/**
 * TL-038: "going to" (and "gonna") is a periphrastic-future filler that
 * pushes a negation token outside NEGATION_WINDOW: "not going to take
 * legal action" puts "not" 4 tokens before the anchor, so the guard missed
 * it and a polite disavowal escalated to P1/escalate_legal. Merge the
 * bigram into one token for guard purposes only (tokenize() itself is
 * untouched — fuzzy matching still sees the original tokens). "not going
 * to hesitate to take legal action" still fires: "hesitate" stays between
 * the negation and the anchor, and the double negation reads as assertion.
 */
export function mergeGoingTo(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "going" && tokens[i + 1] === "to") {
      out.push("going_to");
      i++;
    } else if (tokens[i] === "gonna") {
      out.push("going_to");
    } else {
      out.push(tokens[i]);
    }
  }
  return out;
}

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
 * the earliest matched phrase token ("I was not charged twice"). TL-038:
 * the token stream is going_to-merged first so "not going to take X"
 * still scopes the negation. */
function negatedBefore(textTokens: string[], phraseTokenSet: Set<string>): boolean {
  const toks = mergeGoingTo(textTokens);
  let earliest = -1;
  for (let i = 0; i < toks.length; i++) {
    if (phraseTokenSet.has(toks[i])) {
      earliest = i;
      break;
    }
  }
  if (earliest === -1) return false;
  for (let i = Math.max(0, earliest - NEGATION_WINDOW); i < earliest; i++) {
    if (NEGATION_TOKENS.has(toks[i])) return true;
  }
  return false;
}

/**
 * TL-016: bounded character-level typo tolerance for multi-token phrases.
 *
 * token_set_ratio tolerates extra/intervening words but requires every
 * token to be character-exact, so one typo ("charged twise", "chrged
 * twise") silently defeated billing. The fallback below accepts a phrase
 * only when EVERY phrase token is present either exactly or within edit
 * distance 1 (tokens of length >= 4), with each text token consumed at
 * most once. It is deliberately narrow:
 * - multi-token phrases only (single-token "refund" stays exact);
 * - one-edit maximum per token, no prefix/suffix stemming;
 * - known confusable real words are excluded ("change"/"changed" are not
 *   misspellings of "charge"/"charged").
 * Number aliases need their surface forms back: normalize() rewrites
 * "twice" to the token "2x", so the alias's originals are candidates too.
 */
const TYPO_TOKEN_ALIASES: Record<string, string[]> = {
  "2x": ["2x", "twice", "double", "x2"],
  "1x": ["1x", "once", "one"],
};

const TYPO_CONFUSABLES: Record<string, ReadonlySet<string>> = {
  charged: new Set(["changed", "change"]),
  charge: new Set(["change", "changed"]),
};

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    let mismatches = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i] && ++mismatches > 1) return false;
    }
    return true;
  }
  const short = a.length < b.length ? a : b;
  const long = a.length < b.length ? b : a;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i++;
      j++;
    } else {
      if (++edits > 1) return false;
      j++; // one insertion/deletion in the longer token
    }
  }
  return edits + (long.length - j) <= 1;
}

function typoTokenMatches(phraseToken: string, textToken: string): boolean {
  if (TYPO_CONFUSABLES[phraseToken]?.has(textToken)) return false;
  const candidates = TYPO_TOKEN_ALIASES[phraseToken] ?? [phraseToken];
  return candidates.some(
    (candidate) =>
      Math.min(candidate.length, textToken.length) >= 4 &&
      editDistanceAtMostOne(candidate, textToken),
  );
}

/**
 * Indices of the text tokens consumed by a typo-tolerant phrase match, or
 * null when any phrase token has neither an exact nor a one-edit match.
 * Exact matches are preferred so a correctly spelled token is never
 * "spent" on a neighbouring typo candidate.
 */
function typoMatchedIndices(textTokens: string[], phraseTokens: string[]): number[] | null {
  const used = new Set<number>();
  const indices: number[] = [];
  for (const phraseToken of phraseTokens) {
    let idx = textTokens.findIndex((t, i) => !used.has(i) && t === phraseToken);
    if (idx === -1) {
      idx = textTokens.findIndex(
        (t, i) => !used.has(i) && typoTokenMatches(phraseToken, t),
      );
    }
    if (idx === -1) return null;
    used.add(idx);
    indices.push(idx);
  }
  return indices;
}

function negatedBeforeIndex(textTokens: string[], index: number): boolean {
  // TL-038: index refers to the ORIGINAL token stream; map it through the
  // going_to merge so "not going to take X" scopes the same as elsewhere.
  const toks = mergeGoingTo(textTokens);
  let mergedIdx = 0;
  for (let i = 0; i < index && i < textTokens.length; i++) {
    mergedIdx++;
    if (textTokens[i] === "going" && textTokens[i + 1] === "to") i++;
  }
  for (let i = Math.max(0, mergedIdx - NEGATION_WINDOW); i < mergedIdx; i++) {
    if (NEGATION_TOKENS.has(toks[i])) return true;
  }
  return false;
}

/**
 * TL-038 (ledger): a fuzzy hit is only valid when EVERY phrase token has
 * at least one occurrence that is not negated. token_set_ratio assembles a
 * phrase from the whole field, so "a second charge. I was not charged
 * twice" used to score "double charge" at 100 — the negated "twice"
 * donated its 2x token while the unnegated "a second charge" donated
 * "charge", and the old earliest-token guard only inspected the window
 * before "charge". A token that occurs solely inside a negation can no
 * longer contribute to a hit; a token with both negated and asserted
 * occurrences still fires through its asserted occurrence. This subsumes
 * the old earliest-token check for multi-token phrases. The token stream
 * is going_to-merged first, matching negatedBefore's scoping.
 */
function everyPhraseTokenHasUnnegatedOccurrence(
  textTokens: string[],
  phraseTokens: string[],
): boolean {
  const toks = mergeGoingTo(textTokens);
  const wanted = new Set(mergeGoingTo(phraseTokens));
  const occurrences = new Map<string, number[]>();
  for (let i = 0; i < toks.length; i++) {
    if (wanted.has(toks[i])) {
      const arr = occurrences.get(toks[i]) ?? [];
      arr.push(i);
      occurrences.set(toks[i], arr);
    }
  }
  for (const token of wanted) {
    const idxs = occurrences.get(token) ?? [];
    let anyClean = false;
    for (const idx of idxs) {
      let negated = false;
      for (let i = Math.max(0, idx - NEGATION_WINDOW); i < idx; i++) {
        if (NEGATION_TOKENS.has(toks[i])) {
          negated = true;
          break;
        }
      }
      if (!negated) {
        anyClean = true;
        break;
      }
    }
    if (!anyClean) return false;
  }
  return true;
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
    const phraseTokens = tokenize(phrase);
    const score = tokenSetRatio(phrase, text);
    if (score >= threshold) {
      // TL-038 (ledger): per-token unnegated-occurrence check (subsumes the
      // old earliest-token guard) — a token occurring solely inside a
      // negation cannot donate to a fuzzy hit.
      if (
        phraseTokens.length > 1 &&
        !everyPhraseTokenHasUnnegatedOccurrence(tokens, phraseTokens)
      ) {
        continue;
      }
      hits.push({ pattern: phrase, score: Math.round(score), threshold });
      continue;
    }
    // TL-016 fallback: every phrase token present within one edit.
    if (phraseTokens.length <= 1) continue;
    const indices = typoMatchedIndices(tokens, phraseTokens);
    if (!indices) continue;
    if (negatedBeforeIndex(tokens, Math.min(...indices))) continue;
    hits.push({ pattern: phrase, score: 99, threshold, typoTolerant: true });
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
  { phrase: "amount mismatch", threshold: 85 },
  { phrase: "charged different amount", threshold: 85 },
  { phrase: "refund", threshold: 100 },
];
