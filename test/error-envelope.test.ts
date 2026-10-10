/**
 * TL-009 step 2 (ClaimFix): handler-originated failures return the
 * fleet error envelope, not the SDK catch-all's raw err.message text.
 *
 * Driven by a real MCP Client against the real server factory over
 * InMemoryTransport, with a fault-injecting ledger (the only way a
 * handler can throw once SDK argument validation has passed — e.g. a
 * future Postgres ledger failing mid-call). Assertions pin:
 *   1. isError tool result (no JSON-RPC error, no raw throw text);
 *   2. structuredContent = { error: "internal_error",
 *      status: "internal", tool, message } per ERROR-ENVELOPE-STANDARD;
 *   3. text content mirrors structuredContent.message exactly, and the
 *      fault's raw message ("sensitive backend detail") never leaks;
 *   4. success shapes untouched (no envelope on a healthy call).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createClaimFixServer } from "../src/server.js";
import type {
  EntitlementEvent,
  EntitlementLedger,
  RecordEventResult,
} from "../src/entitlement.js";

const SECRET_DETAIL = "pg connection failed: password authentication failed for user claimfix";

class ThrowingLedger implements EntitlementLedger {
  recordEvent(_event: EntitlementEvent): RecordEventResult {
    throw new Error(SECRET_DETAIL);
  }
  findByEmail(_email: string): EntitlementEvent[] {
    throw new Error(SECRET_DETAIL);
  }
  findByStripeEventId(_id: string): EntitlementEvent | undefined {
    throw new Error(SECRET_DETAIL);
  }
  size(): number {
    return 0;
  }
}

async function connect(ledger?: EntitlementLedger) {
  const server = createClaimFixServer(ledger);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tl009-test-client", version: "0.0.1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? "").join("\n");
}

describe("TL-009: ClaimFix fleet error envelope", () => {
  it("diagnose_claim handler throw -> internal_error envelope, no leak", async () => {
    const { client, server } = await connect(new ThrowingLedger());
    try {
      const result = await client.callTool({
        name: "diagnose_claim",
        arguments: {
          claimId: "env-1",
          customerEmail: "env@example.com",
          subject: "help",
          body: "my card was charged twice",
        },
      });
      assert.equal(result.isError, true);
      const sc = result.structuredContent as Record<string, unknown> | undefined;
      assert.ok(sc, "structuredContent envelope present");
      assert.equal(sc.error, "internal_error");
      assert.equal(sc.status, "internal");
      assert.equal(sc.tool, "diagnose_claim");
      assert.equal(typeof sc.message, "string");
      assert.equal(textOf(result), sc.message, "text mirrors structuredContent.message");
      assert.ok(!textOf(result).includes(SECRET_DETAIL), "raw fault detail never leaks");
      assert.ok(!textOf(result).includes("MCP error -"), "no protocol plumbing in text");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("record_entitlement_event handler throw -> internal_error envelope, no leak", async () => {
    const { client, server } = await connect(new ThrowingLedger());
    try {
      const result = await client.callTool({
        name: "record_entitlement_event",
        arguments: {
          stripeEventId: "evt_env_1",
          type: "charge.succeeded",
          customerEmail: "env@example.com",
          state: "paid",
          receivedAt: "2026-10-10T00:00:00Z",
        },
      });
      assert.equal(result.isError, true);
      const sc = result.structuredContent as Record<string, unknown> | undefined;
      assert.ok(sc, "structuredContent envelope present");
      assert.equal(sc.error, "internal_error");
      assert.equal(sc.status, "internal");
      assert.equal(sc.tool, "record_entitlement_event");
      assert.equal(textOf(result), sc.message);
      assert.ok(!textOf(result).includes(SECRET_DETAIL), "raw fault detail never leaks");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("success shapes untouched: healthy calls carry no error envelope", async () => {
    const { client, server } = await connect();
    try {
      const result = await client.callTool({
        name: "diagnose_claim",
        arguments: {
          claimId: "env-ok-1",
          customerEmail: "ok@example.com",
          subject: "question",
          body: "just checking my plan",
        },
      });
      assert.notEqual(result.isError, true);
      const sc = result.structuredContent as Record<string, unknown> | undefined;
      assert.equal(sc?.error, undefined);
      const parsed = JSON.parse(textOf(result)) as { triageLevel?: string };
      assert.equal(parsed.triageLevel, "P3");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
