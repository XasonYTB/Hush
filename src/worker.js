// Hush — Cloudflare Worker
// Your own music library:
//   * songs + covers live in an R2 bucket (binding: MUSIC)
//   * a small index.json in the same bucket lists every song
//   * /admin/ (password protected) uploads, edits and deletes songs
//   * everyone else can browse and stream

const enc = new TextEncoder();

const MAX_AUDIO = 95 * 1024 * 1024; // Cloudflare caps request bodies at 100 MB on Free/Pro plans
const MAX_COVER = 3 * 1024 * 1024;
const SESSION_DAYS = 30;
const INDEX_KEY = 'index.json';

/* ---------------- small helpers ---------------- */

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });

const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const ID_RE = /^[a-z0-9]{6,32}$/;
const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

const slug = (s) =>
  String(s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- auth (signed cookie) ---------------- */

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function makeToken(env) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  return `${exp}.${await hmac(env.ADMIN_PASSWORD, 'hush-session:' + exp)}`;
}
async function isAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const m = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)hush_admin=([^;]+)/);
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await hmac(env.ADMIN_PASSWORD, 'hush-session:' + exp));
}
const cookie = (value, maxAge, secure) =>
  `hush_admin=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;

/* ---------------- library index ---------------- */

async function readIndex(env) {
  const obj = await env.MUSIC.get(INDEX_KEY);
  if (!obj) return [];
  try { return await obj.json(); } catch { return []; }
}
async function writeIndex(env, list) {
  await env.MUSIC.put(INDEX_KEY, JSON.stringify(list), { httpMetadata: { contentType: 'application/json' } });
}
function publicTrack(t) {
  const cover = t.hasCover ? `/media/cover/${t.id}` : null;
  return {
    id: t.id,
    title: t.title,
    duration: t.duration,
    genre: t.genre || '',
    addedAt: t.addedAt,
    artwork: cover ? { '150x150': cover, '480x480': cover, '1000x1000': cover } : null,
    user: { id: slug(t.artist), name: t.artist },
  };
}

/* ---------------- streaming from R2 (with Range support) ---------------- */

async function serveObject(request, env, key, cacheControl) {
  if (request.method === 'HEAD') {
    const head = await env.MUSIC.head(key);
    if (!head) return json({ error: 'Not found' }, 404);
    const h = new Headers();
    head.writeHttpMetadata(h);
    h.set('ETag', head.httpEtag);
    h.set('Accept-Ranges', 'bytes');
    h.set('Content-Length', String(head.size));
    h.set('Cache-Control', cacheControl);
    return new Response(null, { headers: h });
  }

  const wantsRange = request.headers.has('Range');
  let obj;
  try {
    obj = await env.MUSIC.get(key, wantsRange ? { range: request.headers } : {});
  } catch {
    return new Response('Invalid range', { status: 416 });
  }
  if (!obj) return json({ error: 'Not found' }, 404);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('ETag', obj.httpEtag);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', cacheControl);

  let status = 200;
  if (wantsRange && obj.range) {
    let start = obj.range.offset ?? 0;
    let length = obj.range.length ?? obj.size - start;
    if (obj.range.suffix !== undefined) {
      length = Math.min(obj.range.suffix, obj.size);
      start = obj.size - length;
    }
    headers.set('Content-Range', `bytes ${start}-${start + length - 1}/${obj.size}`);
    headers.set('Content-Length', String(length));
    status = 206;
  } else {
    headers.set('Content-Length', String(obj.size));
  }
  return new Response(obj.body, { status, headers });
}

/* ---------------- admin API ---------------- */

async function admin(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  const secure = url.protocol === 'https:';

  if (!env.ADMIN_PASSWORD) {
    if (path === '/api/admin/session') return json({ configured: false, authed: false });
    return json({ error: 'Admin is not set up yet. Run: npx wrangler secret put ADMIN_PASSWORD' }, 503);
  }

  // Cross-site requests can't change anything.
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = request.headers.get('Origin');
    if (origin && new URL(origin).host !== url.host) return json({ error: 'Forbidden' }, 403);
  }

  if (path === '/api/admin/session' && method === 'GET') {
    return json({ configured: true, authed: await isAdmin(request, env) });
  }

  if (path === '/api/admin/login' && method === 'POST') {
    const body = await request.json().catch(() => null);
    const given = typeof body?.password === 'string' ? body.password : '';
    const same = safeEqual(await hmac('login-check', given), await hmac('login-check', env.ADMIN_PASSWORD));
    if (!same) { await sleep(600); return json({ error: 'Wrong password.' }, 401); }
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(await makeToken(env), SESSION_DAYS * 86400, secure) });
  }

  if (path === '/api/admin/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': cookie('', 0, secure) });
  }

  // Everything below needs a valid session.
  if (!(await isAdmin(request, env))) return json({ error: 'Please sign in.' }, 401);

  // 1) upload the audio file (raw body, streamed straight into R2)
  if (path === '/api/admin/audio' && method === 'PUT') {
    const type = request.headers.get('Content-Type') || '';
    if (!type.startsWith('audio/')) return json({ error: 'That doesn’t look like an audio file.' }, 415);
    const size = Number(request.headers.get('Content-Length'));
    if (!size) return json({ error: 'Missing file size.' }, 411);
    if (size > MAX_AUDIO) return json({ error: 'Files over 95 MB aren’t supported. MP3 or M4A keep songs small.' }, 413);
    const id = newId();
    await env.MUSIC.put('audio/' + id, request.body, { httpMetadata: { contentType: type } });
    return json({ id });
  }

  // 2) optional cover image
  let m = path.match(/^\/api\/admin\/cover\/([a-z0-9]{6,32})$/);
  if (m && method === 'PUT') {
    const id = m[1];
    const type = request.headers.get('Content-Type') || '';
    if (!type.startsWith('image/')) return json({ error: 'Covers must be images.' }, 415);
    const size = Number(request.headers.get('Content-Length'));
    if (!size || size > MAX_COVER) return json({ error: 'Cover images must be under 3 MB.' }, 413);
    if (!(await env.MUSIC.head('audio/' + id))) return json({ error: 'Upload the song first.' }, 404);
    await env.MUSIC.put('cover/' + id, request.body, { httpMetadata: { contentType: type } });
    return json({ ok: true });
  }

  // 3) publish: add the song to the library
  if (path === '/api/admin/tracks' && method === 'POST') {
    const b = await request.json().catch(() => null);
    if (!b || !ID_RE.test(String(b.id || ''))) return json({ error: 'Invalid song.' }, 400);
    const title = clean(b.title, 200), artist = clean(b.artist, 120), genre = clean(b.genre, 40);
    if (!title || !artist) return json({ error: 'A title and an artist are required.' }, 400);
    const audio = await env.MUSIC.head('audio/' + b.id);
    if (!audio) return json({ error: 'The audio file is missing. Upload it again.' }, 404);
    const hasCover = b.hasCover ? !!(await env.MUSIC.head('cover/' + b.id)) : false;
    const duration = Math.max(0, Math.min(86400, Math.round(Number(b.duration) || 0)));

    const list = await readIndex(env);
    if (list.some((t) => t.id === b.id)) return json({ error: 'Already published.' }, 409);
    const track = { id: b.id, title, artist, genre, duration, hasCover, size: audio.size, addedAt: new Date().toISOString() };
    list.unshift(track);
    await writeIndex(env, list);
    return json({ track: publicTrack(track) }, 201);
  }

  m = path.match(/^\/api\/admin\/tracks\/([a-z0-9]{6,32})$/);
  if (m && method === 'PATCH') {
    const b = await request.json().catch(() => null);
    if (!b) return json({ error: 'Invalid request.' }, 400);
    const list = await readIndex(env);
    const t = list.find((x) => x.id === m[1]);
    if (!t) return json({ error: 'Song not found.' }, 404);
    if (b.title !== undefined) { const v = clean(b.title, 200); if (!v) return json({ error: 'Title can’t be empty.' }, 400); t.title = v; }
    if (b.artist !== undefined) { const v = clean(b.artist, 120); if (!v) return json({ error: 'Artist can’t be empty.' }, 400); t.artist = v; }
    if (b.genre !== undefined) t.genre = clean(b.genre, 40);
    await writeIndex(env, list);
    return json({ track: publicTrack(t) });
  }
  if (m && method === 'DELETE') {
    const list = await readIndex(env);
    const next = list.filter((x) => x.id !== m[1]);
    if (next.length === list.length) return json({ error: 'Song not found.' }, 404);
    await writeIndex(env, next);
    await env.MUSIC.delete(['audio/' + m[1], 'cover/' + m[1]]);
    return json({ ok: true });
  }

  return json({ error: 'Not found' }, 404);
}

/* ---------------- entry point ---------------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/api/library' && request.method === 'GET') {
        const list = await readIndex(env);
        return json({ tracks: list.map(publicTrack) });
      }

      const media = path.match(/^\/media\/(audio|cover)\/([a-z0-9]{6,32})$/);
      if (media && (request.method === 'GET' || request.method === 'HEAD')) {
        return serveObject(request, env, `${media[1]}/${media[2]}`, 'public, max-age=86400');
      }

      if (path.startsWith('/api/admin/')) return await admin(request, env, url);

      if (path.startsWith('/api/') || path.startsWith('/media/')) return json({ error: 'Not found' }, 404);
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err);
      return json({ error: 'Something went wrong on the server.' }, 500);
    }
  },
};
