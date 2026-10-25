export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // API ROUTES
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }

    // DASHBOARD ROUTE
    if (url.pathname === "/dashboard") {
      return new Response(DASHBOARD_HTML, { headers: { "content-type": "text/html" } });
    }

    // LANDING PAGE ROUTE
    return new Response(LANDING_HTML, { headers: { "content-type": "text/html" } });
  },

  // CRON JOB
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

// --- API HANDLER ---
async function handleApi(request, env, url) {
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
  
  const workspace = request.headers.get("X-Workspace") || "default";
  const tenantId = workspace.toLowerCase().replace(/[^a-z0-9-]/g, ''); 

  // Check if this tenant exists and what their plan is
  let tenant = await env.DB.prepare(`SELECT plan FROM tenants WHERE id = ?`).bind(tenantId).first();
  if (!tenant) {
    await env.DB.prepare(`INSERT INTO tenants (id, email, plan, created_at) VALUES (?, ?, 'free', ?)`).bind(tenantId, tenantId + "@watcher.local", Date.now()).run();
    tenant = { plan: 'free' };
  }
  const isPremium = tenant.plan === 'premium';

  // ADD APP
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
    let pingInterval = interval ? parseInt(interval) : 5;

    if (!isPremium && pingInterval === 1) {
       return json({ error: "1-minute intervals require Premium. Please upgrade." }, 403);
    }

    await env.DB.prepare(`INSERT INTO apps (id, tenant_id, url, verify_token, verified, interval_min, created_at) VALUES (?, ?, ?, 'none', 1, ?, ?)`)
      .bind(id, tenantId, target, pingInterval, Date.now()).run();

    return json({ id, ok: true }, 201);
  }

  // GET APPS
  if (request.method === "GET" && url.pathname === "/api/apps") {
    const { results: apps } = await env.DB.prepare(`SELECT id, url, interval_min, last_pinged, last_status FROM apps WHERE tenant_id = ?`).bind(tenantId).all();
    for (let app of apps) {
      const { results: logs } = await env.DB.prepare(`SELECT status, latency_ms, created_at FROM ping_logs WHERE app_id = ? ORDER BY created_at DESC LIMIT 5`).bind(app.id).all();
      app.logs = logs;
    }
    return json({ apps, plan: tenant.plan });
  }

  // DELETE APP
  const d = url.pathname.match(/^\/api\/apps\/([^/]+)$/);
  if (request.method === "DELETE" && d) {
    const appId = d[1];
    await env.DB.prepare(`DELETE FROM ping_logs WHERE app_id = ?`).bind(appId).run();
    await env.DB.prepare(`DELETE FROM apps WHERE id = ? AND tenant_id = ?`).bind(appId, tenantId).run();
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
}


// --- THE LANDING PAGE ---
const LANDING_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"><title>Watcher | Keep Your Apps Alive</title>
  <style>
    body { background: #050810; color: #fff; font-family: sans-serif; margin: 0; padding: 0; line-height: 1.6; }
    .nav { display: flex; justify-content: space-between; padding: 20px 40px; border-bottom: 1px solid #1f293d; align-items: center;}
    .nav a { color: #fff; text-decoration: none; font-weight: bold; }
    .hero { text-align: center; padding: 80px 20px; max-width: 800px; margin: 0 auto; }
    .hero img { width: 250px; margin-bottom: 20px; }
    .hero h1 { font-size: 48px; margin: 0 0 10px 0; background: linear-gradient(90deg, #fff, #0088ff); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .hero p { font-size: 18px; color: #94a3b8; margin-bottom: 40px; }
    .btn { background: #0088ff; color: #fff; padding: 15px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 18px; transition: 0.2s; display: inline-block; }
    .btn:hover { background: #0077e6; box-shadow: 0 0 20px rgba(0,136,255,0.5); }
    .features { display: flex; gap: 20px; max-width: 1000px; margin: 0 auto; padding: 40px 20px; text-align: center; flex-wrap: wrap; justify-content: center;}
    .feature-card { background: #0f1523; border: 1px solid #1f293d; padding: 30px; border-radius: 8px; flex: 1; min-width: 250px; }
    .feature-card h3 { color: #0088ff; }
    .pricing { text-align: center; padding: 60px 20px; }
    .pricing-grid { display: flex; gap: 20px; justify-content: center; flex-wrap: wrap; max-width: 800px; margin: 40px auto; }
    .price-card { background: #0f1523; border: 1px solid #1f293d; padding: 40px; border-radius: 8px; flex: 1; min-width: 300px; }
    .price-card.premium { border-color: #0088ff; box-shadow: 0 0 30px rgba(0,136,255,0.2); }
    .footer { text-align: center; padding: 40px; color: #64748b; border-top: 1px solid #1f293d; margin-top: 60px; }
  </style>
</head>
<body>
  <div class="nav">
    <a href="/" style="display:flex; align-items:center; gap:10px;">
       <img src="https://raw.githubusercontent.com/safarisoftwares-code/watcher/main/watcher.png?v=4" style="height:30px;"> Watcher
    </a>
    <a href="/dashboard" class="btn" style="padding: 10px 20px; font-size: 14px;">Go to Dashboard</a>
  </div>

  <div class="hero">
    <img src="https://raw.githubusercontent.com/safarisoftwares-code/watcher/main/watcher.png?v=4" alt="Watcher Logo">
    <h1>Always Watching. Always Working.</h1>
    <p>Free-tier hosting sleeps your apps after 15 minutes. Watcher keeps them awake with precision clock-aligned pings. Zero data collection. Total sovereignty.</p>
    <a href="/dashboard" class="btn">Launch Your Dashboard</a>
  </div>

  <div class="features">
    <div class="feature-card">
      <h3>🔒 Zero Data Collection</h3>
      <p>We only read status codes. We never read your content, headers, or user data.</p>
    </div>
    <div class="feature-card">
      <h3>⏱️ Exact Precision</h3>
      <p>Pings are aligned perfectly to the clock (e.g. 8:00, 8:05). No random delays.</p>
    </div>
    <div class="feature-card">
      <h3>🛡️ Private Workspaces</h3>
      <p>Create a unique Workspace Name. Your apps are isolated and hidden from others.</p>
    </div>
  </div>

  <div class="pricing">
    <h2>Simple, transparent pricing</h2>
    <div class="pricing-grid">
      <div class="price-card">
        <h3>Free</h3>
        <h1 style="color:#fff; font-size:36px; margin:10px 0;">$0</h1>
        <p style="color:#94a3b8; margin-bottom:20px;">Forever</p>
        <ul style="text-align:left; color:#94a3b8; padding-left:20px; margin-bottom:30px;">
          <li>Up to 5 apps</li>
          <li>5, 10, or 15 min intervals</li>
          <li>Private Workspaces</li>
        </ul>
        <a href="/dashboard" class="btn" style="background:#1f293d;">Start Free</a>
      </div>
      <div class="price-card premium">
        <h3>Premium</h3>
        <h1 style="color:#0088ff; font-size:36px; margin:10px 0;">$2<span style="font-size:16px; color:#94a3b8;">/mo</span></h1>
        <p style="color:#94a3b8; margin-bottom:20px;">For power users</p>
        <ul style="text-align:left; color:#e2e8f0; padding-left:20px; margin-bottom:30px;">
          <li><strong>1-minute intervals</strong></li>
          <li>Up to 25 apps</li>
          <li>Priority support</li>
        </ul>
        <a href="/dashboard" class="btn">Upgrade to Premium</a>
      </div>
    </div>
  </div>

  <div class="footer">
    A Safari Softwares Product. Built in Kenya. Built for the world.
  </div>
</body>
</html>
`;


// --- THE DASHBOARD ---
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
  <div class="card">
    <img src="https://raw.githubusercontent.com/safarisoftwares-code/watcher/main/watcher.png?v=4" alt="Watcher Logo" class="logo">
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
          <option value="5" selected>Every 5 min (Free)</option>
          <option value="10">Every 10 min (Free)</option>
          <option value="15">Every 15 min (Free)</option>
        </select>
        <button class="btn" onclick="add()">Add</button>
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
        if (d.plan === 'premium') {
          badge.innerText = "PREMIUM ⭐";
          badge.style.background = "rgba(0,136,255,0.2)";
          badge.style.color = "#0088ff";
        } else {
          badge.innerText = "FREE";
          badge.style.background = "#1f293d";
          badge.style.color = "#94a3b8";
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