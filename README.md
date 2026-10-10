# claimfix-mcp

Claim triage and dispute-resolution MCP server. It takes a raw customer
complaint and returns a structured diagnosis:

```
diagnose(claimPayload) -> { triageLevel, category, verifiedProof, resolutionAction, ruleHits }
```

## How it works

1. **Tier-1 deterministic rules run first.** Legal threats, chargeback
   threats, and do-not-contact requests are classified P1 by pure
   pattern rules over the payload — no network, no clock, no LLM.
   P1 hits short-circuit; they never wait on entitlement lookups.
2. **Entitlement verification.** The claim's email is matched against an
   append-only ledger of Stripe webhook events, keyed by UNIQUE
   `stripeEventId` (idempotent on redelivery). v0 ships an in-memory
   ledger; a Postgres-backed one with a UNIQUE constraint is the
   production replacement behind the same interface.
3. Everything else falls through to P3 general complaint.

## Triage tiers

- **P1** — act now: `dnd_request` (suppress contact), `legal_threat`
  (escalate to legal), `chargeback_risk` (hold fulfillment, review).
- **P2** — verify then act: `billing_dispute` (check entitlement, then
  refund or explain), `pending_authorization_hold` (explain the hold,
  verify the actual charge), `duplicate` (link to the original claim).
- **P3** — normal queue: `general_complaint`.

## Tools (stdio MCP)

- `diagnose_claim` — classify one claim. Input: `claimId`,
  `customerEmail`, `subject`, `body`, optional `channel`,
  `receivedAt`, `metadata`. Duplicate detection unions
  `metadata.seenClaimIds` with server-session memory: resubmitting
  identical claimId+content in the same session is flagged, and the
  rule detail discloses which source(s) fired (TL-017).
- `record_entitlement_event` — append a Stripe event
  (`stripeEventId`, `type`, `customerEmail`, `state`, ...). Same
  `stripeEventId` with an identical payload is a no-op; the same id with
  a materially different payload keeps the original and returns
  `conflict: true` with a reason (TL-012).

Validation contract (TL-013/TL-019, enforced in `src/schemas.ts`):
`state` must be one of `paid` / `refunded` / `disputed` / `failed` /
`active`; `type` a dotted Stripe-style event type over a known resource
family; `amountCents` a non-negative integer; `receivedAt` ISO-8601.
Garbage is rejected at the boundary, so it can never be recorded and
later presented inside `verifiedProof`. Identifiers (`claimId`,
`stripeEventId`) are trimmed, then must be non-empty — whitespace-only
ids are rejected and padding never reaches the ledger.

Triage integrity (TL-010/TL-011): tier-1 P1 rules apply the same
negation guard billing has — "do not remove me", "not disputing",
"not going to sue", "do not refund me" never escalate as assertions.
Entitlement proof is the most recent *entitlement-bearing* event by
`receivedAt` (ties: later insertion), so out-of-order webhooks and
unrelated events like `customer.updated` cannot displace charge proof.

Rules depth (TL-014–TL-018): stated-vs-charged amount mismatches
("receipt says $49 but my card was charged $94") surface as their own
contradiction facet and as a billing signal — visible even when a P1
rule wins triage; same-sentence contradictions surface like
two-sentence ones. Spanish P1 phrase sets route chargeback threats,
do-not-contact requests, and legal threats to their P1 categories
(negated Spanish statements do not escalate; more languages slot in as
phrase sets in `src/rules.ts`). Billing matching tolerates one-typo
tokens ("charged twise", "chrged twise") within an edit-distance-1
bound that excludes confusable real words. Pending-hold /
authorization claims route to `pending_authorization_hold` with a
hold-explanation action instead of falling through to P3 — while a
negated "charged twice" still never fires billing.

Both tools declare MCP `annotations` (TestLabs gap #7, verified by
`~/workspace/testlabs/regressions/claimfix-annotations.mjs`):
`diagnose_claim` is read-only + idempotent; `record_entitlement_event`
writes but is append-only, non-destructive, and idempotent on
`stripeEventId`. Neither talks to an external system (`openWorldHint:
false`).

Unknown extra arguments (TestLabs gap #8): currently stripped by Zod's
default object behaviour, not rejected. Tightening to strict mode was
investigated and deliberately not done — it would break existing callers
that send harmless extra keys, while a misspelled required key already
fails validation. This is the pinned contract until an announced breaking
change.

## Run

```sh
npm install
npm run check   # tsc --noEmit
npm test        # node --test via tsx; no network required
npm run build && npm start   # stdio MCP server
```

### Hosted (Streamable HTTP)

Same tools, hosted transport (stateless Streamable HTTP, the MCP spec's
hosted default). Tool definitions are shared with stdio via
`src/server.ts`; only the transport differs.

```sh
npm run build
CLAIMFIX_API_KEY=<key> npm run start:http   # http://127.0.0.1:8787/mcp
```

- Auth gate: every request needs `Authorization: Bearer <key>` (or
  `x-api-key: <key>`); missing/wrong key -> 401 with a structured JSON
  error. The server refuses to start without `CLAIMFIX_API_KEY`.
- Env: `PORT` (default 8787), `HOST` (default 127.0.0.1).
- Dogfood with a real MCP client: `node --import tsx scripts/dogfood-http.ts`
- Note: the API key is a gate, not an entitlement system — production
  still needs per-customer entitlement checks and durable ledger storage.

## Status

v0. No LLM reasoning yet — when added, it will only refine P2/P3
wording. Tier-1 P1 classification stays rule-determined. Real Stripe
webhook wiring is not connected; the ledger interface is ready for it.
