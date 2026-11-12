/**
 * Worker entry: Astro serves every HTTP request; this file adds the extraction queue consumer
 * and the nightly cron (both configured in wrangler.jsonc).
 */
import { handle } from '@astrojs/cloudflare/handler';
import type { ExtractMessage } from './lib/ingest';
import { nightlyMaintenance, processEmail } from './lib/process';

const MAX_ATTEMPTS = 3;

export default {
  fetch: handle,

  async queue(batch: MessageBatch<ExtractMessage>, env: Env) {
    for (const message of batch.messages) {
      const { inboundId } = message.body;
      try {
        await processEmail(env, inboundId);
        message.ack();
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.error('extraction failed', inboundId, error);
        const final = message.attempts >= MAX_ATTEMPTS;
        await env.DB.prepare(`UPDATE inbound_emails SET error = ?, status = CASE WHEN ? THEN 'failed' ELSE status END WHERE id = ?`)
          .bind(error.slice(0, 1000), final ? 1 : 0, inboundId)
          .run();
        if (final) message.ack();
        else message.retry({ delaySeconds: 60 * message.attempts });
      }
    }
  },

  async scheduled(_controller: ScheduledController, env: Env) {
    await nightlyMaintenance(env);
  },
} satisfies ExportedHandler<Env, ExtractMessage>;
