/** Constant-time check of the poller's "Authorization: Bearer <INGEST_TOKEN>" header. */
export function tokenOk(header: string | null, expected: string | undefined) {
  if (!expected || !header?.startsWith('Bearer ')) return false;
  const a = new TextEncoder().encode(header.slice(7));
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
