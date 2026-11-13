/** Re-queue every email whose extraction failed (e.g. after fixing a bug or an API key). */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { back } from '../../../../lib/form';
import type { ExtractMessage } from '../../../../lib/ingest';

export const prerender = false;

export const POST: APIRoute = async () => {
  const e = env as Env;
  const ids = (
    await e.DB.prepare(
      `SELECT id FROM inbound_emails WHERE company_id IS NOT NULL AND (status = 'failed' OR (status = 'received' AND error IS NOT NULL))`,
    ).all<{ id: number }>()
  ).results.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    await e.DB.prepare(`UPDATE inbound_emails SET status = 'received', error = NULL WHERE id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk)
      .run();
    await e.EXTRACT_QUEUE.sendBatch(chunk.map((inboundId) => ({ body: { inboundId } satisfies ExtractMessage })));
  }
  return back('/admin/inbox/');
};
