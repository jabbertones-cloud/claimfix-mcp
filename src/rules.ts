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
import { detectAmountMismatch, formatMoney } from "./contradictions.js";
import {
  BILLING_PHRASES,
  NEGATION_TOKENS,
  NEGATION_WINDOW,
  matchPhrases,
  mergeGoingTo,
  negatedBeforePhrase,
  tokenize,
} from "./fuzzy.js";

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
   *   billing_dispute 50 > pending_hold 45 > duplicate_claim 40
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

/**
 * TL-010: every tier-1 pattern rule matches through { regex, phrase }
 * alternatives guarded by the SAME negation check billing got in gap 13
 * (negatedBeforePhrase): an alternative only counts when it is not
 * explicitly negated. Before this, the P1 regexes had no guard, so
 * "Do not remove me from your list, I love the emails" escalated to
 * P1/dnd_request suppress_contact — the exact opposite of the request —
 * and "not disputing" / "not going to sue" escalated as assertions.
 *
 * True positives are preserved: the "do not contact me" alternatives carry
 * their own negation inside the anchor phrase, and the guard only looks at
 * tokens BEFORE the anchor, so an asserted do-not-contact is never
 * suppressed by its own wording.
 */
interface GuardedPattern {
  re: RegExp;
  /** Phrase named in the audit detail when this alternative matches. */
  phrase: string;
  /**
   * Token bag fed to the negation guard when `phrase` makes a poor anchor
   * (common words like "the"/"you"/"my" would pin the guard window to an
   * unrelated earlier token). Defaults to `phrase`.
   */
  guard?: string;
  /** ISO language code when this alternative belongs to a localized set (TL-015). */
  lang?: string;
}

function guardedPatternDetail(text: string, patterns: GuardedPattern[]): string | undefined {
  for (const { re, phrase, guard, lang } of patterns) {
    if (!re.test(text)) continue;
    if (negatedBeforePhrase(text, guard ?? phrase)) continue;
    return `exact pattern match "${phrase}"${lang ? ` (${lang})` : ""}`;
  }
  return undefined;
}

const LEGAL_PATTERNS: GuardedPattern[] = [
  { re: /lawsuit/i, phrase: "lawsuit" },
  { re: /sue\s+you/i, phrase: "sue you", guard: "sue" },
  { re: /(?:i'?m|i am)\s+going\s+to\s+sue/i, phrase: "going to sue", guard: "sue" },
  { re: /\bi'?ll\s+sue\b/i, phrase: "I'll sue", guard: "sue" },
  { re: /take\s+(?:you|this|it)\s+to\s+court/i, phrase: "take to court", guard: "court" },
  { re: /my\s+attorney/i, phrase: "my attorney", guard: "attorney" },
  { re: /my\s+lawyer/i, phrase: "my lawyer", guard: "lawyer" },
  { re: /legal\s+action/i, phrase: "legal action" },
  { re: /small\s+claims/i, phrase: "small claims" },
  { re: /better\s+business\s+bureau/i, phrase: "better business bureau", guard: "bureau" },
  { re: /\bftc\b/i, phrase: "ftc" },
  { re: /consumer\s+protection/i, phrase: "consumer protection" },
];

const CHARGEBACK_PATTERNS: GuardedPattern[] = [
  { re: /chargeback/i, phrase: "chargeback" },
  { re: /disput(e|ing)\s+(the\s+)?charge/i, phrase: "dispute the charge", guard: "disputing dispute" },
  { re: /reverse\s+(the\s+)?payment/i, phrase: "reverse the payment", guard: "reverse payment" },
  { re: /call(ing)?\s+my\s+bank/i, phrase: "call my bank", guard: "call calling bank" },
  { re: /report\s+(as\s+)?fraud/i, phrase: "report fraud" },
];

const DND_PATTERNS: GuardedPattern[] = [
  { re: /unsubscrib/i, phrase: "unsubscribe", guard: "unsubscribe unsubscribing unsubscribed" },
  { re: /do\s*not\s*contact\s*me/i, phrase: "do not contact me" },
  { re: /do\s*not\s*email\s*me/i, phrase: "do not email me" },
  { re: /do\s*not\s*call\s*me/i, phrase: "do not call me" },
  { re: /do\s*not\s*text\s*me/i, phrase: "do not text me" },
  { re: /remove\s*me/i, phrase: "remove me" },
  { re: /opt[-\s]?out/i, phrase: "opt out" },
  { re: /stop\s*emailing/i, phrase: "stop emailing" },
  { re: /stop\s*contacting/i, phrase: "stop contacting" },
  // TL-039: the modal-negation construction "do not want ... to keep
  // emailing/contacting/sending" is an asserted DND request, not a
  // contact_ok stance. The anchor phrase carries its own negation (per
  // TL-010), so the guard only suppresses a negation token BEFORE the
  // anchor — the pattern's own "do not" never self-suppresses, including
  // the contracted "don't" (tokenize expands n't -> " not").
  {
    re: /\b(?:do\s+not|don'?t)\s+want\s+(?:\w+\s+)?to\s+keep\s+(?:emailing|contacting|sending)\b/i,
    phrase: "do not want to keep emailing",
    guard: "do not want to keep emailing contacting sending",
  },
];

/**
 * TL-015: localized P1 phrase sets. Non-English P1s used to fall through
 * to P3/general — for a do-not-contact request that is a compliance
 * miss, not just a routing miss. Each language contributes guarded
 * patterns to the SAME three categories (deterministic phrases, no ML,
 * per the rules-first product contract); add a language by adding one
 * entry here. The negation guard is shared, with Spanish guard tokens
 * in fuzzy.ts's NEGATION_TOKENS.
 */
interface LocalizedPatternSet {
  lang: string;
  legal: GuardedPattern[];
  chargeback: GuardedPattern[];
  dnd: GuardedPattern[];
}

const LOCALIZED_PATTERN_SETS: LocalizedPatternSet[] = [
  {
    lang: "es",
    legal: [
      { re: /\bmi\s+abogado\b/i, phrase: "mi abogado", guard: "hablar mi abogado abogado", lang: "es" },
      { re: /\bdemandar\w*\b/i, phrase: "demandar", guard: "demandar demandarlos demandarlas demandarte demanda", lang: "es" },
      { re: /\bpresent\w*\s+una\s+demanda\b/i, phrase: "presentar una demanda", guard: "presentar una demanda", lang: "es" },
      { re: /\bacci[oó]n\s+legal\b/i, phrase: "acción legal", lang: "es" },
      { re: /\bllevar\w*\s+a\s+la\s+corte\b/i, phrase: "llevar a la corte", guard: "llevar a la corte", lang: "es" },
      { re: /\bdenunci\w*\s+ante\b/i, phrase: "denunciar ante", guard: "denunciar denunciare ante", lang: "es" },
    ],
    chargeback: [
      { re: /\bcontracargo\b/i, phrase: "contracargo", lang: "es" },
      { re: /\bdisput\w*\s+(?:el\s+)?cargo\b/i, phrase: "disputar el cargo", guard: "disputar disputare disputo el cargo", lang: "es" },
      { re: /\bllamar(?:é|e)?\s+a\s+mi\s+banco\b/i, phrase: "llamar a mi banco", guard: "llamar llamare a mi banco", lang: "es" },
      { re: /\breport\w*\s+(?:esto\s+)?como\s+fraude\b/i, phrase: "reportar como fraude", guard: "reportar reportare como fraude", lang: "es" },
      { re: /\brevertir\s+(?:el\s+)?pago\b/i, phrase: "revertir el pago", guard: "revertir el pago", lang: "es" },
      { re: /\bdevolver\s+(?:el\s+)?cargo\b/i, phrase: "devolver el cargo", guard: "devolver el cargo", lang: "es" },
    ],
    dnd: [
      { re: /\bno\s+me\s+contacten\s+(?:m[aá]s|otra\s+vez)\b/i, phrase: "no me contacten más", lang: "es" },
      { re: /\bno\s+me\s+env[ií]en\s+(?:m[aá]s\s+)?(?:correos?|mensajes?)\b/i, phrase: "no me envíen más correos", guard: "no me envien mas correos mensajes", lang: "es" },
      { re: /\bdejen\s+de\s+(?:contactarme|enviarme\s+correos?)\b/i, phrase: "dejen de contactarme", guard: "dejen de contactarme enviarme correos", lang: "es" },
      { re: /\bcancel\w*\s+mi\s+suscripci[oó]n\b/i, phrase: "cancelar mi suscripción", guard: "cancelar cancelen mi suscripcion", lang: "es" },
      { re: /\bdarme\s+de\s+baja\b/i, phrase: "darme de baja", lang: "es" },
      { re: /\bdejar\s+de\s+recibir\s+correos\b/i, phrase: "dejar de recibir correos", guard: "dejar de recibir correos", lang: "es" },
    ],
  },
];

const legalMatchDetail = (p: ClaimPayload): string | undefined =>
  guardedPatternDetail(textOf(p), [
    ...LEGAL_PATTERNS,
    ...LOCALIZED_PATTERN_SETS.flatMap((s) => s.legal),
  ]);
const chargebackMatchDetail = (p: ClaimPayload): string | undefined =>
  guardedPatternDetail(textOf(p), [
    ...CHARGEBACK_PATTERNS,
    ...LOCALIZED_PATTERN_SETS.flatMap((s) => s.chargeback),
  ]);
const dndMatchDetail = (p: ClaimPayload): string | undefined =>
  guardedPatternDetail(textOf(p), [
    ...DND_PATTERNS,
    ...LOCALIZED_PATTERN_SETS.flatMap((s) => s.dnd),
  ]);

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
  { re: /amount\s+(mismatch|difference|discrepancy)/i, phrase: "amount mismatch" },
  { re: /didn'?t\s+authori[sz]e/i, phrase: "did not authorize" },
  { re: /unauthorized\s+charge/i, phrase: "unauthorized charge" },
  { re: /refund/i, phrase: "refund" }, // single token: guarded by refundRefused below, not the generic guard
];

/**
 * TL-010, billing arm: "refund" needs one refinement over the generic
 * negation guard. Negating RECEIPT is still a billing complaint ("I did
 * not get a refund" — the negation scopes over getting, and the customer
 * is owed an explanation), but negating the REMEDY is an explicit refusal
 * that must not route into verify_entitlement_then_refund_or_explain
 * ("I do not want a refund. Please do not refund me, just resend it").
 * Refusal = a negation token scoping over a "refund" mention with no
 * receipt verb (get/receive/see/...) between the negation and the refund.
 */
const RECEIPT_VERBS = new Set(["get", "got", "receive", "received", "see", "seen"]);

// TL-038: filler words between a negation and "refund" must not hide a
// refusal — "not going to take a refund" is the same refusal as
// "not ... refund". Receipt verbs are NEVER filler: "not get a refund"
// stays a billing complaint.
const REFUSAL_FILLER = new Set(["going_to", "take", "takes", "taking", "a", "an", "the"]);

function refundRefused(text: string): boolean {
  // TL-038: going_to-merged and filler-stripped so "not going to take a
  // refund" scopes the negation the same way the generic guard does.
  const tokens = mergeGoingTo(tokenize(text)).filter((t) => !REFUSAL_FILLER.has(t));
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "refund") continue;
    for (let j = Math.max(0, i - NEGATION_WINDOW); j < i; j++) {
      if (!NEGATION_TOKENS.has(tokens[j])) continue;
      if (!tokens.slice(j + 1, i).some((t) => RECEIPT_VERBS.has(t))) return true;
    }
  }
  return false;
}

function billingMatchDetail(p: ClaimPayload): string | undefined {
  const text = textOf(p);
  const refused = refundRefused(text);
  // TL-014: a stated-vs-charged amount mismatch is itself a billing
  // signal — the customer is disputing money, even when no stock billing
  // phrase ("charged twice", "refund") appears. It surfaces here as the
  // billing hit and again, verbatim, via the amount contradiction facet.
  const mismatch = detectAmountMismatch(text);
  if (mismatch) {
    return (
      `amount mismatch: stated ${formatMoney(mismatch.stated.cents)} ` +
      `vs charged ${formatMoney(mismatch.charged.cents)}`
    );
  }
  for (const { re, phrase } of BILLING_EXACT) {
    if (!re.test(text)) continue;
    if (phrase === "refund") {
      if (refused) continue;
    } else if (tokenize(phrase).length > 1 && negatedBeforePhrase(text, phrase)) {
      continue;
    }
    return `exact pattern match "${phrase}"`;
  }
  // Wave-1 F1 (GAP-claimfix-30): fuzzy phrase matching is FIELD-LOCAL.
  // token_set_ratio assembles a phrase from the union of subject+body
  // tokens, so subject "Second charge?" donated "charge" and the body's
  // explicitly negated "charged twice" donated "2x" — together they
  // fabricated an unnegated "double charge" hit and billing outranked
  // the pending-hold route the customer actually asked for. A billing
  // phrase's tokens must co-occur inside one field; the exact-regex
  // fast path above stays on combined text (it needs adjacency anyway).
  const hits = [p.subject ?? "", p.body ?? ""]
    .flatMap((field) => matchPhrases(field, BILLING_PHRASES))
    .filter((h) => h.pattern !== "refund" || !refused)
    .sort((a, b) => b.score - a.score);
  if (hits.length === 0) return undefined;
  const best = hits[0];
  return (
    `fuzzy phrase match "${best.pattern}" score ${best.score} >= threshold ${best.threshold}` +
    (best.typoTolerant ? " (TL-016 character-typo tolerant)" : "")
  );
}

/**
 * TL-018: pending-hold / authorization claims need their own route.
 * "I wasn't charged twice — my bank shows a pending hold that looks like
 * a second charge, can you check before I dispute it?" is NOT a billing
 * dispute (the negated duplicate-charge correctly does not fire) and it
 * is not a generic complaint either: the customer is asking for the
 * hold/authorization explanation. Guarded like the P1 patterns, so
 * "there is no pending hold" does not route here.
 */
const PENDING_HOLD_PATTERNS: GuardedPattern[] = [
  { re: /pending\s+hold/i, phrase: "pending hold" },
  { re: /pending\s+(authorization|authorisation)/i, phrase: "pending authorization" },
  { re: /(authorization|authorisation)\s+hold/i, phrase: "authorization hold" },
  { re: /temporary\s+hold/i, phrase: "temporary hold" },
  { re: /pending\s+(charge|transaction)/i, phrase: "pending charge" },
  { re: /hold\s+(on|against)\s+(my\s+)?(bank\s+)?(card|account)/i, phrase: "hold on my card", guard: "hold card account" },
  { re: /hold\s+on\s+(the\s+|my\s+)?(charge|transaction|payment)/i, phrase: "hold on the charge", guard: "hold charge transaction payment" },
  { re: /pre-?authorization/i, phrase: "pre-authorization", guard: "pre authorization" },
];

const pendingHoldMatchDetail = (p: ClaimPayload): string | undefined =>
  guardedPatternDetail(textOf(p), PENDING_HOLD_PATTERNS);

export const TIER1_RULES: Tier1Rule[] = [
  {
    id: "legal_threat",
    expr: "subject_or_body matches LEGAL_THREAT_PATTERN",
    priority: 100,
    specificity: 8,
    when: (p) => legalMatchDetail(p) !== undefined,
    matchDetail: legalMatchDetail,
    level: "P1",
    category: "legal_threat",
    resolutionAction: "escalate_legal",
  },
  {
    id: "chargeback_threat",
    expr: "subject_or_body matches CHARGEBACK_PATTERN",
    priority: 90,
    specificity: 6,
    when: (p) => chargebackMatchDetail(p) !== undefined,
    matchDetail: chargebackMatchDetail,
    level: "P1",
    category: "chargeback_risk",
    resolutionAction: "hold_fulfillment_review",
  },
  {
    id: "dnd_unsubscribe",
    expr: "subject_or_body matches DND_PATTERN",
    priority: 80,
    specificity: 6,
    when: (p) => dndMatchDetail(p) !== undefined,
    matchDetail: dndMatchDetail,
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
    id: "pending_hold",
    expr: "subject_or_body matches PENDING_HOLD_PATTERN (pending/authorization hold explanation route)",
    priority: 45,
    specificity: 8,
    when: (p) => pendingHoldMatchDetail(p) !== undefined,
    matchDetail: pendingHoldMatchDetail,
    level: "P2",
    category: "pending_authorization_hold",
    resolutionAction: "explain_pending_hold_and_verify_actual_charge",
  },
  {
    id: "duplicate_claim",
    expr: "claim_id in seen_claim_ids OR identical claimId+content already diagnosed in this server session (TL-017)",
    priority: 40,
    specificity: 1,
    when: (p) =>
      p.sessionDuplicate === true ||
      (Array.isArray(p.metadata?.["seenClaimIds"]) &&
        (p.metadata?.["seenClaimIds"] as unknown[]).includes(p.claimId)),
    matchDetail: (p) => {
      const sources: string[] = [];
      if (
        Array.isArray(p.metadata?.["seenClaimIds"]) &&
        (p.metadata?.["seenClaimIds"] as unknown[]).includes(p.claimId)
      ) {
        sources.push("caller metadata.seenClaimIds");
      }
      if (p.sessionDuplicate === true) {
        sources.push(
          "server session (identical claimId+content already diagnosed in this session)",
        );
      }
      return `duplicate claim detected via ${sources.join(" + ")}`;
    },
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
