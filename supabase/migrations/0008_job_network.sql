-- Jobs never recorded which Stellar network they ran on, because a deployment
-- served exactly one and the answer was implicit. The mainnet deployment shares
-- this database, so the network becomes part of a Job's identity: an agent id is
-- only unique within one registry, and operator tooling must never resolve a
-- mainnet Job with testnet configuration. Payment records already carry it.
alter table public.jobs add column if not exists network text;

-- Every row that exists today was produced by the testnet deployment.
update public.jobs set network = 'stellar:testnet' where network is null;

-- No default: the inserting deployment must state its own network, so a missing
-- value fails loudly instead of silently claiming to be testnet.
alter table public.jobs alter column network set not null;

create index if not exists jobs_network_state_idx on public.jobs(network, state);
