/**
 * Turns one stored newsletter into draft deals.
 * The model sees the email (text, links, main images) plus the store's current deals, and says for each
 * offer whether it is new, an update to a known deal, or the same deal seen again.
 */
import PostalMime from 'postal-mime';

export const DEAL_TYPES = ['percent_off', 'dollars_off', 'bogo', 'bundle', 'free_gift', 'free_shipping', 'tiered', 'price_drop', 'other'] as const;
export const SCOPES = ['sitewide', 'collection', 'product'] as const;

export type ExtractedProduct = {
  product_name: string;
  product_url?: string | null;
  category_slug?: string | null;
  cannabinoids?: { slug: string; mg?: number | null }[];
  mg_per_unit?: number | null;
  units_per_pack?: number | null;
  price_regular?: number | null;
  price_deal?: number | null;
};

export type ExtractedDeal = {
  action: 'new' | 'update' | 'same';
  existing_deal_id?: number | null;
  title: string;
  scope: (typeof SCOPES)[number];
  deal_type: (typeof DEAL_TYPES)[number];
  value_pct?: number | null;
  value_amount?: number | null;
  value_text?: string | null;
  collection_name?: string | null;
  category_slugs?: string[];
  code?: string | null;
  url?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
  is_ongoing?: boolean;
  min_order?: number | null;
  new_customers_only?: boolean;
  subscribe_only?: boolean;
  restrictions?: string | null;
  confidence: number;
  products?: ExtractedProduct[];
};

export type Extraction = {
  kind: 'deals' | 'no_deals' | 'confirmation';
  confirmation_url?: string | null;
  deals: ExtractedDeal[];
};

export type KnownDeal = {
  id: number;
  title: string;
  scope: string;
  deal_type: string;
  code: string | null;
  value_pct: number | null;
  value_amount: number | null;
  value_text: string | null;
  ends_at: string | null;
  status: string;
};

const num = { type: ['number', 'null'] };
const str = { type: ['string', 'null'] };

/**
 * Structured outputs compile the schema into a grammar, with hard limits per request:
 * at most 24 optional properties and 16 properties using unions (anyOf / nullable).
 * So: every property is required, every object is closed, nullable text becomes a plain string
 * ("" = not stated, which the cleaning code already treats as null), and only nullable numbers
 * stay as unions (9 of them).
 */
function strict(node: any): any {
  if (Array.isArray(node)) return node.map(strict);
  if (!node || typeof node !== 'object') return node;
  const out: any = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v as object).map(([pk, pv]) => [pk, strict(pv)])) : strict(v);
  }
  if (Array.isArray(out.type)) {
    const { type, description, ...rest } = out;
    const nonNull = type.filter((t: string) => t !== 'null');
    if (nonNull.length === 1 && nonNull[0] === 'string') {
      return { ...rest, type: 'string', description: `${description ? `${description} ` : ''}Empty string if not stated.` };
    }
    return { ...(description ? { description } : {}), anyOf: type.map((t: string) => (t === 'null' ? { type: 'null' } : { type: t, ...rest })) };
  }
  if (out.type === 'object') {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties ?? {});
  }
  return out;
}

export const schemaStats = (schema: any) => {
  let unions = 0;
  let optional = 0;
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.type === 'object' && n.properties) {
      const req = new Set(n.required ?? []);
      for (const [k, v] of Object.entries<any>(n.properties)) {
        if (!req.has(k)) optional++;
        if (v.anyOf || Array.isArray(v.type)) unions++;
      }
    }
    Object.values(n).forEach(walk);
  };
  walk(schema);
  return { unions, optional };
};

const TOOL = {
  name: 'record_deals',
  description: 'Record every deal or promotion offered in this newsletter.',
  input_schema: {
    type: 'object',
    required: ['kind', 'deals'],
    properties: {
      kind: {
        type: 'string',
        enum: ['deals', 'no_deals', 'confirmation'],
        description:
          'confirmation = a "confirm your subscription" email. no_deals = no discount, code or promotion (e.g. blog post, product launch at full price, order update).',
      },
      confirmation_url: { ...str, description: 'For confirmation emails, the link that confirms the subscription.' },
      deals: {
        type: 'array',
        items: {
          type: 'object',
          required: ['action', 'title', 'scope', 'deal_type', 'confidence'],
          properties: {
            action: {
              type: 'string',
              enum: ['new', 'update', 'same'],
              description:
                'same = matches a known deal with no meaningful change. update = matches a known deal but something changed (end date, value, code, terms). new = not in the known deals.',
            },
            existing_deal_id: { type: ['integer', 'null'], description: 'Required for same and update: the id from the known deals list.' },
            title: { type: 'string', description: 'Short and factual, e.g. "30% off sitewide" or "Buy 2 get 1 free on gummies".' },
            scope: {
              type: 'string',
              enum: [...SCOPES],
              description: 'sitewide = whole store. collection = a category or line (all gummies). product = named products only.',
            },
            deal_type: { type: 'string', enum: [...DEAL_TYPES] },
            value_pct: { ...num, description: 'Percent off as a number, 30 for 30%. For "up to" offers use the maximum and say so in restrictions.' },
            value_amount: { ...num, description: 'Dollars off.' },
            value_text: { ...str, description: 'The offer in words when it is not a simple % or $ (BOGO, tiers, free gift).' },
            collection_name: { ...str, description: 'For collection scope, the name used in the email.' },
            category_slugs: { type: 'array', items: { type: 'string' }, description: 'Category slugs from the list given, for collection or product scope.' },
            code: { ...str, description: 'Discount code exactly as written; empty if the discount applies automatically.' },
            url: { ...str, description: 'The link the email uses for this offer (the store or product page), not an unsubscribe or tracking-pixel link.' },
            starts_at: { ...str, description: 'ISO date or date-time if stated.' },
            ends_at: { ...str, description: 'ISO date or date-time when it ends. Resolve relative dates ("ends Sunday") against the sent date.' },
            is_ongoing: { type: 'boolean', description: 'True for standing offers with no end (e.g. "always 20% off subscriptions").' },
            min_order: { ...num, description: 'Minimum order in dollars, if any.' },
            new_customers_only: { type: 'boolean' },
            subscribe_only: { type: 'boolean', description: 'Only for subscribe-and-save orders.' },
            restrictions: { ...str, description: 'Exclusions and fine print in one or two plain sentences.' },
            confidence: { type: 'number', description: '0 to 1: how sure you are this is a real, current offer with correct details.' },
            products: {
              type: 'array',
              description: 'Only for product scope: the specific products on offer.',
              items: {
                type: 'object',
                required: ['product_name'],
                properties: {
                  product_name: { type: 'string' },
                  product_url: str,
                  category_slug: str,
                  cannabinoids: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['slug'],
                      properties: { slug: { type: 'string' }, mg: { ...num, description: 'mg per unit' } },
                    },
                  },
                  mg_per_unit: { ...num, description: 'Total cannabinoid mg per gummy, capsule, ml, etc.' },
                  units_per_pack: { type: ['integer', 'null'] },
                  price_regular: num,
                  price_deal: num,
                },
              },
            },
          },
        },
      },
    },
  },
};

const MAX_TEXT = 30_000;
const MAX_IMAGES = 4;

/** Image URLs worth showing the model: skip tracking pixels, spacers, social icons and logos. */
function contentImages(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!src || !/^https:\/\//i.test(src)) continue;
    const width = Number(/\bwidth\s*=\s*["']?(\d+)/i.exec(tag)?.[1] ?? 0);
    if (width && width < 200) continue;
    if (/(pixel|track|open\.|spacer|beacon|facebook|instagram|twitter|tiktok|youtube|icon|logo)/i.test(src)) continue;
    if (!out.includes(src)) out.push(src);
    if (out.length >= MAX_IMAGES) break;
  }
  return out;
}

function links(html: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1];
    if (!/^https?:/i.test(href) || /unsubscribe|preferences|manage.?subscription/i.test(href)) continue;
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    const line = `${text || '(image link)'} -> ${href}`;
    if (seen.has(href)) continue;
    seen.add(href);
    out.push(line);
    if (out.length >= 60) break;
  }
  return out;
}

function htmlToText(html: string) {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|h\d|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

export async function parseStoredEmail(raw: ArrayBuffer) {
  const email = await PostalMime.parse(raw);
  const html = email.html ?? '';
  const text = (email.text?.trim() || htmlToText(html)).slice(0, MAX_TEXT);
  return { email, html, text, links: links(html), images: contentImages(html) };
}

type CallInput = {
  companyName: string;
  sentAt: string | null;
  subject: string | null;
  text: string;
  links: string[];
  images: string[];
  knownDeals: KnownDeal[];
  categories: string[];
  cannabinoids: string[];
};

function prompt(i: CallInput) {
  const known = i.knownDeals.length
    ? i.knownDeals
        .map(
          (d) =>
            `- id ${d.id} [${d.status}]: ${d.title} | ${d.scope}, ${d.deal_type}` +
            `${d.value_pct != null ? `, ${d.value_pct}%` : ''}${d.value_amount != null ? `, $${d.value_amount}` : ''}` +
            `${d.value_text ? `, "${d.value_text}"` : ''}${d.code ? `, code ${d.code}` : ''}${d.ends_at ? `, ends ${d.ends_at}` : ''}`,
        )
        .join('\n')
    : '(none)';
  return `You are cataloguing deals from a hemp/CBD store's marketing newsletter for a deals website.

Store: ${i.companyName}
Sent: ${i.sentAt ?? 'unknown'}
Subject: ${i.subject ?? '(none)'}

Known current deals for this store:
${known}

Category slugs: ${i.categories.join(', ')}
Cannabinoid slugs: ${i.cannabinoids.join(', ')}

Return every distinct offer in the email as JSON matching the schema. Rules:
- Only real offers: a discount, code, free shipping threshold, BOGO, bundle price, free gift or price drop. Not loyalty-program explainers or products at full price.
- One entry per distinct offer. A sitewide sale and a separate gummy bundle are two entries.
- Compare against the known deals. Same code or same offer = "same" (or "update" if dates, value or terms changed), with its existing_deal_id.
- Known deals marked [rejected] were reviewed and declined. If the email repeats one, return it as "same" with its id.
- Text inside images counts: read the images for the offer, code and end date.
- Never guess values. When the email doesn't say, use null for numbers and an empty string for text.
- Lower confidence when the offer is only implied, the code is unclear, or the dates are ambiguous.

Links in the email:
${i.links.join('\n') || '(none)'}

Email text:
${i.text}`;
}

export const OUTPUT_SCHEMA = strict(TOOL.input_schema);

async function callModel(env: Env, input: CallInput, withImages: boolean) {
  const content: unknown[] = [];
  if (withImages) for (const url of input.images) content.push({ type: 'image', source: { type: 'url', url } });
  content.push({ type: 'text', text: prompt(input) });

  // ANTHROPIC_BASE_URL lets this go through Cloudflare AI Gateway (logging, caching) or a local mock.
  const base = (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
  return fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: env.EXTRACT_MODEL || 'claude-sonnet-5-5',
      // Newer models think before answering, which uses part of this budget.
      max_tokens: 16000,
      // Structured output: the reply is JSON matching the schema. (Forcing a tool call with
      // tool_choice is rejected by current models.)
      output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
      messages: [{ role: 'user', content }],
    }),
  });
}

export async function extractDeals(env: Env, input: CallInput): Promise<Extraction> {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  let res = await callModel(env, input, input.images.length > 0);
  // An image the API can't download fails the whole request; try again with text only.
  if (res.status === 400 && input.images.length) {
    const body = await res.clone().text();
    if (/image|url|media|fetch|download/i.test(body)) res = await callModel(env, input, false);
  }
  if (!res.ok) throw new Error(`Extraction API ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const data = (await res.json()) as { stop_reason?: string; content: { type: string; text?: string }[] };
  const text = data.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('').trim();
  if (!text) throw new Error(`Extraction returned no JSON (stop_reason: ${data.stop_reason ?? 'unknown'})`);
  let parsed: Extraction;
  try {
    parsed = JSON.parse(text) as Extraction;
  } catch {
    throw new Error(`Extraction returned invalid JSON (stop_reason: ${data.stop_reason ?? 'unknown'}): ${text.slice(0, 200)}`);
  }
  return { kind: parsed.kind ?? 'no_deals', confirmation_url: parsed.confirmation_url ?? null, deals: parsed.deals ?? [] };
}
