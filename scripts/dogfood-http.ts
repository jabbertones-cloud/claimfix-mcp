/**
 * Real dogfood of the hosted HTTP transport: boots the actual HTTP server
 * on an ephemeral port and drives it with a real MCP client
 * (StreamableHTTPClientTransport), plus raw fetches for the auth gate.
 *
 * Run: node --import tsx scripts/dogfood-http.ts
 * Exit code 0 only if every check passes.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createClaimFixHttpServer } from "../src/http.js";

const API_KEY = "dogfood-test-key";
let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function main(): Promise<void> {
  const server = createClaimFixHttpServer({ apiKey: API_KEY });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  console.log(`server: ${url}`);

  try {
    // 1. Auth gate: no key -> 401 structured
    const noKey = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const noKeyBody = (await noKey.json()) as { error?: { code?: string } };
    check("no API key -> 401", noKey.status === 401, `status ${noKey.status}`);
    check("401 body is structured", noKeyBody.error?.code === "unauthorized", JSON.stringify(noKeyBody));

    // 2. Auth gate: wrong key -> 401
    const wrongKey = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer wrong-key",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    check("wrong API key -> 401", wrongKey.status === 401, `status ${wrongKey.status}`);

    // 3. Real MCP client, authed: tools/list
    const client = new Client({ name: "dogfood-client", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${API_KEY}` } },
    });
    await client.connect(transport);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    check("tools/list returns both tools", JSON.stringify(names) === JSON.stringify(["diagnose_claim", "record_entitlement_event"]), names.join(","));
    const diag = tools.find((t) => t.name === "diagnose_claim");
    check("diagnose_claim annotations survive HTTP", diag?.annotations?.readOnlyHint === true);

    // 4. Happy path: record an event, then diagnose against it
    const record = await client.callTool({
      name: "record_entitlement_event",
      arguments: {
        stripeEventId: "evt_dogfood_1",
        type: "charge.succeeded",
        customerEmail: "buyer@example.com",
        chargeId: "ch_123",
        amountCents: 1999,
        state: "paid",
        receivedAt: "2026-10-10T00:00:00Z",
      },
    });
    const recordText = (record.content as { text: string }[])[0]?.text ?? "";
    check("record_entitlement_event inserted", recordText.includes('"inserted": true'), recordText.replace(/\s+/g, " "));

    const diagnosis = await client.callTool({
      name: "diagnose_claim",
      arguments: {
        claimId: "claim-dogfood-1",
        customerEmail: "buyer@example.com",
        subject: "Charged twice",
        body: "You charged me twice for the same order, refund the duplicate.",
        channel: "email",
      },
    });
    const diagText = (diagnosis.content as { text: string }[])[0]?.text ?? "";
    let parsed: { triageLevel?: string } = {};
    try { parsed = JSON.parse(diagText); } catch { /* reported below */ }
    check("diagnose_claim happy path", typeof parsed.triageLevel === "string", diagText.replace(/\s+/g, " ").slice(0, 160));

    // 5. Error case: invalid input -> tool error result, not a crash
    const bad = await client.callTool({
      name: "diagnose_claim",
      arguments: { claimId: "x", customerEmail: "not-an-email", subject: "s", body: "b" },
    });
    check("invalid input -> isError tool result", bad.isError === true);

    await client.close();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log(failures === 0 ? "DOGFOOD: all checks passed" : `DOGFOOD: ${failures} check(s) failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("dogfood crashed:", err);
  process.exit(1);
});
