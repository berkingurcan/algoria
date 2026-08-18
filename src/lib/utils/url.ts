export function normalizeEndpoint(value: string): string {
  const url = new URL(value);
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
    url.port = '';
  }
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}

export function endpointKey(value: string): string {
  try {
    return normalizeEndpoint(value);
  } catch {
    return value.trim().toLowerCase();
  }
}
