/**
 * Conversational threading detectors (dogfood fix #2).
 *
 * diagnose() is tier-1-first and stays that way: these patterns are ONLY
 * consulted when tier-1 produced zero hits AND the session holds a prior
 * fresh decision for the same customer. A follow-up that fires any real
 * rule is classified fresh — threading never overrides a classification,
 * so context can only fill the P3 gap, never bleed into unrelated claims.
 *
 * Two follow-up kinds:
 *   recall — the customer asks what was decided ("what did we decide").
 *   thread — a fragmentary continuation ("it was on the 15th, about $49",
 *            "that duplicate charge") that is meaningless without context.
 * Recall wins when both match (e.g. "what did we decide about that
 * duplicate charge" is a recall question first).
 *
 * Deterministic: pure regexes over subject+body, no clock, no network.
 */

export const RECALL_PATTERNS: RegExp[] = [
  /\bwhat did (we|you) (decide|say|agree|conclude|recommend)\b/i,
  /\bwhat was (the )?(decision|verdict|plan|action|outcome)\b/i,
  /\bremind me\b/i,
  /\bso what (happens|now|next|do we do)\b/i,
];

export const THREAD_PATTERNS: RegExp[] = [
  // Explicit back-reference to the prior claim: "that duplicate charge".
  /\b(that|this)\s+(duplicate\s+|billing\s+|second\s+)?(charge|payment|claim|issue|case|hold)\b/i,
  // "the charge from the 15th" — definite article + date pins it to context.
  /\b(the\s+)?(charge|payment)\s+(from|on)\s+(the\s+)?\d{1,2}(st|nd|rd|th)?\b/i,
  // Fragmentary date/amount follow-up, anchored whole-body so only
  // fragment-length messages match: "it was on the 15th, about $49".
  /^\s*(it was\s+)?(on|about)\s+(the\s+)?\$?[\d][\w$,\.\s]*$/i,
];

export type FollowUpKind = "recall" | "thread";

/** Classify a zero-hit message as a recall question, a thread fragment, or neither. */
export function detectFollowUpKind(text: string): FollowUpKind | undefined {
  if (RECALL_PATTERNS.some((re) => re.test(text))) return "recall";
  if (THREAD_PATTERNS.some((re) => re.test(text))) return "thread";
  return undefined;
}
