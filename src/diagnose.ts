/**
 * ClaimFix core contract: diagnose(claimPayload) -> { triageLevel, category, verifiedProof, resolutionAction }.
 *
 * Pipeline order (deliberate):
 *   1. Tier-1 deterministic rules (src/rules.ts) — pure, no network. P1 hits
 *      short-circuit: legal threats, chargeback threats, and DND requests
 *      never wait on entitlement lookups.
 *   1b. Contradiction surfacing (src/contradictions.ts) — competing
 *      assertions are surfaced verbatim into verifiedProof.notes. Notes-only:
 *      never changes triageLevel / category / resolutionAction.
 *   2. Entitlement verification against the ledger (if one is provided) —
 *      matches claim email to recorded Stripe events.
 *   3. Everything else falls through to P3 general complaint.
 *
 * No LLM is called in v0. When one is added, it will only ever refine P2/P3
 * wording — tier-1 P1 classification stays rule-determined.
 */

import { evaluateTier1, type TriageLevel } from "./rules.js";
import { detectContradictions } from "./contradictions.js";
import type { EntitlementLedger } from "./entitlement.js";

export type { TriageLevel };

export interface ClaimPayload {
  claimId: string;
  customerEmail: string;
  subject: string;
  body: string;
  channel?: "email" | "chat" | "phone";
  receivedAt?: string;
  metadata?: Record<string, unknown>;
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

export function diagnose(
  payload: ClaimPayload,
  opts: { ledger?: EntitlementLedger } = {},
): Diagnosis {
  if (!payload.claimId || !payload.customerEmail) {
    throw new Error("diagnose: claimId and customerEmail are required");
  }

  // 1. Tier-1 deterministic rules first.
  const { hits, matched } = evaluateTier1(payload);
  const ruleHits = hits.map((h) => h.ruleId);

  // 1b. Contradiction surfacing: notes-only, never re-triages.
  const contra = detectContradictions(payload, { category: matched?.category });
  for (const id of contra.ruleHits) {
    if (!ruleHits.includes(id)) ruleHits.push(id);
  }

  // 2. Entitlement verification (ledger only; no network in v0).
  let proof: VerifiedProof;
  if (opts.ledger) {
    const events = opts.ledger.findByEmail(payload.customerEmail);
    if (events.length > 0) {
      const latest = events[events.length - 1];
      proof = {
        entitlementMatched: true,
        stripeEventId: latest.stripeEventId,
        chargeId: latest.chargeId,
        customerId: latest.customerId,
        transactionState: latest.state,
        notes: [`matched ${events.length} ledger event(s) for ${payload.customerEmail}`],
      };
    } else {
      proof = emptyProof(`no ledger events for ${payload.customerEmail}`);
    }
  } else {
    proof = emptyProof("no entitlement ledger provided; verification skipped");
  }

  // Audit trail: per-hit match details + contradiction notes.
  for (const h of hits) {
    if (h.detail) proof.notes.push(`${h.ruleId}: ${h.detail}`);
  }
  proof.notes.push(...contra.notes);

  // 3. Tier-1 P1 hits short-circuit; otherwise use the matched rule or P3 default.
  if (matched && matched.level === "P1") {
    return {
      triageLevel: "P1",
      category: matched.category,
      verifiedProof: proof,
      resolutionAction: matched.resolutionAction,
      ruleHits,
    };
  }
  if (matched) {
    return {
      triageLevel: matched.level,
      category: matched.category,
      verifiedProof: proof,
      resolutionAction: matched.resolutionAction,
      ruleHits,
    };
  }
  return {
    triageLevel: "P3",
    category: "general_complaint",
    verifiedProof: proof,
    resolutionAction: "queue_support",
    ruleHits,
  };
}
