/**
 * TL-017: server-side duplicate-claim memory.
 *
 * duplicate_claim used to fire only when the CALLER pre-computed
 * metadata.seenClaimIds — a real user resubmitting the same claim to the
 * same server session got the identical verdict with no duplicate
 * signal. This tracker remembers, per server session, the
 * (claimId, content) pairs already diagnosed; diagnose() consults it
 * before tier-1 evaluation and records the claim afterwards.
 *
 * Scope decisions:
 * - "Identical" means same claimId AND same content (customerEmail,
 *   subject, body). Same claimId with different content is a new claim
 *   variant, not a server-side duplicate — the caller-metadata path
 *   (which keys on claimId alone) still covers that case, and the two
 *   sources are unioned and disclosed separately in the rule detail.
 * - Email identity is case-insensitive, matching the ledger.
 * - In-memory only, like the v0 entitlement ledger; a durable
 *   implementation belongs behind this same interface.
 */

import type { ClaimPayload, Diagnosis } from "./diagnose.js";

/** Wave-1 F7: a customer's contact stance as asserted in a claim. */
export type ContactStance = "dnd" | "contact_ok";

/**
 * Conversational threading: a deterministic snapshot of the last FRESH
 * (non-follow-up) decision for a customer in this session. diagnose()
 * pins this anchor after every fresh classification and threads
 * zero-hit follow-ups ("it was on the 15th", "what did we decide")
 * back to it — same customer only (case-insensitive email), never
 * across customers, and never moving the anchor onto a follow-up.
 */
export type ConversationDecision = Pick<
  Diagnosis,
  "triageLevel" | "category" | "resolutionAction" | "ruleHits"
> & { claimId: string };

export interface ClaimSessionTracker {
  /** True when this exact claimId+content was already diagnosed in this session. */
  hasSeenDuplicate(payload: ClaimPayload): boolean;
  /** Record a diagnosed claim for future duplicate checks. */
  recordDiagnosis(payload: ClaimPayload): void;
  /** Number of distinct (claimId, content) pairs remembered. */
  size(): number;
  /**
   * Wave-1 F7: claimIds that asserted each contact stance for this
   * customer (case-insensitive email) earlier in the session. Used to
   * SURFACE cross-message do-not-contact contradictions — never to
   * resolve them (diagnose() notes-only, same rule as contradictions).
   */
  getContactStances(customerEmail: string): Record<ContactStance, string[]>;
  /** Record the stance a diagnosed claim asserted (no-op for none). */
  recordContactStance(customerEmail: string, stance: ContactStance, claimId: string): void;
  /**
   * Conversational threading: the last fresh (non-follow-up) decision
   * for this customer (case-insensitive email) in this session, if any.
   * diagnose() consults this when tier-1 produces no hit, so fragment
   * follow-ups and "what did we decide" recall questions resolve
   * against the immediately preceding decision instead of P3.
   */
  getLastDecision(customerEmail: string): ConversationDecision | undefined;
  /**
   * Pin the conversation anchor to a fresh decision. diagnose() calls
   * this ONLY for non-threaded diagnoses — a threaded follow-up
   * inherits the anchor, it never becomes it, and a genuinely new
   * classified claim resets it. That is the no-bleed guarantee.
   */
  recordDecision(customerEmail: string, decision: ConversationDecision): void;
}

/**
 * TL-043: normalization is comparison-only. Trailing whitespace (or
 * doubled internal spaces) must not defeat dedup — "resubmit" with one
 * extra space is the same claim. The payload itself stays verbatim;
 * only the fingerprint is normalized.
 */
function normalizeForFingerprint(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function contentFingerprint(payload: ClaimPayload): string {
  return JSON.stringify({
    customerEmail: payload.customerEmail.trim().toLowerCase(),
    subject: normalizeForFingerprint(payload.subject ?? ""),
    body: normalizeForFingerprint(payload.body ?? ""),
  });
}

export class InMemoryClaimSessionTracker implements ClaimSessionTracker {
  private byClaimId = new Map<string, Set<string>>();
  private stancesByEmail = new Map<string, Record<ContactStance, string[]>>();
  private lastDecisionByEmail = new Map<string, ConversationDecision>();

  hasSeenDuplicate(payload: ClaimPayload): boolean {
    const seen = this.byClaimId.get(payload.claimId.trim());
    return seen !== undefined && seen.has(contentFingerprint(payload));
  }

  recordDiagnosis(payload: ClaimPayload): void {
    const key = payload.claimId.trim();
    const seen = this.byClaimId.get(key) ?? new Set<string>();
    seen.add(contentFingerprint(payload));
    this.byClaimId.set(key, seen);
  }

  size(): number {
    let n = 0;
    for (const seen of this.byClaimId.values()) n += seen.size;
    return n;
  }

  getContactStances(customerEmail: string): Record<ContactStance, string[]> {
    const found = this.stancesByEmail.get(customerEmail.trim().toLowerCase());
    return {
      dnd: [...(found?.dnd ?? [])],
      contact_ok: [...(found?.contact_ok ?? [])],
    };
  }

  recordContactStance(customerEmail: string, stance: ContactStance, claimId: string): void {
    const key = customerEmail.trim().toLowerCase();
    const entry = this.stancesByEmail.get(key) ?? { dnd: [], contact_ok: [] };
    if (!entry[stance].includes(claimId)) entry[stance].push(claimId);
    this.stancesByEmail.set(key, entry);
  }

  getLastDecision(customerEmail: string): ConversationDecision | undefined {
    return this.lastDecisionByEmail.get(customerEmail.trim().toLowerCase());
  }

  recordDecision(customerEmail: string, decision: ConversationDecision): void {
    this.lastDecisionByEmail.set(customerEmail.trim().toLowerCase(), {
      ...decision,
      ruleHits: [...decision.ruleHits],
    });
  }
}
