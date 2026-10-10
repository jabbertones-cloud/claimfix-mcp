/**
 * Entitlement verification backend for ClaimFix.
 *
 * Interface shape follows the dj-stripe event-ledger pattern: Stripe webhook
 * events are stored in an append-only ledger keyed by their UNIQUE
 * `stripeEventId`. Recording the same event twice is a no-op (idempotent),
 * and customer identity is resolved by matching the claim's email against
 * ledger events — the same way dj-stripe's `stripe_id`-unique tables give
 * natural webhook idempotency.
 *
 * v0 ships an in-memory ledger. A Postgres-backed implementation with a
 * UNIQUE(stripe_event_id) constraint is the production replacement; the
 * interface does not change.
 */

/**
 * TL-013: the documented transaction states an entitlement event may
 * carry — the charge lifecycle (paid/refunded/disputed/failed) plus
 * "active" for customer/subscription lifecycle events (e.g.
 * customer.updated). Enforced at the record_entitlement_event tool
 * boundary (src/schemas.ts) so nonsense states can never reach
 * verifiedProof; the ledger itself stays dumb storage.
 */
export const TRANSACTION_STATES = ["paid", "refunded", "disputed", "failed", "active"] as const;

/**
 * TL-013: Stripe resource families this ledger understands as event
 * types. `type` must be a dotted Stripe-style type whose first segment
 * is one of these ("charge.succeeded", "customer.updated"); anything
 * else ("banana.event") is rejected at the tool boundary.
 */
export const ENTITLEMENT_EVENT_RESOURCES: ReadonlySet<string> = new Set([
  "charge",
  "customer",
  "dispute",
  "refund",
  "payment_intent",
  "payment_method",
  "invoice",
  "subscription",
  "checkout",
  "setup_intent",
]);

export interface EntitlementEvent {
  /** Stripe event id, e.g. "evt_1ABC...". UNIQUE in the ledger. */
  stripeEventId: string;
  type: string; // dotted Stripe-style, resource in ENTITLEMENT_EVENT_RESOURCES
  customerEmail: string;
  chargeId?: string;
  customerId?: string;
  amountCents?: number;
  /** Last known transaction state derived from the event; one of TRANSACTION_STATES. */
  state: string;
  receivedAt: string; // ISO-8601
}

export interface RecordEventResult {
  inserted: boolean;
  /**
   * TL-012: true when stripeEventId was already recorded with a MATERIALLY
   * different payload. The original event is kept (append-only ledger) and
   * the conflict is surfaced to the caller instead of masquerading as a
   * harmless idempotent retry. Absent for a clean insert or an
   * identical-payload retry (the pinned idempotent no-op shape).
   */
  conflict?: boolean;
  /** Which fields differ, and that the original was kept. Present iff conflict. */
  reason?: string;
}

export interface EntitlementLedger {
  /**
   * Append an event. Returns { inserted: true } on first sight,
   * { inserted: false } when stripeEventId was already recorded — with
   * conflict detail when the redelivery's payload materially differs.
   */
  recordEvent(event: EntitlementEvent): RecordEventResult;
  findByEmail(email: string): EntitlementEvent[];
  findByStripeEventId(stripeEventId: string): EntitlementEvent | undefined;
  size(): number;
}

/** Fields that make a redelivery "the same event" vs a conflict (TL-012). */
const COMPARED_FIELDS: Array<keyof EntitlementEvent> = [
  "type",
  "customerEmail",
  "chargeId",
  "customerId",
  "amountCents",
  "state",
  "receivedAt",
];

function differingFields(a: EntitlementEvent, b: EntitlementEvent): string[] {
  return COMPARED_FIELDS.filter((f) => {
    // Customer identity is case-insensitive everywhere in this codebase,
    // so a casing-only redelivery is the same event, not a conflict.
    if (f === "customerEmail") {
      return String(a[f] ?? "").toLowerCase() !== String(b[f] ?? "").toLowerCase();
    }
    return a[f] !== b[f];
  });
}

export class InMemoryEntitlementLedger implements EntitlementLedger {
  private byEventId = new Map<string, EntitlementEvent>();
  private byEmail = new Map<string, EntitlementEvent[]>();

  recordEvent(event: EntitlementEvent): RecordEventResult {
    const existing = this.byEventId.get(event.stripeEventId);
    if (existing) {
      const differing = differingFields(existing, event);
      if (differing.length === 0) {
        // Identical-payload redelivery: the pinned idempotent no-op.
        return { inserted: false };
      }
      // TL-012: same id, materially different payload. Keep the original
      // (append-only), record nothing new, and surface the conflict
      // instead of silently swallowing what may be mutated-redelivery
      // data loss or an id collision.
      return {
        inserted: false,
        conflict: true,
        reason:
          `stripeEventId ${event.stripeEventId} was already recorded with a ` +
          `different payload (differing: ${differing.join(", ")}); the ` +
          `original event was kept and the conflicting payload was not recorded`,
      };
    }
    this.byEventId.set(event.stripeEventId, event);
    const key = event.customerEmail.toLowerCase();
    const list = this.byEmail.get(key) ?? [];
    list.push(event);
    this.byEmail.set(key, list);
    return { inserted: true };
  }

  findByEmail(email: string): EntitlementEvent[] {
    return this.byEmail.get(email.toLowerCase()) ?? [];
  }

  findByStripeEventId(stripeEventId: string): EntitlementEvent | undefined {
    return this.byEventId.get(stripeEventId);
  }

  size(): number {
    return this.byEventId.size;
  }
}
