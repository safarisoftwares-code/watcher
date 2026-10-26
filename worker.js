export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ─── ADMIN API ───
    if (url.pathname.startsWith("/api/admin/")) {
      const adminKey = request.headers.get("X-Admin-Key");
      if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
      }
      if (request.method === "GET" && url.pathname === "/api/admin/tenants") {
        const { results } = await env.DB.prepare(`SELECT t.id, t.email, t.plan, t.verified, t.created_at, (SELECT COUNT(*) FROM apps WHERE tenant_id = t.id) AS app_count FROM tenants t ORDER BY t.created_at DESC`).all();
        return new Response(JSON.stringify({ tenants: results }), { headers: { "content-type": "application/json" } });
      }
      if (request.method === "POST" && url.pathname.startsWith("/api/admin/tenants/") && url.pathname.endsWith("/suspend")) {
        const tenantId = url.pathname.split("/")[4];
        await env.DB.prepare(`UPDATE tenants SET plan = 'suspended' WHERE id = ?`).bind(tenantId).run();
        return new Response(JSON.stringify({ ok: true, message: "Tenant suspended." }), { headers: { "content-type": "application/json" } });
      }
      if (request.method === "POST" && url.pathname.startsWith("/api/admin/tenants/") && url.pathname.endsWith("/unsuspend")) {
        const tenantId = url.pathname.split("/")[4];
        await env.DB.prepare(`UPDATE tenants SET plan = 'free' WHERE id = ?`).bind(tenantId).run();
        return new Response(JSON.stringify({ ok: true, message: "Tenant unsuspended." }), { headers: { "content-type": "application/json" } });
      }
      if (request.method === "DELETE" && url.pathname.startsWith("/api/admin/tenants/")) {
        const tenantId = url.pathname.split("/")[4];
        const { results: apps } = await env.DB.prepare(`SELECT id FROM apps WHERE tenant_id = ?`).bind(tenantId).all();
        for (const app of apps) {
          await env.DB.prepare(`DELETE FROM ping_logs WHERE app_id = ?`).bind(app.id).run();
          await env.DB.prepare(`DELETE FROM alert_subscriptions WHERE app_id = ?`).bind(app.id).run();
        }
        await env.DB.prepare(`DELETE FROM apps WHERE tenant_id = ?`).bind(tenantId).run();
        await env.DB.prepare(`DELETE FROM tenants WHERE id = ?`).bind(tenantId).run();
        return new Response(JSON.stringify({ ok: true, message: "Tenant deleted." }), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "Admin route not found" }), { status: 404, headers: { "content-type": "application/json" } });
    }

    // ─── SIGNUP PAGE ───
    if (url.pathname === "/signup") {
      return new Response(SIGNUP_HTML, { headers: { "content-type": "text/html" } });
    }

    // ─── SIGNUP API ───
    if (url.pathname === "/api/signup" && request.method === "POST") {
      const { email, workspace } = await request.json().catch(() => ({}));
      if (!email || !workspace) return new Response(JSON.stringify({error: "email and workspace required"}), {status: 400, headers: {"content-type":"application/json"}});
      const tenantId = workspace.toLowerCase().replace(/[^a-z0-9-]/g, '');
      const code = crypto.randomUUID();
      const existingByEmail = await env.DB.prepare(`SELECT id FROM tenants WHERE email = ?`).bind(email.toLowerCase()).first();
      if (existingByEmail) {
        await env.DB.prepare(`UPDATE tenants SET verify_code = ? WHERE email = ?`).bind(code, email.toLowerCase()).run();
        await sendVerificationEmail(env, email, existingByEmail.id, code);
        return new Response(JSON.stringify({ok: true, message: "Verification email sent."}), {headers:{"content-type":"application/json"}});
      }
      await env.DB.prepare(`INSERT INTO tenants (id, email, plan, created_at, verify_code, verified) VALUES (?, ?, 'free', ?, ?, 0)`).bind(tenantId, email.toLowerCase(), Date.now(), code).run();
      await sendVerificationEmail(env, email, tenantId, code);
      return new Response(JSON.stringify({ok: true, message: "Verification email sent."}), {headers:{"content-type":"application/json"}});
    }

    // ─── VERIFY ───
    if (url.pathname === "/verify") {
      const code = url.searchParams.get("code");
      const tenant = await env.DB.prepare(`SELECT id FROM tenants WHERE verify_code = ?`).bind(code).first();
      if (!tenant) return new Response(`<html><body style="background:#050810;color:#fff;font-family:sans-serif;text-align:center;padding:100px;"><h1>❌ Invalid link</h1><a href="/signup" style="color:#0088ff;">Try again</a></body></html>`, {headers:{"content-type":"text/html"}});
      await env.DB.prepare(`UPDATE tenants SET verified = 1, verify_code = NULL WHERE id = ?`).bind(tenant.id).run();
      return new Response(`<html><head><meta http-equiv="refresh" content="3;url=/dashboard"></head><body style="background:#050810;color:#fff;font-family:sans-serif;text-align:center;padding:100px;"><h1>✅ Email Verified</h1><p>Redirecting...</p></body></html>`, {headers:{"content-type":"text/html"}});
    }

    // ─── UNSUBSCRIBE ───
    if (url.pathname === "/unsubscribe") {
      const appId = url.searchParams.get("app");
      const email = url.searchParams.get("email");
      if (appId && email) {
        const app = await env.DB.prepare(`SELECT url FROM apps WHERE id = ?`).bind(appId).first();
        await env.DB.prepare(`DELETE FROM alert_subscriptions WHERE app_id = ? AND email = ?`).bind(appId, email.toLowerCase()).run();
        const appUrl = app ? app.url : "the selected app";
        return new Response(`<!DOCTYPE html><html><head><title>Unsubscribed</title><style>body{background:#050810;color:#fff;font-family:sans-serif;text-align:center;padding:100px 20px;}h1{font-size:32px;margin-bottom:20px;}p{color:#94a3b8;max-width:500px;margin:0 auto 30px auto;}.btn{background:#0088ff;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold;display:inline-block;}</style></head><body><h1>✅ Unsubscribed</h1><p>You will no longer receive email alerts for:<br><strong style="color:#e2e8f0;">${appUrl}</strong></p><a href="/dashboard" class="btn">Go to Dashboard</a></body></html>`, { headers: { "content-type": "text/html" } });
      }
      return new Response("Invalid unsubscribe link.", { status: 400 });
    }

    // ─── API ───
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }

    // ─── KV PAGES ───
    if (url.pathname === "/dashboard") {
      const html = await env.KV_HTML.get("dashboard");
      return new Response(html, { headers: { "content-type": "text/html" } });
    }
    if (url.pathname === "/pricing") {
      const html = await env.KV_HTML.get("pricing");
      return new Response(html, { headers: { "content-type": "text/html" } });
    }
    if (url.pathname === "/terms") {
      const html = await env.KV_HTML.get("terms");
      return new Response(html, { headers: { "content-type": "text/html" } });
    }
    if (url.pathname === "/privacy") {
      const html = await env.KV_HTML.get("privacy");
      return new Response(html, { headers: { "content-type": "text/html" } });
    }
    const html = await env.KV_HTML.get("landing");
    return new Response(html, { headers: { "content-type": "text/html" } });
  },

  async scheduled(event, env, ctx) {
    const now = new Date();
    now.setSeconds(0);
    now.setMilliseconds(0);
    const currentTimestamp = now.getTime();
    const { results: apps } = await env.DB.prepare(`SELECT id, url, interval_min, last_pinged, consecutive_failures, last_known_state FROM apps WHERE verified = 1 AND tenant_id NOT IN (SELECT id FROM tenants WHERE plan = 'suspended')`).all();
    for (const app of apps) {
      let isDue = false;
      if (!app.last_pinged) isDue = true;
      else {
        const lastPingTime = new Date(app.last_pinged).getTime();
        const intervalMs = app.interval_min * 60000;
        if (currentTimestamp - lastPingTime >= intervalMs) isDue = true;
      }
      if (app.last_pinged && (currentTimestamp - app.last_pinged < 60000)) isDue = false;
      if (!isDue) continue;
      const start = Date.now();
      let newStatus = 0, latency = 0;
      try {
        const res = await fetch(app.url, { method: "GET", redirect: "manual", headers: { "User-Agent": `watcher/${app.id}` } });
        await res.body?.cancel();
        newStatus = res.status;
        latency = Date.now() - start;
      } catch (e) { newStatus = 0; latency = Date.now() - start; }
      const isUp = newStatus >= 200 && newStatus < 500;
      const newFailures = isUp ? 0 : (app.consecutive_failures || 0) + 1;
      await env.DB.prepare(`UPDATE apps SET last_pinged = ?, last_status = ?, consecutive_failures = ? WHERE id = ?`).bind(currentTimestamp, newStatus, newFailures, app.id).run();
      const logId = crypto.randomUUID();
      await env.DB.prepare(`INSERT INTO ping_logs (id, app_id, status, latency_ms, created_at) VALUES (?, ?, ?, ?, ?)`).bind(logId, app.id, newStatus, latency, currentTimestamp).run();
      await env.DB.prepare(`DELETE FROM ping_logs WHERE app_id = ? AND id NOT IN (SELECT id FROM ping_logs WHERE app_id = ? ORDER BY created_at DESC LIMIT 5)`).bind(app.id, app.id).run();
      const previousState = app.last_known_state || 'up';
      if (newFailures >= 2 && previousState !== 'down') {
        await env.DB.prepare(`UPDATE apps SET last_known_state = 'down' WHERE id = ?`).bind(app.id).run();
        await sendAlert(env, app, "down");
      }
      if (isUp && previousState === 'down') {
        await env.DB.prepare(`UPDATE apps SET last_known_state = 'up' WHERE id = ?`).bind(app.id).run();
        await sendAlert(env, app, "up");
      }
    }
  }
};

async function sendAlert(env, app, state) {
  const { results: subscribers } = await env.DB.prepare(`SELECT email FROM alert_subscriptions WHERE app_id = ?`).bind(app.id).all();
  if (!subscribers.length) return;
  const RESEND_API_KEY = env.RESEND_API_KEY;
  if (!RESEND_API_KEY) return;
  const isDown = state === "down";
  const subject = isDown ? `🔴 Watcher Alert: ${app.url} is DOWN` : `🟢 Watcher Alert: ${app.url} has RECOVERED`;
  const bannerColor = isDown ? "#ef4444" : "#10b981";
  const bannerText = isDown ? "DOWN" : "RECOVERED";
  const time = new Date().toUTCString();
  const htmlBody = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#050810;font-family:sans-serif;"><div style="max-width:600px;margin:0 auto;padding:40px 20px;"><div style="text-align:center;margin-bottom:30px;"><img src="https://raw.githubusercontent.com/safarisoftwares-code/watcher/main/watcher.png?v=5" alt="Watcher" style="width:100px;"></div><div style="background:#0f1523;border:1px solid #1f293d;border-radius:8px;overflow:hidden;"><div style="background:${bannerColor};padding:20px;text-align:center;"><h1 style="color:#fff;margin:0;font-size:24px;">${bannerText}</h1></div><div style="padding:30px;"><p style="color:#e2e8f0;font-size:16px;">Hello,</p><p style="color:#94a3b8;font-size:14px;">${isDown ? 'The app you are monitoring has gone offline.' : 'Good news — your app is back online.'}</p><div style="background:#0a0f18;padding:20px;border-radius:6px;margin:20px 0;"><p style="color:#64748b;font-size:12px;margin:0 0 5px 0;">URL</p><p style="color:#e2e8f0;font-size:14px;font-weight:bold;margin:0 0 15px 0;word-break:break-all;">${app.url}</p><p style="color:#64748b;font-size:12px;margin:0 0 5px 0;">Status</p><p style="color:${bannerColor};font-size:14px;font-weight:bold;margin:0 0 15px 0;">${bannerText}</p><p style="color:#64748b;font-size:12px;margin:0 0 5px 0;">Detected</p><p style="color:#e2e8f0;font-size:14px;margin:0;">${time}</p></div></div></div><div style="text-align:center;padding:30px 20px 0 20px;"><p style="color:#64748b;font-size:11px;">You're receiving this because you subscribed to Watcher alerts.<br><a href="https://watcher.safari-pos-pro.workers.dev/unsubscribe?app=${app.id}&email=SUBSCRIBER_EMAIL" style="color:#64748b;text-decoration:underline;">Unsubscribe</a></p><p style="color:#64748b;font-size:11px;margin:20px 0 0 0;">— Watcher by Safari Softwares</p></div></div></body></html>`;
  for (const sub of subscribers) {
    const personalizedHtml = htmlBody.replace("SUBSCRIBER_EMAIL", encodeURIComponent(sub.email));
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: "Watcher <watcher@safari-pos.co.ke>", reply_to: "info@safarisoftwares.co.ke", to: sub.email, subject, html: personalizedHtml }),
      });
    } catch (e) { console.error("Alert failed for", sub.email, e.message); }
  }
}

async function sendVerificationEmail(env, email, workspace, code) {
  const RESEND_API_KEY = env.RESEND_API_KEY;
  if (!RESEND_API_KEY) return;
  const link = `https://watcher.safari-pos-pro.workers.dev/verify?code=${code}`;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Watcher <watcher@safari-pos.co.ke>",
        reply_to: "info@safarisoftwares.co.ke",
        to: email,
        subject: "🔐 Verify your Watcher account",
        html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:30px;background:#050810;color:#fff;"><h2 style="color:#0088ff;">Welcome to Watcher</h2><p>Click to verify workspace <strong>${workspace}</strong>:</p><a href="${link}" style="display:inline-block;background:#0088ff;color:#fff;padding:14px 28px;text-decoration:none;border-radius:6px;font-weight:bold;margin:20px 0;">Verify Email</a></div>`
      }),
    });
  } catch (e) { console.error("Verification email failed:", e.message); }
}

async function handleApi(request, env, url) {
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
  const workspace = request.headers.get("X-Workspace") || "default";
  const tenantId = workspace.toLowerCase().replace(/[^a-z0-9-]/g, '');

  let tenant = await env.DB.prepare(`SELECT plan, subscription_expires_at, email, verified FROM tenants WHERE id = ?`).bind(tenantId).first();
  if (!tenant) {
    await env.DB.prepare(`INSERT INTO tenants (id, email, plan, created_at, verified) VALUES (?, ?, 'free', ?, 0)`).bind(tenantId, tenantId + "@watcher.local", Date.now()).run();
    tenant = { plan: 'free', subscription_expires_at: null, email: null, verified: 0 };
  }

    // Suspended takes priority — even if they were verified before, admin has locked the account
  if (tenant.plan === 'suspended') return json({ error: "Account suspended by administrator. Contact info@safarisoftwares.co.ke to resolve." }, 403);
  // Unverified — only new signups who haven't clicked the magic link
  if (tenant.verified !== 1) return json({ error: "Please verify your email first. Check your inbox for the verification link from Watcher." }, 403);

  let isPremium = tenant.plan === 'premium';
  let isInGrace = false;
  if (isPremium && tenant.subscription_expires_at) {
    const graceEnd = tenant.subscription_expires_at + (3 * 24 * 60 * 60 * 1000);
    const now = Date.now();
    if (now > graceEnd) {
      await env.DB.prepare(`UPDATE tenants SET plan = 'free' WHERE id = ?`).bind(tenantId).run();
      await env.DB.prepare(`UPDATE apps SET interval_min = 10 WHERE tenant_id = ? AND interval_min < 10`).bind(tenantId).run();
      isPremium = false; tenant.plan = 'free';
    } else if (now > tenant.subscription_expires_at) isInGrace = true;
  }

  if (request.method === "POST" && url.pathname === "/api/apps") {
    let { url: target, interval } = await request.json().catch(() => ({}));
    if (!target) return json({ error: "URL required" }, 400);
    target = target.trim();
    if (!target.startsWith("http://") && !target.startsWith("https://")) target = "https://" + target;
    const id = crypto.randomUUID();
    let pingInterval = interval ? parseInt(interval) : 10;
    if (!isPremium && (pingInterval === 1 || pingInterval === 5)) return json({ error: "1-minute and 5-minute intervals require Premium." }, 403);
    await env.DB.prepare(`INSERT INTO apps (id, tenant_id, url, verify_token, verified, interval_min, created_at, owner_email) VALUES (?, ?, ?, 'none', 1, ?, ?, ?)`).bind(id, tenantId, target, pingInterval, Date.now(), tenant.email).run();
    return json({ id, ok: true }, 201);
  }

  if (request.method === "GET" && url.pathname === "/api/apps") {
    const { results: apps } = await env.DB.prepare(`SELECT id, url, interval_min, last_pinged, last_status FROM apps WHERE tenant_id = ?`).bind(tenantId).all();
    for (let app of apps) {
      const { results: logs } = await env.DB.prepare(`SELECT status, latency_ms, created_at FROM ping_logs WHERE app_id = ? ORDER BY created_at DESC LIMIT 5`).bind(app.id).all();
      app.logs = logs;
      const { results: subs } = await env.DB.prepare(`SELECT email FROM alert_subscriptions WHERE app_id = ?`).bind(app.id).all();
      app.subscribers = subs.map(s => s.email);
    }
    return json({ apps, plan: tenant.plan, is_in_grace: isInGrace });
  }

  if (request.method === "POST" && url.pathname === "/api/alerts/subscribe") {
    const { app_id, email } = await request.json().catch(() => ({}));
    if (!app_id || !email) return json({ error: "app_id and email required" }, 400);
    if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) return json({ error: "Invalid email" }, 400);
    const app = await env.DB.prepare(`SELECT id FROM apps WHERE id = ? AND tenant_id = ?`).bind(app_id, tenantId).first();
    if (!app) return json({ error: "App not found" }, 404);
    try {
      await env.DB.prepare(`INSERT INTO alert_subscriptions (id, app_id, email, subscribed_at) VALUES (?, ?, ?, ?)`).bind(crypto.randomUUID(), app_id, email.toLowerCase(), Date.now()).run();
      return json({ ok: true });
    } catch { return json({ ok: true, message: "Already subscribed" }); }
  }

  if (request.method === "POST" && url.pathname === "/api/alerts/unsubscribe") {
    const { app_id, email } = await request.json().catch(() => ({}));
    if (!app_id || !email) return json({ error: "app_id and email required" }, 400);
    await env.DB.prepare(`DELETE FROM alert_subscriptions WHERE app_id = ? AND email = ?`).bind(app_id, email.toLowerCase()).run();
    return json({ ok: true });
  }

  const d = url.pathname.match(/^\/api\/apps\/([^/]+)$/);
  if (request.method === "DELETE" && d) {
    await env.DB.prepare(`DELETE FROM ping_logs WHERE app_id = ?`).bind(d[1]).run();
    await env.DB.prepare(`DELETE FROM alert_subscriptions WHERE app_id = ?`).bind(d[1]).run();
    await env.DB.prepare(`DELETE FROM apps WHERE id = ? AND tenant_id = ?`).bind(d[1], tenantId).run();
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
}

const SIGNUP_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Watcher | Create Account</title>
  <style>
    body { background: #050810; color: #fff; font-family: sans-serif; padding: 40px; display: flex; justify-content: center; margin: 0; min-height: 100vh; align-items: center; box-sizing: border-box;}
    .card { background: #0f1523; border: 1px solid #1f293d; padding: 40px; border-radius: 8px; max-width: 450px; width: 100%; }
    h1 { font-size: 26px; margin: 0 0 10px 0; color: #fff; }
    p { color: #94a3b8; font-size: 14px; margin: 0 0 25px 0; }
    label { display: block; color: #94a3b8; font-size: 13px; margin-bottom: 6px; margin-top: 15px;}
    input { width: 100%; padding: 12px; background: #000; color: #fff; border: 1px solid #1f293d; border-radius: 4px; box-sizing: border-box; font-size: 15px; }
    button { background: #0088ff; color: #fff; padding: 12px 20px; border: none; cursor: pointer; border-radius: 4px; font-weight: bold; width: 100%; margin-top: 20px; font-size: 15px; }
    button:hover { background: #0077e6; }
    .footer { text-align: center; margin-top: 30px; color: #64748b; font-size: 12px; }
    .link { color: #0088ff; text-decoration: none; }
    #status { margin-top: 15px; padding: 10px; border-radius: 4px; font-size: 13px; display: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Create your Watcher account</h1>
    <p>We'll send a verification email. You must verify to start monitoring.</p>
    <label>Email address</label>
    <input type="email" id="email" placeholder="you@company.com" required>
    <label>Workspace name</label>
    <input type="text" id="workspace" placeholder="my-company" required>
    <button onclick="signup()">Sign Up</button>
    <div id="status"></div>
    <div class="footer">Already have an account? <a href="/dashboard" class="link">Sign in</a></div>
  </div>
  <script>
    async function signup() {
      const email = document.getElementById('email').value.trim();
      const workspace = document.getElementById('workspace').value.trim();
      const status = document.getElementById('status');
      if (!email || !workspace) { status.style.display='block'; status.style.background='#ef4444'; status.textContent='Email and workspace required'; return; }
      status.style.display = 'block';
      status.style.background = '#1f293d';
      status.textContent = 'Creating account...';
      const res = await fetch('/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, workspace: workspace })
      });
      const d = await res.json();
      if (res.ok) {
        status.style.background = '#10b981';
        status.textContent = '✅ ' + (d.message || 'Verification email sent. Check your inbox.');
      } else {
        status.style.background = '#ef4444';
        status.textContent = '❌ ' + (d.error || 'Signup failed');
      }
    }
  </script>
</body>
</html>`;