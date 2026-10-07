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
  refund or explain), `duplicate` (link to the original claim).
- **P3** — normal queue: `general_complaint`.

## Tools (stdio MCP)

- `diagnose_claim` — classify one claim. Input: `claimId`,
  `customerEmail`, `subject`, `body`, optional `channel`,
  `receivedAt`, `metadata` (`metadata.seenClaimIds` enables duplicate
  detection).
- `record_entitlement_event` — append a Stripe event
  (`stripeEventId`, `type`, `customerEmail`, `state`, ...). Same
  `stripeEventId` twice is a no-op.

## Run

```sh
npm install
npm run check   # tsc --noEmit
npm test        # node --test via tsx; no network required
npm run build && npm start   # stdio MCP server
```

## Status

v0. No LLM reasoning yet — when added, it will only refine P2/P3
wording. Tier-1 P1 classification stays rule-determined. Real Stripe
webhook wiring is not connected; the ledger interface is ready for it.
