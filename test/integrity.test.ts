/**
 * Integrity regression tests for the TestLabs deep-discovery gaps:
 *   TL-010 (CF-1)  — P1 negation guard (legal / chargeback / DND / billing arm)
 *   TL-011 (CF-2)  — proof selection by relevance + receivedAt chronology
 *   TL-012 (CF-3)  — conflicting duplicate stripeEventId surfaces a conflict
 *   TL-013 (CF-4)  — record_entitlement_event validates state/type/amount/date
 *   TL-019 (CF-11) — whitespace-only identifiers rejected (trimmed, then min(1))
 *
 * Every negated repro is paired with the un-negated control: the same
 * sentence without the negation MUST still escalate.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diagnose } from "../src/diagnose.js";
import { InMemoryEntitlementLedger, type EntitlementEvent } from "../src/entitlement.js";
import { InMemoryClaimSessionTracker } from "../src/claim-session.js";
import { claimSchema, eventSchema } from "../src/schemas.js";

function payload(over: Record<string, unknown> = {}) {
  return {
    claimId: "integrity-test",
    customerEmail: "case@example.com",
    subject: "",
    body: "",
    ...over,
  };
}

function evt(over: Partial<EntitlementEvent> = {}): EntitlementEvent {
  return {
    stripeEventId: "evt_int_1",
    type: "charge.succeeded",
    customerEmail: "proof@example.com",
    chargeId: "ch_int_1",
    state: "paid",
    receivedAt: "2026-10-01T10:00:00.000Z",
    ...over,
  };
}

describe("TL-010: P1 negation guard — negated assertions do not escalate", () => {
  it("CF-1/H3: 'Do not remove me... I am not asking to unsubscribe' is NOT a DND request", () => {
    const d = diagnose(
      payload({
        subject: "keep the emails coming",
        body: "Do not remove me from your list, I love the emails. I am not asking to unsubscribe.",
      }),
    );
    assert.ok(!d.ruleHits.includes("dnd_unsubscribe"));
    assert.equal(d.triageLevel, "P3");
    assert.equal(d.category, "general_complaint");
  });

  it("CF-1/H1: 'I am not disputing the charge... will not call my bank' is NOT a chargeback threat", () => {
    const d = diagnose(
      payload({
        body: "I am not disputing the charge and I will not call my bank. Package arrived late.",
      }),
    );
    assert.ok(!d.ruleHits.includes("chargeback_threat"));
    assert.equal(d.triageLevel, "P3");
  });

  it("CF-1/H2: 'I am not going to sue you or get a lawyer involved' is NOT a legal threat", () => {
    const d = diagnose(
      payload({ body: "I am not going to sue you or get a lawyer involved, just want a refund" }),
    );
    assert.ok(!d.ruleHits.includes("legal_threat"));
    assert.notEqual(d.triageLevel, "P1");
  });

  it("CF-1/H4: 'I do not want a refund. Please do not refund me' does NOT route to refund", () => {
    const d = diagnose(
      payload({
        body: "I do not want a refund. Please do not refund me, just resend the item.",
      }),
    );
    assert.ok(!d.ruleHits.includes("billing_dispute"));
    assert.equal(d.triageLevel, "P3");
  });

  it("close variants: don't-remove-me, not-filing-lawsuit", () => {
    const a = diagnose(payload({ body: "Please don't remove me from the mailing list." }));
    assert.ok(!a.ruleHits.includes("dnd_unsubscribe"));
    const b = diagnose(payload({ body: "We're not filing a lawsuit, just unhappy with the wait." }));
    assert.ok(!b.ruleHits.includes("legal_threat"));
    const c = diagnose(payload({ body: "I am not unsubscribing, the emails are useful." }));
    assert.ok(!c.ruleHits.includes("dnd_unsubscribe"));
  });

  it("billing receipt-negation still bills: 'I did not get a refund'", () => {
    const d = diagnose(payload({ body: "I did not get a refund for the returned item." }));
    assert.equal(d.category, "billing_dispute");
    assert.ok(d.ruleHits.includes("billing_dispute"));
  });

  it("negation does not bleed across sentences: 'not happy... My lawyer will call you'", () => {
    const d = diagnose(
      payload({ body: "I am not happy with the wait. My lawyer will call you tomorrow." }),
    );
    assert.equal(d.triageLevel, "P1");
    assert.equal(d.category, "legal_threat");
  });
});

describe("TL-010: true-positive controls — un-negated sentences still escalate", () => {
  it("DND control: 'Remove me from your list, I want to unsubscribe'", () => {
    const d = diagnose(
      payload({ body: "Remove me from your list, I want to unsubscribe." }),
    );
    assert.equal(d.triageLevel, "P1");
    assert.equal(d.category, "dnd_request");
    assert.equal(d.resolutionAction, "suppress_contact");
  });

  it("chargeback control: 'I am disputing the charge and I will call my bank'", () => {
    const d = diagnose(
      payload({ body: "I am disputing the charge and I will call my bank." }),
    );
    assert.equal(d.triageLevel, "P1");
    assert.equal(d.category, "chargeback_risk");
    assert.equal(d.resolutionAction, "hold_fulfillment_review");
  });

  it("legal control: 'I am going to sue you and get my lawyer involved'", () => {
    const d = diagnose(
      payload({ body: "I am going to sue you and get my lawyer involved." }),
    );
    assert.equal(d.triageLevel, "P1");
    assert.equal(d.category, "legal_threat");
    assert.equal(d.resolutionAction, "escalate_legal");
  });

  it("billing control: 'I want a refund. Please refund me, just resend the item'", () => {
    const d = diagnose(
      payload({ body: "I want a refund. Please refund me, just resend the item." }),
    );
    assert.equal(d.triageLevel, "P2");
    assert.equal(d.category, "billing_dispute");
  });

  it("asserted 'Do not contact me again' still fires (its own negation is the request)", () => {
    const d = diagnose(payload({ body: "Do not contact me again." }));
    assert.equal(d.triageLevel, "P1");
    assert.equal(d.category, "dnd_request");
  });
});

describe("TL-011: proof selection — relevance + chronology, not insertion order", () => {
  it("CF-2/C3: out-of-order arrival — newer refund recorded first, older paid second, proof is refunded", () => {
    const ledger = new InMemoryEntitlementLedger();
    ledger.recordEvent(
      evt({ stripeEventId: "evt_C_refund", type: "charge.refunded", state: "refunded", receivedAt: "2026-10-05T10:00:00.000Z" }),
    );
    ledger.recordEvent(
      evt({ stripeEventId: "evt_C_paid", receivedAt: "2026-10-01T10:00:00.000Z" }),
    );
    const d = diagnose(payload({ customerEmail: "proof@example.com" }), { ledger });
    assert.equal(d.verifiedProof.entitlementMatched, true);
    assert.equal(d.verifiedProof.transactionState, "refunded");
    assert.equal(d.verifiedProof.stripeEventId, "evt_C_refund");
  });

  it("in-order arrival still yields the newer event", () => {
    const ledger = new InMemoryEntitlementLedger();
    ledger.recordEvent(evt({ stripeEventId: "evt_paid_first" }));
    ledger.recordEvent(
      evt({ stripeEventId: "evt_refund_second", type: "charge.refunded", state: "refunded", receivedAt: "2026-10-05T10:00:00.000Z" }),
    );
    const d = diagnose(payload({ customerEmail: "proof@example.com" }), { ledger });
    assert.equal(d.verifiedProof.transactionState, "refunded");
    assert.equal(d.verifiedProof.stripeEventId, "evt_refund_second");
  });

  it("CF-2/D3: an unrelated customer.updated must not displace charge proof or erase chargeId", () => {
    const ledger = new InMemoryEntitlementLedger();
    ledger.recordEvent(
      evt({ stripeEventId: "evt_D_paid", customerId: "cus_D", amountCents: 9900 }),
    );
    ledger.recordEvent(
      evt({
        stripeEventId: "evt_D_custupd",
        type: "customer.updated",
        chargeId: undefined,
        state: "active",
        receivedAt: "2026-10-06T10:00:00.000Z",
      }),
    );
    const d = diagnose(payload({ customerEmail: "proof@example.com" }), { ledger });
    assert.equal(d.verifiedProof.stripeEventId, "evt_D_paid");
    assert.equal(d.verifiedProof.transactionState, "paid");
    assert.equal(d.verifiedProof.chargeId, "ch_int_1");
    assert.equal(d.verifiedProof.customerId, "cus_D");
    assert.ok(
      d.verifiedProof.notes.some((n) => n.includes("ignored 1 unrelated event(s)")),
      "selection + skipped unrelated events disclosed in notes",
    );
  });

  it("tie-break: equal receivedAt resolves to the later-inserted event, deterministically", () => {
    const ledger = new InMemoryEntitlementLedger();
    ledger.recordEvent(evt({ stripeEventId: "evt_tie_1" }));
    ledger.recordEvent(
      evt({ stripeEventId: "evt_tie_2", type: "charge.refunded", state: "refunded" }),
    );
    const a = diagnose(payload({ customerEmail: "proof@example.com" }), { ledger });
    const b = diagnose(payload({ customerEmail: "proof@example.com" }), { ledger });
    assert.equal(a.verifiedProof.stripeEventId, "evt_tie_2");
    assert.deepEqual(a, b);
  });

  it("fallback: only unrelated events recorded — still matched, on the latest one", () => {
    const ledger = new InMemoryEntitlementLedger();
    ledger.recordEvent(
      evt({ stripeEventId: "evt_only_cust", type: "customer.updated", chargeId: undefined, state: "active" }),
    );
    const d = diagnose(payload({ customerEmail: "proof@example.com" }), { ledger });
    assert.equal(d.verifiedProof.entitlementMatched, true);
    assert.equal(d.verifiedProof.transactionState, "active");
    assert.equal(d.verifiedProof.stripeEventId, "evt_only_cust");
  });
});

describe("TL-012: conflicting duplicate stripeEventId surfaces a conflict", () => {
  it("identical-payload retry stays the pinned idempotent no-op shape", () => {
    const ledger = new InMemoryEntitlementLedger();
    const e = evt();
    assert.deepEqual(ledger.recordEvent(e), { inserted: true });
    const again = ledger.recordEvent({ ...e });
    assert.deepEqual(again, { inserted: false });
    assert.ok(!("conflict" in again));
    assert.equal(ledger.size(), 1);
  });

  it("email-casing-only redelivery is the same event, not a conflict", () => {
    const ledger = new InMemoryEntitlementLedger();
    ledger.recordEvent(evt());
    const again = ledger.recordEvent(evt({ customerEmail: "PROOF@Example.COM" }));
    assert.deepEqual(again, { inserted: false });
    assert.equal(ledger.findByEmail("proof@example.com").length, 1);
  });

  it("CF-3/B2: same id, materially different payload -> conflict, original kept, nothing swallowed", () => {
    const ledger = new InMemoryEntitlementLedger();
    ledger.recordEvent(evt({ stripeEventId: "evt_B_conflict" }));
    const res = ledger.recordEvent(
      evt({
        stripeEventId: "evt_B_conflict",
        type: "charge.refunded",
        customerEmail: "second@example.com",
        state: "refunded",
        receivedAt: "2026-10-03T10:00:00.000Z",
      }),
    );
    assert.equal(res.inserted, false);
    assert.equal(res.conflict, true);
    assert.ok(res.reason?.includes("differing:"), "reason names the differing fields");
    assert.ok(res.reason?.includes("state") && res.reason?.includes("customerEmail"));
    assert.equal(ledger.size(), 1);
    // the original event is the only one visible anywhere
    const kept = ledger.findByStripeEventId("evt_B_conflict");
    assert.equal(kept?.state, "paid");
    assert.equal(kept?.customerEmail, "proof@example.com");
    assert.equal(ledger.findByEmail("second@example.com").length, 0);
  });

  it("after a conflict, diagnose for the first email still sees the original proof", () => {
    const ledger = new InMemoryEntitlementLedger();
    ledger.recordEvent(evt({ stripeEventId: "evt_B_conflict" }));
    ledger.recordEvent(
      evt({ stripeEventId: "evt_B_conflict", type: "charge.refunded", state: "refunded", receivedAt: "2026-10-03T10:00:00.000Z" }),
    );
    const d = diagnose(payload({ customerEmail: "proof@example.com" }), { ledger });
    assert.equal(d.verifiedProof.transactionState, "paid");
    assert.equal(d.verifiedProof.chargeId, "ch_int_1");
  });
});

describe("TL-013/TL-019: record_entitlement_event input validation", () => {
  const validEvent = {
    stripeEventId: "evt_schema_1",
    type: "charge.succeeded",
    customerEmail: "valid@example.com",
    chargeId: "ch_schema_1",
    amountCents: 4900,
    state: "paid",
    receivedAt: "2026-10-01T10:00:00.000Z",
  };

  it("accepts a well-formed event, including customer.updated/active and date-only ISO", () => {
    assert.equal(eventSchema.safeParse(validEvent).success, true);
    assert.equal(
      eventSchema.safeParse({ ...validEvent, type: "customer.updated", state: "active" }).success,
      true,
    );
    assert.equal(
      eventSchema.safeParse({ ...validEvent, receivedAt: "2026-10-05" }).success,
      true,
    );
    assert.equal(eventSchema.safeParse({ ...validEvent, amountCents: 0 }).success, true);
  });

  it("CF-4/E1: nonsense state is rejected", () => {
    assert.equal(eventSchema.safeParse({ ...validEvent, state: "banana_pants" }).success, false);
  });

  it("CF-4/E3: implausible event type is rejected (shape and resource family)", () => {
    assert.equal(eventSchema.safeParse({ ...validEvent, type: "banana.event" }).success, false);
    assert.equal(eventSchema.safeParse({ ...validEvent, type: "banana" }).success, false);
    assert.equal(eventSchema.safeParse({ ...validEvent, type: "Charge.Succeeded" }).success, false);
  });

  it("CF-4/E3: negative amount and non-ISO receivedAt are rejected", () => {
    assert.equal(eventSchema.safeParse({ ...validEvent, amountCents: -4900 }).success, false);
    assert.equal(eventSchema.safeParse({ ...validEvent, amountCents: 49.5 }).success, false);
    assert.equal(
      eventSchema.safeParse({ ...validEvent, receivedAt: "next Tuesday-ish" }).success,
      false,
    );
    assert.equal(
      eventSchema.safeParse({ ...validEvent, receivedAt: "10/10/2026" }).success,
      false,
    );
  });

  it("CF-11/TL-019: whitespace-only identifiers are rejected after trim", () => {
    assert.equal(
      eventSchema.safeParse({ ...validEvent, stripeEventId: "   " }).success,
      false,
    );
    const badClaim = claimSchema.safeParse({
      claimId: "   ",
      customerEmail: "a@b.co",
      subject: "s",
      body: "b",
    });
    assert.equal(badClaim.success, false);
  });

  it("identifiers are trimmed (not stored with padding), consistent with email hygiene", () => {
    const parsed = eventSchema.parse({ ...validEvent, stripeEventId: "  evt_schema_1  " });
    assert.equal(parsed.stripeEventId, "evt_schema_1");
  });

  it("CF-4/E3 verbatim: the whole garbage payload has no path into the ledger", () => {
    const garbage = {
      stripeEventId: "evt_E_garbage",
      type: "banana.event",
      customerEmail: "garbage@example.com",
      amountCents: -4900,
      state: "paid",
      receivedAt: "next Tuesday-ish",
    };
    assert.equal(eventSchema.safeParse(garbage).success, false);
  });
});

describe("TL-039: contact_ok stance has a negation guard — negated contact asks are not recorded as contact_ok", () => {
  it("'I do NOT want you to keep emailing me' is a DND request (P1/dnd_request), not a general complaint", () => {
    const d = diagnose(
      payload({ subject: "emails", body: "I do NOT want you to keep emailing me. Stop it." }),
    );
    assert.equal(d.triageLevel, "P1");
    assert.equal(d.category, "dnd_request");
    assert.equal(d.resolutionAction, "suppress_contact");
  });

  it("contracted twin: \"I don't want you to keep emailing me\" is also a DND request", () => {
    const d = diagnose(payload({ body: "I don't want you to keep emailing me." }));
    assert.equal(d.triageLevel, "P1");
    assert.equal(d.category, "dnd_request");
  });

  it("no false cross-message DND contradiction: negated 'keep emailing' followed by a real DND surfaces no contradiction", () => {
    const claimSession = new InMemoryClaimSessionTracker();
    const first = diagnose(
      payload({
        claimId: "tl39-a",
        customerEmail: "stance@example.com",
        body: "I do NOT want you to keep emailing me. Stop it.",
      }),
      { claimSession },
    );
    assert.equal(first.category, "dnd_request");
    const second = diagnose(
      payload({
        claimId: "tl39-b",
        customerEmail: "stance@example.com",
        body: "Do not email me anymore.",
      }),
      { claimSession },
    );
    assert.equal(second.category, "dnd_request");
    assert.ok(!second.ruleHits.includes("cross_message_dnd_contradiction"));
  });

  it("directly negated contact_ok phrase ('please don't keep emailing me') records no stance", () => {
    const claimSession = new InMemoryClaimSessionTracker();
    const first = diagnose(
      payload({
        claimId: "tl39-c",
        customerEmail: "stance2@example.com",
        body: "Please don't keep emailing me, it's too much.",
      }),
      { claimSession },
    );
    assert.notEqual(first.category, "dnd_request");
    // A later real DND must not claim this customer "asked to be contacted earlier".
    const second = diagnose(
      payload({
        claimId: "tl39-d",
        customerEmail: "stance2@example.com",
        body: "Do not email me anymore.",
      }),
      { claimSession },
    );
    assert.equal(second.category, "dnd_request");
    assert.ok(!second.ruleHits.includes("cross_message_dnd_contradiction"));
  });

  it("flip side: 'please do not stop contacting me' (uncontracted) still asserts contact_ok — a later DND surfaces the genuine contradiction", () => {
    const claimSession = new InMemoryClaimSessionTracker();
    diagnose(
      payload({
        claimId: "tl39-e",
        customerEmail: "stance3@example.com",
        body: "Please do not stop contacting me, I need the updates.",
      }),
      { claimSession },
    );
    const second = diagnose(
      payload({
        claimId: "tl39-f",
        customerEmail: "stance3@example.com",
        body: "Do not email me anymore.",
      }),
      { claimSession },
    );
    assert.equal(second.category, "dnd_request");
    assert.ok(second.ruleHits.includes("cross_message_dnd_contradiction"));
  });

  it("control: un-negated 'you can contact me' then a DND still surfaces the contradiction", () => {
    const claimSession = new InMemoryClaimSessionTracker();
    diagnose(
      payload({
        claimId: "tl39-g",
        customerEmail: "stance4@example.com",
        body: "You can contact me anytime about my order.",
      }),
      { claimSession },
    );
    const second = diagnose(
      payload({
        claimId: "tl39-h",
        customerEmail: "stance4@example.com",
        body: "Stop emailing me.",
      }),
      { claimSession },
    );
    assert.equal(second.category, "dnd_request");
    assert.ok(second.ruleHits.includes("cross_message_dnd_contradiction"));
  });
});
