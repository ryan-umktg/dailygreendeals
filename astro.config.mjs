// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import preact from '@astrojs/preact';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://dailygreendeals.com',
  trailingSlash: 'always',
  build: { format: 'directory' },
  // Static by default. Deal, brand, admin and API routes opt out with `export const prerender = false`.
  // The Worker entry (src/worker.ts, set as "main" in wrangler.jsonc) adds the queue and cron handlers.
  adapter: cloudflare({ imageService: 'passthrough' }),
  session: false,
  integrations: [
    preact(),
    sitemap({ filter: (page) => !page.includes('/admin/') && !page.includes('/api/') }),
  ],
  vite: { plugins: [tailwindcss()] },
});
