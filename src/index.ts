#!/usr/bin/env node
/**
 * claimfix-mcp: Claim triage and dispute-resolution MCP server (stdio).
 *
 * Tools:
 *   diagnose_claim            -> { triageLevel, category, verifiedProof, resolutionAction, ruleHits }
 *   record_entitlement_event  -> append a Stripe webhook event to the ledger (idempotent on stripeEventId)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { diagnose } from "./diagnose.js";
import { InMemoryEntitlementLedger, type EntitlementEvent } from "./entitlement.js";

const ledger = new InMemoryEntitlementLedger();

const server = new McpServer({ name: "claimfix-mcp", version: "0.1.0" });

const claimSchema = z.object({
  claimId: z.string().min(1),
  customerEmail: z.string().email(),
  subject: z.string(),
  body: z.string(),
  channel: z.enum(["email", "chat", "phone"]).optional(),
  receivedAt: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

server.registerTool(
  "diagnose_claim",
  {
    title: "Diagnose a customer claim",
    description:
      "Classify a customer complaint: tier-1 deterministic rules first (DND, legal threat, chargeback threat, duplicate, billing), then entitlement verification against the ledger. Returns triageLevel P1/P2/P3, category, verifiedProof, and resolutionAction.",
    inputSchema: claimSchema.shape,
  },
  async (args) => {
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
      { ledger },
    );
    return { content: [{ type: "text", text: JSON.stringify(diagnosis, null, 2) }] };
  },
);

const eventSchema = z.object({
  stripeEventId: z.string().min(1),
  type: z.string().min(1),
  customerEmail: z.string().email(),
  chargeId: z.string().optional(),
  customerId: z.string().optional(),
  amountCents: z.number().int().optional(),
  state: z.string().min(1),
  receivedAt: z.string().min(1),
});

server.registerTool(
  "record_entitlement_event",
  {
    title: "Record an entitlement event",
    description:
      "Append a Stripe webhook event to the idempotency ledger. Recording the same stripeEventId twice is a no-op.",
    inputSchema: eventSchema.shape,
  },
  async (args) => {
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
    const { inserted } = ledger.recordEvent(event);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ inserted, ledgerSize: ledger.size() }, null, 2),
        },
      ],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("claimfix-mcp failed to start:", err);
  process.exit(1);
});
