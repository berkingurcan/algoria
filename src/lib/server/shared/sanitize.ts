const CONTROL_AND_BIDI = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;

export function sanitizeUntrustedText(value: unknown, maxLength = 500): string {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_AND_BIDI, '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function safeErrorMessage(error: unknown, fallback = 'Upstream service unavailable'): string {
  if (!(error instanceof Error)) return fallback;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return 'Upstream request timed out';
  return sanitizeUntrustedText(error.message, 180) || fallback;
}
