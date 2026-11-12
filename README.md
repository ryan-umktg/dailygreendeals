# dailygreendeals.com

Curated deals from online CBD and hemp stores. Astro on Cloudflare Workers, same setup as Local Flip Funding, plus a pipeline that turns store newsletters into deals.

## How deals get in

1. Ryan signs up for each store's newsletter with its own address, e.g. `vivimu@dailygreendeals.com`. The `info@` catch-all on PrivateEmail receives them all.
2. **Inbox poller** (`scripts/poll-inbox.mjs`, run hourly by `.github/workflows/poll-inbox.yml`) reads `info@` over IMAP and posts each store newsletter to `POST /api/ingest/`. Mail sent only to `info@` is left alone.
3. **Ingest** stores the raw email in R2, records it in `inbound_emails` and matches it to a store by address. Matched emails go on the `dgd-extract` queue; the poller then moves them to the `Processed` folder. Unmatched ones stay in the inbox and show in `/admin/inbox/`.
4. **Extraction** (queue consumer in `src/worker.ts` → `src/lib/process.ts`) sends the email text, links and main images, plus the store's current deals, to Claude. Each offer comes back as `new` (draft deal), `same` (bumps `last_seen_at`) or `update` (overwrites a draft, or queues changes on a live deal for approval).
5. **Review** at `/admin/`: approve, edit or reject drafts; apply or dismiss changes to live deals; open confirmation links.
6. **Nightly cron** (2:07am Denver) expires ended deals and flags live deals with no end date that haven't appeared in a newsletter for 14 days.

Adding or editing a store at `/admin/stores/` re-runs any unmatched emails, so emails that arrived before the store was set up aren't lost.

## Where things live

| What | Where |
| --- | --- |
| Database schema, seed categories and cannabinoids | `migrations/` |
| Worker entry (fetch + queue + cron) | `src/worker.ts` |
| Ingest and store matching | `src/lib/ingest.ts` |
| Extraction prompt and schema | `src/lib/extract.ts` |
| Writing results, nightly maintenance | `src/lib/process.ts` |
| Admin login check (Cloudflare Access) | `src/lib/admin-auth.ts`, `src/middleware.ts` |
| Admin pages | `src/pages/admin/` and `src/pages/api/admin/` |
| Inbox poller | `scripts/poll-inbox.mjs`, `.github/workflows/poll-inbox.yml` |
| Site name, disclaimer | `src/consts.ts` |

The homepage is a placeholder that lists live deals, so the pipeline can be checked end to end. The real public site is Phase 3.

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars        # then add a real ANTHROPIC_API_KEY
npm run db:migrate:local
npm run preview                       # builds, then runs the Worker at http://localhost:8787
```

`DEV_ADMIN_BYPASS=1` in `.dev.vars` opens `/admin/` on localhost without Cloudflare Access.

Send a saved email through the pipeline:

```sh
curl -X POST http://localhost:8787/api/ingest/ \
  -H 'authorization: Bearer local-dev-token' --data-binary @some-newsletter.eml
```

Run the nightly job by hand: `npx wrangler dev --test-scheduled`, then open `http://localhost:8787/cdn-cgi/handler/scheduled`.

Try the poller against the real inbox without changing anything:

```sh
DRY_RUN=1 IMAP_USER=info@dailygreendeals.com IMAP_PASS=... npm run poll
```

## First deploy (one time)

1. `npx wrangler login`
2. Create resources:
   ```sh
   npx wrangler d1 create dgd                  # paste the database_id into wrangler.jsonc
   npx wrangler r2 bucket create dgd-raw-emails
   npx wrangler queues create dgd-extract
   npm run db:migrate
   ```
3. Secrets:
   ```sh
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler secret put INGEST_TOKEN        # any long random string, e.g. `openssl rand -hex 32`
   ```
4. `npm run deploy`. It goes live on `new.dailygreendeals.com` (set in `wrangler.jsonc`), with WordPress still on the main domain. Non-production hostnames send `noindex`.
5. **Protect `/admin/`** with Cloudflare Zero Trust → Access → Applications → Self-hosted:
   - Domain `new.dailygreendeals.com` with path `admin`, plus a second destination with path `api/admin`. Add the main domain at cutover. (Access can't protect paths on a workers.dev URL, which is why the site runs on a subdomain.)
   - Policy: allow the email in `ADMIN_EMAIL` (one-time PIN login is fine).
   - Copy the team domain (`<team>.cloudflareaccess.com`) and the application's AUD tag into `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in `wrangler.jsonc`, then deploy again. Until both are set, `/admin/` returns 403.
6. **Inbox poller.** In GitHub → Settings → Secrets and variables → Actions:
   - Secrets: `IMAP_USER` (`info@dailygreendeals.com`), `IMAP_PASS`, `INGEST_TOKEN` (same value as step 3).
   - Variable (optional): `INGEST_URL`. The default is `https://new.dailygreendeals.com/api/ingest/`; change it at cutover.
   - Run "Poll inbox" once by hand from the Actions tab and check its log.

## Notes

- Every email is kept in R2, so extraction can be re-run any time from `/admin/inbox/` (for example after changing the prompt).
- `ANTHROPIC_BASE_URL` can point at Cloudflare AI Gateway to log and cache extraction calls.
- GitHub can delay scheduled workflows by several minutes at busy times. That's fine for a daily review.
- `worker-configuration.d.ts` is generated by `npm run cf-typegen`. Rerun it after changing bindings in `wrangler.jsonc`.
