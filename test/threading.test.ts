/**
 * Conversational threading (dogfood fix #2): a zero-hit follow-up should
 * resolve against the session's last fresh decision for the same customer
 * instead of falling to P3 with amnesia.
 *
 * Covered:
 *  (a) date/amount fragment threads to the prior claim ("it was on the 15th, about $49")
 *  (b) "what did we decide" recall answers from the prior decision
 *  (c) isolation: new classified claims reset the anchor, other customers
 *      never see it, and a real classification always beats threading
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diagnose } from "../src/diagnose.js";
import { InMemoryClaimSessionTracker } from "../src/claim-session.js";
import { detectFollowUpKind } from "../src/threading.js";

const EMAIL = "thread-cust@example.com";
const OTHER = "stranger@example.com";

function payload(over: Record<string, unknown> = {}) {
  return {
    claimId: "thread-x",
    customerEmail: EMAIL,
    subject: "",
    body: "",
    ...over,
  };
}

function dx(over: Record<string, unknown>, session = new InMemoryClaimSessionTracker()) {
  return diagnose(payload(over), { claimSession: session });
}

describe("detectFollowUpKind", () => {
  it("recall: 'what did we decide' and variants", () => {
    assert.equal(detectFollowUpKind("what did we decide to do?"), "recall");
    assert.equal(
      detectFollowUpKind("So about that duplicate charge — what did we decide?"),
      "recall",
    );
    assert.equal(detectFollowUpKind("remind me what you said"), "recall");
    assert.equal(detectFollowUpKind("what was the decision?"), "recall");
  });

  it("recall wins when both match", () => {
    assert.equal(
      detectFollowUpKind("what did we decide about that duplicate charge"),
      "recall",
    );
  });

  it("thread: fragmentary date/amount follow-ups and back-references", () => {
    assert.equal(detectFollowUpKind("it was on the 15th, about $49"), "thread");
    assert.equal(detectFollowUpKind("on the 15th"), "thread");
    assert.equal(detectFollowUpKind("about that duplicate charge"), "thread");
    assert.equal(detectFollowUpKind("the charge from the 15th"), "thread");
  });

  it("neither: ordinary new claims", () => {
    assert.equal(detectFollowUpKind("the app keeps crashing on my phone"), undefined);
    assert.equal(
      detectFollowUpKind("I was charged twice for my subscription"),
      undefined,
    );
    assert.equal(detectFollowUpKind("please do not contact me again"), undefined);
  });
});

describe("(a) date follow-up threading", () => {
  it("dogfood turn 2: 'it was on the 15th, about $49' threads to the prior billing claim", () => {
    const session = new InMemoryClaimSessionTracker();
    const first = dx(
      {
        claimId: "claim-001",
        subject: "double charge",
        body: "I was charged twice for my subscription last month, what do I do?",
      },
      session,
    );
    assert.equal(first.triageLevel, "P2");
    assert.equal(first.category, "billing_dispute");

    const follow = dx(
      { claimId: "claim-002", subject: "", body: "it was on the 15th, about $49" },
      session,
    );
    assert.equal(follow.triageLevel, "P2");
    assert.equal(follow.category, "billing_dispute");
    assert.equal(follow.resolutionAction, "verify_entitlement_then_refund_or_explain");
    assert.ok(follow.ruleHits.includes("context_threading"));
    assert.ok(
      follow.verifiedProof.notes.some((n) => n.includes("claim-001")),
      "threading note names the anchor claim",
    );
  });
});

describe("(b) 'what did we decide' recall", () => {
  it("dogfood turn 6: recall answers from the prior decision, not P3 amnesia", () => {
    const session = new InMemoryClaimSessionTracker();
    dx(
      {
        claimId: "claim-001",
        subject: "double charge",
        body: "I was charged twice for my subscription last month, what do I do?",
      },
      session,
    );
    dx({ claimId: "claim-002", body: "it was on the 15th, about $49" }, session);

    const recall = dx(
      {
        claimId: "claim-003",
        body: "So about that duplicate charge from the 15th — what did we decide to do about it?",
      },
      session,
    );
    // TL-040: "duplicate charge" is now a real tier-1 billing signal, so
    // this classifies fresh as billing (tier-1 always beats threading per
    // the 3b contract) — same level/category/action the recall would have
    // inherited, but as a fresh decision that resets the anchor. A pure
    // recall question with no tier-1 signal still recalls (next test).
    assert.equal(recall.triageLevel, "P2");
    assert.equal(recall.category, "billing_dispute");
    assert.equal(recall.resolutionAction, "verify_entitlement_then_refund_or_explain");
    assert.ok(!recall.ruleHits.includes("context_recall"));
    assert.ok(!recall.ruleHits.includes("context_threading"));
  });

  it("TL-040: pure recall question with no tier-1 signal still recalls", () => {
    const session = new InMemoryClaimSessionTracker();
    dx(
      {
        claimId: "claim-001",
        subject: "double charge",
        body: "I was charged twice for my subscription last month, what do I do?",
      },
      session,
    );
    const recall = dx(
      { claimId: "claim-002", body: "What did we decide about it?" },
      session,
    );
    assert.equal(recall.triageLevel, "P2");
    assert.equal(recall.category, "billing_dispute");
    assert.equal(recall.resolutionAction, "verify_entitlement_then_refund_or_explain");
    assert.ok(recall.ruleHits.includes("context_recall"));
    assert.ok(
      recall.verifiedProof.notes.some(
        (n) => n.includes("claim-001") && n.includes("verify_entitlement_then_refund_or_explain"),
      ),
      "recall note names the ORIGINAL anchor claim-001",
    );
  });

  it("recall after a P1 decision returns the P1 decision", () => {
    const session = new InMemoryClaimSessionTracker();
    dx(
      { claimId: "legal-1", body: "I am going to sue you over this charge." },
      session,
    );
    const recall = dx({ claimId: "legal-2", body: "what did we decide?" }, session);
    assert.equal(recall.triageLevel, "P1");
    assert.equal(recall.category, "legal_threat");
    assert.equal(recall.resolutionAction, "escalate_legal");
    assert.ok(recall.ruleHits.includes("context_recall"));
  });
});

describe("(c) context isolation — no bleed", () => {
  it("a newly classified claim resets the anchor; recall follows the NEW claim", () => {
    const session = new InMemoryClaimSessionTracker();
    dx(
      {
        claimId: "claim-001",
        body: "I was charged twice for my subscription last month.",
      },
      session,
    );
    const dnd = dx(
      { claimId: "claim-009", body: "please do not contact me again" },
      session,
    );
    assert.equal(dnd.triageLevel, "P1");
    assert.equal(dnd.category, "dnd_request");
    assert.ok(!dnd.ruleHits.some((r) => r.startsWith("context_")));

    const recall = dx({ claimId: "claim-010", body: "what did we decide?" }, session);
    assert.equal(recall.triageLevel, "P1");
    assert.equal(recall.category, "dnd_request");
    assert.equal(recall.resolutionAction, "suppress_contact");
    assert.ok(
      recall.verifiedProof.notes.some((n) => n.includes("claim-009")),
      "anchor moved to the DND claim, not the old billing claim",
    );
  });

  it("a real classification always beats threading, even with follow-up fragments in the body", () => {
    const session = new InMemoryClaimSessionTracker();
    dx(
      {
        claimId: "claim-001",
        body: "I was charged twice for my subscription last month.",
      },
      session,
    );
    const d = dx(
      {
        claimId: "claim-002",
        body: "I was charged twice, it was on the 15th — this is a new problem.",
      },
      session,
    );
    assert.equal(d.category, "billing_dispute");
    assert.ok(d.ruleHits.includes("billing_dispute"));
    assert.ok(!d.ruleHits.some((r) => r.startsWith("context_")));
  });

  it("context never crosses customers: a stranger's follow-up stays P3", () => {
    const session = new InMemoryClaimSessionTracker();
    dx(
      {
        claimId: "claim-001",
        body: "I was charged twice for my subscription last month.",
      },
      session,
    );
    const d = dx(
      {
        claimId: "other-1",
        customerEmail: OTHER,
        body: "it was on the 15th, about $49",
      },
      session,
    );
    assert.equal(d.triageLevel, "P3");
    assert.equal(d.category, "general_complaint");
    assert.ok(!d.ruleHits.some((r) => r.startsWith("context_")));
  });

  it("a follow-up with no prior decision stays P3 (no crash on empty memory)", () => {
    const d = dx({ claimId: "lone-1", body: "what did we decide?" });
    assert.equal(d.triageLevel, "P3");
    assert.equal(d.category, "general_complaint");
    assert.ok(!d.ruleHits.some((r) => r.startsWith("context_")));
  });

  it("an unrecognized P3 claim stays P3 and becomes the new anchor", () => {
    const session = new InMemoryClaimSessionTracker();
    dx(
      {
        claimId: "claim-001",
        body: "I was charged twice for my subscription last month.",
      },
      session,
    );
    const fresh = dx(
      { claimId: "claim-007", body: "the app keeps crashing on my phone" },
      session,
    );
    assert.equal(fresh.triageLevel, "P3");
    assert.ok(!fresh.ruleHits.some((r) => r.startsWith("context_")));

    const recall = dx({ claimId: "claim-008", body: "what did we decide?" }, session);
    assert.equal(recall.triageLevel, "P3");
    assert.equal(recall.resolutionAction, "queue_support");
    assert.ok(
      recall.verifiedProof.notes.some((n) => n.includes("claim-007")),
      "anchor is the fresh P3 claim, not the stale billing claim",
    );
  });

  it("email identity for the anchor is case-insensitive", () => {
    const session = new InMemoryClaimSessionTracker();
    dx(
      {
        claimId: "claim-001",
        customerEmail: "Thread-Cust@Example.com",
        body: "I was charged twice for my subscription last month.",
      },
      session,
    );
    const d = dx(
      { claimId: "claim-002", customerEmail: "thread-cust@example.com", body: "on the 15th" },
      session,
    );
    assert.ok(d.ruleHits.includes("context_threading"));
  });
});
