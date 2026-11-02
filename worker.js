// Flightroute server helper (Cloudflare Worker).
// Serves the app's files as before, and adds /api/opensky, which passes a small set of read-only
// OpenSky Network requests through, so the app can look up the path a flight actually flew even when
// the browser can't reach OpenSky directly. Answers are cached to stay within OpenSky's daily limits.
//
// Optional: an OpenSky account raises the daily limit. Add OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET
// as secrets on the Worker (Settings → Variables and Secrets); without them requests are anonymous.

const ALLOWED = new Set(['flights/departure', 'flights/arrival', 'flights/aircraft', 'tracks/all']);
const TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
let token = null, tokenExpires = 0;

async function getToken(env) {
  if (!env.OPENSKY_CLIENT_ID || !env.OPENSKY_CLIENT_SECRET) return null;
  if (token && Date.now() < tokenExpires - 60000) return token;
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.OPENSKY_CLIENT_ID, client_secret: env.OPENSKY_CLIENT_SECRET })
  });
  if (!r.ok) return null;
  const j = await r.json();
  token = j.access_token; tokenExpires = Date.now() + (j.expires_in || 1800) * 1000;
  return token;
}

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS' };
const json = (body, status = 200, extra = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors, ...extra } });

async function opensky(request, env, ctx) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  const url = new URL(request.url);
  const path = url.searchParams.get('path') || '';
  if (!ALLOWED.has(path)) return json({ error: 'unsupported request' }, 400);
  const q = new URLSearchParams();
  for (const [k, v] of url.searchParams) if (k !== 'path' && /^[a-z0-9]+$/i.test(k) && /^[A-Za-z0-9 ]{1,16}$/.test(v)) q.set(k, v);
  const base = env.OPENSKY_BASE || 'https://opensky-network.org/api';
  const upstream = `${base}/${path}?${q}`;

  const cache = caches.default, key = new Request(upstream);
  const hit = await cache.match(key);
  if (hit) return hit;

  const headers = { 'user-agent': 'Flightroute (+https://github.com/robfoy-cloud/GPS-tracker)' };
  const t = await getToken(env).catch(() => null);
  if (t) headers.authorization = 'Bearer ' + t;
  let r;
  try { r = await fetch(upstream, { headers }); }
  catch (e) { return json({ error: 'OpenSky could not be reached' }, 502); }
  if (r.status === 404) return json('[]', 200, { 'cache-control': 'public, max-age=1800' });   // OpenSky: nothing found
  if (!r.ok) {
    const detail = (await r.text().catch(() => '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    return json({ error: 'OpenSky answered ' + r.status + (t ? '' : ' (anonymous)'), detail, retryAfter: r.headers.get('x-rate-limit-retry-after-seconds') }, r.status === 429 ? 429 : 502);
  }
  // Past flights don't change: keep tracks a day, flight lists an hour
  const res = json(await r.text(), 200, { 'cache-control': 'public, max-age=' + (path === 'tracks/all' ? 86400 : 3600) });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/opensky') return opensky(request, env, ctx);
    return env.ASSETS.fetch(request);
  }
};
