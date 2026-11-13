/** Mark unmatched emails sent more than 30 days ago as ignored (old backlog that was in the inbox). */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { back } from '../../../../lib/form';

export const prerender = false;

export const POST: APIRoute = async () => {
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
  await (env as Env).DB.prepare(`UPDATE inbound_emails SET status = 'ignored' WHERE status = 'unmatched' AND COALESCE(sent_at, received_at) < ?`)
    .bind(cutoff)
    .run();
  return back('/admin/inbox/');
};
