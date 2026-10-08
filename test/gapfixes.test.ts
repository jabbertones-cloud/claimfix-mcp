/**
 * Gap-fix regression tests: fuzzy billing matching (gap 13), rule priority
 * (gap 14), contradiction surfacing (gap 29), plus fixture-derived regressions
 * from the testlabs v2 torture pack.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diagnose } from "../src/diagnose.js";
import {
  TIER1_RULES,
  compareTier1Rules,
  evaluateTier1,
  type Tier1Rule,
} from "../src/rules.js";
import { tokenSetRatio } from "../src/fuzzy.js";
import { detectContradictions } from "../src/contradictions.js";

function payload(over: Record<string, unknown> = {}) {
  return {
    claimId: "gap-test",
    customerEmail: "gap@example.com",
    subject: "",
    body: "",
    ...over,
  };
}

describe("gap 13: token_set_ratio port", () => {
  it("subset of tokens scores 100 regardless of extra words", () => {
    assert.equal(tokenSetRatio("charged twice", "you charged me twice for this"), 100);
    assert.equal(tokenSetRatio("fuzzy was a bear", "fuzzy fuzzy was a bear"), 100);
  });

  it("is order-insensitive", () => {
    assert.equal(tokenSetRatio("twice charged", "charged twice"), 100);
  });

  it("disjoint and empty inputs score 0", () => {
    assert.equal(tokenSetRatio("dog", "cat"), 0);
    assert.equal(tokenSetRatio("", "charged twice"), 0);
    assert.equal(tokenSetRatio("charged twice", ""), 0);
  });

  it("partial disagreement lowers the score below threshold", () => {
    const s = tokenSetRatio("charged twice", "charged the account");
    assert.ok(s > 0 && s < 85, `expected 0 < score < 85, got ${s}`);
  });
});

describe("gap 13: fuzzy billing matching", () => {
  it('catches the concrete bug: "charged me twice"', () => {
    const d = diagnose(
      payload({ subject: "Question about my order", body: "You charged me twice for my order." }),
    );
    assert.equal(d.triageLevel, "P2");
    assert.equal(d.category, "billing_dispute");
    assert.equal(d.resolutionAction, "verify_entitlement_then_refund_or_explain");
    assert.ok(d.ruleHits.includes("billing_dispute"));
    assert.ok(
      d.verifiedProof.notes.some((n) => n.includes('fuzzy phrase match "charged twice"')),
      "audit note must record pattern + score",
    );
  });

  it('catches "they charged my card twice"', () => {
    const d = diagnose(
      payload({ body: "They charged my card twice and I want my money back." }),
    );
    assert.equal(d.category, "billing_dispute");
    assert.ok(d.ruleHits.includes("billing_dispute"));
  });

  it('catches number-word variants: "charged 2 times"', () => {
    const d = diagnose(payload({ body: "I was charged 2 times for one purchase." }));
    assert.equal(d.category, "billing_dispute");
    assert.ok(d.ruleHits.includes("billing_dispute"));
  });

  it('negation guard: "I was not charged twice" does not bill', () => {
    const d = diagnose(
      payload({ body: "I was not charged twice; the statement date is simply wrong." }),
    );
    assert.equal(d.triageLevel, "P3");
    assert.equal(d.category, "general_complaint");
    assert.ok(!d.ruleHits.includes("billing_dispute"));
  });

  it('negation guard: "wasn\'t double charged" does not bill', () => {
    const d = diagnose(payload({ body: "I wasn't double charged, just checking the statement." }));
    assert.ok(!d.ruleHits.includes("billing_dispute"));
  });

  it("near-miss sentiment does not false-fire into billing", () => {
    const d = diagnose(
      payload({
        body: "I am really disappointed with how this went. I expected better from a company like yours.",
      }),
    );
    assert.equal(d.triageLevel, "P3");
    assert.deepEqual(d.ruleHits, []);
  });
});

describe("gap 14: rule priority mechanism", () => {
  it("every rule declares a finite numeric priority (never positional)", () => {
    assert.ok(TIER1_RULES.length > 0);
    for (const r of TIER1_RULES) {
      assert.equal(typeof r.priority, "number", `${r.id} must declare priority`);
      assert.ok(Number.isFinite(r.priority), `${r.id} priority must be finite`);
    }
  });

  it("comparator: priority desc, then specificity desc, then id asc", () => {
    const mk = (id: string, priority: number, specificity = 0): Tier1Rule =>
      ({ id, priority, specificity }) as Tier1Rule;
    const sorted = [mk("c", 50), mk("a", 100), mk("b", 50, 3), mk("d", 50, 3)].sort(
      compareTier1Rules,
    );
    assert.deepEqual(
      sorted.map((r) => r.id),
      ["a", "b", "d", "c"],
    );
  });

  it("priority wins over array position: legal_threat beats dnd_unsubscribe", () => {
    const d = diagnose(
      payload({ body: "I'm contacting my attorney, and stop emailing me." }),
    );
    assert.equal(d.triageLevel, "P1");
    assert.equal(d.category, "legal_threat");
    assert.equal(d.resolutionAction, "escalate_legal");
    assert.deepEqual(d.ruleHits, ["legal_threat", "dnd_unsubscribe"]);
  });

  it("ruleHits are priority-ordered and the winner rationale is in the notes", () => {
    const d = diagnose(
      payload({
        body: "I will sue you for this. I am also calling my bank to reverse the payment.",
      }),
    );
    assert.deepEqual(d.ruleHits, ["legal_threat", "chargeback_threat"]);
    assert.ok(
      d.verifiedProof.notes.some((n) =>
        n.includes("winner legal_threat (priority 100) over chargeback_threat (priority 90)"),
      ),
    );
  });

  it("evaluation order does not depend on TIER1_RULES array position", () => {
    const { hits } = evaluateTier1(
      payload({ body: "Stop emailing me. You charged me twice." }),
    );
    const ids = hits.map((h) => h.ruleId);
    assert.deepEqual(ids, ["dnd_unsubscribe", "billing_dispute"]);
  });
});

describe("gap 14: rule-pair shadowing matrix (priority order, deliberate)", () => {
  const cases: Array<{
    name: string;
    winner: string;
    body: string;
    loser: string;
    duplicate?: boolean;
    expect: { triageLevel: string; category: string; resolutionAction: string };
  }> = [
    {
      name: "legal_threat over chargeback_threat",
      winner: "legal_threat",
      loser: "chargeback_threat",
      body: "I will sue you for this. I am also calling my bank to reverse the payment.",
      expect: { triageLevel: "P1", category: "legal_threat", resolutionAction: "escalate_legal" },
    },
    {
      name: "legal_threat over dnd_unsubscribe",
      winner: "legal_threat",
      loser: "dnd_unsubscribe",
      body: "I'm contacting my attorney, and stop emailing me.",
      expect: { triageLevel: "P1", category: "legal_threat", resolutionAction: "escalate_legal" },
    },
    {
      name: "legal_threat over billing_dispute",
      winner: "legal_threat",
      loser: "billing_dispute",
      body: "You charged me twice and you'll hear from my lawyer.",
      expect: { triageLevel: "P1", category: "legal_threat", resolutionAction: "escalate_legal" },
    },
    {
      name: "legal_threat over duplicate_claim",
      winner: "legal_threat",
      loser: "duplicate_claim",
      body: "You will hear from my lawyer.",
      duplicate: true,
      expect: { triageLevel: "P1", category: "legal_threat", resolutionAction: "escalate_legal" },
    },
    {
      name: "chargeback_threat over dnd_unsubscribe",
      winner: "chargeback_threat",
      loser: "dnd_unsubscribe",
      body: "Do not email me again. I will call my bank and file a chargeback.",
      expect: {
        triageLevel: "P1",
        category: "chargeback_risk",
        resolutionAction: "hold_fulfillment_review",
      },
    },
    {
      name: "chargeback_threat over billing_dispute",
      winner: "chargeback_threat",
      loser: "billing_dispute",
      body: "You charged me twice. I will call my bank to reverse the payment.",
      expect: {
        triageLevel: "P1",
        category: "chargeback_risk",
        resolutionAction: "hold_fulfillment_review",
      },
    },
    {
      name: "chargeback_threat over duplicate_claim",
      winner: "chargeback_threat",
      loser: "duplicate_claim",
      body: "I am filing a chargeback with my bank.",
      duplicate: true,
      expect: {
        triageLevel: "P1",
        category: "chargeback_risk",
        resolutionAction: "hold_fulfillment_review",
      },
    },
    {
      name: "dnd_unsubscribe over billing_dispute",
      winner: "dnd_unsubscribe",
      loser: "billing_dispute",
      body: "Stop emailing me. You charged me twice.",
      expect: { triageLevel: "P1", category: "dnd_request", resolutionAction: "suppress_contact" },
    },
    {
      name: "dnd_unsubscribe over duplicate_claim",
      winner: "dnd_unsubscribe",
      loser: "duplicate_claim",
      body: "Stop emailing me.",
      duplicate: true,
      expect: { triageLevel: "P1", category: "dnd_request", resolutionAction: "suppress_contact" },
    },
    {
      name: "billing_dispute over duplicate_claim (default-policy flip of fixture claimfix/duplicate-claim-resubmission)",
      winner: "billing_dispute",
      loser: "duplicate_claim",
      body: "You charged me twice.",
      duplicate: true,
      expect: {
        triageLevel: "P2",
        category: "billing_dispute",
        resolutionAction: "verify_entitlement_then_refund_or_explain",
      },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const p = payload({
        claimId: "shadow-claim",
        body: c.body,
        ...(c.duplicate ? { metadata: { seenClaimIds: ["shadow-claim"] } } : {}),
      });
      const d = diagnose(p);
      assert.equal(d.triageLevel, c.expect.triageLevel, "triageLevel");
      assert.equal(d.category, c.expect.category, "category");
      assert.equal(d.resolutionAction, c.expect.resolutionAction, "resolutionAction");
      assert.ok(d.ruleHits.includes(c.winner), `must include ${c.winner}`);
      assert.ok(d.ruleHits.includes(c.loser), `must include ${c.loser}`);
      assert.equal(d.ruleHits[0], c.winner, "winner is first (priority order)");
    });
  }
});

describe("gap 29: contradiction surfacing", () => {
  const contraBody =
    "You charged twice for my order, but I never received it. Actually, wait — I did receive a box yesterday and it was completely empty inside.";

  it("surfaces both verbatim statements without changing triage", () => {
    const d = diagnose(
      payload({ subject: "Double charge confusion", body: contraBody }),
    );
    assert.equal(d.triageLevel, "P2");
    assert.equal(d.category, "billing_dispute");
    assert.equal(d.resolutionAction, "verify_entitlement_then_refund_or_explain");
    assert.ok(d.ruleHits.includes("billing_dispute"));
    assert.ok(d.ruleHits.includes("contradiction_receipt_never_vs_received"));
    const raw = JSON.stringify(d);
    assert.ok(raw.includes("never received"), "first statement survives verbatim");
    assert.ok(raw.includes("empty"), "second statement survives verbatim");
    const note = d.verifiedProof.notes.find((n) => n.startsWith("contradiction[receipt]"));
    assert.ok(note, "structured contradiction note present");
    assert.ok(
      note.includes('retraction marker noted: "Actually, wait"'),
      "retraction marker recorded, not trusted as resolution",
    );
  });

  it("temporal disqualification: different time references are not a contradiction", () => {
    const d = diagnose(
      payload({
        body: "I never received my package on Tuesday. I received an empty box on Thursday.",
      }),
    );
    assert.ok(
      !d.ruleHits.includes("contradiction_receipt_never_vs_received"),
      "time-shifted truth must not fire",
    );
  });

  it("detects the charge_count pair without re-triaging", () => {
    const d = diagnose(
      payload({
        body: "You charged me twice for this. Looking at my statement, I was charged only once.",
      }),
    );
    assert.equal(d.triageLevel, "P2");
    assert.equal(d.category, "billing_dispute");
    assert.ok(d.ruleHits.includes("contradiction_charge_count_twice_vs_once"));
  });

  it("no contradiction on a consistent claim", () => {
    const d = diagnose(payload({ body: "You charged me twice for my order." }));
    assert.ok(
      d.ruleHits.every((id) => !id.startsWith("contradiction_")),
      "no contradiction hits on consistent text",
    );
    assert.ok(
      d.verifiedProof.notes.every((n) => !n.startsWith("contradiction[")),
      "no contradiction notes on consistent text",
    );
  });

  it("detectContradictions is pure and returns structured findings", () => {
    const a = detectContradictions(payload({ body: contraBody }), { category: "billing_dispute" });
    const b = detectContradictions(payload({ body: contraBody }), { category: "billing_dispute" });
    assert.deepEqual(a, b);
    assert.equal(a.findings.length, 1);
    assert.equal(a.findings[0].severity, "warn");
    assert.deepEqual(a.findings[0].statements.length, 2);
  });
});

describe("fixture regressions (testlabs v2 pack)", () => {
  it("claimfix/duplicate-charge-auth-hold: perceived duplicate -> billing", () => {
    const d = diagnose(
      payload({
        subject: "Charged twice?",
        body: "My $29.23 transaction is showing twice in my account history and I believe I have been charged twice. Please explain.",
      }),
    );
    assert.equal(d.triageLevel, "P2");
    assert.equal(d.category, "billing_dispute");
    assert.ok(d.ruleHits.includes("billing_dispute"));
  });

  it("claimfix/chargeback-and-lawsuit: legal outranks chargeback", () => {
    const d = diagnose(
      payload({
        body: "If I do not receive my immediate refund, I will call my bank and file a FRAUD chargeback and get all of my money back for both orders. There is a huge LAWSUIT against this company for the same problems and I am joining the law suit.",
      }),
    );
    assert.equal(d.triageLevel, "P1");
    assert.equal(d.category, "legal_threat");
    assert.equal(d.resolutionAction, "escalate_legal");
    assert.ok(d.ruleHits.includes("legal_threat"));
    assert.ok(d.ruleHits.includes("chargeback_threat"));
  });

  it("claimfix/dnd-plus-legal-threat: FLIP under new defaults -> legal wins", () => {
    const d = diagnose(
      payload({
        body: "I am reporting you to the Better Business Bureau. Also, do not email me ever again.",
      }),
    );
    assert.equal(d.triageLevel, "P1");
    assert.equal(d.category, "legal_threat");
    assert.equal(d.resolutionAction, "escalate_legal");
    assert.ok(d.ruleHits.includes("legal_threat"));
    assert.ok(d.ruleHits.includes("dnd_unsubscribe"));
  });

  it("claimfix/duplicate-claim-resubmission: FLIP under new defaults -> billing outranks duplicate", () => {
    const d = diagnose(
      payload({
        claimId: "cf-2026-011",
        body: "I am rejecting your response. You never completed the changes to my documents, and you have charged me twice. Your receipt shows one refund but I am still owed another.",
        metadata: { seenClaimIds: ["cf-2026-011"] },
      }),
    );
    assert.equal(d.triageLevel, "P2");
    assert.equal(d.category, "billing_dispute");
    assert.ok(d.ruleHits.includes("billing_dispute"));
    assert.ok(d.ruleHits.includes("duplicate_claim"));
    assert.equal(d.ruleHits[0], "billing_dispute");
  });

  it("claimfix/cancelled-but-charged: 'dispute the transaction' is not a chargeback", () => {
    const d = diagnose(
      payload({
        body: "Three days later you charged my account anyway. I am now forced to dispute the transaction and spend my time chasing a refund for money that should never have been taken.",
      }),
    );
    assert.equal(d.triageLevel, "P2");
    assert.equal(d.category, "billing_dispute");
    assert.ok(!d.ruleHits.includes("chargeback_threat"));
  });

  it("claimfix/contradictory-receipt-claim: contradiction surfaced, triage pinned", () => {
    const d = diagnose(
      payload({
        subject: "Double charge confusion",
        body: "You charged twice for my order, but I never received it. Actually, wait — I did receive a box yesterday and it was completely empty inside.",
      }),
    );
    assert.equal(d.triageLevel, "P2");
    assert.equal(d.category, "billing_dispute");
    assert.equal(d.resolutionAction, "verify_entitlement_then_refund_or_explain");
    assert.ok(!d.ruleHits.includes("chargeback_threat"));
    const raw = JSON.stringify(d);
    assert.ok(raw.includes("never received") && raw.includes("empty"));
  });
});
