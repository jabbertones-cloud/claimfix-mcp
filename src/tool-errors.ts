/**
 * TL-009 (fleet error envelope, step 2 of 4): structured tool errors.
 *
 * Adopted from the proven WWDC choke-point shape
 * (wwdc-mcp-server src/services/format.ts toolError()) — the fleet's
 * minimal envelope — rather than CommerceOS's typed-class variant,
 * which is sized for a multi-provider dispatch layer this 2-tool
 * server does not have. Same wire contract either way:
 *
 *   { isError: true,
 *     content: [{ type: "text", text: message }],
 *     structuredContent: { error, status, tool, message, ... } }
 *
 * `status` is the fleet taxonomy from
 * ~/workspace/testlabs/ERROR-ENVELOPE-STANDARD.md §3.1. Text mirrors
 * structuredContent.message exactly (spec: structured content is
 * mirrored as serialized text for backwards compatibility).
 *
 * Handler-originated failures only. SDK-level validation errors
 * (missing/wrong args) still arrive via the SDK's own isError text —
 * accepted gap per the standard §4 step 2 (model-readable, right
 * channel, cosmetic prefix). The `arguments: null` → -32603 class
 * lives below product code on all three fleet servers (step 4,
 * fleet/SDK tracking) and is untouched here.
 */

export type ToolErrorStatus =
  | "invalid_input"
  | "not_found"
  | "not_configured"
  | "not_performed"
  | "upstream_failure"
  | "internal";

export interface ToolErrorEnvelope {
  error: string;
  status: ToolErrorStatus;
  tool: string;
  message: string;
  hint?: string;
  retryable?: boolean;
  [extra: string]: unknown;
}

export function toolError(options: {
  tool: string;
  error: string;
  status: ToolErrorStatus;
  message: string;
  hint?: string;
  retryable?: boolean;
  fields?: Record<string, unknown>;
}): {
  isError: true;
  content: [{ type: "text"; text: string }];
  structuredContent: ToolErrorEnvelope;
} {
  const { tool, error, status, message, hint, retryable, fields } = options;
  const structuredContent: ToolErrorEnvelope = {
    error,
    status,
    tool,
    message,
    ...(hint ? { hint } : {}),
    ...(retryable ? { retryable: true } : {}),
    ...(fields ?? {}),
  };
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent,
  };
}

/**
 * Convert an unexpected handler throw into the canonical envelope.
 * The original error goes to stderr (operator logs) only — raw
 * messages, stack traces, and internal detail never reach the client
 * (standard §3.3 never-leak list).
 */
export function toolErrorFromCaught(err: unknown, tool: string) {
  console.error(`[claimfix] ${tool} failed unexpectedly:`, err);
  return toolError({
    tool,
    error: "internal_error",
    status: "internal",
    message: `Tool '${tool}' failed unexpectedly. The failure has been logged for the operator.`,
  });
}
