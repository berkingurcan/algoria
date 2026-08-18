const DEFAULT_MAX_REQUEST_BYTES = 128 * 1024;

export async function readBoundedJsonObject(
  request: Request,
  maxBytes = DEFAULT_MAX_REQUEST_BYTES
): Promise<Record<string, unknown>> {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || BigInt(length) > BigInt(maxBytes))) {
    throw new Error(`Request body exceeds ${maxBytes} bytes`);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.body?.getReader();
  if (!reader) throw new Error('A JSON request body is required');
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('Request body limit exceeded').catch(() => undefined);
        throw new Error(`Request body exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const value = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('JSON request body must be an object');
  }
  return value as Record<string, unknown>;
}
