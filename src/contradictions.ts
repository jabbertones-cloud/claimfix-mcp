/**
 * Gap 29 — contradiction surfacing (deterministic, zero dependencies).
 *
 * When a claim contains contradictory facts (e.g. "charged twice" + "never
 * received it... actually did receive an empty box"), the detector SURFACES
 * both verbatim statements into verifiedProof.notes. It never resolves the
 * contradiction, never invents facts to make the input consistent, and never
 * changes triageLevel / category / resolutionAction.
 *
 * Borrowing decisions (see testlabs-fleet/gap-fixes/claimfix-contradiction-surfacing.md):
 * - BORROW: hermes-labs-ai/rule-audit — a static mutually-exclusive pair
 *   table, a shared-facet (topic) gate enforced structurally by the table
 *   shape (a pair only exists within one facet), structured findings with
 *   verbatim source spans, report-never-resolve.
 * - BORROW (dimensions only): gather's period/scope/place disqualification
 *   list (temporal disqualification here); agent-belief-conflict-router's
 *   "auditable pair, human disposes" surfacing contract.
 * - SKIP: NLI/LLM detectors (engram evidence: >80% false contradictions on
 *   non-co-referring pairs; claimfix v0 is no-LLM by contract); auto-revise /
 *   mitigation loops (the exact behavior the torture fixture forbids).
 */

import type { ClaimPayload } from "./diagnose.js";
import { matchPhrases, type PhrasePattern } from "./fuzzy.js";

export interface ContradictionPair {
  id: string;
  /** Shared facet both assertions must belong to (the topic gate). */
  facet: string;
  /** zeroSteiner-style audit string. */
  expr: string;
  /** The two mutually-exclusive assertion patterns (exact fast path). */
  a: RegExp;
  b: RegExp;
  /**
   * Optional fuzzy phrase equivalents (gap-13 token_set_ratio scorer) so
   * intervening words don't defeat the pair — "charged me twice" must count
   * as a "charged twice" assertion. The scorer's negation guard applies.
   */
  aPhrases?: PhrasePattern[];
  bPhrases?: PhrasePattern[];
}

export interface ContradictionNote {
  pairId: string;
  facet: string;
  /** VERBATIM sentence spans — never normalized, paraphrased, or truncated. */
  statements: [string, string];
  /**
   * Retraction-marker text if present (e.g. "Actually, wait"). Recorded as
   * context only — a claimed retraction is NOT resolution authority, so the
   * pair is still surfaced untouched.
   */
  retractionMarker: string | null;
  severity: "info" | "warn";
  description: string;
}

const CONTRADICTION_PAIRS: ContradictionPair[] = [
  {
    id: "receipt_never_vs_received",
    facet: "receipt",
    expr: "NEVER_RECEIVED_RE and RECEIVED_EMPTY_RE in different sentences",
    a: /\bnever\s+(received|got|arrived)\b/i,
    // "did receive ... empty (box)": base/past/progressive forms all occur
    b: /\breceiv(?:e|ed|ing)\b[^.!?]{0,120}\bempty\b/i,
  },
  {
    id: "charge_count_twice_vs_once",
    facet: "charge_count",
    expr: "CHARGED_TWICE and CHARGED_ONCE assertions in different sentences (fuzzy: intervening words tolerated)",
    a: /\bcharged\s+twice\b/i,
    b: /\bcharged\s+(only\s+|just\s+)?once\b/i,
    aPhrases: [{ phrase: "charged twice", threshold: 85 }],
    bPhrases: [{ phrase: "charged once", threshold: 85 }],
  },
  {
    id: "address_wrong_vs_correct",
    facet: "delivery_address",
    expr: "WRONG_ADDRESS_RE and ADDRESS_CORRECT_RE in different sentences",
    a: /\bwrong\s+address\b/i,
    b: /\baddress\s+(was\s+|is\s+)?correct\b|\bconfirmed\s+(the\s+)?address\b/i,
  },
];

const RETRACTION_RE = /actually,?\s*wait|sorry,?\s*i\s+meant|i\s+was\s+wrong|scratch\s+that|\bcorrection:/i;

const TEMPORAL_RE =
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|yesterday|today|tomorrow|last\s+night|last\s+week|this\s+morning|january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}[\/-]\d{1,2})\b/i;

/**
 * Facets whose contradiction is load-bearing for a category -> severity warn,
 * otherwise info. Severity never changes triage; it is FYI for the human step.
 */
const LOAD_BEARING: Record<string, string[]> = {
  receipt: ["billing_dispute"],
  charge_count: ["billing_dispute"],
};

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?;\n])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function temporalMarker(span: string): string | null {
  const m = TEMPORAL_RE.exec(span);
  return m ? m[0].toLowerCase() : null;
}

/** A span matches when the exact regex fires or any fuzzy phrase scores at/above threshold. */
function spanMatches(span: string, re: RegExp, phrases?: PhrasePattern[]): boolean {
  if (re.test(span)) return true;
  return !!phrases && matchPhrases(span, phrases).length > 0;
}

/**
 * Detect competing assertions. Returns notes to append to
 * verifiedProof.notes and `contradiction_<pairId>` rule-hit ids.
 * Pure: no network, no clock, no randomness. Never re-triages.
 */
export function detectContradictions(
  payload: ClaimPayload,
  opts: { category?: string } = {},
): { notes: string[]; ruleHits: string[]; findings: ContradictionNote[] } {
  const text = `${payload.subject ?? ""}\n${payload.body ?? ""}`;
  const sentences = splitSentences(text);
  const retraction = RETRACTION_RE.exec(text);
  const notes: string[] = [];
  const ruleHits: string[] = [];
  const findings: ContradictionNote[] = [];

  for (const pair of CONTRADICTION_PAIRS) {
    const spanA = sentences.find((s) => spanMatches(s, pair.a, pair.aPhrases));
    const spanB = sentences.find((s) => s !== spanA && spanMatches(s, pair.b, pair.bPhrases));
    if (!spanA || !spanB) continue;
    // Temporal disqualification: when BOTH spans carry explicit time references
    // and they DIFFER ("never received it Tuesday" vs "received it Thursday"),
    // that is a time-shifted truth, not a contradiction. A timestamp on only
    // one side ("did receive a box yesterday") is just detail — the canonical
    // torture fixture does exactly that, so one-sided markers do NOT
    // disqualify.
    const ta = temporalMarker(spanA);
    const tb = temporalMarker(spanB);
    if (ta !== null && tb !== null && ta !== tb) continue;
    const severity: "info" | "warn" = (LOAD_BEARING[pair.facet] ?? []).includes(
      opts.category ?? "",
    )
      ? "warn"
      : "info";
    const finding: ContradictionNote = {
      pairId: pair.id,
      facet: pair.facet,
      statements: [spanA, spanB],
      retractionMarker: retraction ? retraction[0] : null,
      severity,
      description: `competing assertions on facet "${pair.facet}" (${pair.id})`,
    };
    findings.push(finding);
    ruleHits.push(`contradiction_${pair.id}`);
    notes.push(
      `contradiction[${pair.facet}]: competing assertions — "${spanA}" vs "${spanB}"` +
        (finding.retractionMarker
          ? ` (retraction marker noted: "${finding.retractionMarker}" — recorded, not resolved)`
          : "") +
        ` [severity: ${severity}; both statements preserved verbatim for entitlement/human review]`,
    );
  }
  return { notes, ruleHits, findings };
}
