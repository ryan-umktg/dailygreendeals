/**
 * POST /api/ingest/  - called by the inbox poller with one raw email (message/rfc822) per request.
 * Auth: Authorization: Bearer <INGEST_TOKEN>. Optional ?alias= when the poller knows the signup address.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ingestRaw } from '../../../lib/ingest';
import { tokenOk } from '../../../lib/ingest-auth';

export const prerender = false;

const MAX_BYTES = 15 * 1024 * 1024;

export const POST: APIRoute = async ({ request, url }) => {
  const e = env as Env;
  if (!tokenOk(request.headers.get('authorization'), e.INGEST_TOKEN)) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BYTES) return Response.json({ ok: false, error: 'too large' }, { status: 413 });

  const raw = await request.arrayBuffer();
  if (!raw.byteLength) return Response.json({ ok: false, error: 'empty body' }, { status: 400 });

  const result = await ingestRaw(e, raw, { alias: url.searchParams.get('alias') ?? undefined });
  return Response.json({ ok: true, ...result });
};
