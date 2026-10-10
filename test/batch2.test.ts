import test from "node:test";
import assert from "node:assert/strict";
import { diagnose, type ClaimPayload } from "../src/diagnose.js";
import { InMemoryClaimSessionTracker, type ClaimSessionTracker } from "../src/claim-session.js";
import { postRetractionText } from "../src/contradictions.js";

const dx = (
  body: string,
  session?: ClaimSessionTracker,
  extra: Partial<ClaimPayload> = {},
) =>
  diagnose(
    {
      claimId: "b2u",
      customerEmail: "u@example.com",
      subject: "",
      body,
      ...extra,
    },
    { claimSession: session ?? new InMemoryClaimSessionTracker() },
  );

// TL-040: duplicate charge billing + threading contract
test("TL-040: 'duplicate charge' bills; negated stays silent", () => {
  const d = dx("I see that duplicate charge on my statement.");
  assert.equal(d.category, "billing_dispute");
  const n = dx("Not a duplicate charge, just checking my statement.");
  assert.ok(!n.ruleHits.includes("billing_dispute"));
});
test("TL-040: billing fragment after P1/legal classifies fresh, never threads", () => {
  const s = new InMemoryClaimSessionTracker();
  dx("I am going to sue you over this charge.", s, { claimId: "a1" });
  const f = dx("that duplicate charge", s, { claimId: "a2" });
  assert.equal(f.category, "billing_dispute");
  assert.ok(!f.ruleHits.includes("context_threading"));
  assert.notEqual(f.resolutionAction, "escalate_legal");
});

// TL-041: Spanish billing slot
test("TL-041: Spanish billing routes billing; negated stays silent", () => {
  const d = dx("Me cobraron dos veces por mi pedido. Quiero un reembolso.");
  assert.equal(d.category, "billing_dispute");
  const n = dx("No me cobraron dos veces, todo está bien.");
  assert.ok(!n.ruleHits.includes("billing_dispute"));
});

// TL-042: retraction
test("TL-042: postRetractionText scopes to after the marker", () => {
  assert.equal(
    postRetractionText("I was charged twice — no wait, it was a pending hold"),
    ", it was a pending hold",
  );
  assert.equal(
    postRetractionText("No wait, I was charged twice"),
    ", I was charged twice",
  );
  assert.equal(postRetractionText("I was charged twice"), "I was charged twice");
});
test("TL-042: retracted billing yields to pending hold with trace", () => {
  const d = dx("I was charged twice — no wait, it was a pending hold for the same amount. Can you explain?");
  assert.equal(d.category, "pending_authorization_hold");
  assert.ok(!d.ruleHits.includes("billing_dispute"));
  assert.ok(d.verifiedProof.notes.some((n) => n.includes("no wait") && n.includes("recorded, not resolved")));
});

// TL-043: fingerprint normalization
test("TL-043: whitespace-only resubmission dedups; different content does not", () => {
  const s = new InMemoryClaimSessionTracker();
  dx("My box never arrived.", s, { claimId: "w1" });
  const r = dx("My box never arrived. ", s, { claimId: "w1" });
  assert.ok(r.ruleHits.includes("duplicate_claim"));
  const s2 = new InMemoryClaimSessionTracker();
  dx("My box never arrived.", s2, { claimId: "w2" });
  const r2 = dx("My box arrived damaged.", s2, { claimId: "w2" });
  assert.ok(!r2.ruleHits.includes("duplicate_claim"));
});
