/**
 * POST /api/ingest/known/  {"message_ids": ["<abc@x>", ...]}
 * Tells the inbox poller which emails the site already has, so it doesn't download them again.
 * Answer: {"known": {"abc@x": true|false}} where the value says whether it's matched to a store.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { tokenOk } from '../../../lib/ingest-auth';

export const prerender = false;

const core = (id: string) => id.trim().replace(/^<|>$/g, '');

export const POST: APIRoute = async ({ request }) => {
  const e = env as Env;
  if (!tokenOk(request.headers.get('authorization'), e.INGEST_TOKEN)) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { message_ids?: unknown };
  const ids = Array.isArray(body.message_ids) ? body.message_ids.filter((x): x is string => typeof x === 'string' && !!x.trim()).slice(0, 400) : [];

  const known: Record<string, boolean> = {};
  // Stored Message-IDs may or may not keep their angle brackets, so ask for both forms.
  // 400 ids = 800 forms = 9 queries, well inside the free plan's 50 calls per request.
  const forms = ids.flatMap((id) => [`<${core(id)}>`, core(id)]);
  for (let i = 0; i < forms.length; i += 90) {
    const chunk = forms.slice(i, i + 90);
    const rows = (
      await e.DB.prepare(`SELECT message_id, company_id FROM inbound_emails WHERE message_id IN (${chunk.map(() => '?').join(',')})`)
        .bind(...chunk)
        .all<{ message_id: string; company_id: number | null }>()
    ).results;
    for (const r of rows) known[core(r.message_id)] = r.company_id != null;
  }
  return Response.json({ ok: true, known });
};
