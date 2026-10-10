/**
 * Rules-depth regression tests for the TestLabs deep-discovery gaps:
 *   TL-014 (CF-5/CF-6) — amount-mismatch facet + billing signal;
 *                        same-sentence contradictions surface
 *   TL-015 (CF-7)      — Spanish P1 phrase sets (chargeback / DND / legal)
 *   TL-016 (CF-8)      — bounded character-typo tolerance in billing
 *   TL-017 (CF-9)      — server-side duplicate-claim session memory
 *   TL-018 (CF-10)     — pending-hold / authorization route
 *
 * Every true positive is paired with a true-negative control: the same
 * shape without the trigger MUST NOT fire.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diagnose } from "../src/diagnose.js";
import { detectAmountMismatch } from "../src/contradictions.js";
import { InMemoryClaimSessionTracker } from "../src/claim-session.js";

function payload(over: Record<string, unknown> = {}) {
  return {
    claimId: "rules-depth-test",
    customerEmail: "depth@example.com",
    subject: "",
    body: "",
    ...over,
  };
}

describe("TL-014: amount mismatch surfaces", () => {
  it("CF-5: 'receipt says $49 but card charged $94' routes billing and surfaces the facet", () => {
    const d = diagnose(
      payload({ body: "My receipt says $49 but my card was charged $94." }),
    );
    assert.equal(d.triageLevel, "P2");
    assert.equal(d.category, "billing_dispute");
    assert.ok(d.ruleHits.includes("billing_dispute"));
    assert.ok(d.ruleHits.includes("contradiction_amount_stated_vs_charged"));
    const note = d.verifiedProof.notes.find((n) => n.startsWith("contradiction[amount]"));
    assert.ok(note, "amount contradiction note present");
    assert.ok(note.includes("$49") && note.includes("$94"), "both amounts verbatim in note");
    assert.ok(
      d.verifiedProof.notes.some((n) => n.includes("amount mismatch: stated $49 vs charged $94")),
      "billing hit details the mismatch",
    );
  });

  it("CF-5/F2 triple collision: legal wins triage AND the amount mismatch is still surfaced", () => {
    const d = diagnose(
      payload({
        subject: "fix this now",
        body: "Do not email me again. I will contact my attorney if this is not fixed. My receipt says $49 but my card was charged $94.",
      }),
    );
    assert.equal(d.triageLevel, "P1");
    assert.equal(d.category, "legal_threat");
    assert.ok(d.ruleHits.includes("dnd_unsubscribe"));
    assert.ok(d.ruleHits.includes("billing_dispute"), "billing fires under the P1 winner");
    assert.ok(d.ruleHits.includes("contradiction_amount_stated_vs_charged"));
    assert.ok(
      d.verifiedProof.notes.some((n) => n.startsWith("contradiction[amount]")),
      "amount facet visible even though legal won",
    );
  });

  it("amount roles work in either order and with cents", () => {
    const m = detectAmountMismatch(
      "My card was charged $94.50 for this, though the receipt says $49.00.",
    );
    assert.ok(m);
    assert.equal(m.stated.cents, 4900);
    assert.equal(m.charged.cents, 9450);
  });

  it("true negative: stated and charged amounts agree — no facet, no billing", () => {
    const d = diagnose(
      payload({ body: "My receipt says $49 and my card was charged $49. Just confirming." }),
    );
    assert.ok(!d.ruleHits.includes("contradiction_amount_stated_vs_charged"));
    assert.ok(!d.ruleHits.includes("billing_dispute"));
    assert.equal(d.triageLevel, "P3");
  });

  it("true negative: a lone price mention is not a mismatch", () => {
    const d = diagnose(payload({ body: "The receipt says $49. Where is my package?" }));
    assert.ok(!d.ruleHits.includes("contradiction_amount_stated_vs_charged"));
  });
});

describe("TL-014: same-sentence contradictions surface", () => {
  it("CF-6/H6: 'charged twice and charged only once' in ONE sentence surfaces", () => {
    const d = diagnose(
      payload({ body: "I was charged twice and charged only once, both in this one sentence." }),
    );
    assert.equal(d.category, "billing_dispute");
    assert.ok(d.ruleHits.includes("contradiction_charge_count_twice_vs_once"));
    assert.ok(
      d.verifiedProof.notes.some((n) => n.startsWith("contradiction[charge_count]")),
      "same-sentence contradiction note present",
    );
  });

  it("control: the two-sentence form still surfaces (H7)", () => {
    const d = diagnose(
      payload({
        body: "You charged me twice for this. Looking at my statement, I was charged only once.",
      }),
    );
    assert.ok(d.ruleHits.includes("contradiction_charge_count_twice_vs_once"));
  });

  it("true negative: a single consistent charge-count assertion does not surface", () => {
    const d = diagnose(payload({ body: "I was charged twice and I am very annoyed." }));
    assert.ok(
      d.ruleHits.every((id) => !id.startsWith("contradiction_")),
      "no contradiction on consistent text",
    );
  });
});

describe("TL-015: Spanish P1 phrase sets", () => {
  it("CF-7/H8: Spanish chargeback threat reaches P1 chargeback_risk", () => {
    const d = diagnose(
      payload({ body: "Voy a disputar el cargo con mi banco si no resuelven esto." }),
    );
    assert.equal(d.triageLevel, "P1");
    assert.equal(d.category, "chargeback_risk");
    assert.equal(d.resolutionAction, "hold_fulfillment_review");
    assert.ok(
      d.verifiedProof.notes.some((n) => n.includes("chargeback_threat:") && n.includes("(es)")),
      "Spanish source disclosed in audit detail",
    );
  });

  it("CF-7/H9: Spanish DND reaches P1 dnd_request", () => {
    const d = diagnose(
      payload({ body: "No me contacten más, cancelen mi suscripción." }),
    );
    assert.equal(d.triageLevel, "P1");
    assert.equal(d.category, "dnd_request");
    assert.equal(d.resolutionAction, "suppress_contact");
  });

  it("Spanish legal threat reaches P1 legal_threat", () => {
    const d = diagnose(
      payload({ body: "Hablaré con mi abogado y presentaré una demanda." }),
    );
    assert.equal(d.triageLevel, "P1");
    assert.equal(d.category, "legal_threat");
    assert.equal(d.resolutionAction, "escalate_legal");
  });

  it("negated Spanish chargeback does NOT escalate", () => {
    const d = diagnose(
      payload({ body: "No voy a disputar el cargo con mi banco, solo quiero información." }),
    );
    assert.ok(!d.ruleHits.includes("chargeback_threat"));
    assert.notEqual(d.triageLevel, "P1");
  });

  it("negated Spanish legal does NOT escalate", () => {
    const d = diagnose(
      payload({ body: "No voy a demandarlos ni hablar con mi abogado, solo estoy frustrado." }),
    );
    assert.ok(!d.ruleHits.includes("legal_threat"));
    assert.notEqual(d.triageLevel, "P1");
  });

  it("'no cancelen mi suscripción' (do NOT cancel) does NOT fire DND", () => {
    const d = diagnose(
      payload({ body: "Por favor no cancelen mi suscripción, me encanta el servicio." }),
    );
    assert.ok(!d.ruleHits.includes("dnd_unsubscribe"));
    assert.notEqual(d.category, "dnd_request");
    // The subject naming the subscription must not defeat the guard:
    // tokenize() splits the accented word, and a guard anchored on that
    // fragment would pin to the subject instead of the negated verb.
    const withSubject = diagnose(
      payload({
        subject: "suscripción",
        body: "Por favor no cancelen mi suscripción, me encanta el servicio.",
      }),
    );
    assert.ok(!withSubject.ruleHits.includes("dnd_unsubscribe"));
  });

  it("true negative: ordinary Spanish support text fires nothing", () => {
    const d = diagnose(
      payload({ body: "Quiero información sobre mi pedido y el envío, gracias." }),
    );
    assert.equal(d.triageLevel, "P3");
    assert.deepEqual(d.ruleHits, []);
  });
});

describe("TL-016: one-typo tolerance in billing matching", () => {
  it("CF-8/H11: 'charged twise' (one typo) matches billing", () => {
    const d = diagnose(payload({ body: "you charged twise for my order" }));
    assert.equal(d.triageLevel, "P2");
    assert.equal(d.category, "billing_dispute");
    assert.ok(
      d.verifiedProof.notes.some((n) => n.includes("TL-016 character-typo tolerant")),
      "typo tolerance disclosed in audit detail",
    );
  });

  it("CF-8/H10: 'chrged twise' (two typo'd tokens) matches billing", () => {
    const d = diagnose(payload({ body: "you chrged twise for my order plese fix" }));
    assert.equal(d.category, "billing_dispute");
    assert.ok(d.ruleHits.includes("billing_dispute"));
  });

  it("negated typo billing does NOT fire: 'not chrged twise'", () => {
    const d = diagnose(
      payload({ body: "I was not chrged twise; the statement date is simply wrong." }),
    );
    assert.ok(!d.ruleHits.includes("billing_dispute"));
  });

  it("true negative: unrelated complaint with no billing tokens fires nothing", () => {
    const d = diagnose(
      payload({ body: "The package arrived late and the box was dented, very disappointing." }),
    );
    assert.equal(d.triageLevel, "P3");
    assert.deepEqual(d.ruleHits, []);
  });

  it("true negative: confusable real words are not typos ('changed twice' plan change)", () => {
    const d = diagnose(
      payload({ body: "My delivery window was changed twice because of the weather." }),
    );
    assert.ok(!d.ruleHits.includes("billing_dispute"));
  });

  it("true negative: correctly-spelled 'authorized charge' is not 'unauthorized charge'", () => {
    const d = diagnose(
      payload({ body: "This was an authorized charge and everything is correct." }),
    );
    assert.ok(!d.ruleHits.includes("billing_dispute"));
  });
});

describe("TL-017: server-side duplicate-claim session memory", () => {
  const claim = {
    claimId: "dup-session-1",
    customerEmail: "repeat@example.com",
    subject: "charged twice",
    body: "You charged me twice for my order.",
  };

  it("CF-9/W2: identical resubmission in one session produces a duplicate signal", () => {
    const claimSession = new InMemoryClaimSessionTracker();
    const first = diagnose(claim, { claimSession });
    assert.ok(!first.ruleHits.includes("duplicate_claim"), "first sight is not a duplicate");
    const second = diagnose(claim, { claimSession });
    assert.ok(second.ruleHits.includes("duplicate_claim"));
    assert.ok(
      second.verifiedProof.notes.some((n) => n.includes("server session")),
      "server-session source disclosed in notes",
    );
  });

  it("same claimId with DIFFERENT content is not a server-side duplicate", () => {
    const claimSession = new InMemoryClaimSessionTracker();
    diagnose(claim, { claimSession });
    const variant = diagnose(
      { ...claim, body: "Actually the package never arrived." },
      { claimSession },
    );
    assert.ok(!variant.ruleHits.includes("duplicate_claim"));
  });

  it("a fresh session does not inherit another session's memory", () => {
    const a = new InMemoryClaimSessionTracker();
    diagnose(claim, { claimSession: a });
    const fresh = diagnose(claim, { claimSession: new InMemoryClaimSessionTracker() });
    assert.ok(!fresh.ruleHits.includes("duplicate_claim"));
  });

  it("caller metadata path still works on its own and names its source", () => {
    const d = diagnose({
      ...claim,
      claimId: "dup-caller-1",
      subject: "Following up",
      body: "Just checking on my earlier message.",
      metadata: { seenClaimIds: ["dup-caller-1"] },
    });
    assert.equal(d.category, "duplicate");
    assert.ok(
      d.verifiedProof.notes.some(
        (n) => n.includes("caller metadata.seenClaimIds") && !n.includes("server session"),
      ),
    );
  });

  it("union: caller metadata + server session are both disclosed", () => {
    const claimSession = new InMemoryClaimSessionTracker();
    const withMeta = { ...claim, claimId: "dup-union-1", metadata: { seenClaimIds: ["dup-union-1"] } };
    diagnose(withMeta, { claimSession });
    const second = diagnose(withMeta, { claimSession });
    assert.ok(second.ruleHits.includes("duplicate_claim"));
    assert.ok(
      second.verifiedProof.notes.some(
        (n) => n.includes("caller metadata.seenClaimIds") && n.includes("server session"),
      ),
      "both sources named in the rule detail",
    );
  });

  it("duplicate signal does not steal triage from a stronger rule (billing still wins)", () => {
    const claimSession = new InMemoryClaimSessionTracker();
    diagnose(claim, { claimSession });
    const second = diagnose(claim, { claimSession });
    assert.equal(second.category, "billing_dispute");
    assert.equal(second.ruleHits[0], "billing_dispute");
    assert.ok(second.ruleHits.includes("duplicate_claim"));
  });
});

describe("TL-018: pending-hold route", () => {
  it("CF-10/F1: negated duplicate + pending hold routes to the hold explanation, NOT billing", () => {
    const d = diagnose(
      payload({
        subject: "pending hold question",
        body: "I wasn't charged twice - my bank shows a pending hold that looks like a second charge, can you check before I dispute it?",
      }),
    );
    assert.equal(d.triageLevel, "P2");
    assert.equal(d.category, "pending_authorization_hold");
    assert.equal(d.resolutionAction, "explain_pending_hold_and_verify_actual_charge");
    assert.ok(d.ruleHits.includes("pending_hold"));
    assert.ok(
      !d.ruleHits.includes("billing_dispute"),
      "honesty property: negated 'charged twice' must not bill",
    );
  });

  it("'temporary authorization hold on my card' routes the same way", () => {
    const d = diagnose(
      payload({ body: "There is a temporary authorization hold on my card, what is it?" }),
    );
    assert.equal(d.category, "pending_authorization_hold");
    const bankHold = diagnose(
      payload({ body: "My bank put a hold on the charge and I do not understand it." }),
    );
    assert.equal(bankHold.category, "pending_authorization_hold");
  });

  it("true negative: 'no pending hold' does not route to the hold path", () => {
    const d = diagnose(
      payload({ body: "There is no pending hold; the final charge posted correctly." }),
    );
    assert.ok(!d.ruleHits.includes("pending_hold"));
    assert.equal(d.triageLevel, "P3");
  });

  it("a real billing dispute mentioning a hold still bills (billing outranks pending_hold)", () => {
    const d = diagnose(
      payload({ body: "You charged me twice and there is also a pending hold showing." }),
    );
    assert.equal(d.category, "billing_dispute");
    assert.ok(d.ruleHits.includes("pending_hold"), "hold still surfaced in hits");
  });
});

describe("TL-038: fuzzy hits cannot assemble across a negation boundary", () => {
  it("CF-17/N8: negated 'charged twice' cannot donate its token to a fuzzy 'double charge' built with an unnegated 'charge'", () => {
    const d = diagnose(
      payload({
        subject: "pending hold question",
        body: "My bank shows a pending hold that looks like a second charge. I was not charged twice, please check before I dispute it.",
      }),
    );
    assert.equal(d.category, "pending_authorization_hold");
    assert.ok(!d.ruleHits.includes("billing_dispute"), "phantom billing must not fire");
    assert.ok(d.ruleHits.includes("pending_hold"));
  });

  it("re-asserted phrase tokens still fire through their asserted occurrence", () => {
    const d = diagnose(
      payload({
        subject: "billing question",
        body: "I was not charged twice last week, but I was charged twice yesterday.",
      }),
    );
    assert.ok(d.ruleHits.includes("billing_dispute"), "asserted occurrence carries the hit");
  });

  it("negation scoping over the going_to filler still suppresses ('not going to be charged twice')", () => {
    const d = diagnose(payload({ body: "I am not going to be charged twice." }));
    assert.ok(!d.ruleHits.includes("billing_dispute"));
  });

  it("unit: matchPhrases drops a hit whose every token occurrence is negated", async () => {
    const { matchPhrases, BILLING_PHRASES } = await import("../src/fuzzy.js");
    const negOnly = matchPhrases(
      "a second charge. I was not charged twice",
      BILLING_PHRASES.filter((p) => p.phrase === "double charge"),
    );
    assert.equal(negOnly.length, 0, "no hit from fully-negated token occurrences");
    const asserted = matchPhrases(
      "a second charge appeared twice on my statement",
      BILLING_PHRASES.filter((p) => p.phrase === "double charge"),
    );
    assert.ok(asserted.length > 0, "asserted tokens still hit");
  });
});
