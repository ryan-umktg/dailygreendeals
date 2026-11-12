/**
 * POST /api/ingest/  - called by the inbox poller with one raw email (message/rfc822) per request.
 * Auth: Authorization: Bearer <INGEST_TOKEN>. Optional ?alias= when the poller knows the signup address.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ingestRaw } from '../../lib/ingest';

export const prerender = false;

const MAX_BYTES = 15 * 1024 * 1024;

function tokenOk(header: string | null, expected: string | undefined) {
  if (!expected || !header?.startsWith('Bearer ')) return false;
  const a = new TextEncoder().encode(header.slice(7));
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export const POST: APIRoute = async ({ request, url }) => {
  const e = env as Env;
  if (!tokenOk(request.headers.get('authorization'), e.INGEST_TOKEN)) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BYTES) return Response.json({ ok: false, error: 'too large' }, { status: 413 });

  const raw = await request.arrayBuffer();
  if (!raw.byteLength) return Response.json({ ok: false, error: 'empty body' }, { status: 400 });

  const result = await ingestRaw(e, raw, { alias: url.searchParams.get('alias') ?? undefined });
  return Response.json({ ok: true, ...result });
};
