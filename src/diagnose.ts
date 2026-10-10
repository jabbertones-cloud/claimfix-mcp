/**
 * ClaimFix core contract: diagnose(claimPayload) -> { triageLevel, category, verifiedProof, resolutionAction }.
 *
 * Pipeline order (deliberate):
 *   1. Tier-1 deterministic rules (src/rules.ts) — pure, no network. P1 hits
 *      short-circuit: legal threats, chargeback threats, and DND requests
 *      never wait on entitlement lookups. Rules carry a required priority
 *      (gap 14); the first hit in priority order wins and the winner
 *      rationale is recorded in verifiedProof.notes.
 *   1b. Contradiction surfacing (src/contradictions.ts, gap 29) — competing
 *      assertions are surfaced verbatim into verifiedProof.notes. Notes-only:
 *      never changes triageLevel / category / resolutionAction.
 *   2. Entitlement verification against the ledger (if one is provided) —
 *      matches claim email to recorded Stripe events; proof is the most
 *      recent entitlement-bearing event by receivedAt, never merely the
 *      last one inserted (TL-011, selectProofEvent below).
 *   3. Verdict: a tier-1 hit sets it; a zero-hit claim may still thread
 *      to the session's last fresh decision for the same customer
 *      (conversational threading — context_recall / context_threading,
 *      src/threading.ts); everything else falls through to P3 general
 *      complaint. Only fresh decisions move the session anchor —
 *      follow-ups inherit it, new claims reset it (no bleed).
 *
 * No LLM is called in v0. When one is added, it will only ever refine P2/P3
 * wording — tier-1 P1 classification stays rule-determined.
 */

import { evaluateTier1, type TriageLevel } from "./rules.js";
import { detectContradictions } from "./contradictions.js";
import { detectFollowUpKind } from "./threading.js";
import { negatedBeforePhrase } from "./fuzzy.js";
import type { EntitlementEvent, EntitlementLedger } from "./entitlement.js";
import type { ClaimSessionTracker, ConversationDecision } from "./claim-session.js";

export type { TriageLevel };

export interface ClaimPayload {
  claimId: string;
  customerEmail: string;
  subject: string;
  body: string;
  channel?: "email" | "chat" | "phone";
  receivedAt?: string;
  metadata?: Record<string, unknown>;
  /**
   * @internal TL-017: set by diagnose() itself from the session tracker —
   * true when this identical claimId+content was already diagnosed in
   * the current server session. Not a wire field (the tool schema strips
   * unknown keys); callers signal duplicates via metadata.seenClaimIds.
   */
  sessionDuplicate?: boolean;
}

export interface VerifiedProof {
  entitlementMatched: boolean;
  stripeEventId?: string;
  chargeId?: string;
  customerId?: string;
  transactionState?: string;
  notes: string[];
}

export interface Diagnosis {
  triageLevel: TriageLevel;
  category: string;
  verifiedProof: VerifiedProof;
  resolutionAction: string;
  ruleHits: string[];
}

function emptyProof(note: string): VerifiedProof {
  return { entitlementMatched: false, notes: [note] };
}

/**
 * Wave-1 F7: explicit "contact me" assertions — the opposite pole of a
 * DND request. Deliberately narrow (an explicit ask to be contacted,
 * not mere absence of DND wording) and only consulted when the claim
 * did NOT itself hit dnd_request, whose guarded patterns already own
 * negation ("please do not contact me" must never read as contact_ok).
 *
 * TL-039: these raw regexes had no negation guard — "I do NOT want you
 * to keep emailing me" matched "keep emailing" and recorded contact_ok,
 * fabricating a cross-message DND contradiction on the next claim. Every
 * pattern now carries the same negatedBeforePhrase guard TL-010 gave the
 * tier-1 rules; anchors' own negations (e.g. "don't stop") never
 * self-suppress, and the uncontracted "do not stop" twin is listed so it
 * asserts contact_ok instead of recording nothing.
 */
const CONTACT_OK_PATTERNS: Array<{ re: RegExp; phrase: string; guard?: string }> = [
  { re: /\bplease\s+(do\s+)?contact\s+me\b/i, phrase: "please contact me", guard: "contact" },
  { re: /\bdo\s+contact\s+me\b/i, phrase: "do contact me", guard: "contact" },
  { re: /\bkeep\s+(sending|emailing|contacting)\b/i, phrase: "keep emailing", guard: "keep" },
  { re: /\bcontact\s+me\s+(anytime|whenever|directly)\b/i, phrase: "contact me anytime", guard: "contact" },
  { re: /\byou\s+(can|may)\s+contact\s+me\b/i, phrase: "you can contact me", guard: "contact" },
  { re: /\bdon'?t\s+stop\s+(sending|emailing|contacting)\b/i, phrase: "don't stop emailing" },
  { re: /\bdo\s+not\s+stop\s+(sending|emailing|contacting)\b/i, phrase: "do not stop emailing" },
];

/**
 * TL-011: an event is entitlement-bearing when it carries charge-level
 * proof — a chargeId, or a charge.* event type. Unrelated lifecycle
 * events (customer.updated and friends) are recorded in the ledger but
 * must never displace real charge proof or erase its chargeId from a
 * diagnosis.
 */
function isEntitlementBearing(e: EntitlementEvent): boolean {
  return e.chargeId !== undefined || e.type.startsWith("charge.");
}

/**
 * TL-011: proof comes from the most relevant + most recent event, not
 * the last one inserted. Selection rule: among entitlement-bearing
 * events (falling back to all events when none are), pick the latest
 * by receivedAt; ties and unparseable dates resolve deterministically
 * toward the later-inserted event. Webhooks arrive out of order, so
 * insertion order is not chronology.
 */
function selectProofEvent(events: EntitlementEvent[]): {
  event: EntitlementEvent;
  bearingCount: number;
} {
  const bearing = events.filter(isEntitlementBearing);
  const pool = bearing.length > 0 ? bearing : events;
  let best = pool[0];
  for (let i = 1; i < pool.length; i++) {
    const t = Date.parse(pool[i].receivedAt);
    const bt = Date.parse(best.receivedAt);
    const tv = Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
    const bv = Number.isNaN(bt) ? Number.NEGATIVE_INFINITY : bt;
    if (tv >= bv) best = pool[i]; // >= : later insertion wins ties (deterministic)
  }
  return { event: best, bearingCount: bearing.length };
}

export function diagnose(
  payload: ClaimPayload,
  opts: { ledger?: EntitlementLedger; claimSession?: ClaimSessionTracker } = {},
): Diagnosis {
  if (!payload.claimId || !payload.customerEmail) {
    throw new Error("diagnose: claimId and customerEmail are required");
  }

  // TL-017: consult server-side session memory BEFORE evaluating, then
  // record this claim. First sight in a session is never a duplicate;
  // an identical resubmission is. The tracker signal is unioned with
  // the caller-supplied metadata.seenClaimIds inside duplicate_claim,
  // and the rule detail discloses which source(s) fired.
  const sessionDuplicate = opts.claimSession?.hasSeenDuplicate(payload) ?? false;
  const effectivePayload: ClaimPayload = sessionDuplicate
    ? { ...payload, sessionDuplicate: true }
    : payload;
  opts.claimSession?.recordDiagnosis(payload);

  // 1. Tier-1 deterministic rules first (priority-ordered).
  const { hits, matched, winnerNote } = evaluateTier1(effectivePayload);
  const ruleHits = hits.map((h) => h.ruleId);

  // 1b. Contradiction surfacing: notes-only, never re-triages.
  const contra = detectContradictions(payload, { category: matched?.category });
  for (const id of contra.ruleHits) {
    if (!ruleHits.includes(id)) ruleHits.push(id);
  }

  // 1c. Wave-1 F7: cross-message do-not-contact contradiction. A
  // customer who asserted DND in one claim and "please do contact me"
  // in another (same session, same identity) has contradicted
  // themselves; per the contradictions contract this is SURFACED in
  // notes for a human, never silently resolved by overwriting the
  // earlier instruction. Notes-only: triage is untouched.
  const crossMessageNotes: string[] = [];
  if (opts.claimSession) {
    const text = `${payload.subject ?? ""}\n${payload.body ?? ""}`;
    const contactOk =
      matched?.category !== "dnd_request" &&
      CONTACT_OK_PATTERNS.some(
        ({ re, phrase, guard }) => re.test(text) && !negatedBeforePhrase(text, guard ?? phrase),
      );
    const currentStance =
      matched?.category === "dnd_request" ? "dnd" : contactOk ? "contact_ok" : undefined;
    if (currentStance) {
      const prior = opts.claimSession.getContactStances(payload.customerEmail);
      const opposite = currentStance === "dnd" ? prior.contact_ok : prior.dnd;
      if (opposite.length > 0) {
        if (!ruleHits.includes("cross_message_dnd_contradiction")) {
          ruleHits.push("cross_message_dnd_contradiction");
        }
        crossMessageNotes.push(
          `cross-message do-not-contact contradiction: claim(s) ${opposite.join(", ")} ` +
            (currentStance === "dnd"
              ? "asked to be contacted earlier in this session; this claim requests do-not-contact"
              : "requested do-not-contact earlier in this session; this claim asks to be contacted") +
            " — surfaced for a human, not resolved (neither instruction is auto-applied over the other)",
        );
      }
      opts.claimSession.recordContactStance(payload.customerEmail, currentStance, payload.claimId);
    }
  }

  // 2. Entitlement verification (ledger only; no network in v0).
  let proof: VerifiedProof;
  if (opts.ledger) {
    const events = opts.ledger.findByEmail(payload.customerEmail);
    if (events.length > 0) {
      const { event: latest, bearingCount } = selectProofEvent(events);
      const skipped = bearingCount > 0 ? events.length - bearingCount : 0;
      proof = {
        entitlementMatched: true,
        stripeEventId: latest.stripeEventId,
        chargeId: latest.chargeId,
        customerId: latest.customerId,
        transactionState: latest.state,
        notes: [
          `matched ${events.length} ledger event(s) for ${payload.customerEmail}`,
          `proof: ${latest.stripeEventId} — most recent ${
            bearingCount > 0 ? "entitlement-bearing " : ""
          }event by receivedAt (TL-011 selection rule)${
            skipped > 0 ? `; ignored ${skipped} unrelated event(s)` : ""
          }`,
        ],
      };
    } else {
      proof = emptyProof(`no ledger events for ${payload.customerEmail}`);
    }
  } else {
    proof = emptyProof("no entitlement ledger provided; verification skipped");
  }

  // Audit trail: winner rationale + per-hit match details + contradiction notes.
  if (winnerNote) proof.notes.push(winnerNote);
  for (const h of hits) {
    if (h.detail) proof.notes.push(`${h.ruleId}: ${h.detail}`);
  }
  proof.notes.push(...contra.notes);
  proof.notes.push(...crossMessageNotes);

  // 3. Tier-1 hits set the verdict; otherwise conversational threading
  // (step 3b) may thread a zero-hit follow-up to the session's last
  // decision; everything else falls through to P3 general complaint.
  let verdict: Diagnosis;
  let threadedFrom: ConversationDecision | undefined;
  let threadKind: "recall" | "thread" | undefined;
  if (matched) {
    verdict = {
      triageLevel: matched.level,
      category: matched.category,
      verifiedProof: proof,
      resolutionAction: matched.resolutionAction,
      ruleHits,
    };
  } else {
    // 3b. Conversational threading (dogfood fix #2): consult session
    // memory ONLY when tier-1 produced no hit. A real classification
    // always wins over context, so unrelated new claims can never
    // bleed into an old thread; context only fills the P3 gap.
    if (opts.claimSession) {
      const last = opts.claimSession.getLastDecision(payload.customerEmail);
      if (last) {
        const kind = detectFollowUpKind(
          `${payload.subject ?? ""}\n${payload.body ?? ""}`,
        );
        if (kind) {
          threadedFrom = last;
          threadKind = kind;
        }
      }
    }
    if (threadedFrom && threadKind) {
      const ruleId =
        threadKind === "recall" ? "context_recall" : "context_threading";
      if (!ruleHits.includes(ruleId)) ruleHits.push(ruleId);
      proof.notes.push(
        threadKind === "recall"
          ? `context_recall: the customer asked about the prior decision — claim "${threadedFrom.claimId}" was classified ${threadedFrom.triageLevel}/${threadedFrom.category} with action "${threadedFrom.resolutionAction}"; not re-classified (this message is a recall question, not a new claim)`
          : `context_threading: fragment follow-up threaded to claim "${threadedFrom.claimId}" (${threadedFrom.triageLevel}/${threadedFrom.category}, action "${threadedFrom.resolutionAction}") from earlier in this session; inherited that classification`,
      );
      verdict = {
        triageLevel: threadedFrom.triageLevel,
        category: threadedFrom.category,
        verifiedProof: proof,
        resolutionAction: threadedFrom.resolutionAction,
        ruleHits,
      };
    } else {
      verdict = {
        triageLevel: "P3",
        category: "general_complaint",
        verifiedProof: proof,
        resolutionAction: "queue_support",
        ruleHits,
      };
    }
  }

  // 3c. Pin the session conversation anchor to the last FRESH decision
  // only. A threaded follow-up inherits the anchor — it never becomes
  // it — and a genuinely new classified claim resets it. That is the
  // no-bleed guarantee: follow-ups can't hijack the anchor, and
  // unrelated claims can't inherit stale context.
  if (opts.claimSession && !threadedFrom) {
    opts.claimSession.recordDecision(payload.customerEmail, {
      claimId: payload.claimId,
      triageLevel: verdict.triageLevel,
      category: verdict.category,
      resolutionAction: verdict.resolutionAction,
      ruleHits: [...verdict.ruleHits],
    });
  }

  return verdict;
}
