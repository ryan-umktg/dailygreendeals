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
 * Which emails count:
 *  - anything sent to a store address on dailygreendeals.com (not in NON_STORE_ADDRESSES, i.e. not info@);
 *  - mail sent to a shared address (info@, kimberly@: NON_STORE_ADDRESSES), but only if it's a
 *    mailing-list email (has a List-Unsubscribe header). Those are matched to a store by sender domain
 *    (add "@store.com" to the store in /admin/stores/).
 * Ordinary one-to-one mail to the shared addresses is never touched.
 * Only mail from the last SINCE_DAYS days (default 30) is looked at, newest first, and emails the site
 * already has are not downloaded again. Each run stops after TIME_BUDGET_MINUTES (default 12).
 * Emails the site can't match to a store yet are stored there and left in the inbox; they're skipped
 * on later runs because the site recognises them by Message-ID.
 */
import { ImapFlow } from 'imapflow';

const DOMAIN = 'dailygreendeals.com';
const PROCESSED = 'Processed';
const SKIP = new Set(
  (process.env.NON_STORE_ADDRESSES ?? `info@${DOMAIN},kimberly@${DOMAIN}`)
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

const SINCE_DAYS = Number(process.env.SINCE_DAYS ?? 30);
const TIME_BUDGET_MS = Number(process.env.TIME_BUDGET_MINUTES ?? 12) * 60_000;
const started = Date.now();
const stats = { seen: 0, candidates: 0, already_have: 0, sent: 0, queued: 0, unmatched: 0, duplicate: 0, skipped: 0, failed: 0, moved: 0, out_of_time: 0 };

async function post(path, init) {
  const url = new URL(process.env.INGEST_URL);
  url.pathname = url.pathname.replace(/\/?$/, '/') + path;
  return fetch(url, { ...init, headers: { authorization: `Bearer ${process.env.INGEST_TOKEN}`, ...init.headers } });
}

/** Which of these emails does the site already have? → Map(core message-id → matched to a store?) */
async function knownIds(messageIds) {
  const known = new Map();
  for (let i = 0; i < messageIds.length; i += 400) {
    const res = await post('known/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message_ids: messageIds.slice(i, i + 400) }),
    });
    if (!res.ok) throw new Error(`known/ returned ${res.status}`);
    const body = await res.json();
    for (const [id, matched] of Object.entries(body.known ?? {})) known.set(id, matched);
  }
  return known;
}
const core = (id) => String(id ?? '').trim().replace(/^<|>$/g, '');

// Without an 'error' listener a dropped connection (ECONNRESET) crashes the whole run.
let connected = false;
client.on('error', (err) => {
  console.error(`IMAP connection error: ${err?.message ?? err}`);
  connected = false;
});
client.on('close', () => {
  connected = false;
});

await client.connect();
connected = true;
const toMove = [];
async function flushMoves() {
  if (!toMove.length || DRY) return;
  const batch = toMove.splice(0);
  await client.messageMove(batch.join(','), PROCESSED, { uid: true });
  stats.moved += batch.length;
}

try {
  if (!DRY) {
    const boxes = await client.list();
    if (!boxes.some((b) => b.path === PROCESSED)) await client.mailboxCreate(PROCESSED);
  }

  const lock = await client.getMailboxLock('INBOX');
  try {
    // Only recent mail: old backlog in the inbox is ignored (set SINCE_DAYS to reach further back).
    const since = new Date(Date.now() - SINCE_DAYS * 86_400_000);
    const uids = (await client.search({ since }, { uid: true })) || [];
    stats.seen = uids.length;

    // Headers only, newest first.
    const items = [];
    if (uids.length) {
      for await (const msg of client.fetch(uids.join(','), { uid: true, envelope: true, headers: ['delivered-to', 'x-original-to', 'envelope-to', 'list-unsubscribe'] }, { uid: true })) {
        const headersText = msg.headers?.toString() ?? '';
        const alias = storeAlias(msg.envelope ?? {}, headersText);
        // Mail to shared addresses (info@): only bulk mail, which always carries List-Unsubscribe.
        const isNewsletter = /^list-unsubscribe:/im.test(headersText);
        if (!alias && !isNewsletter) {
          stats.skipped++;
          continue;
        }
        items.push({
          uid: msg.uid,
          alias,
          messageId: core(msg.envelope?.messageId),
          date: msg.envelope?.date ? new Date(msg.envelope.date).getTime() : 0,
          from: msg.envelope?.from?.[0]?.address ?? '',
          subject: msg.envelope?.subject ?? '',
        });
      }
    }
    items.sort((a, b) => b.date - a.date);
    stats.candidates = items.length;

    // Skip what the site already has: matched ones just get filed, unmatched ones stay put.
    const known = DRY || !items.length ? new Map() : await knownIds(items.map((i) => i.messageId).filter(Boolean));
    const fresh = [];
    for (const item of items) {
      if (item.messageId && known.has(item.messageId)) {
        stats.already_have++;
        if (known.get(item.messageId)) toMove.push(item.uid);
      } else fresh.push(item);
    }
    await flushMoves();

    for (const item of fresh) {
      if (DRY) {
        console.log(`[dry run] ${item.alias ?? `shared address, from ${item.from}`}  ${item.subject}`);
        continue;
      }
      if (Date.now() - started > TIME_BUDGET_MS) {
        stats.out_of_time = fresh.length - stats.sent - stats.failed;
        console.log(`Time budget reached; ${stats.out_of_time} emails left for the next run.`);
        break;
      }
      try {
        const { content } = await client.download(String(item.uid), undefined, { uid: true });
        const chunks = [];
        for await (const chunk of content) chunks.push(chunk);
        const raw = Buffer.concat(chunks);

        const res = await post(item.alias ? `?alias=${encodeURIComponent(item.alias)}` : '', {
          method: 'POST',
          headers: { 'content-type': 'message/rfc822' },
          body: raw,
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.ok) throw new Error(`ingest returned ${res.status} ${body.error ?? ''}`);
        stats.sent++;
        stats[body.status] = (stats[body.status] ?? 0) + 1;
        if (body.status === 'queued' || (body.status === 'duplicate' && body.matched)) toMove.push(item.uid);
        if (body.status === 'unmatched') {
          const hint = item.alias ?? `@${(String(item.from).split('@')[1] ?? '').split('.').slice(-2).join('.')}`;
          console.log(`Unmatched: ${item.alias ?? `from ${item.from}`} "${item.subject}" (add ${hint} to a store in /admin/stores/)`);
        }
      } catch (err) {
        stats.failed++;
        console.error(`Failed: ${item.alias ?? item.from} "${item.subject}": ${err?.message ?? err}`);
        if (!connected) break; // connection dropped; what's done so far is kept, the rest waits for the next run
      }
      if (toMove.length >= 20) await flushMoves();
    }
    if (connected) await flushMoves();
  } finally {
    if (connected) lock.release();
  }
} finally {
  if (connected) await client.logout().catch(() => {});
}

console.log(JSON.stringify(stats));
if (stats.failed) process.exitCode = 1;
