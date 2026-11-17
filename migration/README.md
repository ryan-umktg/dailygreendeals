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

## Status

- 2026-11-17: Converted the 17 kept posts from the WordPress backup (`wpp2_` tables in `mysql.sql`) into 15 guides (two pairs merged). Then rewrote each guide: accurate, no disease or treatment claims, current federal hemp rules (synthetics excluded Nov 12, 2026; total-THC standard and 0.4 mg/container cap from Dec 11, 2026 unless delayed), and no guest-post or affiliate links. The old images (keyword-stuffed 2019 graphics) were dropped, so no image copying is needed. The raw conversion is in the commit before the rewrite, for comparison.
- Next: Ryan reviews each guide and sets `reviewed: true` (unreviewed guides are noindexed).

## Re-running

- `node scripts/wp-to-guides.mjs <export.xml>` converts a WordPress export again (it skips guides that already exist).
- After any CSV edit, run `node scripts/build-redirects.mjs` to regenerate `public/_redirects`.

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
