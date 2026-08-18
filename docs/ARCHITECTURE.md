# Architecture

## Lean request lifecycle

1. A user sends a message. A small conversational layer handles greetings; a concrete task enters routing.
2. Routing considers only the operator-controlled Stellar 8004 allowlist for the deployment's network and returns at most one recommended HTTP service.
3. After wallet authentication, the server re-resolves the selected identity, verifies the allowlist and endpoint, compiles the exact request, and shows it without executing it.
4. Job approval authorizes one immutable HTTP request snapshot.
5. A successful free response is returned directly. A supported `402` response creates a short-lived, one-use exact x402 quote.
6. The user reviews the deployment's network, USDC SAC, amount, recipient, and a live quote-expiry countdown, then signs in the wallet. An expired quote blocks signing and offers a fresh run instead.
7. The server verifies the stored quote hash still matches the reviewed challenge, revalidates the credential against it, and retries the same request snapshot once. It stores the result and payment receipt.
8. If the controlled provider's paid response is lost, Algoria performs one same-origin, token-authenticated status lookup. A stored success completes the Job without resubmitting the payment; an indeterminate outcome stays visibly uncertain.

The Job Card is persisted before egress, so an interrupted run remains visible after reload instead of disappearing, and a completed outcome can never be overwritten by a late bookkeeping failure. Two authenticated endpoints keep the client honest afterwards: `GET /api/jobs/{id}` returns the authoritative Job Card rebuilt from the database, and `POST /api/jobs/{id}/recover` re-drives the same-origin recovery lookup for a Job stuck in `executing` or `payment-uncertain` (or closes a stale unpaid probe). Recovery never resubmits a payment credential and marks a Job succeeded only with settlement evidence.

The network and feature policy is centralized in `src/lib/constants.ts` and enforced by `src/lib/server/network/policy.ts`. API routes fail closed if deployment configuration disagrees with the active network profile. Bazaar routing, open catalog discovery, MCP execution, MPP and A2A are explicit false feature gates; mainnet and on-chain feedback were opened once each had something real behind it.

## Feature gate map

Every disabled v0 feature maps to a `false` flag in `LEAN_V0_FEATURES` (`src/lib/constants.ts`) plus fail-closed enforcement. The two gates that have since been opened are listed here as well, with what still bounds them:

| Feature | Gate | Enforcement |
| --- | --- | --- |
| Mainnet | `mainnet: true` | One deployment serves exactly one network, selected by `PUBLIC_STELLAR_NETWORK`: a testnet deployment, and a pubnet deployment on its own origin with its own signing key, JWT secret, and session pepper. `validateLeanV0Configuration` + `assertPinnedSdkProfile` re-derive that profile from the installed SDKs and reject a disagreeing environment on every `/api/*` request (`hooks.server.ts`); quote validation re-pins network/asset. A pubnet deployment fails closed if the gate is ever set back to `false` |
| Open catalog discovery | `openCatalogDiscovery: false` | `/api/catalog/search` returns `501` unconditionally; `searchCatalog` gate in `catalog/search.ts` |
| Bazaar routing | `bazaarRouting: false` | Gate at the top of `catalog/bazaar.ts`; `assertLeanV0Selection` and `catalog/resolve.ts` reject `x402-bazaar` sources |
| Runtime MCP | `mcpExecution: false` | Gates in `execution/mcp.ts`; selection rejects `mcp` protocol; `/api/jobs` accepts only `http` action kinds |
| MPP | `mppPayment: false` | `payments/mpp.ts` is `never`-typed; a `402` with `www-authenticate` but no x402 header fails with `unsupported-policy` |
| A2A | `a2aExecution: false` | No implementation exists; selection rejects the declared protocol |
| On-chain feedback | `feedback: true` | `POST /api/jobs/{id}/feedback` assembles an unsigned entry for the payer's own address; `PUT` re-reads the signed transaction field by field before submitting. Offered only on a succeeded job with a settled payment, one per job |

`/api/health` echoes the deployed flag state, and `pnpm smoke` fails if it drifts from this table.

## Active boundaries

- `src/lib/server/network`: deployment profile, allowlist, protocol, and payment-policy gates
- `src/lib/server/auth`: SEP-10 challenges on the active network and short-lived Supabase-compatible sessions
- `src/lib/server/catalog`: direct identity-contract lookup on the active network, bounded metadata loading, and live selection re-resolution
- `src/lib/server/execution`: bounded, SSRF-checked HTTP execution
- `src/lib/server/payments`: exact x402 parsing pinned to the active network and policy enforcement
- `src/lib/server/provider`: controlled deterministic services, x402 resource-server adapter, and correlation/recovery state
- `src/lib/server/db`: user-scoped conversation history and server-only job, receipt, and audit writes
- `src/lib/client`: wallet selection for the active network and x402 signing
- `src/lib/components`: thread, proposal, request review, payment review, and result UI

Legacy modules for later protocols may remain in the repository, but no v0 route may reach them. Unsupported routes return `501 unsupported-policy`; a deployment profile mismatch returns `503 network-policy-mismatch`.

## Data model

All database access is server-side through the Supabase secret key and every user-facing query explicitly filters the authenticated Algoria user UUID. RLS and table grants remain defense in depth; Algoria's SEP-10 JWT is not treated as a Supabase Auth token. Jobs retain request/result state, while payment records and audit events preserve minimal operational receipts. Controlled provider runs are server-only: Supabase stores the request hash, Artifact, Payment Receipt, x402 response, and only a SHA-256 hash of the random recovery token for 30 days. Existing schema support for later features is not a claim that those features are active.

The production shell runs as a SvelteKit Worker with static assets on Cloudflare. Node development uses DNS-pinned Undici egress. In Workers, `global_fetch_strictly_public` plus Cloudflare's outbound proxy prevents access to private/internal origins, while the application still enforces HTTPS, default port, literal-IP, credential, redirect, timeout, and response-size rules.

Catalog metadata is never authoritative browser state. A selection must be allowlisted and re-resolved on the server before preparation and again before execution.
