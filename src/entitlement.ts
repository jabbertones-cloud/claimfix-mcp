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

export interface EntitlementEvent {
  /** Stripe event id, e.g. "evt_1ABC...". UNIQUE in the ledger. */
  stripeEventId: string;
  type: string; // e.g. "charge.succeeded", "charge.refunded", "customer.created"
  customerEmail: string;
  chargeId?: string;
  customerId?: string;
  amountCents?: number;
  /** Last known transaction state derived from the event. */
  state: string; // e.g. "paid" | "refunded" | "disputed" | "failed"
  receivedAt: string; // ISO-8601
}

export interface EntitlementLedger {
  /**
   * Append an event. Returns { inserted: true } on first sight,
   * { inserted: false } when stripeEventId was already recorded (idempotent).
   */
  recordEvent(event: EntitlementEvent): { inserted: boolean };
  findByEmail(email: string): EntitlementEvent[];
  findByStripeEventId(stripeEventId: string): EntitlementEvent | undefined;
  size(): number;
}

export class InMemoryEntitlementLedger implements EntitlementLedger {
  private byEventId = new Map<string, EntitlementEvent>();
  private byEmail = new Map<string, EntitlementEvent[]>();

  recordEvent(event: EntitlementEvent): { inserted: boolean } {
    if (this.byEventId.has(event.stripeEventId)) {
      return { inserted: false };
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
