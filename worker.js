export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // 1. Get the Workspace Name from the request header
    const workspace = request.headers.get("X-Workspace") || "default";
    const tenantId = workspace.toLowerCase().replace(/[^a-z0-9-]/g, ''); 

    if (url.pathname.startsWith("/api/")) {
      
      if (request.method === "POST" && url.pathname === "/api/apps") {
        const { url: target, interval } = await request.json().catch(() => ({}));
        if (!target) return json({ error: "URL required" }, 400);
        
        const id = crypto.randomUUID();
        const pingInterval = interval ? parseInt(interval) : 5;

        await env.DB.prepare(`INSERT INTO apps (id, tenant_id, url, verify_token, verified, interval_min, created_at) VALUES (?, ?, ?, 'none', 1, ?, ?)`)
          .bind(id, tenantId, target, pingInterval, Date.now()).run();

        return json({ id, ok: true }, 201);
      }

      if (request.method === "GET" && url.pathname === "/api/apps") {
        const { results: apps } = await env.DB.prepare(`SELECT id, url, interval_min, last_pinged, last_status FROM apps WHERE tenant_id = ?`).bind(tenantId).all();
        
        for (let app of apps) {
          const { results: logs } = await env.DB.prepare(`SELECT status, latency_ms, created_at FROM ping_logs WHERE app_id = ? ORDER BY created_at DESC LIMIT 5`).bind(app.id).all();
          app.logs = logs;
        }
        
        return json({ apps });
      }

      return json({ error: "not found" }, 404);
    }

    return new Response(DASHBOARD_HTML, { headers: { "content-type": "text/html" } });
  },

  // CRON JOB (Runs exactly on the minute intervals)
  async scheduled(event, env, ctx) {
    const now = new Date();
    const currentMinute = now.getMinutes(); 

    const { results: apps } = await env.DB.prepare(`SELECT id, url, interval_min, last_pinged FROM apps WHERE verified = 1`).all();
    const due = apps.filter(a => currentMinute % a.interval_min === 0);
    
    for (const app of due) {
      if (app.last_pinged && (Date.now() - app.last_pinged) < 30000) continue;

      const start = Date.now();
      try {
        const res = await fetch(app.url, { method: "GET", redirect: "manual", headers: { "User-Agent": `watcher/${app.id}` } });
        await res.body?.cancel();
        const latency = Date.now() - start;
        
        await env.DB.prepare(`UPDATE apps SET last_pinged = ?, last_status = ? WHERE id = ?`).bind(Date.now(), res.status, app.id).run();
        
        const logId = crypto.randomUUID();
        await env.DB.prepare(`INSERT INTO ping_logs (id, app_id, status, latency_ms, created_at) VALUES (?, ?, ?, ?, ?)`).bind(logId, app.id, res.status, latency, Date.now()).run();
        
        await env.DB.prepare(`DELETE FROM ping_logs WHERE app_id = ? AND id NOT IN (SELECT id FROM ping_logs WHERE app_id = ? ORDER BY created_at DESC LIMIT 5)`).bind(app.id, app.id).run();

      } catch (e) {
        const latency = Date.now() - start;
        await env.DB.prepare(`UPDATE apps SET last_pinged = ?, last_status = 0 WHERE id = ?`).bind(Date.now(), app.id).run();
        const logId = crypto.randomUUID();
        await env.DB.prepare(`INSERT INTO ping_logs (id, app_id, status, latency_ms, created_at) VALUES (?, ?, 0, ?, ?)`).bind(logId, app.id, latency, Date.now()).run();
      }
    }
  }
};

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

const DASHBOARD_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"><title>WATCHER</title>
  <style>
    body { background: #050810; color: #fff; font-family: sans-serif; padding: 40px; display: flex; justify-content: center; }
    .card { background: #0f1523; border: 1px solid #1f293d; padding: 30px; border-radius: 8px; max-width: 700px; width: 100%; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
    .logo { display: block; max-width: 100%; width: 200px; margin: 0 auto 10px auto; }
    p { color: #94a3b8; font-size: 14px; line-height: 1.5; text-align: center; }
    
    /* Workspace Login Screen */
    #workspace-screen { text-align: center; padding: 20px 0; }
    .input-wrapper { position: relative; width: 80%; margin: 0 auto 10px auto; }
    .input-wrapper input { width: 100%; padding: 12px 40px 12px 12px; background: #000; color: #fff; border: 1px solid #1f293d; border-radius: 4px; text-align: center; font-size: 16px; box-sizing: border-box; }
    .eye-btn { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); cursor: pointer; color: #64748b; font-size: 18px; background: none; border: none; padding: 0; }
    .eye-btn:hover { color: #fff; }

    .input-group { display: flex; gap: 10px; margin: 15px 0; }
    input[type="text"] { flex: 1; padding: 12px; background: #000; color: #fff; border: 1px solid #1f293d; border-radius: 4px; }
    select { padding: 12px; background: #000; color: #fff; border: 1px solid #1f293d; border-radius: 4px; cursor: pointer; }
    .btn { background: #0088ff; color: #fff; padding: 12px 20px; border: none; cursor: pointer; border-radius: 4px; font-weight: bold; transition: 0.2s; }
    .btn:hover { background: #0077e6; box-shadow: 0 0 15px rgba(0, 136, 255, 0.4); }
    ul { padding-left: 0; list-style: none; margin-top: 30px;}
    .app-card { background: #151f33; padding: 15px; border-radius: 4px; margin-bottom: 15px; border-left: 4px solid #0088ff; }
    .app-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
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
    <img src="https://raw.githubusercontent.com/safarisoftwares-code/watcher/main/watcher.png" alt="Watcher Logo" class="logo">
    <p>Always Watching. Always Working.</p>
    
    <!-- THE WORKSPACE LOCK SCREEN -->
    <div id="workspace-screen" style="display: none;">
      <p style="color:#e2e8f0; margin-bottom: 10px;">Enter your Workspace Name to access your dashboard.</p>
      
      <div class="input-wrapper">
        <input type="password" id="workspace-input" placeholder="e.g. safari-softwares">
        <button class="eye-btn" onclick="toggleEye()" id="eye-btn">👁️</button>
      </div>
      
      <button class="btn" onclick="unlockWorkspace()">Enter</button>
      <p style="font-size: 11px; margin-top: 15px; color: #64748b;">New here? Just type a name to create a new private workspace.</p>
    </div>

    <!-- THE DASHBOARD -->
    <div id="dashboard-screen" style="display: none;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid #1f293d;">
        <span style="font-size: 13px; color: #94a3b8;">Workspace: <strong id="current-workspace" style="color: #e2e8f0;"></strong></span>
        <a href="#" onclick="logout()" style="font-size: 12px; color: #ef4444; text-decoration: none;">Switch Workspace</a>
      </div>

      <div class="input-group">
        <input type="text" id="url" placeholder="Paste your Render URL here (https://...)">
        <select id="interval">
          <option value="5">Every 5 min</option>
          <option value="10">Every 10 min</option>
          <option value="15">Every 15 min</option>
        </select>
        <button class="btn" onclick="add()">Add</button>
      </div>
      <ul id="list"></ul>
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
        document.getElementById('list').innerHTML = d.apps.map(a => {
          const status = a.last_status 
            ? '<span class="status-ok">STATUS: ' + a.last_status + '</span>' 
            : '<span class="status-pending">PENDING</span>';
          
          let lastPingStr = "Never";
          
          if (a.last_pinged) {
            lastPingStr = new Date(a.last_pinged).toLocaleTimeString();
          }

          // Calculate exact next ping time based on current clock
          const nextDate = new Date();
          nextDate.setSeconds(0);
          nextDate.setMilliseconds(0);
          const currentMin = nextDate.getMinutes();
          const nextMin = Math.ceil((currentMin + 1) / a.interval_min) * a.interval_min;
          
          if (nextMin >= 60) {
            nextDate.setHours(nextDate.getHours() + Math.floor(nextMin / 60));
            nextDate.setMinutes(nextMin % 60);
          } else {
            nextDate.setMinutes(nextMin);
          }
          const nextPingStr = nextDate.toLocaleTimeString();

          const logsHtml = a.logs.map(l => {
            const time = new Date(l.created_at).toLocaleTimeString();
            const color = l.status === 200 ? '#10b981' : '#ef4444';
            return '<div class="log-item"><span>' + time + '</span> <span style="color:' + color + '">' + l.status + ' (' + l.latency_ms + 'ms)</span></div>';
          }).join('');

          return \`
            <li class="app-card">
              <div class="app-header">
                <strong>\${a.url}</strong>
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
      await fetch('/api/apps', { 
        method:'POST', 
        headers:{'Content-Type':'application/json', 'X-Workspace': workspace}, 
        body:JSON.stringify({url: url, interval: interval}) 
      });
      document.getElementById('url').value = '';
      loadApps();
    }
  </script>
</body>
</html>
`;