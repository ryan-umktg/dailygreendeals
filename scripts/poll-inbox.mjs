#!/usr/bin/env node
/**
 * Inbox poller. Reads info@dailygreendeals.com (PrivateEmail, IMAP), sends each store newsletter to
 * the site's /api/ingest/ endpoint, then moves it to the "Processed" folder.
 *
 * Runs hourly from .github/workflows/poll-inbox.yml, or by hand: `npm run poll`.
 *
 * Environment:
 *   IMAP_USER      info@dailygreendeals.com
 *   IMAP_PASS      mailbox password
 *   INGEST_URL     https://dailygreendeals.com/api/ingest/ (or http://localhost:4321/api/ingest/)
 *   INGEST_TOKEN   same value as the Worker secret
 *   IMAP_HOST      default mail.privateemail.com
 *   IMAP_PORT      default 993
 *   DRY_RUN=1      list what would be sent, change nothing
 *
 * Which emails count: anything sent to an address on dailygreendeals.com other than the
 * NON_STORE_ADDRESSES list (info@ by default). Mail sent only to info@ is left alone.
 * Emails the site can't match to a store yet are stored there and left in the inbox; they're skipped
 * on later runs because the site recognises them by Message-ID.
 */
import { ImapFlow } from 'imapflow';

const DOMAIN = 'dailygreendeals.com';
const PROCESSED = 'Processed';
const SKIP = new Set(
  (process.env.NON_STORE_ADDRESSES ?? `info@${DOMAIN}`)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);
const DRY = process.env.DRY_RUN === '1';

for (const k of ['IMAP_USER', 'IMAP_PASS', 'INGEST_URL', 'INGEST_TOKEN']) {
  if (!process.env[k] && !(DRY && k.startsWith('INGEST'))) {
    console.error(`Missing ${k}`);
    process.exit(1);
  }
}

/** The store signup address this message was sent to, from the envelope and delivery headers. */
function storeAlias(envelope, headersText) {
  const candidates = [
    ...(envelope.to ?? []).map((a) => a.address),
    ...(envelope.cc ?? []).map((a) => a.address),
    ...[...headersText.matchAll(/^(?:delivered-to|x-original-to|envelope-to):\s*(.+)$/gim)].map((m) => m[1]),
  ];
  for (const c of candidates) {
    for (const m of String(c ?? '').toLowerCase().matchAll(/[a-z0-9._%+-]+@([a-z0-9.-]+)/g)) {
      if (m[1] === DOMAIN && !SKIP.has(m[0])) return m[0];
    }
  }
  return null;
}

const client = new ImapFlow({
  host: process.env.IMAP_HOST ?? 'mail.privateemail.com',
  port: Number(process.env.IMAP_PORT ?? 993),
  secure: true,
  auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASS },
  logger: false,
});

const stats = { seen: 0, sent: 0, queued: 0, unmatched: 0, duplicate: 0, skipped: 0, failed: 0 };

await client.connect();
try {
  if (!DRY) {
    const boxes = await client.list();
    if (!boxes.some((b) => b.path === PROCESSED)) await client.mailboxCreate(PROCESSED);
  }

  const lock = await client.getMailboxLock('INBOX');
  try {
    // Collect first, then act: moving messages while iterating a fetch confuses some servers.
    const items = [];
    for await (const msg of client.fetch('1:*', { uid: true, envelope: true, headers: ['delivered-to', 'x-original-to', 'envelope-to'] })) {
      stats.seen++;
      const alias = storeAlias(msg.envelope ?? {}, msg.headers?.toString() ?? '');
      if (!alias) {
        stats.skipped++;
        continue;
      }
      items.push({ uid: msg.uid, alias, subject: msg.envelope?.subject ?? '' });
    }

    const toMove = [];
    for (const item of items) {
      if (DRY) {
        console.log(`[dry run] ${item.alias}  ${item.subject}`);
        continue;
      }
      const { content } = await client.download(String(item.uid), undefined, { uid: true });
      const chunks = [];
      for await (const chunk of content) chunks.push(chunk);
      const raw = Buffer.concat(chunks);

      const url = new URL(process.env.INGEST_URL);
      url.searchParams.set('alias', item.alias);
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${process.env.INGEST_TOKEN}`, 'content-type': 'message/rfc822' },
        body: raw,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        stats.failed++;
        console.error(`Failed (${res.status}) ${item.alias} "${item.subject}": ${body.error ?? ''}`);
        continue;
      }
      stats.sent++;
      stats[body.status] = (stats[body.status] ?? 0) + 1;
      // Matched (or already stored and matched before): file it. Unmatched stays in the inbox for a person to see.
      if (body.status === 'queued' || (body.status === 'duplicate' && body.matched)) toMove.push(item.uid);
      if (body.status === 'unmatched') console.log(`Unmatched: ${item.alias} "${item.subject}" (add this address to a store in /admin/stores/)`);
    }

    if (toMove.length) await client.messageMove(toMove.join(','), PROCESSED, { uid: true });
  } finally {
    lock.release();
  }
} finally {
  await client.logout();
}

console.log(JSON.stringify(stats));
if (stats.failed) process.exitCode = 1;
