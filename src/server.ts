/**
 * claimfix-mcp server factory — shared by the stdio entry (src/index.ts)
 * and the hosted Streamable HTTP entry (src/http.ts). Tool behaviour lives
 * here exactly once; transports only differ in how they connect.
 *
 * Tools:
 *   diagnose_claim            -> { triageLevel, category, verifiedProof, resolutionAction, ruleHits }
 *   record_entitlement_event  -> append a Stripe webhook event to the ledger (idempotent on stripeEventId)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { diagnose } from "./diagnose.js";
import {
  InMemoryClaimSessionTracker,
  type ClaimSessionTracker,
} from "./claim-session.js";
import {
  InMemoryEntitlementLedger,
  type EntitlementEvent,
  type EntitlementLedger,
} from "./entitlement.js";
import { claimSchema, eventSchema } from "./schemas.js";
import { toolErrorFromCaught } from "./tool-errors.js";

export function createClaimFixServer(
  ledger: EntitlementLedger = new InMemoryEntitlementLedger(),
  claimSession: ClaimSessionTracker = new InMemoryClaimSessionTracker(),
): McpServer {
  const server = new McpServer({ name: "claimfix-mcp", version: "0.1.0" });

  // Tool argument schemas live in src/schemas.ts: the gap #8 extra-args
  // decision (stripped, not rejected — pinned by
  // ~/workspace/testlabs/regressions/claimfix-annotations.mjs) plus the
  // TL-013 / TL-019 validation contract are documented there.

  server.registerTool(
    "diagnose_claim",
    {
      title: "Diagnose a customer claim",
      description:
        "Classify a customer complaint: tier-1 deterministic rules first (DND, legal threat, chargeback threat, billing, pending-hold, duplicate), then entitlement verification against the ledger. Duplicate detection unions caller-supplied metadata.seenClaimIds with server-session memory: resubmitting identical claimId+content in the same session is flagged as a duplicate (TL-017). Returns triageLevel P1/P2/P3, category, verifiedProof, and resolutionAction.",
      inputSchema: claimSchema.shape,
      // TestLabs discovery gap #7: declare MCP ToolAnnotations so clients can
      // tell this is safe to call automatically. Read-only: it only reads the
      // in-memory ledger (no mutation, no network), and the same claim always
      // classifies the same way.
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      // TL-009 step 2: handler-originated failures return the fleet
      // error envelope (tool-errors.ts), never the SDK catch-all's raw
      // err.message text.
      try {
        const diagnosis = diagnose(
          {
            claimId: args.claimId,
            customerEmail: args.customerEmail,
            subject: args.subject,
            body: args.body,
            channel: args.channel,
            receivedAt: args.receivedAt,
            metadata: args.metadata,
          },
          { ledger, claimSession },
        );
        return { content: [{ type: "text", text: JSON.stringify(diagnosis, null, 2) }] };
      } catch (err) {
        return toolErrorFromCaught(err, "diagnose_claim");
      }
    },
  );

  server.registerTool(
    "record_entitlement_event",
    {
      title: "Record an entitlement event",
      description:
        "Append a Stripe webhook event to the idempotency ledger. Recording the same stripeEventId with an identical payload is a no-op; the same id with a materially different payload keeps the original and returns conflict:true with a reason (TL-012). state must be one of paid/refunded/disputed/failed/active, type a dotted Stripe-style event type, receivedAt ISO-8601 (TL-013).",
      inputSchema: eventSchema.shape,
      // TestLabs discovery gap #7: this tool writes (appends to the ledger), so
      // readOnlyHint is false — but it is append-only and idempotent on
      // stripeEventId, never deletes or overwrites, and talks to nothing
      // external, so destructiveHint and openWorldHint are false. Clients must
      // not fall back to the spec default (readOnly=false => destructive
      // assumed true) for this tool.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      // TL-009 step 2: see diagnose_claim above.
      try {
        const event: EntitlementEvent = {
          stripeEventId: args.stripeEventId,
          type: args.type,
          customerEmail: args.customerEmail,
          chargeId: args.chargeId,
          customerId: args.customerId,
          amountCents: args.amountCents,
          state: args.state,
          receivedAt: args.receivedAt,
        };
        const result = ledger.recordEvent(event);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  inserted: result.inserted,
                  ledgerSize: ledger.size(),
                  // TL-012: backward-compatible added fields, present only
                  // when a same-id redelivery materially disagrees with the
                  // recorded original.
                  ...(result.conflict
                    ? { conflict: true, reason: result.reason }
                    : {}),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return toolErrorFromCaught(err, "record_entitlement_event");
      }
    },
  );

  return server;
}
