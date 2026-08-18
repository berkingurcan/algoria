# Controlled provider protocol

The reference provider is deliberately deterministic. It exists to make Stellar 8004 identity, HTTP invocation, exact x402 payment, and recovery failures observable without mixing in model quality or another vendor dependency.

## Services

- `POST /api/provider/summarize` returns a bounded leading-sentence summary.
- `POST /api/provider/extract` extracts requested `field: value` lines.
- `POST /api/provider/classify` chooses one supplied label by stable token overlap.

All three routes accept JSON, require `X-Algoria-Correlation-Id: <uuid>` plus a random 32-byte base64url `X-Algoria-Recovery-Token`, and cost `0.01` testnet USDC. `GET /api/provider/manifest` returns the exact schemas, examples, Stellar 8004 registration metadata, network, asset, recipient, and recovery template. The recovery token is not logged or stored directly; only its SHA-256 hash is retained.

## x402 exchange

1. An unpaid request returns `402` with x402 v2 `PAYMENT-REQUIRED`.
2. The only accepted requirement is exact `stellar:testnet` USDC for `100000` atomic units.
3. A request with `PAYMENT-SIGNATURE` is verified by the configured facilitator.
4. The deterministic handler runs only after verification.
5. Successful settlement returns the Artifact, a Payment Receipt, and `PAYMENT-RESPONSE`.
6. The correlation id is bound to the service and canonical parsed input. Reusing it for different work returns `409`.
7. Replaying the same settled request returns the stored Artifact and Payment Receipt without another facilitator call or settlement.

## Recovery

`GET /api/provider/status/{correlationId}` requires the original recovery token header and returns one bounded state:

- `200 succeeded`: Artifact and Payment Receipt are available.
- `202 processing`: do not submit another payment while work is in progress.
- `202 uncertain`: settlement may have happened; do not submit another payment. Lean v0 requires operator review and does not claim automatic reconciliation.
- `409 failed`: the recorded terminal failure code is returned.
- `404`: no verified provider run exists for that correlation id.

The optional `ALGORIA_PROVIDER_TEST_TOKEN` enables only the `response-loss` adversarial mode. With matching `X-Algoria-Test-Token` and `X-Algoria-Test-Mode: response-loss`, the provider settles and persists success, then deliberately withholds the normal success response. Recovery must return the stored result without settling again.

Algoria binds the recovery URL into the immutable reviewed request snapshot. After a lost paid response it performs a same-origin status lookup with the original recovery token; it never resends the payment credential as a recovery mechanism.

The unit harness injects facilitator outcomes for terminal failure and indeterminate timeout. It preserves the facilitator error reason instead of replacing all failures with one generic message. A live testnet run still requires a receiving G-address, testnet USDC support for that address, and an on-chain Stellar 8004 Agent Identity.

## Testnet registration

The operator key stays in the Stellar CLI secure store. The application receives only its public G-address through `ALGORIA_PROVIDER_PAY_TO`.

After deploying the provider to a stable HTTPS origin, validate its exact manifest without touching the chain:

```bash
pnpm provider:register -- --origin https://provider.example
```

The dry run requires the manifest to advertise `stellar:testnet`, exact x402, the canonical testnet USDC SAC, the selected Keychain public address, and same-origin HTTPS service endpoints. It encodes the canonical SDK metadata as a bounded data URI.

Only after reviewing that output, register once:

```bash
pnpm provider:register -- --origin https://provider.example --execute
```

The script asks Stellar CLI to sign with `algoria-provider-testnet` in the OS secure store; the private key is never exported into the Node process, environment, or command arguments. It returns only the Agent ID and transaction hash. Set that ID in both `ALGORIA_PROVIDER_AGENT_ID` and `ALGORIA_ALLOWED_AGENT_IDS`. If the manifest already declares an Agent ID, the script refuses to create a duplicate.

The current controlled deployment is Agent `13` on testnet. Registration transaction: `ddcd8f0075b9e2fe61c938a089d1bfe7d7849a5f21851f060a0cf9a2eae7811b`.
