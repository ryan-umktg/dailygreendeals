/**
 * /admin/ is protected twice: Cloudflare Access sits in front of it (configured in the Zero Trust
 * dashboard), and every admin request also verifies the Access login token here, so a misconfigured
 * Access rule can't expose the admin area.
 */
import { createRemoteJWKSet, jwtVerify } from 'jose';

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

export async function adminEmail(request: Request, env: Env): Promise<string | null> {
  // Local development only: DEV_ADMIN_BYPASS lives in .dev.vars, which is never deployed.
  // (wrangler dev rewrites the hostname to the route's, so a localhost check doesn't work here.)
  if (env.DEV_ADMIN_BYPASS === '1') return env.ADMIN_EMAIL;

  const team = env.ACCESS_TEAM_DOMAIN;
  const aud = env.ACCESS_AUD;
  if (!team || !aud) return null;

  const token =
    request.headers.get('cf-access-jwt-assertion') ??
    /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(request.headers.get('cookie') ?? '')?.[1];
  if (!token) return null;

  jwks ??= createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: `https://${team}`, audience: aud });
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
    return email && email === env.ADMIN_EMAIL.toLowerCase() ? email : null;
  } catch {
    return null;
  }
}
