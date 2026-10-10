#!/usr/bin/env node
/**
 * claimfix-mcp: Claim triage and dispute-resolution MCP server (stdio).
 *
 * Tools are defined once in src/server.ts and shared with the hosted
 * Streamable HTTP entry (src/http.ts, `npm run start:http`).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClaimFixServer } from "./server.js";

async function main() {
  const server = createClaimFixServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("claimfix-mcp failed to start:", err);
  process.exit(1);
});
