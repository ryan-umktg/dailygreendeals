/**
 * Best guess at a new store's details from one of its unmatched newsletters:
 * the name from the sender's display name, the website from the sender's domain (or, when the email
 * was sent through a mailing service's own domain, the domain the email links to most), and the
 * addresses to match it by.
 */
import { parseStoredEmail } from './extract';

/** Mailing services' own sending domains: these say nothing about the store. */
const ESP_DOMAINS = new Set([
  'klaviyomail.com', 'klaviyo.com', 'shopifyemail.com', 'myshopify.com', 'shopify.com', 'mailchimpapp.net', 'mcsv.net',
  'mcdlv.net', 'list-manage.com', 'mailchimp.com', 'sendgrid.net', 'sendgrid.com', 'omnisend.com', 'omnisendlink.com',
  'attentivemobile.com', 'attn.tv', 'postscript.io', 'hubspotemail.net', 'hubspot.com', 'mailgun.org', 'mailgun.net',
  'amazonses.com', 'sendinblue.com', 'brevo.com', 'constantcontact.com', 'ccsend.com', 'rs6.net', 'mailerlite.com',
  'convertkit.com', 'ck.page', 'kit.com', 'drip.com', 'activecampaign.com', 'aweber.com', 'getresponse.com',
  'yotpo.com', 'smile.io', 'privy.com', 'gorgias.com', 'zendesk.com', 'substack.com', 'beehiiv.com', 'wix.com',
  'squarespace.com', 'bigcommerce.com', 'woocommerce.com', 'mailpoet.com', 'sparkpostmail.com', 'mandrillapp.com',
]);

/** Link domains that are tracking, images or social, never the store's own site. */
const NOT_A_STORE = new Set([
  ...ESP_DOMAINS,
  'klclick.com', 'klclick1.com', 'klclick2.com', 'klclick3.com', 'google.com', 'goo.gl', 'gstatic.com', 'googleapis.com',
  'facebook.com', 'fb.com', 'instagram.com', 'twitter.com', 'x.com', 'tiktok.com', 'youtube.com', 'youtu.be',
  'pinterest.com', 'linkedin.com', 'apple.com', 'bit.ly', 'linktr.ee', 'trustpilot.com', 'judge.me', 'okendo.io',
  'stamped.io', 'cloudfront.net', 'amazonaws.com', 'dailygreendeals.com',
]);

/** example.com from mail.example.com. Good enough for the .com/.co/.net storefronts we track. */
export const registrable = (domain: string) => domain.toLowerCase().replace(/\.$/, '').split('.').slice(-2).join('.');

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

/** "Kache Hemp | Team" → "Kache Hemp" */
function cleanName(display: string | undefined | null) {
  const n = (display ?? '')
    .replace(/["']/g, '')
    .split(/\s[|•·–—-]\s|\s+from\s+/i)[0]
    .replace(/\b(team|support|hello|info|newsletter|no-?reply)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return n.length >= 2 ? n : '';
}

/** "zeropointextracts" → "Zeropointextracts", used only when the email has no display name. */
const nameFromDomain = (d: string) => (d.split('.')[0] ?? '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export type StoreGuess = {
  name: string;
  website: string;
  addresses: string[];
  /** Addresses already linked to a store, with that store's name. */
  taken: { address: string; store: string }[];
  note: string;
};

export async function guessStore(env: Env, emailId: number): Promise<StoreGuess | null> {
  const row = await env.DB.prepare('SELECT r2_key, alias, from_address FROM inbound_emails WHERE id = ?')
    .bind(emailId)
    .first<{ r2_key: string; alias: string | null; from_address: string | null }>();
  if (!row) return null;

  const shared = new Set(String(env.NON_STORE_ADDRESSES ?? '').split(',').map((a) => a.trim().toLowerCase()));
  const alias = row.alias && !shared.has(row.alias.toLowerCase()) ? row.alias.toLowerCase() : null;
  const fromDomain = registrable(row.from_address?.split('@')[1] ?? '');
  const senderIsEsp = !fromDomain || ESP_DOMAINS.has(fromDomain);

  // The domains the email links to, most-linked first.
  let displayName = '';
  const counts = new Map<string, number>();
  const obj = await env.RAW_EMAILS.get(row.r2_key);
  if (obj) {
    const parsed = await parseStoredEmail(await obj.arrayBuffer());
    displayName = cleanName(parsed.email.from?.name);
    for (const line of parsed.links) {
      const host = hostOf(line.split(' -> ').pop() ?? '');
      if (!host) continue;
      const d = registrable(host);
      if (!NOT_A_STORE.has(d)) counts.set(d, (counts.get(d) ?? 0) + 1);
    }
  }
  const topLink = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  let site: string | null;
  let note: string;
  if (!senderIsEsp && (counts.has(fromDomain) || !topLink)) {
    site = fromDomain;
    note = `Website guessed from the sender's domain (${row.from_address}).`;
  } else if (topLink) {
    site = topLink;
    note = senderIsEsp
      ? `Sent through a mailing service (${fromDomain || 'unknown'}), so the website is the domain the email links to most.`
      : `The sender's domain (${fromDomain}) isn't linked in the email; using the domain it links to most.`;
  } else {
    site = null;
    note = 'Couldn\'t guess the website from this email.';
  }

  const addresses = [alias, senderIsEsp ? null : `@${fromDomain}`].filter((a): a is string => !!a);
  const taken = addresses.length
    ? (
        await env.DB.prepare(
          `SELECT s.address, c.name AS store FROM email_sources s JOIN companies c ON c.id = s.company_id
           WHERE s.address IN (${addresses.map(() => '?').join(',')})`,
        )
          .bind(...addresses)
          .all<{ address: string; store: string }>()
      ).results
    : [];

  return {
    name: displayName || nameFromDomain(site ?? alias?.split('@')[0] ?? ''),
    website: site ? `https://${site}` : '',
    addresses,
    taken,
    note,
  };
}
