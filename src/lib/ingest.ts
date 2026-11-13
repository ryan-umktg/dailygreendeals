/**
 * Takes one raw newsletter (as received by info@ on PrivateEmail), stores it in R2, records it in
 * inbound_emails, matches it to a store and queues it for deal extraction.
 */
import PostalMime from 'postal-mime';

export const SITE_DOMAIN = 'dailygreendeals.com';

export type ExtractMessage = { inboundId: number };

export type IngestResult =
  | { status: 'duplicate'; id: number; matched: boolean }
  | { status: 'queued'; id: number; companyId: number }
  | { status: 'unmatched'; id: number; alias: string | null };

const lower = (s?: string | null) => (s ?? '').trim().toLowerCase();

function nonStoreAddresses(env: Env) {
  return new Set(
    String(env.NON_STORE_ADDRESSES ?? '')
      .split(',')
      .map(lower)
      .filter(Boolean),
  );
}

/** The store signup address a newsletter was sent to, e.g. vivimu@dailygreendeals.com. */
export function findAlias(env: Env, candidates: (string | null | undefined)[]): string | null {
  const skip = nonStoreAddresses(env);
  for (const c of candidates) {
    for (const match of lower(c).matchAll(/[a-z0-9._%+-]+@([a-z0-9.-]+)/g)) {
      const address = match[0];
      if (match[1] === SITE_DOMAIN && !skip.has(address)) return address;
    }
  }
  return null;
}

/**
 * Match a store by sender domain first (stored as "@vivimu.com"; @email.vivimu.com also matches),
 * then by the store-specific signup address. Shared addresses (NON_STORE_ADDRESSES, e.g. info@ and
 * kimberly@) never identify a store: many brands mail them.
 */
export async function findCompanyId(env: Env, alias: string | null, fromAddress: string | null) {
  const keys: string[] = [];
  const domain = lower(fromAddress).split('@')[1];
  if (domain) {
    keys.push(`@${domain}`);
    const parts = domain.split('.');
    if (parts.length > 2) keys.push(`@${parts.slice(-2).join('.')}`);
  }
  if (alias && !nonStoreAddresses(env).has(lower(alias))) keys.push(lower(alias));
  for (const key of keys) {
    const row = await env.DB.prepare('SELECT company_id FROM email_sources WHERE address = ?').bind(key).first<{ company_id: number }>();
    if (row) return row.company_id;
  }
  return null;
}

export async function ingestRaw(env: Env, raw: ArrayBuffer, hint: { alias?: string } = {}): Promise<IngestResult> {
  const email = await PostalMime.parse(raw);
  const header = (name: string) => email.headers.filter((h) => h.key === name).map((h) => h.value);

  const messageId = email.messageId?.trim() || null;
  if (messageId) {
    const existing = await env.DB.prepare('SELECT id, company_id FROM inbound_emails WHERE message_id = ?')
      .bind(messageId)
      .first<{ id: number; company_id: number | null }>();
    if (existing) return { status: 'duplicate', id: existing.id, matched: existing.company_id != null };
  }

  const alias = findAlias(env, [
    hint.alias,
    ...header('delivered-to'),
    ...header('x-original-to'),
    ...(email.to ?? []).map((a) => a.address),
    ...(email.cc ?? []).map((a) => a.address),
  ]);
  const fromAddress = lower(email.from?.address) || null;
  const companyId = await findCompanyId(env, alias, fromAddress);

  const now = new Date();
  const key = `raw/${now.toISOString().slice(0, 10).replaceAll('-', '/')}/${crypto.randomUUID()}.eml`;
  await env.RAW_EMAILS.put(key, raw, { httpMetadata: { contentType: 'message/rfc822' } });

  let sentAt: string | null = null;
  if (email.date) {
    const d = new Date(email.date);
    if (!Number.isNaN(d.getTime())) sentAt = d.toISOString();
  }

  const row = await env.DB.prepare(
    `INSERT INTO inbound_emails (message_id, r2_key, alias, from_address, subject, sent_at, company_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(messageId, key, alias, fromAddress, email.subject ?? null, sentAt, companyId, companyId ? 'received' : 'unmatched')
    .first<{ id: number }>();
  const id = row!.id;

  if (!companyId) return { status: 'unmatched', id, alias };
  await env.EXTRACT_QUEUE.send({ inboundId: id } satisfies ExtractMessage);
  return { status: 'queued', id, companyId };
}

/** Re-run matching and extraction for a stored email (admin "Re-run" button, or after adding a store). */
export async function requeue(env: Env, inboundId: number) {
  const row = await env.DB.prepare('SELECT alias, from_address FROM inbound_emails WHERE id = ?')
    .bind(inboundId)
    .first<{ alias: string | null; from_address: string | null }>();
  if (!row) return { ok: false as const, error: 'Email not found' };
  const companyId = await findCompanyId(env, row.alias, row.from_address);
  if (!companyId) {
    await env.DB.prepare("UPDATE inbound_emails SET status = 'unmatched', company_id = NULL WHERE id = ?").bind(inboundId).run();
    return { ok: false as const, error: 'No store matches this email yet. Add its address to a store first.' };
  }
  await env.DB.prepare("UPDATE inbound_emails SET status = 'received', company_id = ?, error = NULL WHERE id = ?")
    .bind(companyId, inboundId)
    .run();
  await env.EXTRACT_QUEUE.send({ inboundId } satisfies ExtractMessage);
  return { ok: true as const };
}

/** Link unmatched emails to a store that was just added or edited, and queue them for extraction. */
export async function matchWaitingEmails(env: Env, companyId: number, addresses: string[]) {
  if (!addresses.length) return 0;
  const skip = nonStoreAddresses(env);
  const set = new Set(addresses.filter((a) => !skip.has(a)));
  const waiting = (
    await env.DB.prepare(`SELECT id, alias, from_address FROM inbound_emails WHERE status = 'unmatched'`).all<{
      id: number;
      alias: string | null;
      from_address: string | null;
    }>()
  ).results;
  const ids = waiting
    .filter((w) => {
      const domain = lower(w.from_address).split('@')[1];
      if (domain && (set.has(`@${domain}`) || set.has(`@${domain.split('.').slice(-2).join('.')}`))) return true;
      return !!w.alias && set.has(lower(w.alias));
    })
    .map((w) => w.id);
  if (!ids.length) return 0;

  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    await env.DB.prepare(
      `UPDATE inbound_emails SET status = 'received', company_id = ?, error = NULL WHERE id IN (${chunk.map(() => '?').join(',')})`,
    )
      .bind(companyId, ...chunk)
      .run();
    await env.EXTRACT_QUEUE.sendBatch(chunk.map((inboundId) => ({ body: { inboundId } satisfies ExtractMessage })));
  }
  return ids.length;
}
