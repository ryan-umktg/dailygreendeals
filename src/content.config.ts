import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// Evergreen articles carried over from the old WordPress blog, plus new ones.
const guides = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/guides' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    published: z.coerce.date(),
    updated: z.coerce.date().optional(),
    // Old WordPress paths that now point here (documentation; redirects live in migration/url-inventory.csv).
    legacy_paths: z.array(z.string()).default([]),
    // Set true once Ryan has reviewed the migrated text. Unreviewed guides are built but noindexed.
    reviewed: z.boolean().default(false),
  }),
});

export const collections = { guides };
