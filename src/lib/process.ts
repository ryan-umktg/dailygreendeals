/**
 * Queue consumer work: run extraction on one stored email and write the results.
 * - new    → a draft deal (with product rows for product-specific deals)
 * - same   → bumps last_seen_at on the existing deal; that's how ongoing deals stay current
 * - update → drafts are overwritten; live deals get pending_changes for Ryan to apply
 */
import { DEAL_TYPES, SCOPES, extractDeals, parseStoredEmail, type ExtractedDeal, type KnownDeal } from './extract';

const nowIso = () => new Date().toISOString();

/** Dates from the model → UTC ISO. A bare date means the end of that day, US Eastern. */
export function normalizeDate(value: string | null | undefined, endOfDay: boolean): string | null {
  if (!value) return null;
  const v = value.trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(v);
  const d = new Date(dateOnly ? `${v}T${endOfDay ? '23:59:59' : '00:00:00'}-05:00` : v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const s = (v: unknown, max = 500) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const b = (v: unknown) => (v === true ? 1 : 0);

function clean(d: ExtractedDeal, categories: Set<string>) {
  return {
    title: s(d.title, 160) ?? 'Untitled deal',
    scope: (SCOPES as readonly string[]).includes(d.scope) ? d.scope : 'sitewide',
    deal_type: (DEAL_TYPES as readonly string[]).includes(d.deal_type) ? d.deal_type : 'other',
    value_pct: n(d.value_pct),
    value_amount: n(d.value_amount),
    value_text: s(d.value_text, 200),
    collection_name: s(d.collection_name, 120),
    category_slugs: JSON.stringify((d.category_slugs ?? []).filter((c) => categories.has(c))),
    code: s(d.code, 60),
    url: s(d.url, 1000),
    starts_at: normalizeDate(d.starts_at, false),
    ends_at: normalizeDate(d.ends_at, true),
    is_ongoing: b(d.is_ongoing),
    min_order: n(d.min_order),
    new_customers_only: b(d.new_customers_only),
    subscribe_only: b(d.subscribe_only),
    restrictions: s(d.restrictions, 1000),
    confidence: Math.max(0, Math.min(1, n(d.confidence) ?? 0.5)),
  };
}
type CleanDeal = ReturnType<typeof clean>;
const FIELDS = Object.keys(clean({} as ExtractedDeal, new Set())) as (keyof CleanDeal)[];

export async function processEmail(env: Env, inboundId: number) {
  const row = await env.DB.prepare(
    `SELECT e.id, e.r2_key, e.subject, e.sent_at, e.received_at, e.company_id, c.name AS company_name
     FROM inbound_emails e JOIN companies c ON c.id = e.company_id WHERE e.id = ?`,
  )
    .bind(inboundId)
    .first<{ id: number; r2_key: string; subject: string | null; sent_at: string | null; received_at: string; company_id: number; company_name: string }>();
  if (!row) return; // unmatched or deleted: nothing to do

  const obj = await env.RAW_EMAILS.get(row.r2_key);
  if (!obj) throw new Error(`Raw email missing from R2: ${row.r2_key}`);
  const parsed = await parseStoredEmail(await obj.arrayBuffer());

  const known = (
    await env.DB.prepare(
      `SELECT id, title, scope, deal_type, code, value_pct, value_amount, value_text, ends_at, status
       FROM deals WHERE company_id = ?
         AND (status IN ('draft', 'approved') OR (status = 'rejected' AND updated_at > ?)) ORDER BY id`,
    )
      .bind(row.company_id, new Date(Date.now() - 60 * 86_400_000).toISOString())
      .all<KnownDeal>()
  ).results;
  const knownIds = new Map(known.map((d) => [d.id, d]));

  const categories = (await env.DB.prepare('SELECT slug FROM categories').all<{ slug: string }>()).results.map((r) => r.slug);
  const cannabinoids = (await env.DB.prepare('SELECT slug FROM cannabinoids').all<{ slug: string }>()).results.map((r) => r.slug);
  const categorySet = new Set(categories);
  const cannabinoidSet = new Set(cannabinoids);

  const result = await extractDeals(env, {
    companyName: row.company_name,
    sentAt: row.sent_at ?? row.received_at,
    subject: row.subject,
    text: parsed.text,
    links: parsed.links,
    images: parsed.images,
    knownDeals: known,
    categories,
    cannabinoids,
  });

  const seenAt = row.sent_at ?? nowIso();
  const stmts: D1PreparedStatement[] = [];
  let created = 0;

  for (const raw of result.deals) {
    const existing = raw.existing_deal_id != null ? knownIds.get(raw.existing_deal_id) : undefined;
    const action = existing ? raw.action : 'new'; // an unknown id means we treat it as new

    if (action === 'same' && existing) {
      stmts.push(
        env.DB.prepare(
          `UPDATE deals SET last_seen_at = MAX(last_seen_at, ?),
             needs_review = CASE WHEN needs_review LIKE 'Not seen%' THEN NULL ELSE needs_review END,
             updated_at = ? WHERE id = ?`,
        ).bind(seenAt, nowIso(), existing.id),
      );
      continue;
    }

    // A deal Ryan already rejected: don't bring it back, just note it was seen.
    if (existing?.status === 'rejected') {
      stmts.push(env.DB.prepare('UPDATE deals SET last_seen_at = MAX(last_seen_at, ?) WHERE id = ?').bind(seenAt, existing.id));
      continue;
    }

    const d = clean(raw, categorySet);

    if (action === 'update' && existing) {
      if (existing.status === 'draft') {
        stmts.push(
          env.DB.prepare(
            `UPDATE deals SET ${FIELDS.map((f) => `${f} = ?`).join(', ')}, last_seen_at = ?, source_email_id = ?, updated_at = ? WHERE id = ?`,
          ).bind(...FIELDS.map((f) => d[f]), seenAt, inboundId, nowIso(), existing.id),
        );
      } else {
        stmts.push(
          env.DB.prepare(
            `UPDATE deals SET pending_changes = ?, needs_review = 'A newer email changed this deal', last_seen_at = ?, updated_at = ? WHERE id = ?`,
          ).bind(JSON.stringify({ ...d, source_email_id: inboundId }), seenAt, nowIso(), existing.id),
        );
      }
      continue;
    }

    // New deal: insert, then its products (D1 batches run in order, so last_insert_rowid() is this deal).
    created++;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO deals (company_id, ${FIELDS.join(', ')}, status, first_seen_at, last_seen_at, source_email_id)
         VALUES (?, ${FIELDS.map(() => '?').join(', ')}, 'draft', ?, ?, ?)`,
      ).bind(row.company_id, ...FIELDS.map((f) => d[f]), seenAt, seenAt, inboundId),
    );
    if (d.scope === 'product') {
      for (const p of raw.products ?? []) {
        const name = s(p.product_name, 200);
        if (!name) continue;
        stmts.push(
          env.DB.prepare(
            `INSERT INTO deal_products (deal_id, product_name, product_url, category_slug, cannabinoids, mg_per_unit, units_per_pack, price_regular, price_deal)
             VALUES ((SELECT MAX(id) FROM deals WHERE source_email_id = ?), ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            inboundId,
            name,
            s(p.product_url, 1000),
            p.category_slug && categorySet.has(p.category_slug) ? p.category_slug : null,
            JSON.stringify((p.cannabinoids ?? []).filter((c) => cannabinoidSet.has(c.slug)).map((c) => ({ slug: c.slug, mg: n(c.mg) }))),
            n(p.mg_per_unit),
            n(p.units_per_pack),
            n(p.price_regular),
            n(p.price_deal),
          ),
        );
      }
    }
  }

  stmts.push(
    env.DB.prepare(
      `UPDATE inbound_emails SET status = 'extracted', kind = ?, confirmation_url = ?, deals_found = ?, error = NULL WHERE id = ?`,
    ).bind(result.kind, s(result.confirmation_url, 2000), created, inboundId),
  );
  await env.DB.batch(stmts);
  return { kind: result.kind, created, total: result.deals.length };
}

/** Nightly: expire ended deals and flag live deals that newsletters have stopped mentioning. */
export async function nightlyMaintenance(env: Env) {
  const now = nowIso();
  const stale = new Date(Date.now() - 14 * 86_400_000).toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE deals SET status = 'expired', updated_at = ? WHERE status IN ('approved', 'draft') AND ends_at IS NOT NULL AND ends_at < ?`).bind(now, now),
    env.DB.prepare(
      `UPDATE deals SET needs_review = 'Not seen in a newsletter for 14 days', updated_at = ?
       WHERE status = 'approved' AND ends_at IS NULL AND is_ongoing = 0 AND last_seen_at < ? AND needs_review IS NULL`,
    ).bind(now, stale),
  ]);
}
