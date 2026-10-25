// Timely publisher: приём файлов от чекера и публикация на Cloudflare Pages
// сереверно. Только /api/* ходит через этот воркер (см. _routes.json),
// остальное — статика как раньше.
//
// Ключ (шарится с чекером), серверный токен Cloudflare подставляется при
// сборке на ПК (TIMELY_CF_TOKEN).
const ACC = '159791e2cf9efcb4531b2475cc9c4cf5';
const PROJECT = 'timely-ggpk';
const API = 'https://api.cloudflare.com/client/v4';
const TOKEN = ''; // TIMELY_CF_TOKEN
const KEYS = [
  'nfp_EhW16oQMhMBhWoWe4jcyNzuHL5yPFfM8b30d12:52',
  'nfp_EhW16oQMhMBhWoWe4jcyNzuHL5yPFfM8b30d12',
];

// Помимо личных ключей (KEYS) принимаем и токен Cloudflare(cfat_…):
// проверяем его живым запросом к нашему проекту — подходит, только
// если токен реально имеет доступ к проекту. Результат кэшируем.
const cfatCache = new Map(); // ключ -> «действителен до»

async function accessOK(k) {
  let ok = KEYS.includes(k);
  if (!ok) {
    const until = cfatCache.get(k) || 0;
    if (until > Date.now()) {
      ok = true;
    } else {
      const probe = await fetch(
        `${API}/accounts/${ACC}/pages/projects/${PROJECT}/deployments?max_count=1`,
        { headers: { Authorization: 'Bearer ' + k } });
      if (probe.ok) {
        ok = true;
        cfatCache.set(k, Date.now() + 10 * 60 * 1000);
      }
    }
  }
  return ok;
}

function json(o, status = 200, more = {}) {
  return new Response(JSON.stringify(o), {
    status,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, more),
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sha256hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0'))
      .join('').slice(0, 32); // ключ длиной 32, как у wrangler
}

function bufToB64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(s);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      if (request.method !== 'POST') {
        return json({ ok: false, error: 'нужен POST' }, 405);
      }
      const k = (request.headers.get('x-timely-key') || '').trim();
      if (!k.length || !(await accessOK(k))) {
        return json({ ok: false, error: 'ключ не принят' }, 403);
      }
      const tok = env.CF_API_TOKEN || TOKEN;
      if (!tok) return json({ ok: false, error: 'почтарь не настроен' }, 503);

      if (url.pathname === '/api/ping') {
        return json({ ok: true, service: 'timely-publisher' });
      }
      if (url.pathname !== '/api/publish') {
        return json({ ok: false, error: 'нет такого пути' }, 404);
      }
      return await publish(request, tok);
    } catch (e) {
      return json({ ok: false, error: 'почтарь: ' + String((e && e.message) || e) }, 500);
    }
  },
};

async function publish(request, tok) {
  const form = await request.formData();
  const parts = form.getAll('file');
  if (!parts.length) return json({ ok: false, error: 'файлы не получены' }, 400);
  const files = [];
  for (const p of parts) {
    const name = String(p.name || '').trim();
    if (!/^[\w\-.]+(\/[\w\-.]+)*$/.test(name) || name.includes('..')) {
      return json({ ok: false, error: 'плохое имя файла: ' + name }, 400);
    }
    files.push({ name, bytes: new Uint8Array(await p.arrayBuffer()) });
  }

  const H = { Authorization: 'Bearer ' + tok };

  // 1) манифест последнего деплоя
  const lr = await fetch(`${API}/accounts/${ACC}/pages/projects/${PROJECT}/deployments`, { headers: H });
  if (!lr.ok) return json({ ok: false, error: 'сайт: HTTP ' + lr.status }, 502);
  const list = ((await lr.json()).result || []);
  if (!list.length) return json({ ok: false, error: 'на сайте нет деплоев' }, 502);
  const dd = await fetch(
    `${API}/accounts/${ACC}/pages/projects/${PROJECT}/deployments/${list[0].id}`, { headers: H });
  if (!dd.ok) return json({ ok: false, error: 'сайт: HTTP ' + dd.status }, 502);
  const fmap = Object.assign({}, (((await dd.json()).result || {}).files || {}));

  // 2) дайджесты новых файлов (sha256 — свой неймспейс ключей)
  const fresh = [];
  for (const f of files) {
    const h = await sha256hex(f.bytes);
    fresh.push({ name: f.name, bytes: f.bytes, h });
    fmap['/src/' + f.name] = h;
  }

  // 3) заливка недостающих блобов
  const tr = await fetch(`${API}/accounts/${ACC}/pages/projects/${PROJECT}/upload-token`, { headers: H });
  if (!tr.ok) return json({ ok: false, error: 'заливка: HTTP ' + tr.status }, 502);
  const jwt = ((await tr.json()).result || {}).jwt || '';
  const JH = { Authorization: 'Bearer ' + jwt, 'content-type': 'application/json' };
  const mr = await fetch(`${API}/pages/assets/check-missing`, {
    method: 'POST', headers: JH, body: JSON.stringify({ hashes: Object.values(fmap) }),
  });
  if (!mr.ok) return json({ ok: false, error: 'заливка: HTTP ' + mr.status }, 502);
  const missing = new Set((await mr.json()).result || []);
  for (const f of fresh) {
    if (!missing.has(f.h)) continue;
    const up = await fetch(`${API}/pages/assets/upload`, {
      method: 'POST', headers: JH,
      body: JSON.stringify([{
        key: f.h, value: bufToB64(f.bytes),
        metadata: { contentType: 'application/pdf' }, base64: true,
      }]),
    });
    if (!up.ok) return json({ ok: false, error: 'заливка: HTTP ' + up.status }, 502);
  }
  const hr = await fetch(`${API}/pages/assets/upsert-hashes`, {
    method: 'POST', headers: JH, body: JSON.stringify({ hashes: Object.values(fmap) }),
  });
  if (!hr.ok) return json({ ok: false, error: 'заливка: HTTP ' + hr.status }, 502);

  // 4) деплой (multipart: только поля manifest и branch, без filename)
  const bnd = '----timely' + Date.now().toString(16);
  const body = `--${bnd}\r\nContent-Disposition: form-data; name="manifest"\r\n\r\n${
    JSON.stringify(fmap)}\r\n--${bnd}\r\nContent-Disposition: form-data; name="branch"\r\n\r\nmain\r\n--${bnd}--\r\n`;
  const dep = await fetch(`${API}/accounts/${ACC}/pages/projects/${PROJECT}/deployments`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tok, 'content-type': 'multipart/form-data; boundary=' + bnd },
    body,
  });
  if (!dep.ok) {
    const t = (await dep.text()).slice(0, 200);
    return json({ ok: false, error: 'деплой: HTTP ' + dep.status + ' ' + t }, 502);
  }
  const ndid = (((await dep.json()).result || {}).id) || list[0].id;

  // 5) ждём deploy/success
  for (let i = 0; i < 12; i++) {
    await sleep(4000);
    const gd = await fetch(
      `${API}/accounts/${ACC}/pages/projects/${PROJECT}/deployments/${ndid}`, { headers: H });
    if (!gd.ok) continue;
    const st = (((await gd.json()).result || {}).latest_stage) || {};
    if (st.name === 'deploy' && st.status === 'success') {
      return json({ ok: true, deployment: ndid, published: fresh.map((f) => '/src/' + f.name) });
    }
    if (st.status === 'failure' || st.status === 'canceled') {
      return json({ ok: false, error: 'деплой не собрался' }, 502);
    }
  }
  return json({ ok: true, pending: true, deployment: ndid });
}
