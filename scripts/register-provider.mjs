#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  TESTNET_CONFIG,
  validateAgentUri,
  validateMetadataJson
} from '@trionlabs/stellar8004';
import { DataUriStorage } from '@trionlabs/stellar8004/storage/data-uri';
import { USDC_TESTNET_ADDRESS } from '@x402/stellar';

const DEFAULT_IDENTITY = 'algoria-provider-testnet';
const MAX_AGENT_URI_BYTES = 8_192;

function usage(message) {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write(
    'Usage: pnpm provider:register -- --origin https://provider.example [--identity algoria-provider-testnet] [--execute]\n'
  );
  process.exitCode = 1;
}

function options(argv) {
  const parsed = { identity: DEFAULT_IDENTITY, execute: false, origin: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--') continue;
    if (value === '--execute') parsed.execute = true;
    else if (value === '--origin') parsed.origin = argv[++index] ?? '';
    else if (value === '--identity') parsed.identity = argv[++index] ?? '';
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!parsed.origin) throw new Error('--origin is required');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(parsed.identity)) throw new Error('Identity alias is invalid');
  const origin = new URL(parsed.origin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('--origin must be a bare HTTPS origin');
  }
  parsed.origin = origin.origin;
  return parsed;
}

function stellarKey(identity, kind) {
  return execFileSync('stellar', ['keys', kind, identity], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit']
  }).trim();
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

async function loadAndValidateManifest(origin, publicKey) {
  const response = await fetch(`${origin}/api/provider/manifest`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`Provider manifest returned HTTP ${response.status}`);
  const manifest = record(await response.json());
  if (manifest.network !== 'stellar:testnet') throw new Error('Provider manifest is not pinned to stellar:testnet');
  if (manifest.paymentProtocol !== 'x402' || manifest.scheme !== 'exact') throw new Error('Provider manifest is not exact x402');
  if (manifest.asset !== USDC_TESTNET_ADDRESS) throw new Error('Provider manifest uses the wrong testnet USDC asset');
  if (manifest.payTo !== publicKey) throw new Error('Provider manifest payTo does not match the selected Keychain identity');
  if (manifest.agent8004Id !== undefined) throw new Error('Provider manifest already declares an Agent ID; refusing duplicate registration');

  const metadata = record(manifest.registrationMetadata);
  validateMetadataJson(metadata);
  const services = Array.isArray(metadata.services) ? metadata.services.map(record) : [];
  if (services.length === 0 || services.some((service) => {
    if (typeof service.endpoint !== 'string') return true;
    const endpoint = new URL(service.endpoint);
    return endpoint.origin !== origin || endpoint.protocol !== 'https:';
  })) {
    throw new Error('Every registered service must use the provider HTTPS origin');
  }
  const agentUri = await new DataUriStorage().upload(metadata);
  validateAgentUri(agentUri);
  if (Buffer.byteLength(agentUri, 'utf8') > MAX_AGENT_URI_BYTES) throw new Error('Encoded Agent URI exceeds 8 KiB');
  return { agentUri, metadata, manifest };
}

async function main() {
  let parsed;
  try {
    parsed = options(process.argv.slice(2));
  } catch (error) {
    usage(error instanceof Error ? error.message : 'Invalid arguments');
    return;
  }

  const publicKey = stellarKey(parsed.identity, 'public-key');
  const { agentUri, metadata } = await loadAndValidateManifest(parsed.origin, publicKey);
  const preview = {
    mode: parsed.execute ? 'execute' : 'dry-run',
    network: 'stellar:testnet',
    identity: parsed.identity,
    owner: publicKey,
    origin: parsed.origin,
    services: metadata.services.length,
    agentUriBytes: Buffer.byteLength(agentUri, 'utf8')
  };
  process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
  if (!parsed.execute) {
    process.stdout.write('Dry run complete. Add --execute only after reviewing this exact public deployment.\n');
    return;
  }

  // Let Stellar CLI sign with the OS Secure Store identity. The private key is
  // never exported into this process, its environment, or command arguments.
  const common = [
    'contract', 'invoke',
    '--id', TESTNET_CONFIG.contracts.identity,
    '--source-account', parsed.identity,
    '--rpc-url', TESTNET_CONFIG.rpcUrl,
    '--network-passphrase', TESTNET_CONFIG.networkPassphrase,
    '--auto-sign'
  ];
  const output = execFileSync('stellar', [
    ...common, '--', 'register_with_uri', '--caller', publicKey, '--agent_uri', JSON.stringify(agentUri)
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
  const decoded = (() => { try { return JSON.parse(output); } catch { return output; } })();
  const agentId = Number(decoded);
  if (!Number.isSafeInteger(agentId) || agentId < 0) throw new Error('Stellar CLI returned no valid Agent ID');

  const horizon = await fetch(`https://horizon-testnet.stellar.org/accounts/${publicKey}/transactions?order=desc&limit=1`, {
    headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000)
  });
  const horizonBody = horizon.ok ? record(await horizon.json()) : {};
  const embedded = record(horizonBody._embedded);
  const latest = Array.isArray(embedded.records) ? record(embedded.records[0]) : {};
  const result = {
    agentId,
    transactionHash: typeof latest.hash === 'string' ? latest.hash : undefined,
    owner: publicKey,
    origin: parsed.origin
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`Set ALGORIA_PROVIDER_AGENT_ID=${result.agentId} and ALGORIA_ALLOWED_AGENT_IDS=${result.agentId}.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Provider registration failed'}\n`);
  process.exitCode = 1;
});
