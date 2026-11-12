import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { back, fstr } from '../../../../lib/form';
import { requeue } from '../../../../lib/ingest';

export const prerender = false;

export const POST: APIRoute = async ({ params, request }) => {
  const e = env as Env;
  const id = Number(params.id);
  const f = await request.formData();
  const action = fstr(f, 'action', 30);
  if (action === 'rerun') {
    const r = await requeue(e, id);
    if (!r.ok) return new Response(r.error, { status: 409 });
  } else if (action === 'ignore') {
    await e.DB.prepare(`UPDATE inbound_emails SET status = 'ignored' WHERE id = ?`).bind(id).run();
  } else if (action === 'confirmed') {
    await e.DB.prepare(`UPDATE inbound_emails SET confirmation_url = NULL, kind = 'confirmation' WHERE id = ?`).bind(id).run();
  } else {
    return new Response('Unknown action', { status: 400 });
  }
  return back(fstr(f, 'return_to', 200) ?? '/admin/inbox/');
};
