/**
 * Tier-1 deterministic triage rules for ClaimFix.
 *
 * These run BEFORE any entitlement lookup or LLM reasoning. They are pure
 * functions of the claim payload: no network, no clock, no randomness.
 *
 * Rule style follows zeroSteiner/rule-engine semantics: each rule is a named
 * boolean expression over the payload dict. We keep the expression as a
 * readable `expr` string (documentation / audit trail) alongside the
 * compiled predicate `when`.
 *
 * Gap 14: priority is a REQUIRED numeric field on every rule (node-rules
 * pattern). Evaluation sorts priority-desc, then specificity-desc, then id-asc;
 * the first hit wins. Array position is cosmetic and means nothing.
 */

import type { ClaimPayload } from "./diagnose.js";
import { BILLING_PHRASES, matchPhrases, negatedBeforePhrase, tokenize } from "./fuzzy.js";

export type TriageLevel = "P1" | "P2" | "P3";

export interface RuleHit {
  ruleId: string;
  expr: string;
  /** Audit detail recorded when the rule matches (pattern, score, ...). */
  detail?: string;
}

export interface Tier1Rule {
  id: string;
  /** Boolean expression over the payload, in zeroSteiner-style notation (for audit). */
  expr: string;
  /**
   * REQUIRED evaluation priority. Higher number = evaluated earlier and wins
   * over lower numbers (node-rules descending-sort pattern). Never optional:
   * an optional field with a falsy-guard comparator silently degrades back to
   * positional ordering — the exact bug this fixes.
   *
   * *** PRIORITY POLICY — THE DEFAULT NUMBERS BELOW NEED Scott'S SIGN-OFF ***
   * *** BEFORE MERGE. ***
   * The mechanism (required field, desc sort, first-match-wins) is the gap-14
   * fix and is settled. The numeric defaults encode a policy judgment —
   * safety/legal escalation outranks contact suppression, money-risk outranks
   * suppression, suppression outranks billing investigation, investigation
   * outranks dedup bookkeeping — and that judgment is Scott's call, not the
   * builder's. Suggested defaults:
   *   legal_threat 100 > chargeback_threat 90 > dnd_unsubscribe 80 >
   *   billing_dispute 50 > duplicate_claim 40
   * Known consequences of these defaults (pinned by tests; update tests if the
   * numbers change):
   * - billing_dispute now outranks duplicate_claim: fixture
   *   claimfix/duplicate-claim-resubmission flips from `duplicate` to
   *   billing_dispute.
   * - legal_threat now outranks dnd_unsubscribe: fixture
   *   claimfix/dnd-plus-legal-threat flips from `dnd_request` to legal_threat
   *   (its torture note already anticipated this product decision).
   */
  priority: number;
  /**
   * Tiebreak hint: number of match-pattern alternatives in the rule.
   * Used ONLY when priorities tie; then rule id ascending for determinism.
   * (Conflict-resolution taxonomy: priority first, specificity second,
   * never positional order.)
   */
  specificity?: number;
  when: (payload: ClaimPayload) => boolean;
  /** Optional audit detail recorded when the rule matches. */
  matchDetail?: (payload: ClaimPayload) => string | undefined;
  level: TriageLevel;
  category: string;
  resolutionAction: string;
}

function textOf(p: ClaimPayload): string {
  return `${p.subject ?? ""}\n${p.body ?? ""}`;
}

const DND_RE = /unsubscrib|do\s*not\s*(contact|email|call|text)\s*me|remove\s*me|opt[-\s]?out|stop\s*(emailing|contacting)/i;
const LEGAL_RE = /lawsuit|sue\s+you|my\s+(attorney|lawyer)|legal\s+action|small\s+claims|better\s+business\s+bureau|\bftc\b|consumer\s+protection/i;
const CHARGEBACK_RE = /chargeback|disput(e|ing)\s+(the\s+)?charge|reverse\s+(the\s+)?payment|call(ing)?\s+my\s+bank|report\s+(as\s+)?fraud/i;

/**
 * Gap 13: keep the regexes as an exact fast path; fall back to the fuzzy
 * phrase scorer (RapidFuzz token_set_ratio port) so "charged me twice",
 * "they charged my card twice", "charged 2 times" etc. all match.
 *
 * The negation guard applies to BOTH paths: the exact regex contains
 * "charged twice" as a literal substring, so "I was NOT charged twice" would
 * otherwise bill through the fast path. A negated exact match is skipped and
 * the remaining alternatives are tried.
 *
 * Returns an audit string for verifiedProof.notes, or undefined on no match.
 */
const BILLING_EXACT: Array<{ re: RegExp; phrase: string }> = [
  { re: /charged\s+twice/i, phrase: "charged twice" },
  { re: /double\s+charge/i, phrase: "double charge" },
  { re: /wrong\s+amount/i, phrase: "wrong amount" },
  { re: /didn'?t\s+authori[sz]e/i, phrase: "did not authorize" },
  { re: /unauthorized\s+charge/i, phrase: "unauthorized charge" },
  { re: /refund/i, phrase: "refund" }, // single token: exempt from negation guard
];

function billingMatchDetail(p: ClaimPayload): string | undefined {
  const text = textOf(p);
  for (const { re, phrase } of BILLING_EXACT) {
    if (!re.test(text)) continue;
    if (tokenize(phrase).length > 1 && negatedBeforePhrase(text, phrase)) continue;
    return `exact pattern match "${phrase}"`;
  }
  const hits = matchPhrases(text, BILLING_PHRASES);
  if (hits.length === 0) return undefined;
  const best = hits[0];
  return `fuzzy phrase match "${best.pattern}" score ${best.score} >= threshold ${best.threshold}`;
}

export const TIER1_RULES: Tier1Rule[] = [
  {
    id: "legal_threat",
    expr: "subject_or_body matches LEGAL_THREAT_PATTERN",
    priority: 100,
    specificity: 8,
    when: (p) => LEGAL_RE.test(textOf(p)),
    matchDetail: () => "exact LEGAL_RE match",
    level: "P1",
    category: "legal_threat",
    resolutionAction: "escalate_legal",
  },
  {
    id: "chargeback_threat",
    expr: "subject_or_body matches CHARGEBACK_PATTERN",
    priority: 90,
    specificity: 6,
    when: (p) => CHARGEBACK_RE.test(textOf(p)),
    matchDetail: () => "exact CHARGEBACK_RE match",
    level: "P1",
    category: "chargeback_risk",
    resolutionAction: "hold_fulfillment_review",
  },
  {
    id: "dnd_unsubscribe",
    expr: "subject_or_body matches DND_PATTERN",
    priority: 80,
    specificity: 6,
    when: (p) => DND_RE.test(textOf(p)),
    matchDetail: () => "exact DND_RE match",
    level: "P1",
    category: "dnd_request",
    resolutionAction: "suppress_contact",
  },
  {
    id: "billing_dispute",
    expr: "subject_or_body matches BILLING_PATTERN (regex fast path + fuzzy phrase scorer)",
    priority: 50,
    specificity: 12,
    when: (p) => billingMatchDetail(p) !== undefined,
    matchDetail: billingMatchDetail,
    level: "P2",
    category: "billing_dispute",
    resolutionAction: "verify_entitlement_then_refund_or_explain",
  },
  {
    id: "duplicate_claim",
    expr: "claim_id in seen_claim_ids",
    priority: 40,
    specificity: 1,
    when: (p) =>
      Array.isArray(p.metadata?.["seenClaimIds"]) &&
      (p.metadata?.["seenClaimIds"] as unknown[]).includes(p.claimId),
    matchDetail: () => "claim_id found in seen_claim_ids metadata",
    level: "P2",
    category: "duplicate",
    resolutionAction: "link_to_original",
  },
];

const priorityById = new Map(TIER1_RULES.map((r) => [r.id, r.priority]));

/** Conflict-resolution order: priority desc -> specificity desc -> id asc. Exported for tests. */
export function compareTier1Rules(a: Tier1Rule, b: Tier1Rule): number {
  if (b.priority !== a.priority) return b.priority - a.priority;
  const sa = a.specificity ?? 0;
  const sb = b.specificity ?? 0;
  if (sb !== sa) return sb - sa;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Evaluate tier-1 rules in priority order. Returns all hits (priority-sorted
 * for the audit trail); the first hit is the winner and sets level/category.
 */
export function evaluateTier1(payload: ClaimPayload): {
  hits: RuleHit[];
  matched?: Tier1Rule;
  /** Human-readable winner rationale for verifiedProof.notes. */
  winnerNote?: string;
} {
  const ordered = [...TIER1_RULES].sort(compareTier1Rules);
  const hits: RuleHit[] = [];
  let matched: Tier1Rule | undefined;
  for (const rule of ordered) {
    if (rule.when(payload)) {
      hits.push({ ruleId: rule.id, expr: rule.expr, detail: rule.matchDetail?.(payload) });
      if (!matched) matched = rule;
    }
  }
  let winnerNote: string | undefined;
  if (matched) {
    const others = hits
      .filter((h) => h.ruleId !== matched!.id)
      .map((h) => `${h.ruleId} (priority ${priorityById.get(h.ruleId) ?? "?"})`)
      .join(", ");
    winnerNote = `winner ${matched.id} (priority ${matched.priority})` +
      (others ? ` over ${others}` : " (sole match)");
  }
  return { hits, matched, winnerNote };
}
