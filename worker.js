export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }
    if (url.pathname === "/dashboard") {
      return new Response(DASHBOARD_HTML, { headers: { "content-type": "text/html" } });
    }
    return new Response(LANDING_HTML, { headers: { "content-type": "text/html" } });
  },

  async scheduled(event, env, ctx) {
    const now = new Date();
    now.setSeconds(0);
    now.setMilliseconds(0);
    const currentTimestamp = now.getTime();
    const { results: apps } = await env.DB.prepare(`SELECT id, url, interval_min, last_pinged FROM apps WHERE verified = 1`).all();
    for (const app of apps) {
      let isDue = false;
      if (!app.last_pinged) {
        isDue = true;
      } else {
        const lastPingTime = new Date(app.last_pinged).getTime();
        const intervalMs = app.interval_min * 60000;
        if (currentTimestamp - lastPingTime >= intervalMs) isDue = true;
      }
      if (app.last_pinged && (currentTimestamp - app.last_pinged < 60000)) isDue = false;
      if (isDue) {
        const start = Date.now();
        try {
          const res = await fetch(app.url, { method: "GET", redirect: "manual", headers: { "User-Agent": `watcher/${app.id}` } });
          await res.body?.cancel();
          const latency = Date.now() - start;
          await env.DB.prepare(`UPDATE apps SET last_pinged = ?, last_status = ? WHERE id = ?`).bind(currentTimestamp, res.status, app.id).run();
          const logId = crypto.randomUUID();
          await env.DB.prepare(`INSERT INTO ping_logs (id, app_id, status, latency_ms, created_at) VALUES (?, ?, ?, ?, ?)`).bind(logId, app.id, res.status, latency, currentTimestamp).run();
          await env.DB.prepare(`DELETE FROM ping_logs WHERE app_id = ? AND id NOT IN (SELECT id FROM ping_logs WHERE app_id = ? ORDER BY created_at DESC LIMIT 5)`).bind(app.id, app.id).run();
        } catch (e) {
          const latency = Date.now() - start;
          await env.DB.prepare(`UPDATE apps SET last_pinged = ?, last_status = 0 WHERE id = ?`).bind(currentTimestamp, app.id).run();
          const logId = crypto.randomUUID();
          await env.DB.prepare(`INSERT INTO ping_logs (id, app_id, status, latency_ms, created_at) VALUES (?, ?, 0, ?, ?)`).bind(logId, app.id, latency, currentTimestamp).run();
        }
      }
    }
  }
};

async function handleApi(request, env, url) {
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
  const workspace = request.headers.get("X-Workspace") || "default";
  const tenantId = workspace.toLowerCase().replace(/[^a-z0-9-]/g, ''); 

  let tenant = await env.DB.prepare(`SELECT plan, subscription_expires_at FROM tenants WHERE id = ?`).bind(tenantId).first();
  if (!tenant) {
    await env.DB.prepare(`INSERT INTO tenants (id, email, plan, created_at) VALUES (?, ?, 'free', ?)`).bind(tenantId, tenantId + "@watcher.local", Date.now()).run();
    tenant = { plan: 'free', subscription_expires_at: null };
  }
  
  let isPremium = tenant.plan === 'premium';
  let isInGrace = false;
  
  if (isPremium && tenant.subscription_expires_at) {
    const graceEnd = tenant.subscription_expires_at + (3 * 24 * 60 * 60 * 1000);
    const now = Date.now();
    if (now > graceEnd) {
      await env.DB.prepare(`UPDATE tenants SET plan = 'free' WHERE id = ?`).bind(tenantId).run();
      await env.DB.prepare(`UPDATE apps SET interval_min = 10 WHERE tenant_id = ? AND interval_min < 10`).bind(tenantId).run();
      isPremium = false;
      tenant.plan = 'free';
    } else if (now > tenant.subscription_expires_at) {
      isInGrace = true;
    }
  }

  if (request.method === "POST" && url.pathname === "/api/apps") {
    let { url: target, interval } = await request.json().catch(() => ({}));
    if (!target) return json({ error: "URL required" }, 400);
    target = target.trim();
    if (!target.startsWith("http://") && !target.startsWith("https://")) target = "https://" + target;
    try {
      const parsedUrl = new URL(target);
      const host = parsedUrl.hostname.toLowerCase();
      const BLOCK = [/^10\./, /^127\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^localhost/];
      for (const re of BLOCK) if (re.test(host)) return json({ error: "Private IP addresses not allowed" }, 400);
    } catch { return json({ error: "Invalid URL format" }, 400); }

    const id = crypto.randomUUID();
    let pingInterval = interval ? parseInt(interval) : 10;
    if (!isPremium && (pingInterval === 1 || pingInterval === 5)) {
      return json({ error: "1-minute and 5-minute intervals require Premium." }, 403);
    }
    await env.DB.prepare(`INSERT INTO apps (id, tenant_id, url, verify_token, verified, interval_min, created_at) VALUES (?, ?, ?, 'none', 1, ?, ?)`).bind(id, tenantId, target, pingInterval, Date.now()).run();
    return json({ id, ok: true }, 201);
  }

  if (request.method === "GET" && url.pathname === "/api/apps") {
    const { results: apps } = await env.DB.prepare(`SELECT id, url, interval_min, last_pinged, last_status FROM apps WHERE tenant_id = ?`).bind(tenantId).all();
    for (let app of apps) {
      const { results: logs } = await env.DB.prepare(`SELECT status, latency_ms, created_at FROM ping_logs WHERE app_id = ? ORDER BY created_at DESC LIMIT 5`).bind(app.id).all();
      app.logs = logs;
    }
    return json({ apps, plan: tenant.plan, is_in_grace: isInGrace });
  }

  const d = url.pathname.match(/^\/api\/apps\/([^/]+)$/);
  if (request.method === "DELETE" && d) {
    await env.DB.prepare(`DELETE FROM ping_logs WHERE app_id = ?`).bind(d[1]).run();
    await env.DB.prepare(`DELETE FROM apps WHERE id = ? AND tenant_id = ?`).bind(d[1], tenantId).run();
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
}

const LANDING_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"><title>Watcher | Keep Your Apps Alive</title>
  <style>
    body { background: #050810; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; line-height: 1.6; }
    .nav { position: absolute; top: 0; left: 0; right: 0; display: flex; justify-content: space-between; align-items: center; padding: 20px 40px; max-width: 1100px; margin: 0 auto; z-index: 10; }
    .nav-brand { display: flex; align-items: center; gap: 10px; color: #fff; text-decoration: none; font-weight: bold; font-size: 20px; }
    .nav-brand img { height: 32px; }
    .hero { height: 100vh; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; padding: 0 20px; box-sizing: border-box; background: radial-gradient(circle at center 40%, rgba(0, 136, 255, 0.08) 0%, #050810 60%); position: relative; }
    .hero img { width: 120px; margin-bottom: 20px; filter: drop-shadow(0 0 20px rgba(0, 136, 255, 0.4)); }
    .hero h1 { font-size: 46px; font-weight: 800; margin: 0 0 15px 0; letter-spacing: -1px; background: linear-gradient(90deg, #fff, #0088ff); -webkit-background-clip: text; -webkit-text-fill-color: transparent; max-width: 800px;}
    .hero p { font-size: 18px; color: #94a3b8; margin-bottom: 35px; max-width: 600px; margin-left: auto; margin-right: auto; }
    .btn { background: #0088ff; color: #fff; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px; transition: 0.2s; display: inline-block; border: 1px solid transparent;}
    .btn:hover { background: #0077e6; box-shadow: 0 0 20px rgba(0,136,255,0.5); transform: translateY(-2px); }
    .btn-outline { background: transparent; border: 1px solid #1f293d; color: #e2e8f0; }
    .btn-outline:hover { background: #0f1523; border-color: #0088ff; box-shadow: none; }
    .scroll-indicator { position: absolute; bottom: 18px; display: inline-flex; flex-direction: column; align-items: center; padding: 8px 24px; background: rgba(15, 21, 35, 0.8); border: 1px solid #1f293d; border-radius: 30px; color: #0088ff; text-decoration: none; font-weight: bold; font-size: 13px; animation: bounce 2s infinite; transition: 0.2s; box-shadow: 0 4px 15px rgba(0,0,0,0.5); }
    .scroll-indicator:hover { border-color: #0088ff; background: #151f33; }
    .scroll-indicator span { font-size: 20px; margin-top: 2px; line-height: 1; }
    @keyframes bounce { 0%, 20%, 50%, 80%, 100% { transform: translateY(0); } 40% { transform: translateY(-8px); } 60% { transform: translateY(-4px); } }
    .features { display: flex; gap: 20px; max-width: 1000px; margin: 80px auto; padding: 0 20px; text-align: left; flex-wrap: wrap; justify-content: center;}
    .feature-card { background: #0f1523; border: 1px solid #1f293d; padding: 30px; border-radius: 8px; flex: 1; min-width: 260px; transition: 0.2s;}
    .feature-card:hover { border-color: #0088ff; transform: translateY(-5px);}
    .feature-card h3 { color: #fff; font-size: 18px; margin-top: 0; margin-bottom: 10px; display: flex; align-items: center; gap: 8px;}
    .feature-card p { font-size: 15px; color: #94a3b8; margin: 0; }
    .pricing { text-align: center; padding: 40px 20px 100px 20px; max-width: 1100px; margin: 0 auto; }
    .pricing h2 { font-size: 32px; margin-bottom: 50px; }
    .pricing-grid { display: flex; gap: 20px; justify-content: center; flex-wrap: wrap; align-items: flex-start;}
    .price-card { background: #0f1523; border: 1px solid #1f293d; padding: 40px 35px; border-radius: 8px; flex: 1; min-width: 280px; max-width: 320px; text-align: left; position: relative;}
    .price-card.premium { border-color: #0088ff; box-shadow: 0 0 40px rgba(0,136,255,0.15); }
    .price-card.yearly { border-color: #10b981; box-shadow: 0 0 40px rgba(16,185,129,0.15); transform: scale(1.05); z-index: 10;}
    .badge { position: absolute; top: -12px; right: 20px; background: #10b981; color: #fff; font-size: 11px; font-weight: bold; padding: 4px 10px; border-radius: 20px; text-transform: uppercase; letter-spacing: 0.5px;}
    .price-card h3 { margin-top: 0; font-size: 18px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px;}
    .price-card h1 { color: #fff; font-size: 42px; margin: 10px 0; }
    .price-card.premium h1 { color: #0088ff; }
    .price-card.yearly h1 { color: #10b981; }
    .price-card h1 span { font-size: 16px; color: #94a3b8; font-weight: normal; }
    .price-card ul { list-style: none; padding: 0; margin: 25px 0; color: #e2e8f0; font-size: 14px;}
    .price-card ul li { margin-bottom: 12px; display: flex; align-items: center; gap: 8px;}
    .price-card ul li::before { content: "✓"; color: #10b981; font-weight: bold; }
    .footer { text-align: center; padding: 40px; color: #64748b; border-top: 1px solid #1f293d; font-size: 13px; }
    @media (max-width: 900px) { .price-card.yearly { transform: scale(1); } }
    @media (max-width: 600px) { .hero h1 { font-size: 32px; } .nav { flex-direction: column; gap: 15px; padding: 20px; } }
  </style>
</head>
<body>
  <script>if ('scrollRestoration' in history) { history.scrollRestoration = 'manual'; }</script>
  <div class="nav">
    <a href="/" class="nav-brand"><img src="https://raw.githubusercontent.com/safarisoftwares-code/watcher/main/watcher.png?v=5" fetchpriority="high"> Watcher</a>
    <a href="/dashboard" class="btn btn-outline" style="padding: 10px 20px; font-size: 14px;">Go to Dashboard</a>
  </div>
  <div class="hero">
    <img src="https://raw.githubusercontent.com/safarisoftwares-code/watcher/main/watcher.png?v=5" alt="Watcher Logo" fetchpriority="high">
    <h1>Always Watching. Always Working.</h1>
    <p>Free-tier hosting sleeps your apps after 15 minutes. Watcher keeps them awake with precision clock-aligned pings. Zero data collection. Total sovereignty.</p>
    <a href="/dashboard" class="btn">Launch Your Dashboard</a>
    <a href="#features" class="scroll-indicator">View Pricing<span>↓</span></a>
  </div>
  <div class="features" id="features">
    <div class="feature-card"><h3>🔒 Zero Data Collection</h3><p>We only read status codes. We never read your content, headers, or user data. Your app remains completely private.</p></div>
    <div class="feature-card"><h3>⏱️ Exact Precision</h3><p>Pings are aligned perfectly to the clock (e.g. 8:00, 8:05, 8:10). No random delays, no missed intervals.</p></div>
    <div class="feature-card"><h3>🛡️ Private Workspaces</h3><p>Create a unique Workspace Name. Your apps are cryptographically isolated and hidden from other users.</p></div>
  </div>
  <div class="pricing" id="pricing">
    <h2>Simple, transparent pricing</h2>
    <div class="pricing-grid">
      <div class="price-card">
        <h3>Free</h3>
        <h1>$0</h1>
        <ul><li>Up to 5 apps</li><li>10 or 15 min intervals</li><li>Private Workspaces</li><li>Community support</li></ul>
        <a href="/dashboard" class="btn btn-outline" style="width: 100%; text-align: center; box-sizing: border-box;">Start Free</a>
      </div>
      <div class="price-card premium">
        <h3 style="color: #0088ff;">Premium</h3>
        <h1>$2<span>/mo</span></h1>
        <ul><li><strong>1, 5, 10, or 15 min intervals</strong></li><li>Up to 25 apps</li><li>Priority support</li><li>Support a Kenyan SaaS</li></ul>
        <a href="/dashboard" class="btn" style="width: 100%; text-align: center; box-sizing: border-box; background:#0088ff;">Get Premium</a>
      </div>
      <div class="price-card yearly">
        <div class="badge">Best Value</div>
        <h3 style="color: #10b981;">Premium Yearly</h3>
        <h1>$20<span>/yr</span></h1>
        <ul><li><strong>1, 5, 10, or 15 min intervals</strong></li><li>Up to 25 apps</li><li>Priority support</li><li>Save $4 (2 months free)</li></ul>
        <a href="/dashboard" class="btn" style="width: 100%; text-align: center; box-sizing: border-box; background:#10b981;">Get Premium</a>
      </div>
    </div>
  </div>
  <div class="footer">A Safari Softwares Product. Built in Kenya. Built for the world.</div>
</body>
</html>
`;

const DASHBOARD_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"><title>Watcher Dashboard</title>
  <style>
    body { background: #050810; color: #fff; font-family: sans-serif; padding: 40px; display: flex; justify-content: center; margin: 0;}
    .card { background: #0f1523; border: 1px solid #1f293d; padding: 30px; border-radius: 8px; max-width: 700px; width: 100%; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
    .logo { display: block; max-width: 100%; width: 150px; margin: 0 auto 10px auto; }
    p { color: #94a3b8; font-size: 14px; line-height: 1.5; text-align: center; }
    #workspace-screen { text-align: center; padding: 20px 0; }
    .input-wrapper { position: relative; width: 80%; margin: 0 auto 10px auto; }
    .input-wrapper input { width: 100%; padding: 12px 40px 12px 12px; background: #000; color: #fff; border: 1px solid #1f293d; border-radius: 4px; text-align: center; font-size: 16px; box-sizing: border-box; }
    .eye-btn { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); cursor: pointer; color: #64748b; font-size: 18px; background: none; border: none; padding: 0; }
    .eye-btn:hover { color: #fff; }
    .input-group { display: flex; gap: 10px; margin: 15px 0; }
    input[type="text"] { flex: 1; padding: 12px; background: #000; color: #fff; border: 1px solid #1f293d; border-radius: 4px; }
    select { padding: 12px; background: #000; color: #fff; border: 1px solid #1f293d; border-radius: 4px; cursor: pointer; }
    .btn { background: #0088ff; color: #fff; padding: 12px 20px; border: none; cursor: pointer; border-radius: 4px; font-weight: bold; transition: 0.2s; text-decoration: none; display: inline-block;}
    .btn:hover { background: #0077e6; box-shadow: 0 0 15px rgba(0, 136, 255, 0.4); }
    .delete-btn { background: none; border: none; color: #ef4444; cursor: pointer; font-size: 16px; padding: 0 5px; opacity: 0.7; transition: 0.2s; }
    .delete-btn:hover { opacity: 1; transform: scale(1.1); }
    ul { padding-left: 0; list-style: none; margin-top: 30px;}
    .app-card { background: #151f33; padding: 15px; border-radius: 4px; margin-bottom: 15px; border-left: 4px solid #0088ff; }
    .app-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    .app-header-left { display: flex; align-items: center; gap: 10px; overflow: hidden; }
    .app-url { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 450px; cursor: pointer; transition: color 0.2s; }
    .app-url:hover { color: #0088ff; text-decoration: underline; }
    .status-ok { color: #10b981; font-weight: bold; background: rgba(16,185,129,0.1); padding: 4px 8px; border-radius: 4px;}
    .status-pending { color: #f59e0b; font-weight: bold; background: rgba(245,158,11,0.1); padding: 4px 8px; border-radius: 4px;}
    .timing-grid { display: flex; gap: 20px; font-size: 12px; color: #94a3b8; margin: 10px 0; background: #0a0f18; padding: 10px; border-radius: 4px; }
    .timing-grid div { display: flex; flex-direction: column; }
    .timing-grid strong { color: #fff; font-size: 13px; margin-top: 2px; }
    .logs { font-size: 12px; color: #64748b; margin-top: 10px; border-top: 1px solid #1f293d; padding-top: 10px; }
    .log-item { display: flex; justify-content: space-between; margin-bottom: 4px; }
    .footer { margin-top: 30px; text-align: center; font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 1px; }
  </style>
</head>
<body>
  <script>if ('scrollRestoration' in history) { history.scrollRestoration = 'manual'; }</script>
  <div class="card">
    <img src="https://raw.githubusercontent.com/safarisoftwares-code/watcher/main/watcher.png?v=4" alt="Watcher Logo" class="logo" fetchpriority="high">
    <p>Always Watching. Always Working.</p>
    
    <div id="workspace-screen" style="display: none;">
      <p style="color:#e2e8f0; margin-bottom: 10px;">Enter your Workspace Name to access your dashboard.</p>
      <div class="input-wrapper">
        <input type="password" id="workspace-input" placeholder="e.g. Alpha-Space">
        <button class="eye-btn" onclick="toggleEye()" id="eye-btn">👁️</button>
      </div>
      <button class="btn" onclick="unlockWorkspace()">Enter</button>
      <p style="font-size: 11px; margin-top: 15px; color: #64748b;">New here? Just type a name to create a new private workspace.</p>
    </div>

    <div id="dashboard-screen" style="display: none;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid #1f293d;">
        <span style="font-size: 13px; color: #94a3b8;">Workspace: <strong id="current-workspace" style="color: #e2e8f0;"></strong> <span id="plan-badge" style="font-size:10px; padding:2px 6px; border-radius:4px; background:#1f293d; margin-left:5px;">FREE</span></span>
        <a href="#" onclick="logout()" style="font-size: 12px; color: #ef4444; text-decoration: none;">Switch Workspace</a>
      </div>

      <div class="input-group">
        <input type="text" id="url" placeholder="Paste your Render URL here (https://...)">
        <select id="interval">
          <option value="1">Every 1 min (Premium ⭐)</option>
          <option value="5">Every 5 min (Premium ⭐)</option>
          <option value="10" selected>Every 10 min (Free)</option>
          <option value="15">Every 15 min (Free)</option>
        </select>
        <button class="btn" onclick="add()">Add</button>
      </div>
      
      <div id="upgrade-banner" style="display:none; margin-top: 15px; background: rgba(16, 185, 129, 0.1); border: 1px solid #10b981; padding: 15px; border-radius: 4px; text-align: center;">
         <p id="banner-text" style="color:#10b981; margin:0 0 10px 0; font-weight:bold;">Want 1-minute or 5-minute pings? Upgrade to Premium.</p>
         <a id="whatsapp-upgrade-btn" href="#" target="_blank" class="btn" style="background:#10b981; display:inline-block; margin-bottom:5px;">Upgrade via WhatsApp</a>
         <a id="email-upgrade-btn" href="#" target="_blank" class="btn btn-outline" style="display:inline-block; border:1px solid #1f293d;">Upgrade via Email</a>
      </div>

      <ul id="list"></ul>
      
      <div style="text-align:center; margin-top:20px;">
         <a href="/" style="color:#64748b; font-size:12px; text-decoration:none;">← Back to Homepage</a>
      </div>
    </div>

    <div class="footer">A Safari Softwares Product</div>
  </div>

  <script>
    let workspace = localStorage.getItem('watcher_workspace');

    if (workspace) {
      document.getElementById('dashboard-screen').style.display = 'block';
      document.getElementById('current-workspace').innerText = workspace;
      
      const waMsg = encodeURIComponent('Hi Safari Softwares, I want to upgrade my Watcher Workspace (' + workspace + ') to Premium.');
      document.getElementById('whatsapp-upgrade-btn').href = 'https://wa.me/254112168732?text=' + waMsg;
      
      const emailSubject = encodeURIComponent('Upgrade Watcher Workspace: ' + workspace);
      const emailBody = encodeURIComponent('Hi Safari Softwares, I want to upgrade my Watcher Workspace (' + workspace + ') to Premium.');
      document.getElementById('email-upgrade-btn').href = 'mailto:info@safarisoftwares.co.ke?subject=' + emailSubject + '&body=' + emailBody;

      loadApps();
      setInterval(loadApps, 10000);
    } else {
      document.getElementById('workspace-screen').style.display = 'block';
    }

    function toggleEye() {
      const input = document.getElementById('workspace-input');
      const btn = document.getElementById('eye-btn');
      if (input.type === 'password') {
        input.type = 'text';
        btn.innerText = '🙈';
      } else {
        input.type = 'password';
        btn.innerText = '👁️';
      }
    }

    function unlockWorkspace() {
      const key = document.getElementById('workspace-input').value.trim();
      if (!key) return;
      localStorage.setItem('watcher_workspace', key);
      location.reload();
    }

    function logout() {
      localStorage.removeItem('watcher_workspace');
      location.reload();
    }

    async function loadApps() {
      workspace = localStorage.getItem('watcher_workspace');
      const res = await fetch('/api/apps', {
        headers: { 'X-Workspace': workspace }
      });
      const d = await res.json();
      
      if (d.apps) {
        const badge = document.getElementById('plan-badge');
        const banner = document.getElementById('upgrade-banner');
        const bannerText = document.getElementById('banner-text');

        if (d.is_in_grace) {
          badge.innerText = "PREMIUM ⚠️";
          badge.style.background = "rgba(245,158,11,0.2)";
          badge.style.color = "#f59e0b";
          banner.style.display = 'block';
          banner.style.background = 'rgba(245,158,11,0.1)';
          banner.style.borderColor = '#f59e0b';
          bannerText.innerText = "⚠️ Your Premium subscription has expired. You have a 3-day grace period. Please renew now to avoid downgrade.";
          bannerText.style.color = '#f59e0b';
        } else if (d.plan === 'premium') {
          badge.innerText = "PREMIUM ⭐";
          badge.style.background = "rgba(0,136,255,0.2)";
          badge.style.color = "#0088ff";
          banner.style.display = 'none';
        } else {
          badge.innerText = "FREE";
          badge.style.background = "#1f293d";
          badge.style.color = "#94a3b8";
          banner.style.display = 'block';
          banner.style.background = 'rgba(16,185,129,0.1)';
          banner.style.borderColor = '#10b981';
          bannerText.innerText = "Want 1-minute or 5-minute pings? Upgrade to Premium.";
          bannerText.style.color = '#10b981';
        }

        document.getElementById('list').innerHTML = d.apps.map(a => {
          const status = a.last_status 
            ? '<span class="status-ok">STATUS: ' + a.last_status + '</span>' 
            : '<span class="status-pending">PENDING</span>';
          
          let lastPingStr = "Never";
          let nextPingStr = "Soon";
          
          if (a.last_pinged) {
            const lastDate = new Date(a.last_pinged);
            lastDate.setSeconds(0);
            lastDate.setMilliseconds(0);
            lastPingStr = lastDate.toLocaleTimeString();
            
            const nextDate = new Date(lastDate.getTime() + (a.interval_min * 60000));
            nextPingStr = nextDate.toLocaleTimeString();
          }

          const logsHtml = a.logs.map(l => {
            const logDate = new Date(l.created_at);
            logDate.setSeconds(0);
            logDate.setMilliseconds(0);
            const time = logDate.toLocaleTimeString();
            const color = l.status === 200 ? '#10b981' : '#ef4444';
            return '<div class="log-item"><span>' + time + '</span> <span style="color:' + color + '">' + l.status + ' (' + l.latency_ms + 'ms)</span></div>';
          }).join('');

          return \`
            <li class="app-card">
              <div class="app-header">
                <div class="app-header-left">
                  <button class="delete-btn" onclick="deleteApp('\${a.id}')" title="Delete Target">🗑️</button>
                  <strong class="app-url" ondblclick="window.open('\${a.url}', '_blank')" title="Double-click to open \${a.url}">\${a.url}</strong>
                </div>
                \${status}
              </div>
              
              <div class="timing-grid">
                <div>Interval <strong>Every \${a.interval_min} min</strong></div>
                <div>Last Ping <strong>\${lastPingStr}</strong></div>
                <div>Next Ping <strong>\${nextPingStr}</strong></div>
              </div>

              <div class="logs">
                <strong style="color:#e2e8f0; display:block; margin-bottom:5px;">Recent Activity:</strong>
                \${logsHtml || '<div style="color:#64748b;">No pings logged yet...</div>'}
              </div>
            </li>
          \`;
        }).join('');
      }
    }

    async function add() {
      const url = document.getElementById('url').value;
      const interval = document.getElementById('interval').value;
      if (!url) return;
      
      const res = await fetch('/api/apps', { 
        method:'POST', 
        headers:{'Content-Type':'application/json', 'X-Workspace': workspace}, 
        body:JSON.stringify({url: url, interval: interval}) 
      });
      
      if (!res.ok) {
        const error = await res.json();
        alert(error.error || "Failed to add app");
        return;
      }
      
      document.getElementById('url').value = '';
      loadApps();
    }

    async function deleteApp(id) {
      if (!confirm("Are you sure you want to delete this target? This will stop all pings for this URL.")) return;
      
      await fetch('/api/apps/' + id, {
        method: 'DELETE',
        headers: { 'X-Workspace': workspace }
      });
      
      loadApps();
    }
  </script>
</body>
</html>
`;