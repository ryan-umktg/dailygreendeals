import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';
import { adminEmail } from './lib/admin-auth';

export const onRequest = defineMiddleware(async (context, next) => {
  const path = context.url.pathname;
  if (path.startsWith('/admin') || path.startsWith('/api/admin')) {
    const email = await adminEmail(context.request, env as Env);
    if (!email) return new Response('Not authorized', { status: 403 });
    context.locals.adminEmail = email;
  }
  const response = await next();
  // Keep pre-launch hostnames (new.dailygreendeals.com, workers.dev) out of search results.
  if (context.url.hostname !== 'dailygreendeals.com' && context.url.hostname !== 'www.dailygreendeals.com') {
    response.headers.set('x-robots-tag', 'noindex, nofollow');
  }
  return response;
});
