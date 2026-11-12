const DEAL_COLUMNS = `d.*, c.name AS company_name, e.subject AS email_subject`;

export async function dealsWithProducts(env: Env, where: string, order: string, binds: unknown[] = []) {
  const deals = (
    await env.DB.prepare(
      `SELECT ${DEAL_COLUMNS} FROM deals d JOIN companies c ON c.id = d.company_id
       LEFT JOIN inbound_emails e ON e.id = d.source_email_id WHERE ${where} ORDER BY ${order} LIMIT 200`,
    )
      .bind(...binds)
      .all<Record<string, any>>()
  ).results;
  const ids = deals.map((d) => d.id);
  const products = ids.length
    ? (await env.DB.prepare(`SELECT * FROM deal_products WHERE deal_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<Record<string, any>>()).results
    : [];
  return deals.map((d) => ({ deal: d, products: products.filter((p) => p.deal_id === d.id) }));
}
