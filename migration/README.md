# WordPress content migration

`url-inventory.csv` lists every old dailygreendeals.com URL that other sites link to (Ahrefs, 2026-11-17), with what happens to it. Ahrefs shows the old site at zero organic traffic, so the inventory is ranked by linking domains: the goal is to keep link value, not traffic.

Decisions (Ryan, 2026-11-17):

- CBD store coupon and review pages become store pages at `/brands/<slug>/`.
- Coupon pages for stores outside the CBD MVP (headshops, seed banks, vaporizer shops) redirect to `/deals/`.
- All health, medical and drug-test posts redirect to `/guides/` and are not migrated.
- Evergreen CBD posts, plus the THC gummy recipe and smoking-stems posts, become guides under `/guides/`.

## Actions

- `store-page`: old URL 301s to a `/brands/<slug>/` page. The store needs a row in `companies` with that slug (list below).
- `keep-guide`: converted to Markdown in `src/content/guides/` by `scripts/wp-to-guides.mjs`.
- `redirect`: 301 only.

## Steps

1. Export WordPress (Tools → Export → All content) and run `node scripts/wp-to-guides.mjs <export.xml>`.
2. Fold `migration/merge-sources/*` into their guides, then delete them.
3. Copy the files in `migration/images-needed.txt` from `wp-content/uploads` into `public/images/guides/`.
4. Review each guide, check `migration/outbound-links.txt` for dead or affiliate links, then set `reviewed: true` (unreviewed guides are noindexed).
5. After any CSV edit, run `node scripts/build-redirects.mjs` to regenerate `public/_redirects`.

## Store pages the redirects expect

| Slug | Linking domains |
| --- | --- |
| `cbd-genesis` | 566 |
| `nuleaf-naturals` | 491 |
| `cbdistillery` | 234 |
| `intrinsic-hemp` | 171 |
| `cbd-american-shaman` | 131 |
| `green-roads` | 96 |
| `infinite-cbd` | 95 |
| `cbd-pure` | 90 |
| `cbdk9` | 88 |
| `dixie-botanicals` | 87 |
| `bota-hemp` | 86 |
| `vitagenne` | 79 |
| `now-cbd` | 77 |
| `green-flower-botanicals` | 72 |
| `cbd-hemp-oil` | 70 |
| `cbd-essence` | 29 |
| `hippie-butler` | 27 |
| `pure-hemp` | 10 |
| `medical-marijuana-inc` | 9 |
| `plantacea` | 6 |
| `cloverstrip` | 2 |
