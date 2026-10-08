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
const BILLING_RE = /charged\s+twice|double\s+charge|wrong\s+amount|didn'?t\s+authori[sz]e|unauthorized\s+charge|refund/i;

/**
 * Gap 13: keep the regex as an exact fast path; fall back to the fuzzy
 * phrase scorer (RapidFuzz token_set_ratio port) so "charged me twice",
 * "they charged my card twice", "charged 2 times" etc. all match.
 *
 * The negation guard applies to BOTH paths: the exact regex contains
 * "charged twice" as a literal substring, so "I was NOT charged twice" would
 * otherwise bill through the fast path. A negated exact match is skipped.
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
    id: "dnd_unsubscribe",
    expr: "subject_or_body matches DND_PATTERN",
    when: (p) => DND_RE.test(textOf(p)),
    level: "P1",
    category: "dnd_request",
    resolutionAction: "suppress_contact",
  },
  {
    id: "legal_threat",
    expr: "subject_or_body matches LEGAL_THREAT_PATTERN",
    when: (p) => LEGAL_RE.test(textOf(p)),
    level: "P1",
    category: "legal_threat",
    resolutionAction: "escalate_legal",
  },
  {
    id: "chargeback_threat",
    expr: "subject_or_body matches CHARGEBACK_PATTERN",
    when: (p) => CHARGEBACK_RE.test(textOf(p)),
    level: "P1",
    category: "chargeback_risk",
    resolutionAction: "hold_fulfillment_review",
  },
  {
    id: "duplicate_claim",
    expr: "claim_id in seen_claim_ids",
    when: (p) =>
      Array.isArray(p.metadata?.["seenClaimIds"]) &&
      (p.metadata?.["seenClaimIds"] as unknown[]).includes(p.claimId),
    level: "P2",
    category: "duplicate",
    resolutionAction: "link_to_original",
  },
  {
    id: "billing_dispute",
    expr: "subject_or_body matches BILLING_PATTERN (regex fast path + fuzzy phrase scorer)",
    when: (p) => billingMatchDetail(p) !== undefined,
    matchDetail: billingMatchDetail,
    level: "P2",
    category: "billing_dispute",
    resolutionAction: "verify_entitlement_then_refund_or_explain",
  },
];

/** Evaluate tier-1 rules in priority order. Returns all hits; the first hit sets level/category. */
export function evaluateTier1(payload: ClaimPayload): { hits: RuleHit[]; matched?: Tier1Rule } {
  const hits: RuleHit[] = [];
  let matched: Tier1Rule | undefined;
  for (const rule of TIER1_RULES) {
    if (rule.when(payload)) {
      hits.push({ ruleId: rule.id, expr: rule.expr, detail: rule.matchDetail?.(payload) });
      if (!matched) matched = rule;
    }
  }
  return { hits, matched };
}
