# Product behavior

Algoria is a minimal, thread-first Stellar agent execution client. It is not an agent marketplace, social network, general-purpose chatbot, or autonomous spending agent.

## Lean v0 user promise

The user connects a Stellar wallet on the deployment's network, describes one bounded task, and receives at most one recommended service from Algoria's controlled Stellar 8004 allowlist. Before anything runs, the user reviews the service and exact HTTP request. If the service responds with an x402 challenge, the user separately reviews and signs the exact USDC payment. Algoria then returns the result and stores a receipt.

The first controlled provider offers only deterministic summarize, extract, and classify operations. This isolates identity, invocation, payment, replay, and recovery behavior from model quality. It is test infrastructure for the product path, not a claim that these three utilities are Algoria's eventual market. It runs on the testnet deployment only; the mainnet deployment ships no controlled provider and routes only to operator-vetted mainnet identities.

The interaction is:

1. Ask.
2. Review one proposal.
3. Approve the exact request.
4. If required, approve the exact x402 payment.
5. Receive the result and receipt.

Casual greetings stay in the conversation layer. A concrete task that cannot be matched produces a normal, truthful explanation; it never manufactures a failed execution or claims an agent is live.

## Trust and consent

- Stellar 8004 identity proves registry identity, not service quality or liveness.
- Only explicitly allowlisted identities are eligible in v0.
- No service runs before job approval.
- No payment is signed before a separate payment approval. The payment review shows the exact amount, asset, recipient, recovery id, and a live quote-expiry countdown; an expired quote can only produce a fresh proposal, never a silent retry.
- The per-payment cap is a hard safety ceiling, not permission to spend automatically. It is set per deployment: 1 USDC on testnet, 0.1 USDC on mainnet. An operator can tighten it by configuration but can never raise it above the compiled-in 1 USDC ceiling. A separate rolling ceiling of 2 USDC per wallet over 24 hours, counted per network, bounds repeated spend.
- The server re-resolves the selected identity and endpoint before preparing and executing it.
- When a paid outcome is lost, the card offers "Check status", which re-verifies through the provider's recovery endpoint without paying again. Uncertain outcomes stay visibly uncertain with their recovery id until verified.
- On-chain feedback is offered only on a succeeded job with a settled payment, once per job. The entry is signed by the payer's own wallet; Algoria holds no key that could write reputation on anyone's behalf.

## Outside v0

Open catalog browsing, x402 Bazaar routing, runtime MCP, MPP, A2A, autonomous multi-agent plans, and smart-account support are disabled. Each should be added only after its own semantics, failure recovery, tests, and user-facing consent are defined.
