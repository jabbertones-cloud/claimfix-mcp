import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diagnose } from "../src/diagnose.js";
import { InMemoryEntitlementLedger } from "../src/entitlement.js";
import { evaluateTier1 } from "../src/rules.js";

describe("diagnose contract", () => {
  it("P1: legal threat short-circuits to escalate_legal", () => {
    const d = diagnose({
      claimId: "c-001",
      customerEmail: "angry@example.com",
      subject: "You will hear from my attorney",
      body: "I am filing a lawsuit over this charge. My lawyer will contact you.",
    });
    assert.equal(d.triageLevel, "P1");
    assert.equal(d.category, "legal_threat");
    assert.equal(d.resolutionAction, "escalate_legal");
    assert.ok(d.ruleHits.includes("legal_threat"));
    // contract shape
    assert.ok(typeof d.verifiedProof === "object");
    assert.equal(typeof d.verifiedProof.entitlementMatched, "boolean");
  });

  it("P1: DND/unsubscribe request", () => {
    const d = diagnose({
      claimId: "c-002",
      customerEmail: "tired@example.com",
      subject: "Please unsubscribe me",
      body: "Do not contact me again. Remove me from your list.",
    });
    assert.equal(d.triageLevel, "P1");
    assert.equal(d.category, "dnd_request");
    assert.equal(d.resolutionAction, "suppress_contact");
  });

  it("P1: chargeback threat", () => {
    const d = diagnose({
      claimId: "c-003",
      customerEmail: "dispute@example.com",
      subject: "Re: my order",
      body: "If you don't refund me I will call my bank and dispute the charge as fraud.",
    });
    assert.equal(d.triageLevel, "P1");
    assert.equal(d.category, "chargeback_risk");
    assert.equal(d.resolutionAction, "hold_fulfillment_review");
  });

  it("P2: billing mismatch with matching entitlement", () => {
    const ledger = new InMemoryEntitlementLedger();
    ledger.recordEvent({
      stripeEventId: "evt_test_1",
      type: "charge.succeeded",
      customerEmail: "buyer@example.com",
      chargeId: "ch_test_1",
      customerId: "cus_test_1",
      amountCents: 4999,
      state: "paid",
      receivedAt: "2026-10-01T12:00:00Z",
    });
    const d = diagnose(
      {
        claimId: "c-004",
        customerEmail: "buyer@example.com",
        subject: "Charged twice",
        body: "I was charged twice for the same order, please refund one.",
      },
      { ledger },
    );
    assert.equal(d.triageLevel, "P2");
    assert.equal(d.category, "billing_dispute");
    assert.equal(d.verifiedProof.entitlementMatched, true);
    assert.equal(d.verifiedProof.chargeId, "ch_test_1");
    assert.equal(d.verifiedProof.transactionState, "paid");
    assert.equal(d.resolutionAction, "verify_entitlement_then_refund_or_explain");
  });

  it("P2: duplicate claim detection via seenClaimIds", () => {
    const d = diagnose({
      claimId: "c-005",
      customerEmail: "repeat@example.com",
      subject: "Following up",
      body: "Just checking on my earlier message.",
      metadata: { seenClaimIds: ["c-004", "c-005"] },
    });
    assert.equal(d.triageLevel, "P2");
    assert.equal(d.category, "duplicate");
    assert.equal(d.resolutionAction, "link_to_original");
  });

  it("P3: general complaint falls through", () => {
    const d = diagnose({
      claimId: "c-006",
      customerEmail: "meh@example.com",
      subject: "Packaging",
      body: "The box was a bit dented but the product is fine.",
    });
    assert.equal(d.triageLevel, "P3");
    assert.equal(d.category, "general_complaint");
    assert.equal(d.resolutionAction, "queue_support");
    assert.deepEqual(d.ruleHits, []);
  });

  it("tier-1 rules are deterministic: same input, same output, no network", () => {
    const payload = {
      claimId: "c-007",
      customerEmail: "x@example.com",
      subject: "lawsuit",
      body: "see you in small claims court",
    };
    const a = evaluateTier1(payload);
    const b = evaluateTier1(payload);
    assert.deepEqual(a, b);
    assert.equal(a.matched?.level, "P1");
  });

  it("requires claimId and customerEmail", () => {
    assert.throws(
      () => diagnose({ claimId: "", customerEmail: "", subject: "s", body: "b" }),
      /claimId and customerEmail are required/,
    );
  });
});

describe("entitlement ledger", () => {
  it("recordEvent is idempotent on stripeEventId", () => {
    const ledger = new InMemoryEntitlementLedger();
    const evt = {
      stripeEventId: "evt_dup",
      type: "charge.succeeded",
      customerEmail: "dup@example.com",
      state: "paid",
      receivedAt: "2026-10-01T12:00:00Z",
    };
    assert.deepEqual(ledger.recordEvent(evt), { inserted: true });
    assert.deepEqual(ledger.recordEvent(evt), { inserted: false });
    assert.equal(ledger.size(), 1);
    assert.equal(ledger.findByEmail("dup@example.com").length, 1);
  });

  it("email lookup is case-insensitive", () => {
    const ledger = new InMemoryEntitlementLedger();
    ledger.recordEvent({
      stripeEventId: "evt_case",
      type: "charge.succeeded",
      customerEmail: "Mixed@Example.com",
      state: "paid",
      receivedAt: "2026-10-01T12:00:00Z",
    });
    assert.equal(ledger.findByEmail("mixed@example.com").length, 1);
  });
});
