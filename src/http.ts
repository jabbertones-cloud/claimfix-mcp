#!/usr/bin/env node
/**
 * claimfix-mcp hosted entry: Streamable HTTP transport (stateless), the
 * current MCP spec's hosted default. The stdio entry (src/index.ts) is
 * unchanged; both share the tool definitions in src/server.ts.
 *
 * Auth gate (paid-MCP fleet pattern — hosted AiSCent/EzSeller /mcp answer
 * 401 unauthenticated): every request must carry the API key as
 * `Authorization: Bearer <key>` or `x-api-key: <key>`. Missing/wrong key
 * -> 401 with a structured JSON error body. This is a gate, not an
 * entitlement system: production needs a real per-customer entitlement
 * check behind it (see README / track report).
 *
 * Config (env):
 *   CLAIMFIX_API_KEY  required; server refuses to start without it
 *   PORT              default 8787
 *   HOST              default 127.0.0.1
 *
 * Run: npm run build && CLAIMFIX_API_KEY=... npm run start:http
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createClaimFixServer } from "./server.js";
import { InMemoryClaimSessionTracker } from "./claim-session.js";
import { InMemoryEntitlementLedger, type EntitlementLedger } from "./entitlement.js";

const MCP_PATH = "/mcp";

function structuredError(res: ServerResponse, status: number, code: string, message: string): void {
  const body = JSON.stringify({ error: { code, message } });
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

function keyMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isAuthorized(req: IncomingMessage, apiKey: string): boolean {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    return keyMatches(auth.slice("Bearer ".length).trim(), apiKey);
  }
  const headerKey = req.headers["x-api-key"];
  return keyMatches(typeof headerKey === "string" ? headerKey : undefined, apiKey);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  return JSON.parse(raw);
}

export function createClaimFixHttpServer(options: {
  apiKey: string;
  ledger?: EntitlementLedger;
}): Server {
  const ledger = options.ledger ?? new InMemoryEntitlementLedger();
  // TL-017: duplicate-claim session memory is shared process-wide, like
  // the ledger — a fresh tracker per request would never see a duplicate.
  const claimSession = new InMemoryClaimSessionTracker();

  return createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== MCP_PATH) {
        structuredError(res, 404, "not_found", `No route for ${url.pathname}; the MCP endpoint is ${MCP_PATH}`);
        return;
      }
      if (!isAuthorized(req, options.apiKey)) {
        res.setHeader("WWW-Authenticate", "Bearer");
        structuredError(res, 401, "unauthorized", "Missing or invalid API key. Send Authorization: Bearer <key>.");
        return;
      }

      // Stateless mode: a fresh server+transport per request (spec-recommended
      // for hosted scaling); the ledger is shared so tools keep one state.
      const server = createClaimFixServer(ledger, claimSession);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);

      let body: unknown;
      if (req.method === "POST") {
        try {
          body = await readJsonBody(req);
        } catch {
          structuredError(res, 400, "parse_error", "Request body is not valid JSON.");
          return;
        }
      }
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        structuredError(res, 500, "internal_error", "Internal server error.");
      } else if (!res.writableEnded) {
        res.end();
      }
      console.error("claimfix-mcp http error:", err);
    }
  });
}

async function main(): Promise<void> {
  const apiKey = process.env.CLAIMFIX_API_KEY;
  if (!apiKey) {
    console.error(
      "CLAIMFIX_API_KEY is not set — refusing to start an unauthenticated paid endpoint. " +
        "Set CLAIMFIX_API_KEY and re-run.",
    );
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "127.0.0.1";
  const httpServer = createClaimFixHttpServer({ apiKey });
  httpServer.listen(port, host, () => {
    console.error(`claimfix-mcp http listening on http://${host}:${port}${MCP_PATH}`);
  });
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  main().catch((err) => {
    console.error("claimfix-mcp http failed to start:", err);
    process.exit(1);
  });
}
