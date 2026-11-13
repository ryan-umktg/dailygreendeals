/** Create or update a store, its signup addresses, and re-run any unmatched emails that now match it. */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { back, fall, fnum, fstr, slugify } from '../../../lib/form';
import { matchWaitingEmails } from '../../../lib/ingest';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const e = env as Env;
  const f = await request.formData();
  const name = fstr(f, 'name', 120);
  if (!name) return new Response('Name is required', { status: 400 });
  const id = fnum(f, 'id');
  const slug = slugify(fstr(f, 'slug', 60) ?? name);
  const values = [
    slug,
    name,
    fstr(f, 'website', 300),
    fstr(f, 'description', 2000),
    JSON.stringify(fall(f, 'cannabinoids_sold')),
    JSON.stringify(fall(f, 'categories_sold')),
    fstr(f, 'shipping_notes', 2000),
    fnum(f, 'free_shipping_min'),
    fstr(f, 'lab_results_url', 500),
    fstr(f, 'status', 10) === 'paused' ? 'paused' : 'active',
  ];

  let companyId: number;
  if (id) {
    await e.DB.prepare(
      `UPDATE companies SET slug = ?, name = ?, website = ?, description = ?, cannabinoids_sold = ?, categories_sold = ?,
         shipping_notes = ?, free_shipping_min = ?, lab_results_url = ?, status = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(...values, new Date().toISOString(), id)
      .run();
    companyId = id;
  } else {
    const existing = await e.DB.prepare('SELECT id FROM companies WHERE slug = ?').bind(slug).first<{ id: number }>();
    if (existing) return new Response(`A store called "${name}" already exists. Edit it on the Stores page instead.`, { status: 409 });
    const row = await e.DB.prepare(
      `INSERT INTO companies (slug, name, website, description, cannabinoids_sold, categories_sold, shipping_notes, free_shipping_min, lab_results_url, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
      .bind(...values)
      .first<{ id: number }>();
    companyId = row!.id;
  }

  // One address per line: signup addresses (vivimu@dailygreendeals.com) or sender domains (@vivimu.com).
  const addresses = (fstr(f, 'addresses', 4000) ?? '')
    .split(/[\s,]+/)
    .map((a) => a.trim().toLowerCase())
    .filter((a) => /^[a-z0-9._%+-]*@[a-z0-9.-]+\.[a-z]{2,}$/.test(a));
  const shared = String(e.NON_STORE_ADDRESSES ?? '').split(',').map((a) => a.trim().toLowerCase()).filter((a) => addresses.includes(a));
  if (shared.length) {
    return new Response(
      `${shared.join(', ')} is a shared signup address used for many stores, so it can't identify one store. Add the store's sender domain instead (e.g. @vivimu.com).`,
      { status: 400 },
    );
  }
  const taken = addresses.length
    ? (
        await e.DB.prepare(
          `SELECT address FROM email_sources WHERE company_id != ? AND address IN (${addresses.map(() => '?').join(',')})`,
        )
          .bind(companyId, ...addresses)
          .all<{ address: string }>()
      ).results.map((r) => r.address)
    : [];
  if (taken.length) return new Response(`Already linked to another store: ${taken.join(', ')}`, { status: 409 });

  await e.DB.batch([
    e.DB.prepare('DELETE FROM email_sources WHERE company_id = ?').bind(companyId),
    ...addresses.map((a) => e.DB.prepare('INSERT INTO email_sources (address, company_id) VALUES (?, ?)').bind(a, companyId)),
  ]);

  // Emails that arrived before this store existed: match and extract them now.
  // A fixed handful of calls however many are waiting (the free Workers plan allows 50 per request).
  await matchWaitingEmails(e, companyId, addresses);

  return back('/admin/stores/');
};
