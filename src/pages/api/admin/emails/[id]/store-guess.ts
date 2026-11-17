/** GET /api/admin/emails/:id/store-guess/ - prefill for the "Add store" dialog on the inbox page. */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { guessStore } from '../../../../../lib/store-guess';

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  const guess = await guessStore(env as Env, Number(params.id));
  if (!guess) return Response.json({ error: 'Email not found' }, { status: 404 });
  return Response.json(guess);
};
