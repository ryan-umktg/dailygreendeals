// Converts the WordPress export (WXR .xml) into Markdown guides for every URL marked keep-guide
// in migration/url-inventory.csv.
// Run: node scripts/wp-to-guides.mjs path/to/dailygreendeals.WordPress.xml
//
// - One guide per new_path. When several old posts share a new_path (a merge), the most-linked post
//   becomes the guide and the others are written to migration/merge-sources/ to fold in by hand.
// - Guides are written with reviewed: false, so they build but stay noindexed until checked.
// - Images still point at the old site are listed in migration/images-needed.txt; the guide links to
//   /images/guides/<file>, so the files need copying into public/images/guides/ before cutover.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import TurndownService from 'turndown';

const file = process.argv[2];
if (!file) throw new Error('Usage: node scripts/wp-to-guides.mjs <export.xml>');

const root = new URL('..', import.meta.url);
const out = new URL('src/content/guides/', root);
const mergeDir = new URL('migration/merge-sources/', root);
mkdirSync(out, { recursive: true });
mkdirSync(mergeDir, { recursive: true });

// --- inventory: keep-guide rows, most-linked first
const [head, ...rows] = readFileSync(new URL('migration/url-inventory.csv', root), 'utf8').trim().split('\n');
const h = head.split(',');
const inventory = rows.map((r) => Object.fromEntries(r.split(',').map((v, i) => [h[i], v])));
const redirectMap = new Map(inventory.map((r) => [r.old_path, r.new_path]));
const keep = inventory
  .filter((r) => r.action === 'keep-guide')
  .sort((a, b) => Number(b.ref_domains) - Number(a.ref_domains));

// --- export: published posts and pages by slug
const xml = new XMLParser({ ignoreAttributes: false, cdataPropName: false, processEntities: true, htmlEntities: true })
  .parse(readFileSync(file, 'utf8'));
const items = [].concat(xml.rss.channel.item ?? []);
const bySlug = new Map();
for (const it of items) {
  const type = it['wp:post_type'];
  if (type !== 'post' && type !== 'page') continue;
  if (it['wp:status'] !== 'publish') continue;
  const meta = Object.fromEntries([].concat(it['wp:postmeta'] ?? []).map((m) => [m['wp:meta_key'], m['wp:meta_value']]));
  bySlug.set(String(it['wp:post_name']), {
    title: String(it.title ?? '').trim(),
    html: String(it['content:encoded'] ?? ''),
    date: String(it['wp:post_date'] ?? '').slice(0, 10),
    modified: String(it['wp:post_modified'] ?? '').slice(0, 10),
    metaDesc: String(meta._seopress_titles_desc ?? meta._yoast_wpseo_metadesc ?? meta.rank_math_description ?? '').trim(),
  });
}

// --- HTML → Markdown
const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' });
const images = new Set();
td.addRule('images', {
  filter: 'img',
  replacement: (_c, node) => {
    const src = node.getAttribute('src') || '';
    if (!src) return '';
    images.add(src);
    const name = basename(new URL(src, 'https://dailygreendeals.com').pathname);
    return `![${(node.getAttribute('alt') || '').replace(/[\[\]]/g, '')}](/images/guides/${name})`;
  },
});
const links = [];
td.addRule('links', {
  filter: 'a',
  replacement: (content, node) => {
    const href = node.getAttribute('href') || '';
    if (!href || !content.trim()) return content;
    links.push(href);
    // Old internal links become root-relative so the redirect map catches them.
    // Old internal links go straight to their new page (no redirect hop).
    const local = href.replace(/^https?:\/\/(www\.)?dailygreendeals\.com/i, '');
    if (local === href) return `[${content}](${href})`;
    const path = (local.split(/[?#]/)[0] || '/').replace(/\/?$/, '/');
    return `[${content}](${redirectMap.get(path) ?? path})`;
  },
});

function wpautop(html) {
  if (/<p[\s>]/i.test(html)) return html;
  return html.split(/\n\s*\n/).map((p) => (/^\s*<(h\d|ul|ol|table|blockquote|div|figure)/i.test(p) ? p : `<p>${p.replace(/\n/g, '<br>')}</p>`)).join('\n');
}
function toMarkdown(html) {
  const clean = html
    .replace(/\[caption[^\]]*\]([\s\S]*?)\[\/caption\]/g, '$1')
    .replace(/\[\/?[a-z_-]+[^\]]*\]/gi, ''); // drop remaining shortcodes
  return td.turndown(wpautop(clean)).replace(/\n{3,}/g, '\n\n').trim();
}
const plain = (md) => md.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#*_>`-]/g, '').replace(/\s+/g, ' ').trim();
const yaml = (s) => JSON.stringify(s);
const slugOf = (path) => path.replace(/^\/|\/$/g, '').split('/').pop();

// --- write
const groups = new Map();
for (const r of keep) {
  if (!groups.has(r.new_path)) groups.set(r.new_path, []);
  groups.get(r.new_path).push(r);
}
const missing = [];
let written = 0;
for (const [newPath, members] of groups) {
  const found = members.map((m) => ({ ...m, post: bySlug.get(slugOf(m.old_path)) })).filter((m) => m.post);
  members.filter((m) => !bySlug.has(slugOf(m.old_path))).forEach((m) => missing.push(m.old_path));
  if (!found.length) continue;
  const [primary, ...rest] = found;
  const p = primary.post;
  const body = toMarkdown(p.html);
  const description = (p.metaDesc || plain(body).slice(0, 155).replace(/\s\S*$/, '') + '…').replace(/\s+/g, ' ');
  const target = new URL(`${slugOf(newPath)}.md`, out);
  if (existsSync(target)) { console.log(`skip ${newPath} (already exists; delete it to regenerate)`); continue; }
  writeFileSync(target, [
    '---',
    `title: ${yaml(p.title.replace(/\s+/g, ' '))}`,
    `description: ${yaml(description)}`,
    `published: ${p.date}`,
    `legacy_paths: ${JSON.stringify(members.map((m) => m.old_path))}`,
    'reviewed: false',
    '---',
    '',
    body,
    '',
  ].join('\n'));
  written++;
  for (const m of rest) {
    writeFileSync(new URL(`${slugOf(newPath)}--from--${slugOf(m.old_path)}.md`, mergeDir),
      `# ${m.post.title}\n\nOld URL: ${m.old_path} (${m.ref_domains} linking domains). Fold anything useful into src/content/guides/${slugOf(newPath)}.md, then delete this file.\n\n${toMarkdown(m.post.html)}\n`);
  }
}

writeFileSync(new URL('migration/images-needed.txt', root), [...images].sort().join('\n') + '\n');
const outbound = [...new Set(links.filter((l) => /^https?:/i.test(l) && !/dailygreendeals\.com/i.test(l)))].sort();
writeFileSync(new URL('migration/outbound-links.txt', root), outbound.join('\n') + '\n');
console.log(`Wrote ${written} guides. ${images.size} images to copy, ${outbound.length} outbound links to check.`);
if (missing.length) console.log(`Not found in export (check slugs):\n  ${missing.join('\n  ')}`);
