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

export type TriageLevel = "P1" | "P2" | "P3";

export interface RuleHit {
  ruleId: string;
  expr: string;
}

export interface Tier1Rule {
  id: string;
  /** Boolean expression over the payload, in zeroSteiner-style notation (for audit). */
  expr: string;
  when: (payload: ClaimPayload) => boolean;
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
    expr: "subject_or_body matches BILLING_PATTERN",
    when: (p) => BILLING_RE.test(textOf(p)),
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
      hits.push({ ruleId: rule.id, expr: rule.expr });
      if (!matched) matched = rule;
    }
  }
  return { hits, matched };
}
