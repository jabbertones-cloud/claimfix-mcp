/**
 * Wire schemas for the two MCP tools (extracted from index.ts so the
 * validation contract is unit-testable in the product suite).
 *
 * Validation contract (TL-013 + TL-019):
 * - Identifiers (claimId, stripeEventId) are TRIMMED, then must be
 *   non-empty: a whitespace-only id is a min(1) failure, and surrounding
 *   whitespace never reaches the ledger or verifiedProof. Trimming (not
 *   rejecting padded-but-real ids) matches the codebase's identity
 *   hygiene — customer email matching is already case-insensitive.
 * - record_entitlement_event validates like the docs promise: state from
 *   TRANSACTION_STATES, type a dotted Stripe-style event type over a
 *   known resource family, amountCents a non-negative integer,
 *   receivedAt an ISO-8601 date/time. Garbage is rejected at this
 *   boundary, so it can never be recorded and later presented inside
 *   verifiedProof as fact.
 * - Unknown extra arguments are still stripped, not rejected (gap #8
 *   decision, pinned by regressions/claimfix-annotations.mjs).
 */

import { z } from "zod";
import { ENTITLEMENT_EVENT_RESOURCES, TRANSACTION_STATES } from "./entitlement.js";

export const claimSchema = z.object({
  claimId: z.string().trim().min(1),
  customerEmail: z.string().email(),
  subject: z.string(),
  body: z.string(),
  channel: z.enum(["email", "chat", "phone"]).optional(),
  receivedAt: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

const EVENT_TYPE_SHAPE_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

export const eventSchema = z.object({
  stripeEventId: z.string().trim().min(1),
  type: z
    .string()
    .trim()
    .regex(
      EVENT_TYPE_SHAPE_RE,
      "type must be a dotted Stripe-style event type, e.g. charge.succeeded",
    )
    .refine(
      (t) => ENTITLEMENT_EVENT_RESOURCES.has(t.split(".")[0]),
      "type resource family is not one this ledger understands (charge, customer, dispute, ...)",
    ),
  customerEmail: z.string().email(),
  chargeId: z.string().optional(),
  customerId: z.string().optional(),
  amountCents: z.number().int().nonnegative().optional(),
  state: z.enum(TRANSACTION_STATES),
  receivedAt: z
    .string()
    .refine(
      (s) => ISO_8601_RE.test(s) && !Number.isNaN(Date.parse(s)),
      "receivedAt must be an ISO-8601 date/time",
    ),
});
