/**
 * HTTP transport regressions: auth gate (401), tools/list, one happy-path
 * call chain, one error case — driven by a real MCP client against the
 * real HTTP server (in-process, ephemeral port). The stdio entry is
 * covered by its own suite; tool behaviour must be identical here.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createClaimFixHttpServer } from "../src/http.js";

const API_KEY = "http-test-key";

let server: Server;
let baseUrl: URL;
let client: Client;

function postJson(headers: Record<string, string>, body: unknown): Promise<Response> {
  return fetch(baseUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

before(async () => {
  server = createClaimFixHttpServer({ apiKey: API_KEY });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  baseUrl = new URL(`http://127.0.0.1:${port}/mcp`);

  client = new Client({ name: "http-test-client", version: "0.0.1" });
  await client.connect(
    new StreamableHTTPClientTransport(baseUrl, {
      requestInit: { headers: { authorization: `Bearer ${API_KEY}` } },
    }),
  );
});

after(async () => {
  await client?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("http auth gate", () => {
  it("rejects requests with no API key: 401 + structured error", async () => {
    const res = await postJson({}, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error?: { code?: string } };
    assert.equal(body.error?.code, "unauthorized");
  });

  it("rejects a wrong API key: 401", async () => {
    const res = await postJson(
      { authorization: "Bearer wrong-key" },
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    );
    assert.equal(res.status, 401);
  });

  it("accepts the x-api-key header as well as Bearer", async () => {
    const res = await postJson(
      { "x-api-key": API_KEY },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "raw", version: "0" },
        },
      },
    );
    assert.equal(res.status, 200);
  });

  it("404s unknown paths with a structured error", async () => {
    const res = await fetch(new URL("/nope", baseUrl), {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error?: { code?: string } };
    assert.equal(body.error?.code, "not_found");
  });
});

describe("http tools over a real MCP client", () => {
  it("tools/list returns both tools with annotations intact", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["diagnose_claim", "record_entitlement_event"]);
    const diag = tools.find((t) => t.name === "diagnose_claim");
    assert.equal(diag?.annotations?.readOnlyHint, true);
    const rec = tools.find((t) => t.name === "record_entitlement_event");
    assert.equal(rec?.annotations?.readOnlyHint, false);
  });

  it("record then diagnose: ledger state is shared across requests", async () => {
    const record = await client.callTool({
      name: "record_entitlement_event",
      arguments: {
        stripeEventId: "evt_http_test_1",
        type: "charge.succeeded",
        customerEmail: "http-buyer@example.com",
        chargeId: "ch_http_1",
        amountCents: 4200,
        state: "paid",
        receivedAt: "2026-10-10T00:00:00Z",
      },
    });
    assert.notEqual(record.isError, true);
    const recordText = (record.content as { text: string }[])[0]?.text ?? "";
    assert.ok(recordText.includes('"inserted": true'), recordText);

    const result = await client.callTool({
      name: "diagnose_claim",
      arguments: {
        claimId: "claim-http-1",
        customerEmail: "http-buyer@example.com",
        subject: "Charged twice",
        body: "You charged me twice for the same order.",
        channel: "email",
      },
    });
    assert.notEqual(result.isError, true);
    const text = (result.content as { text: string }[])[0]?.text ?? "";
    const diagnosis = JSON.parse(text) as {
      triageLevel: string;
      verifiedProof: { entitlementMatched: boolean };
    };
    assert.equal(diagnosis.verifiedProof.entitlementMatched, true);
    assert.ok(["P1", "P2", "P3"].includes(diagnosis.triageLevel));
  });

  it("invalid tool input returns an isError result, not a crash", async () => {
    const bad = await client.callTool({
      name: "diagnose_claim",
      arguments: {
        claimId: "claim-http-bad",
        customerEmail: "not-an-email",
        subject: "s",
        body: "b",
      },
    });
    assert.equal(bad.isError, true);
  });
});
