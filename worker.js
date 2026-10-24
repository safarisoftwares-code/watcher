export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const tenant = await requireTenant(request, env);
      if (!tenant) return json({ error: "unauthorized" }, 401);

      if (request.method === "POST" && url.pathname === "/api/apps") {
        const { n } = await env.DB.prepare(`SELECT COUNT(*) AS n FROM apps WHERE tenant_id = ?`).bind(tenant.id).first();
        if (n >= 5) return json({ error: "app cap reached" }, 402);
        const { url: target, label } = await request.json().catch(() => ({}));
        const id = crypto.randomUUID();
        const tb = crypto.getRandomValues(new Uint8Array(16));
        const verifyToken = [...tb].map(x => x.toString(16).padStart(2, "0")).join("");
        await env.DB.prepare(`INSERT INTO apps (id, tenant_id, url, label, verify_token, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(id, tenant.id, target, label || null, verifyToken, Date.now()).run();
        return json({ id, verify: `Place at ${new URL(target).origin}/.well-known/keepalive-${verifyToken}.txt containing: ${verifyToken}` }, 201);
      }

      const m = url.pathname.match(/^\/api\/apps\/([^/]+)\/verify$/);
      if (request.method === "POST" && m) {
        const app = await env.DB.prepare(`SELECT * FROM apps WHERE id = ? AND tenant_id = ?`).bind(m[1], tenant.id).first();
        if (!app) return json({ error: "not found" }, 404);
        const res = await fetch(`${new URL(app.url).origin}/.well-known/keepalive-${app.verify_token}.txt`);
        if (res.status !== 200) return json({ verified: false, hint: "file not found" }, 202);
        const body = await res.text();
        if (!body.includes(app.verify_token)) return json({ verified: false, hint: "wrong token" }, 202);
        await env.DB.prepare(`UPDATE apps SET verified = 1 WHERE id = ?`).bind(app.id).run();
        return json({ verified: true });
      }

      if (request.method === "GET" && url.pathname === "/api/apps") {
        const { results } = await env.DB.prepare(`SELECT id, url, label, verified, interval_min, last_pinged, last_status FROM apps WHERE tenant_id = ?`).bind(tenant.id).all();
        return json({ apps: results });
      }
      return json({ error: "not found" }, 404);
    }
    return new Response(DASHBOARD_HTML, { headers: { "content-type": "text/html" } });
  },

  async scheduled(event, env, ctx) {
    const now = Date.now();
    const { results: apps } = await env.DB.prepare(`SELECT id, url, interval_min, last_pinged FROM apps WHERE verified = 1`).all();
    for (const app of apps) {
      if (!app.last_pinged || now - app.last_pinged >= app.interval_min * 60000) {
        try {
          const res = await fetch(app.url, { method: "GET", redirect: "manual", headers: { "User-Agent": `watcher/${app.id}` } });
          await res.body?.cancel();
          await env.DB.prepare(`UPDATE apps SET last_pinged = ?, last_status = ? WHERE id = ?`).bind(now, res.status, app.id).run();
        } catch {
          await env.DB.prepare(`UPDATE apps SET last_pinged = ?, last_status = 0 WHERE id = ?`).bind(now, app.id).run();
        }
      }
    }
  }
};
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
async function requireTenant(request, env) {
  const h = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const hash = await sha256Hex(h);
  return await env.DB.prepare(`SELECT t.id, t.plan FROM api_keys k JOIN tenants t ON t.id = k.tenant_id WHERE k.key_hash = ? AND k.revoked = 0`).bind(hash).first();
}
async function sha256Hex(str) {
  const buf = new TextEncoder().encode(str);
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const DASHBOARD_HTML = `
<!DOCTYPE html><html><head><meta charset="UTF-8"><title>WATCHER</title>
<style>body { background: #050810; color: #fff; font-family: sans-serif; padding: 40px; }
.card { background: #0f1523; border: 1px solid #1f293d; padding: 20px; border-radius: 8px; max-width: 600px; margin: auto; }
input { width: 100%; padding: 10px; margin: 10px 0; background: #000; color: #fff; border: 1px solid #1f293d; box-sizing: border-box;}
button { background: #0088ff; color: #fff; padding: 10px 20px; border: none; cursor: pointer; }</style></head>
<body><div class="card"><h2>WATCHER</h2><p>Always Watching. Always Working.</p>
<input type="password" id="key" placeholder="kw_live_..."><button onclick="login()">Connect</button>
<div id="dash" style="display:none; margin-top:20px;"><input type="text" id="url" placeholder="https://your-app.onrender.com">
<button onclick="add()">Add Target</button><ul id="list"></ul></div></div>
<script>
let k = localStorage.getItem('watcher_key');
function login() { localStorage.setItem('watcher_key', document.getElementById('key').value); location.reload(); }
if (k) { document.getElementById('dash').style.display = 'block';
fetch('/api/apps', {headers:{Authorization:'Bearer '+k}}).then(r=>r.json()).then(d=>{
if(d.apps) document.getElementById('list').innerHTML = d.apps.map(a=>\`<li>\${a.url} - \${a.verified?'SECURE':'UNVERIFIED'}</li>\`).join('');
});}
async function add() { await fetch('/api/apps', { method:'POST', headers:{Authorization:'Bearer '+k, 'Content-Type':'application/json'}, body:JSON.stringify({url:document.getElementById('url').value}) }); location.reload(); }
</script></body></html>`