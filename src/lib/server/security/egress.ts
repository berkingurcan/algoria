import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';
import type { FetchLike } from '@modelcontextprotocol/client';

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]
] as const) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32]
] as const) blocked.addSubnet(network, prefix, 'ipv6');

function isBlocked(address: string): boolean {
  const family = isIP(address);
  if (!family) return true;
  if (family === 6 && address.toLowerCase().startsWith('::ffff:')) {
    return isBlocked(address.slice(7));
  }
  return blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

function isCloudflareWorker(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';
}

async function resolvePublicAddresses(hostname: string, family = 0) {
  const addresses = await dnsLookup(hostname, {
    all: true,
    verbatim: true,
    family: family === 4 || family === 6 ? family : 0
  });
  if (addresses.length === 0 || addresses.some((item) => isBlocked(item.address))) {
    throw new Error('Endpoint resolves to a private or reserved network');
  }
  return addresses;
}

// Validate DNS inside the connector and return the exact addresses that were
// checked. This closes the check/use gap that otherwise permits DNS rebinding.
const safeLookup: LookupFunction = (hostname, options, callback) => {
  const family = typeof options.family === 'number' ? options.family : 0;
  void resolvePublicAddresses(hostname, family)
    .then((addresses) => {
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    })
    .catch((error: Error) => callback(error, ''));
};

const safeDispatcher = new Agent({ connect: { lookup: safeLookup } });

export function carriesPaymentCredential(headers: UndiciRequestInit['headers']): boolean {
  const normalized = new Headers(headers as HeadersInit | undefined);
  return normalized.has('payment-signature') || normalized.has('authorization') || normalized.has('x-algoria-recovery-token');
}

export async function assertSafeExternalUrl(value: string): Promise<URL> {
  if (value.length > 2_048) throw new Error('Endpoint URL is too long');
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('Agent endpoints must use HTTPS');
  if (url.username || url.password) throw new Error('Endpoint credentials are not allowed');
  if (url.port && url.port !== '443') throw new Error('Only the HTTPS default port is allowed');
  // `URL` preserves two parser artefacts that every check below would otherwise
  // trip on. A literal IPv6 host keeps its brackets, so `isIP('[::1]')` is 0 and
  // the whole IPv6 blocklist goes unconsulted. A fully-qualified name keeps its
  // root label, so `'localhost.'` matches neither the equality test nor any
  // suffix, and DNS treats it as identical to `'localhost'`. Both are normalised
  // once here so no later check has to remember to do it.
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (
    host === 'localhost' || host.endsWith('.localhost')
    || host.endsWith('.local') || host.endsWith('.internal')
  ) {
    throw new Error('Private endpoints are not allowed');
  }
  if (isIP(host) && isBlocked(host)) {
    throw new Error('Endpoint resolves to a private or reserved network');
  }
  // Workers route global fetches through Cloudflare's public-Internet proxy,
  // which rejects private/internal destinations. Node does not provide that
  // boundary, so local and test runtimes keep the DNS-pinned dispatcher.
  if (!isCloudflareWorker()) await resolvePublicAddresses(host);
  return url;
}

export interface SafeResponse {
  response: Response;
  finalUrl: string;
}

export async function safeExternalFetch(value: string, init: UndiciRequestInit, redirects = 0): Promise<SafeResponse> {
  const url = await assertSafeExternalUrl(value);
  const response = isCloudflareWorker()
    ? await globalThis.fetch(url, { ...init, redirect: 'manual' } as RequestInit)
    : await undiciFetch(url, { ...init, dispatcher: safeDispatcher, redirect: 'manual' }) as unknown as Response;
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    if (redirects >= 3) throw new Error('Too many endpoint redirects');
    if (carriesPaymentCredential(init.headers)) {
      throw new Error('Paid agent requests may not redirect');
    }
    const location = response.headers.get('location');
    if (!location) throw new Error('Endpoint redirect has no location');
    const next = new URL(location, url);
    const nextMethod = response.status === 303 ? 'GET' : init.method;
    return safeExternalFetch(next.toString(), {
      ...init,
      method: nextMethod,
      body: nextMethod === 'GET' || nextMethod === 'HEAD' ? undefined : init.body
    }, redirects + 1);
  }
  return { response, finalUrl: url.toString() };
}

/**
 * MCP transports accept a custom fetch implementation. Route every transport
 * request through the same DNS-pinned egress policy as regular agent calls so
 * MCP cannot become a separate SSRF or redirect bypass.
 */
export const safeMcpFetch: FetchLike = async (input, init) => {
  const request = new Request(input, init);
  const body = request.method === 'GET' || request.method === 'HEAD'
    ? undefined
    : await request.arrayBuffer();
  const { response } = await safeExternalFetch(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    signal: request.signal
  });
  return response;
};

export async function readBoundedResponse(response: Response, maxBytes = 1_048_576): Promise<unknown> {
  const lengthHeader = response.headers.get('content-length');
  if (lengthHeader !== null) {
    if (!/^\d+$/.test(lengthHeader) || BigInt(lengthHeader) > BigInt(maxBytes)) {
      throw new Error(`Agent response exceeds ${maxBytes} bytes`);
    }
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel('Response limit exceeded').catch(() => undefined);
          throw new Error(`Agent response exceeds ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try { return JSON.parse(text); } catch { return text; }
  }
  return text;
}
