/**
 * Contradiction surfacing for ClaimFix (gap: contradictory-receipt-claim).
 *
 * Borrowed shape (hermes-labs-ai/rule-audit): a curated, static table of
 * facet-bound mutually-exclusive assertion pairs. A pair fires only when
 * both sides appear in DIFFERENT sentences of the same claim (shared-facet
 * gate), and the finding quotes both sentence spans VERBATIM. Surfacing is
 * notes-only: it never changes triageLevel / category / resolutionAction
 * and never picks a winner — the human/entitlement step disposes.
 *
 * Deterministic, zero-dep, no LLM — same contract as tier-1 rules.
 */

import type { ClaimPayload } from "./diagnose.js";

export interface ContradictionPair {
  id: string;
  facet: string;
  expr: string;
  a: RegExp;
  b: RegExp;
}

export interface ContradictionNote {
  pairId: string;
  facet: string;
  statements: [string, string];
  retractionMarker: string | null;
  severity: "info" | "warn";
  description: string;
}

export const CONTRADICTION_PAIRS: ContradictionPair[] = [
  {
    id: "receipt_never_vs_received",
    facet: "receipt",
    expr: "NEVER_RECEIVED in one sentence and RECEIVED_BOX in another sentence of the same claim",
    a: /never received/i,
    b: /receive[ds]?\s+(a\s+)?(box|package|item|order)/i,
  },
  {
    id: "charge_count_twice_vs_once",
    facet: "charge_count",
    expr: "CHARGED_TWICE in one sentence and CHARGED_ONCE in another sentence of the same claim",
    a: /charged\s+(me\s+)?twice|double\s+charge/i,
    b: /charged\s+(me\s+)?once|single\s+charge/i,
  },
];

const DAY_RE = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi;
const RETRACTION_RE = /actually,?\s*wait|scratch that|i was wrong|correction:/i;

/** Split subject + body into verbatim sentence spans (no normalization). */
export function sentenceSpans(payload: ClaimPayload): string[] {
  const text = `${payload.subject ?? ""}. ${payload.body ?? ""}`;
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function distinctDays(span: string): Set<string> {
  return new Set((span.match(DAY_RE) ?? []).map((d) => d.toLowerCase()));
}

export interface ContradictionResult {
  notes: string[];
  ruleHits: string[];
  findings: ContradictionNote[];
}

/**
 * Detect competing assertions. Temporal disqualification: when both spans
 * carry explicit, distinct weekday references, the pair is a time-shifted
 * truth, not a contradiction — do not fire.
 */
export function detectContradictions(
  payload: ClaimPayload,
  ctx: { category?: string } = {},
): ContradictionResult {
  const spans = sentenceSpans(payload);
  const fullText = `${payload.subject ?? ""}\n${payload.body ?? ""}`;
  const markerMatch = fullText.match(RETRACTION_RE);
  const retractionMarker = markerMatch ? markerMatch[0] : null;

  const findings: ContradictionNote[] = [];
  for (const pair of CONTRADICTION_PAIRS) {
    let stmtA: string | undefined;
    let stmtB: string | undefined;
    for (const span of spans) {
      if (!stmtA && pair.a.test(span)) stmtA = span;
      else if (!stmtB && pair.b.test(span)) stmtB = span;
    }
    if (!stmtA || !stmtB || stmtA === stmtB) continue;
    const daysA = distinctDays(stmtA);
    const daysB = distinctDays(stmtB);
    const sharedDay = [...daysA].some((d) => daysB.has(d));
    if (daysA.size > 0 && daysB.size > 0 && !sharedDay) continue; // temporal disqualification

    const loadBearing = pair.facet === "receipt" && ctx.category === "billing_dispute";
    findings.push({
      pairId: pair.id,
      facet: pair.facet,
      statements: [stmtA, stmtB],
      retractionMarker,
      severity: loadBearing ? "warn" : "info",
      description: `competing assertions on facet "${pair.facet}" left unresolved for the entitlement/human step`,
    });
  }

  return {
    findings,
    ruleHits: findings.map((f) => `contradiction_${f.pairId}`),
    notes: findings.map(
      (f) =>
        `contradiction surfaced (${f.pairId}, facet=${f.facet}, severity=${f.severity}` +
        (f.retractionMarker ? `, retraction marker "${f.retractionMarker}" recorded but not trusted as resolution` : "") +
        `): ${f.description} — "${f.statements[0]}" vs "${f.statements[1]}"`,
    ),
  };
}
