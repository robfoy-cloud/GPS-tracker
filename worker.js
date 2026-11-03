// Flightroute worker. The app's files are served as static assets; this only handles /api/*.
//
// POST /api/tracks  { id, from, to, pts: [[lon, lat, ele|null], ...] }  →  { ok, file, duplicate? }
// Adds a flown route to the public route library in the GitHub repo (routes/*.gpx and routes/index.json),
// with times removed. Only people who are signed in and on Flightroute's access list can upload.
//
// Needs: SUPABASE_URL and SUPABASE_KEY (vars, public), GITHUB_REPO (var, "owner/repo") and
// GITHUB_TOKEN (secret: a fine-grained token with Contents read and write on that repository only).

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

// Is the caller signed in and on the list? Asks Supabase (rpc fr_is_allowed) with their own token.
const seen = new Map();   // token -> { ok, until }
async function allowed(req, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_KEY) return { ok: false, status: 503, error: 'sign-in is not set up' };
  const m = (req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, status: 401, error: 'sign in needed' };
  const tok = m[1], now = Date.now(), hit = seen.get(tok);
  if (hit && hit.until > now) return hit.ok ? { ok: true } : { ok: false, status: 403, error: 'no access' };
  let ok = false, status = 403;
  try {
    const r = await fetch(env.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/rpc/fr_is_allowed', {
      method: 'POST', body: '{}',
      headers: { apikey: env.SUPABASE_KEY, authorization: 'Bearer ' + tok, 'content-type': 'application/json' }
    });
    if (r.status === 401) status = 401;
    ok = r.ok && (await r.json()) === true;
  } catch (e) { return { ok: false, status: 503, error: 'could not check sign-in' }; }
  if (seen.size > 500) seen.clear();
  seen.set(tok, { ok, until: now + (ok ? 5 : 1) * 60_000 });
  return ok ? { ok: true } : { ok: false, status, error: status === 401 ? 'sign in needed' : 'no access' };
}

const R = 6371008.8, rad = d => d * Math.PI / 180;
function hav(a, b) { const dLa = rad(b[1] - a[1]), dLo = rad(b[0] - a[0]); const s = Math.sin(dLa / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); }
function thin(pts, metres) { const out = [pts[0]]; for (const p of pts) if (hav(out[out.length - 1], p) >= metres) out.push(p); if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]); return out; }
const length = pts => pts.slice(1).reduce((d, p, i) => d + hav(pts[i], p), 0);
const unb64 = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), c => c.charCodeAt(0)));

async function gh(env, path, opts = {}) {
  const r = await fetch((env.GITHUB_API || 'https://api.github.com') + '/repos/' + env.GITHUB_REPO + path, Object.assign({}, opts, {
    headers: { authorization: 'Bearer ' + env.GITHUB_TOKEN, accept: 'application/vnd.github+json', 'user-agent': 'Flightroute', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' }
  }));
  if (!r.ok) { const e = new Error('GitHub ' + r.status); e.status = r.status; throw e; }
  return r.status === 204 ? null : r.json();
}

async function addRoute(env, t) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ref = await gh(env, '/git/ref/heads/main');
    const head = ref.object.sha;
    let list = [];
    try { const f = await gh(env, '/contents/routes/index.json?ref=' + head); list = JSON.parse(unb64(f.content)); if (!Array.isArray(list)) list = []; }
    catch (e) { if (e.status !== 404) throw e; }
    const dup = list.find(e => e.id === t.id);
    if (dup) return { ok: true, duplicate: true, file: dup.file };
    const file = `routes/${t.from}-${t.to}-${t.id.slice(-8)}.gpx`;
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Flightroute" xmlns="http://www.topografix.com/GPX/1/1">\n  <trk><name>${t.from} → ${t.to}</name>\n    <trkseg>\n` +
      t.pts.map(p => `      <trkpt lat="${p[1].toFixed(5)}" lon="${p[0].toFixed(5)}">${p[2] != null ? `<ele>${Math.round(p[2])}</ele>` : ''}</trkpt>`).join('\n') +
      `\n    </trkseg>\n  </trk>\n</gpx>\n`;
    list.push({ id: t.id, file, from: t.from, to: t.to, km: Math.round(length(t.pts) / 1000), route: thin(t.pts, 15000).map(p => [+p[0].toFixed(4), +p[1].toFixed(4)]) });
    const base = await gh(env, '/git/commits/' + head);
    const tree = await gh(env, '/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: base.tree.sha, tree: [
      { path: file, mode: '100644', type: 'blob', content: gpx },
      { path: 'routes/index.json', mode: '100644', type: 'blob', content: JSON.stringify(list, null, 1) + '\n' }] }) });
    const commit = await gh(env, '/git/commits', { method: 'POST', body: JSON.stringify({ message: `Add route ${t.from} → ${t.to} (shared from Flightroute)`, tree: tree.sha, parents: [head] }) });
    try { await gh(env, '/git/refs/heads/main', { method: 'PATCH', body: JSON.stringify({ sha: commit.sha }) }); return { ok: true, file }; }
    catch (e) { if (e.status !== 422) throw e; /* someone else committed meanwhile: start again */ }
  }
  throw new Error('GitHub busy');
}

function validate(b) {
  if (!b || typeof b.id !== 'string' || !/^[a-z0-9-]{6,40}$/.test(b.id)) return 'bad id';
  if (!/^[A-Z]{3}$/.test(b.from || '') || !/^[A-Z]{3}$/.test(b.to || '') || b.from === b.to) return 'bad airports';
  if (!Array.isArray(b.pts) || b.pts.length < 10 || b.pts.length > 50000) return 'bad track';
  for (const p of b.pts) if (!Array.isArray(p) || !(Math.abs(p[0]) <= 180) || !(Math.abs(p[1]) <= 90) || (p[2] != null && !(Math.abs(p[2]) < 20000))) return 'bad point';
  return null;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      const a = await allowed(req, env);
      if (!a.ok) return json({ error: a.error }, a.status);
    }
    if (url.pathname === '/api/tracks') {
      if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
      if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return json({ error: 'route library is not set up' }, 503);
      const raw = await req.text();
      if (raw.length > 3_000_000) return json({ error: 'track too large' }, 413);
      let b; try { b = JSON.parse(raw); } catch (e) { return json({ error: 'bad request' }, 400); }
      const bad = validate(b); if (bad) return json({ error: bad }, 400);
      const pts = thin(b.pts.map(p => [p[0], p[1], p[2] == null ? null : p[2]]), 1000);
      if (length(pts) < 30000) return json({ error: 'too short for the route library' }, 400);
      try { return json(await addRoute(env, { id: b.id, from: b.from, to: b.to, pts })); }
      catch (e) { return json({ error: 'could not save to GitHub (' + e.message + ')' }, 502); }
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    return env.ASSETS.fetch(req);
  }
};
