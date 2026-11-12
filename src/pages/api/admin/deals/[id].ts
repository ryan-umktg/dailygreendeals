import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { DEAL_TYPES, SCOPES } from '../../../../lib/extract';
import { back, fbool, fnum, fromLocalInput, fstr } from '../../../../lib/form';

export const prerender = false;

const now = () => new Date().toISOString();

export const POST: APIRoute = async ({ params, request }) => {
  const e = env as Env;
  const id = Number(params.id);
  const f = await request.formData();
  const action = fstr(f, 'action', 30);
  const returnTo = fstr(f, 'return_to', 200) ?? '/admin/';
  const deal = await e.DB.prepare('SELECT id, pending_changes FROM deals WHERE id = ?').bind(id).first<{ id: number; pending_changes: string | null }>();
  if (!deal) return new Response('Deal not found', { status: 404 });

  if (action === 'save' || action === 'approve') {
    const scope = fstr(f, 'scope', 20);
    const type = fstr(f, 'deal_type', 20);
    await e.DB.prepare(
      `UPDATE deals SET title = ?, scope = ?, deal_type = ?, value_pct = ?, value_amount = ?, value_text = ?, code = ?, url = ?,
         starts_at = ?, ends_at = ?, is_ongoing = ?, min_order = ?, new_customers_only = ?, subscribe_only = ?, restrictions = ?,
         featured = ?, updated_at = ?,
         status = CASE WHEN ? THEN 'approved' ELSE status END,
         approved_at = CASE WHEN ? THEN ? ELSE approved_at END,
         needs_review = CASE WHEN ? THEN NULL ELSE needs_review END
       WHERE id = ?`,
    )
      .bind(
        fstr(f, 'title', 160) ?? 'Untitled deal',
        (SCOPES as readonly string[]).includes(scope ?? '') ? scope : 'sitewide',
        (DEAL_TYPES as readonly string[]).includes(type ?? '') ? type : 'other',
        fnum(f, 'value_pct'),
        fnum(f, 'value_amount'),
        fstr(f, 'value_text', 200),
        fstr(f, 'code', 60),
        fstr(f, 'url', 1000),
        fromLocalInput(fstr(f, 'starts_at', 20)),
        fromLocalInput(fstr(f, 'ends_at', 20)),
        fbool(f, 'is_ongoing'),
        fnum(f, 'min_order'),
        fbool(f, 'new_customers_only'),
        fbool(f, 'subscribe_only'),
        fstr(f, 'restrictions', 1000),
        fbool(f, 'featured'),
        now(),
        action === 'approve' ? 1 : 0,
        action === 'approve' ? 1 : 0,
        now(),
        action === 'approve' ? 1 : 0,
        id,
      )
      .run();
  } else if (action === 'reject') {
    await e.DB.prepare(`UPDATE deals SET status = 'rejected', updated_at = ? WHERE id = ?`).bind(now(), id).run();
  } else if (action === 'expire') {
    await e.DB.prepare(`UPDATE deals SET status = 'expired', needs_review = NULL, updated_at = ? WHERE id = ?`).bind(now(), id).run();
  } else if (action === 'keep') {
    await e.DB.prepare(`UPDATE deals SET needs_review = NULL, last_seen_at = ?, updated_at = ? WHERE id = ?`).bind(now(), now(), id).run();
  } else if (action === 'apply_changes' && deal.pending_changes) {
    const c = JSON.parse(deal.pending_changes) as Record<string, unknown>;
    const cols = ['title', 'scope', 'deal_type', 'value_pct', 'value_amount', 'value_text', 'collection_name', 'category_slugs', 'code', 'url', 'starts_at', 'ends_at', 'is_ongoing', 'min_order', 'new_customers_only', 'subscribe_only', 'restrictions', 'source_email_id'];
    await e.DB.prepare(
      `UPDATE deals SET ${cols.map((k) => `${k} = ?`).join(', ')}, pending_changes = NULL, needs_review = NULL, updated_at = ? WHERE id = ?`,
    )
      .bind(...cols.map((k) => (c[k] ?? null) as string | number | null), now(), id)
      .run();
  } else if (action === 'dismiss_changes') {
    await e.DB.prepare(`UPDATE deals SET pending_changes = NULL, needs_review = NULL, updated_at = ? WHERE id = ?`).bind(now(), id).run();
  } else {
    return new Response('Unknown action', { status: 400 });
  }
  return back(returnTo);
};
