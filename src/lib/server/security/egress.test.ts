import { describe, expect, it } from 'vitest';
import { assertSafeExternalUrl, carriesPaymentCredential, readBoundedResponse, safeMcpFetch } from './egress';

describe('agent egress policy', () => {
  it('detects payment credentials case-insensitively', () => {
    expect(carriesPaymentCredential({ 'PAYMENT-SIGNATURE': 'signed' })).toBe(true);
    expect(carriesPaymentCredential({ Authorization: 'Payment credential' })).toBe(true);
    expect(carriesPaymentCredential({ 'X-Algoria-Recovery-Token': 'secret' })).toBe(true);
    expect(carriesPaymentCredential({ Accept: 'application/json' })).toBe(false);
  });

  it('rejects direct private and loopback endpoints', async () => {
    await expect(assertSafeExternalUrl('https://127.0.0.1/agent')).rejects.toThrow(/private|reserved/);
    await expect(assertSafeExternalUrl('http://example.com/agent')).rejects.toThrow(/HTTPS/);
  });

  // `URL` reports a literal IPv6 host bracketed, and `isIP` rejects that form, so
  // testing the hostname as given made the whole IPv6 blocklist unreachable.
  it('rejects literal IPv6 loopback, link-local, and unique-local endpoints', async () => {
    await expect(assertSafeExternalUrl('https://[::1]/agent')).rejects.toThrow(/private|reserved/);
    await expect(assertSafeExternalUrl('https://[::]/agent')).rejects.toThrow(/private|reserved/);
    await expect(assertSafeExternalUrl('https://[fe80::1]/agent')).rejects.toThrow(/private|reserved/);
    await expect(assertSafeExternalUrl('https://[fc00::1]/agent')).rejects.toThrow(/private|reserved/);
    await expect(assertSafeExternalUrl('https://[::ffff:127.0.0.1]/agent')).rejects.toThrow(/private|reserved/);
  });

  // Cloud metadata and the alternate encodings `URL` normalises on the way in.
  it('rejects cloud metadata and re-encoded loopback addresses', async () => {
    await expect(assertSafeExternalUrl('https://169.254.169.254/latest/meta-data')).rejects.toThrow(/private|reserved/);
    await expect(assertSafeExternalUrl('https://0.0.0.0/agent')).rejects.toThrow(/private|reserved/);
    await expect(assertSafeExternalUrl('https://2130706433/agent')).rejects.toThrow(/private|reserved/);
    await expect(assertSafeExternalUrl('https://0177.0.0.1/agent')).rejects.toThrow(/private|reserved/);
  });

  // Named for what it actually covers: the static suffix test, which rejects these
  // before any DNS lookup happens. The resolution path is exercised separately by
  // the dispatcher, not here.
  it('rejects internal-looking hostnames by name', async () => {
    await expect(assertSafeExternalUrl('https://agent.localhost/agent')).rejects.toThrow(/private/i);
    await expect(assertSafeExternalUrl('https://db.internal/agent')).rejects.toThrow(/private/i);
    await expect(assertSafeExternalUrl('https://printer.local/agent')).rejects.toThrow(/private/i);
  });

  // A fully-qualified name keeps its root label through `URL`, and DNS resolves
  // `localhost.` exactly like `localhost`, so the dot must not carry a host past
  // the suffix checks. On Workers those checks are the only ones that run.
  it('rejects internal hostnames written with a trailing root dot', async () => {
    await expect(assertSafeExternalUrl('https://localhost./agent')).rejects.toThrow(/private/i);
    await expect(assertSafeExternalUrl('https://db.internal./agent')).rejects.toThrow(/private/i);
    await expect(assertSafeExternalUrl('https://printer.local./agent')).rejects.toThrow(/private/i);
  });

  it('applies the same egress policy to MCP transport requests', async () => {
    await expect(safeMcpFetch('https://127.0.0.1/mcp')).rejects.toThrow(/private|reserved/);
  });

  it('stops streaming responses as soon as they exceed the byte limit', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('four'));
        controller.enqueue(new TextEncoder().encode('more'));
        controller.close();
      }
    }));
    await expect(readBoundedResponse(response, 6)).rejects.toThrow(/exceeds 6 bytes/);
  });

  it('parses bounded JSON responses', async () => {
    const response = new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' }
    });
    await expect(readBoundedResponse(response, 64)).resolves.toEqual({ ok: true });
  });
});
