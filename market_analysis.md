# Algoria: Market Analysis

*Prepared for SCF #45, Open Track. Last verified 2026-08-17. Companion to [technical_doc.md](./technical_doc.md).*


Stellar has 28 community agent skills and zero consumer applications. That is the gap Algoria fills, and it is countable rather than asserted.

**Inside Stellar.** The skills directory at skills.stellar.org lists 28 community skills. Payments are covered: MPP Discover pays 90+ API services in Stellar USDC, Nirium ships x402 seller scaffolding live on mainnet, ROZO Checkout settles AI service invoices, StellarTools offers hosted checkout and subscriptions. Agent spending policy is covered by Eunomia with contract-bounded non-custodial accounts, per-payment limits, whitelists and session keys. Escrow is covered by Trustless Work, and Cogladius runs an agent task board with escrow payouts. All 28 are developer tools, SDKs, MCP servers or payment infrastructure. None is something a non-developer opens.

**The standards.** On-chain agent commerce is settling on two: 8004 for identity and reputation, x402 for HTTP-native stablecoin micropayments. Stellar has the payment half natively, with a mainnet facilitator through the OpenZeppelin Relayer plugin, sub-five-second settlement and native USDC through SEP-41. Stellar's official x402 documentation covers payment end to end and says nothing about agent identity or reputation. We closed that gap by putting 8004 on Stellar mainnet.

**Off Stellar.** NEAR AI Agent Market launched in February 2026: users post jobs, agents bid, escrow settles in the NEAR token, a dispute agent arbitrates. It is an auction for autonomous agent-to-agent commerce, it settles in a volatile network token, and its public documentation describes no identity or reputation layer. Virtuals Protocol on Ethereum and Base is the closest architecturally, combining 8004 identity, x402 payments and escrow, but each agent typically launches its own token and value accrues through speculation and buy-and-burn. Algoria has no platform token and no per-agent token. USDC is the only unit of account, which keeps pricing predictable and keeps us inside SCF's rule against token-promotion projects. MoonPay's PayBox, launched July 2026, puts a non-custodial wallet inside ChatGPT and Claude across eight chains, and AgentCash does the same for agent developers. Both are payment vaults. Neither has a registry, reputation or discovery, so neither tells you which agent to hire or whether it was worth paying.

**What we build versus what we compose.** Discovery is our own published MCP. Payment rails are the network's x402. Escrow we left to Trustless Work and Cogladius. What is new here is writing reputation on settlement in one flow, so paying an agent leaves a public record of whether it was worth paying. No payment router or escrow contract on Stellar does that today. The Build adds permissionless routing so every registered agent is reachable, an Agent Profile Registry so each one has a resolvable name, and a consumer surface someone who has never held XLM can use.

## The case against this

An empty category can mean an opening or it can mean no market, and the count above cannot tell you which. We think the honest position is that nobody has proven consumer demand for hiring AI agents with crypto, anywhere, on any chain. NEAR's market, 0G's AIverse and Coinbase's Agentic.Market all launched in 2026 and none has published consumer traction. Early x402 volume includes a meaningful share of test and speculative traffic. And for most tasks a person can already use a chat assistant on a monthly subscription, which is a better experience than connecting a wallet.

So the demand signal we have is supply-side and indirect: 28 skills built, 261 BUIDL submissions and 591 hackers out of SDF's Stellar Hacks: Agents in March and April 2026, and an 8004 Identity Registry on mainnet whose agent count anyone can read. People are building agents on Stellar. Whether people will pay them from a chat is the open question.

That is why the mainnet targets in tranche 3 are stated as counts on a public registry rather than as a forecast. 40 distinct wallets with a completed paid job, 100 settled payments, and 5 agents we did not build carrying reputation written by Algoria users are all reproducible from the 8004 indexer and Stellar Expert by anyone, at any time, whatever the numbers turn out to be. The deliverable is the measurement, not the claim.

## How Algoria earns

Revenue sits at the transaction layer and starts at first volume rather than at a token unlock: 2% on every x402 payment settled through Algoria, margins on our own agents which are priced above their API cost, and a flat $1 to claim a name in the Agent Profile Registry. No platform token, no per-agent token, no markup on compute.

Volume during a 14-week build is close to nothing by design. A hundred settled payments at per-call agent prices is a few tens of dollars. We are proving the path and building the fee mechanism, not chasing revenue before mainnet.

---

## Reference: the 28 community skills at skills.stellar.org

Verified 2026-08-16. Grouped by what they do, to show where Algoria overlaps and where it does not.

**Payments and checkout.** MPP Discover (mpprouter) pays 90+ API services in Stellar USDC through MPP Router. Nirium Agentic Payments (nirium-protocol) charges agents per API call over x402, live on mainnet. ROZO Checkout and ROZO Intents (RozoAI) settle AI service invoices and move USDC across seven chains. StellarTools (payrouteshq) offers hosted checkout, subscriptions and customer portals.

**Agent spending policy.** Eunomia Bounded Agent Treasury (eunomia-finance) provides non-custodial contract-bounded spending accounts with per-payment limits, whitelists, session keys and on-chain ZK compliance checks.

**Escrow and task boards.** Trustless Work Escrow provides escrow and milestone payment workflows with a REST API, React hooks and UI components. Cogladius (furkanyesildag) registers agents to earn XLM on on-chain tasks with escrow payouts.

**Discovery.** Stellar Agent Search (berkingurcan), our own, finds and vets on-chain 8004 agents by natural-language query. LumenLoop MCP Connect provides read-only ecosystem directory queries.

**Developer tooling.** OpenZeppelin Contracts, DeFindex SDK, Soroswap SDK, Caatinga, Agent Browser WebAuthn, Soroban Common Mistakes, Sozu Testnet USDC Faucet, Contextio SDK, Sub Rosa, Anchors (CheesecakeLabs), and seven research and positioning skills from lumenloop and stellarlight.xyz.

Every entry above is a developer tool, an SDK, an MCP server, or payment infrastructure. None is an application a non-developer opens. That is the gap.

## Why this matters for Stellar

Algoria reads and writes the open, MIT-licensed 8004 registries. The `feedback` gate is open on both deployments, and a settled payment lets its payer write a reputation entry, a score and up to two tags, which **the client signs with their own key**. Algoria builds that transaction and never holds a key that could author a review on someone's behalf, so the record is attributable to the account that actually paid. Every paid job through Algoria therefore adds a reputation entry any other Stellar application can read for free, and growth in Algoria is growth in shared Stellar infrastructure rather than a closed dataset. If the demand question above answers no, Stellar still keeps the registries, the discovery MCP and the measurement.
