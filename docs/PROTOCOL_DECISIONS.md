# Protocol expansion decisions: MPP, A2A, runtime MCP

Status: **decided 2026-08-16. All three protocols stay deferred and fail-closed.** Owner: Berkin Gurcan. This confirms the current boundary rather than changing it: MPP, A2A, and runtime MCP remain hard fail-closed (`501 unsupported-policy`), and no runtime behavior changes. Re-opening any of them requires completing that protocol's checklist below and recording a new dated decision here.

This document exists because the lean v0 rule is *decide on paper before touching the boundary*. The v0 promise is the baseline every expansion must preserve: one task, one allowlisted service, one reviewed request, one separately signed exact payment, one artifact and receipt.

## Decision framework

A protocol may leave the fail-closed set only when all six are true:

1. **Consent semantics defined.** What exactly does the user review and authorize, and what can the protocol do that the reviewed snapshot does not show? If the answer is "anything", it does not ship.
2. **Failure and recovery story written.** Every money-adjacent state must be enumerated like x402's (`quoted → signed → settled/failed/reconciling/expired`), with a bounded recovery mechanism that never resubmits a credential.
3. **Replay and idempotency guarantees.** Equivalent of the correlation-id + recovery-token + atomic-claim design; a lost response must be recoverable without a second payment or duplicate execution.
4. **Payment binding.** The payment (if any) must bind to the exact reviewed work, verified server-side against stored state, capped, and separately approved.
5. **Tests before exposure.** Unit harness with injected failures (like the provider facilitator harness), integration checks, and a live canary stage.
6. **Explicit product approval.** Recorded here, per protocol, with a named decision date.

## MPP (Multi-Party Payments)

- **Current state:** `mppPayment: false`; `payments/mpp.ts` is `never`-typed with zero callers; a `402` carrying `www-authenticate` without an x402 header fails with `unsupported-policy`; the `mppx` dependency was removed. DB types still allow `protocol: 'mpp'` as schema headroom, not behavior.
- **What enabling requires:** an MPP quote parser with the same exactness discipline as `parseX402Quote`, a multi-party recipient review UI (the user must see *every* payee and split), cap semantics across parts, and a settlement-evidence story per part.
- **Open risks:**
  - Split payments break the current "one recipient, one amount, one cap check" review model; partial settlement (some parts settle, some fail) has no recovery vocabulary in v0.
  - Quote exactness is harder: any mutable part list between review and signing is a consent violation.
  - No controlled MPP counterparty exists to test against; building one is a precondition, as the deterministic provider was for x402.
- **Decision (2026-08-16): deferred.** Re-evaluate only when a concrete paid service on the allowlist actually requires MPP.

## A2A (agent-to-agent execution)

- **Current state:** `a2aExecution: false`; no implementation exists anywhere; selection rejects the declared protocol.
- **What enabling requires:** a task-lifecycle mapping onto Jobs (A2A tasks are long-lived and multi-turn; Jobs are one-shot), streaming/webhook ingestion inside the SSRF policy, and a consent model for multi-turn exchanges where the agent can ask follow-ups.
- **Open risks:**
  - Multi-turn means the reviewed snapshot no longer bounds the interaction, and the core v0 consent primitive ("job approval authorizes exactly this request") does not survive without a new per-turn approval design.
  - Long-lived remote tasks need server-side state polling that v0 deliberately does not have (no cron, no reconciler).
  - Agent-supplied follow-up questions are untrusted content rendered to the user, which is prompt-injection surface directly into the consent flow.
- **Decision (2026-08-16): deferred.** Requires the per-turn consent design first; nothing else is worth writing until that exists.

## Runtime MCP execution

- **Current state:** `mcpExecution: false`; `execution/mcp.ts` ships a gated client with no callers; `/api/jobs` accepts only `http` action kinds; selection rejects `mcp` protocol declarations (they resolve to `unsupported-protocol`).
- **What enabling requires:** tool-list retrieval and tool choice inside the egress policy, a review UI that shows tool name + exact arguments (the preview type already models this), session semantics (MCP is stateful; snapshots are not), and payment binding for paid MCP servers (x402-over-MCP is not standardized).
- **Open risks:**
  - Tool descriptions are untrusted and model-visible during tool choice, which is injection surface at selection time, before the user reviews anything.
  - A stateful session between prepare and execute breaks snapshot immutability: the same tool call can mean different things against different session state.
  - Response size/time bounding exists for HTTP; MCP transports (SSE/websocket-like streams) need their own bounds.
- **Decision (2026-08-16): deferred.** Closest to feasible of the three (the preview/consent model already fits single tool calls), but blocked on the statefulness and paid-MCP questions. This is the first candidate to revisit if the v0 boundary is ever widened.

## Related gates (for completeness)

Public Bazaar discovery and open catalog discovery remain fail-closed under the same framework; their trigger is product-driven (catalog growth beyond the controlled allowlist). On-chain feedback was fail-closed on the same terms when this document was decided on 2026-08-16, waiting on a reputation strategy worth signing for. It has since been opened, once a payment had actually settled, and is offered only on a succeeded job with a settled payment. The entry is signed by the payer's own wallet, so Algoria holds no key that could write reputation on anyone's behalf. Mainnet promotion is governed by `docs/SECURITY.md` (separate security review, settlement reconciliation, adversarial tests, explicit approval) and is out of scope for this document; that promotion has since been carried out, and mainnet now runs as a separate deployment on its own origin with its own keys and a tighter per-payment cap.

## Promotion checklist (copy per protocol when approved)

- [ ] Consent semantics documented and reviewed
- [ ] State machine + recovery story documented
- [ ] Replay/idempotency design implemented
- [ ] Payment binding implemented and capped
- [ ] Unit harness with injected failures
- [ ] Controlled counterparty deployed and allowlisted
- [ ] Live canary stage added to `pnpm smoke`
- [ ] Product approval recorded here with date and owner
