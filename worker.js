export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ─── ADMIN PAGE ───
    if (url.pathname === "/admin") {
      return new Response(ADMIN_HTML, { headers: { "content-type": "text/html" } });
    }

    // ─── ADMIN API ───
    if (url.pathname.startsWith("/api/admin/")) {
      const adminKey = request.headers.get("X-Admin-Key");
      const adminPassword = request.headers.get("X-Admin-Password");

      let authorized = false;
      if (env.ADMIN_KEY && adminKey === env.ADMIN_KEY) authorized = true;
      if (!authorized && env.ADMIN_PASSWORD_HASH && adminPassword) {
        const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(adminPassword));
        const hashHex = [...new Uint8Array(hashBuf)].map(b => b.toString(16).padStart(2, "0")).join("");
        if (hashHex === env.ADMIN_PASSWORD_HASH.toLowerCase()) authorized = true;
      }

      if (!authorized) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
      }

            if (request.method === "GET" && url.pathname === "/api/admin/tenants") {
        const includeDeleted = url.searchParams.get("include_deleted") === "true";
        
        // 1. Fetch tenants (exclude deleted unless specifically asked)
        const query = includeDeleted 
          ? `SELECT t.id, t.email, t.plan, t.verified, t.subscription_expires_at, t.created_at, t.suspended_at, t.deleted_at, (SELECT COUNT(*) FROM apps WHERE tenant_id = t.id) AS app_count FROM tenants t ORDER BY t.created_at DESC`
          : `SELECT t.id, t.email, t.plan, t.verified, t.subscription_expires_at, t.created_at, t.suspended_at, (SELECT COUNT(*) FROM apps WHERE tenant_id = t.id) AS app_count FROM tenants t WHERE t.plan != 'deleted' ORDER BY t.created_at DESC`;
          
        const { results } = await env.DB.prepare(query).all();

        // 2. Fetch metrics
        const totalTenants = results.filter(t => t.plan !== 'deleted').length;
        const totalSuspended = results.filter(t => t.plan === 'suspended').length;
        const totalDeleted = results.filter(t => t.plan === 'deleted').length;
        
        // 3. Fetch total unique email subscribers across all apps
        const subsCount = await env.DB.prepare(`SELECT COUNT(DISTINCT email) AS total FROM alert_subscriptions`).first();

        return new Response(JSON.stringify({ 
          tenants: results, 
          metrics: { 
            total: totalTenants, 
            suspended: totalSuspended, 
            deleted: totalDeleted, 
            subscribers: subsCount.total 
          } 
        }), { headers: { "content-type": "application/json" } });
      }
      if (request.method === "GET" && url.pathname === "/api/admin/pending") {
        const { results } = await env.DB.prepare(`SELECT * FROM pending_signups ORDER BY created_at DESC`).all();
        return new Response(JSON.stringify({ pending: results }), { headers: { "content-type": "application/json" } });
      }
      if (request.method === "POST" && url.pathname.startsWith("/api/admin/tenants/") && url.pathname.endsWith("/promote")) {
        const tenantId = url.pathname.split("/")[4];
        const expires = (Math.floor(Date.now() / 1000) + 31 * 86400) * 1000;
        await env.DB.prepare(`UPDATE tenants SET plan = 'premium', subscription_expires_at = ? WHERE id = ?`).bind(expires, tenantId).run();
        return new Response(JSON.stringify({ ok: true, message: "Tenant promoted to premium (31 days)." }), { headers: { "content-type": "application/json" } });
      }
      if (request.method === "POST" && url.pathname.startsWith("/api/admin/tenants/") && url.pathname.endsWith("/downgrade")) {
        const tenantId = url.pathname.split("/")[4];
        await env.DB.prepare(`UPDATE tenants SET plan = 'free', subscription_expires_at = NULL WHERE id = ?`).bind(tenantId).run();
        await env.DB.prepare(`UPDATE apps SET interval_min = 10 WHERE tenant_id = ? AND interval_min < 10`).bind(tenantId).run();
        return new Response(JSON.stringify({ ok: true, message: "Tenant downgraded to free." }), { headers: { "content-type": "application/json" } });
      }
            if (request.method === "POST" && url.pathname.startsWith("/api/admin/tenants/") && url.pathname.endsWith("/suspend")) {
        const tenantId = url.pathname.split("/")[4];
        await env.DB.prepare(`UPDATE tenants SET plan = 'suspended', suspended_at = ? WHERE id = ?`).bind(Date.now(), tenantId).run();
        return new Response(JSON.stringify({ ok: true, message: "Tenant suspended." }), { headers: { "content-type": "application/json" } });
      }
      if (request.method === "POST" && url.pathname.startsWith("/api/admin/tenants/") && url.pathname.endsWith("/unsuspend")) {
        const tenantId = url.pathname.split("/")[4];
        await env.DB.prepare(`UPDATE tenants SET plan = 'free' WHERE id = ?`).bind(tenantId).run();
        return new Response(JSON.stringify({ ok: true, message: "Tenant unsuspended." }), { headers: { "content-type": "application/json" } });
      }
            if (request.method === "DELETE" && url.pathname.startsWith("/api/admin/tenants/")) {
        const tenantId = url.pathname.split("/")[4];
        // Soft delete: keep apps and logs intact for legal, just mark tenant as deleted
        await env.DB.prepare(`UPDATE tenants SET plan = 'deleted', deleted_at = ? WHERE id = ?`).bind(Date.now(), tenantId).run();
        
        // Optional: unsubscribe their emails so they stop getting alerts
        const { results: apps } = await env.DB.prepare(`SELECT id FROM apps WHERE tenant_id = ?`).bind(tenantId).all();
        for (const app of apps) {
          await env.DB.prepare(`DELETE FROM alert_subscriptions WHERE app_id = ?`).bind(app.id).run();
          await env.DB.prepare(`DELETE FROM webhook_subscriptions WHERE app_id = ?`).bind(app.id).run();
        }
        
        return new Response(JSON.stringify({ ok: true, message: "Tenant soft-deleted. Data retained for legal." }), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "Admin route not found" }), { status: 404, headers: { "content-type": "application/json" } });
    }

    // ─── SIGNUP PAGE ───
    if (url.pathname === "/signup") {
      return new Response(SIGNUP_HTML, { headers: { "content-type": "text/html" } });
    }

    // ─── SIGNUP API ───
    if (url.pathname === "/api/signup" && request.method === "POST") {
      const { email, workspace, password } = await request.json().catch(() => ({}));
      if (!email || !workspace || !password) return new Response(JSON.stringify({ error: "Email, workspace, and password required" }), { status: 400, headers: { "content-type": "application/json" } });

      const emailLower = email.toLowerCase().trim();
      const wsClean = workspace.toLowerCase().replace(/[^a-z0-9-]/g, '');
      if (!wsClean) return new Response(JSON.stringify({ error: "Invalid workspace name." }), { status: 400, headers: { "content-type": "application/json" } });

      const existingTenantByWs = await env.DB.prepare(`SELECT id FROM tenants WHERE id = ?`).bind(wsClean).first();
      if (existingTenantByWs) return new Response(JSON.stringify({ error: "That workspace name is already taken." }), { status: 409, headers: { "content-type": "application/json" } });

      const existingTenantByEmail = await env.DB.prepare(`SELECT id FROM tenants WHERE email = ?`).bind(emailLower).first();
      if (existingTenantByEmail) return new Response(JSON.stringify({ error: "That email already has an account." }), { status: 409, headers: { "content-type": "application/json" } });

      const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password));
      const passwordHash = [...new Uint8Array(hashBuf)].map(b => b.toString(16).padStart(2, "0")).join("");

      await env.DB.prepare(`DELETE FROM pending_signups WHERE email = ? OR workspace = ?`).bind(emailLower, wsClean).run();

      const code = crypto.randomUUID();
      const now = Date.now();
      const expiresAt = now + (24 * 60 * 60 * 1000);
      await env.DB.prepare(`INSERT INTO pending_signups (verify_code, email, workspace, password, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(code, emailLower, wsClean, passwordHash, now, expiresAt).run();

      await sendVerificationEmail(env, email, wsClean, code);
      return new Response(JSON.stringify({ ok: true, message: "Verification email sent. Click the link within 24 hours to activate your account." }), { headers: { "content-type": "application/json" } });
    }

    // ─── VERIFY ───
    if (url.pathname === "/verify") {
      const code = url.searchParams.get("code");
      if (!code) return new Response(`<html><body style="background:#050810;color:#fff;font-family:sans-serif;text-align:center;padding:100px;"><h1>Invalid link</h1></body></html>`, { headers: { "content-type": "text/html" } });

      const pending = await env.DB.prepare(`SELECT email, workspace, password, expires_at FROM pending_signups WHERE verify_code = ?`).bind(code).first();
      if (!pending) return new Response(`<html><body style="background:#050810;color:#fff;font-family:sans-serif;text-align:center;padding:100px;"><h1>Invalid or expired link</h1></body></html>`, { headers: { "content-type": "text/html" } });

      if (Date.now() > pending.expires_at) {
        await env.DB.prepare(`DELETE FROM pending_signups WHERE verify_code = ?`).bind(code).run();
        return new Response(`<html><body style="background:#050810;color:#fff;font-family:sans-serif;text-align:center;padding:100px;"><h1>Link expired</h1></body></html>`, { headers: { "content-type": "text/html" } });
      }

      await env.DB.prepare(`INSERT INTO tenants (id, email, plan, created_at, verified, password) VALUES (?, ?, 'free', ?, 1, ?)`).bind(pending.workspace, pending.email, Date.now(), pending.password).run();
      await env.DB.prepare(`DELETE FROM pending_signups WHERE verify_code = ?`).bind(code).run();

      return new Response(`<html><head><meta http-equiv="refresh" content="2;url=/dashboard?verified=1&workspace=${encodeURIComponent(pending.workspace)}"></head><body style="background:#050810;color:#fff;font-family:sans-serif;text-align:center;padding:100px;"><h1>Email Verified</h1><p>Redirecting...</p></body></html>`, { headers: { "content-type": "text/html" } });
    }

    // ─── FORGOT PASSWORD ───
    if (url.pathname === "/api/forgot-password" && request.method === "POST") {
      const { email } = await request.json().catch(() => ({}));
      if (!email) return new Response(JSON.stringify({ error: "Email required" }), { status: 400, headers: { "content-type": "application/json" } });

      const emailLower = email.toLowerCase().trim();
      const tenant = await env.DB.prepare(`SELECT id FROM tenants WHERE email = ?`).bind(emailLower).first();
      
      if (tenant) {
        const token = crypto.randomUUID() + "-" + crypto.randomUUID();
        const now = Date.now();
        const expiresAt = now + (60 * 60 * 1000);
        await env.DB.prepare(`INSERT INTO password_resets (token, tenant_id, email, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`).bind(token, tenant.id, emailLower, expiresAt, now).run();
        await sendPasswordResetEmail(env, emailLower, tenant.id, token);
      }

      return new Response(JSON.stringify({ ok: true, message: "If that email is registered, a reset link has been sent." }), { headers: { "content-type": "application/json" } });
    }

    // ─── RESET PASSWORD PAGE ───
    if (url.pathname === "/reset") {
      return new Response(RESET_HTML, { headers: { "content-type": "text/html" } });
    }

    // ─── SUBMIT NEW PASSWORD ───
    if (url.pathname === "/api/reset-password" && request.method === "POST") {
      const { token, new_password } = await request.json().catch(() => ({}));
      if (!token || !new_password) return new Response(JSON.stringify({ error: "Missing fields" }), { status: 400, headers: { "content-type": "application/json" } });

      const reset = await env.DB.prepare(`SELECT tenant_id, expires_at, used FROM password_resets WHERE token = ?`).bind(token).first();
      if (!reset) return new Response(JSON.stringify({ error: "Invalid or expired token." }), { status: 400, headers: { "content-type": "application/json" } });
      if (reset.used === 1) return new Response(JSON.stringify({ error: "This link has already been used." }), { status: 400, headers: { "content-type": "application/json" } });
      if (Date.now() > reset.expires_at) return new Response(JSON.stringify({ error: "This link has expired." }), { status: 400, headers: { "content-type": "application/json" } });

      const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(new_password));
      const passwordHash = [...new Uint8Array(hashBuf)].map(b => b.toString(16).padStart(2, "0")).join("");

      await env.DB.prepare(`UPDATE tenants SET password = ? WHERE id = ?`).bind(passwordHash, reset.tenant_id).run();
      await env.DB.prepare(`UPDATE password_resets SET used = 1 WHERE token = ?`).bind(token).run();

      return new Response(JSON.stringify({ ok: true, message: "Password updated successfully." }), { headers: { "content-type": "application/json" } });
    }

    // ─── UNSUBSCRIBE ───
    if (url.pathname === "/unsubscribe") {
      const appId = url.searchParams.get("app");
      const email = url.searchParams.get("email");
      if (appId && email) {
        const app = await env.DB.prepare(`SELECT url FROM apps WHERE id = ?`).bind(appId).first();
        await env.DB.prepare(`DELETE FROM alert_subscriptions WHERE app_id = ? AND email = ?`).bind(appId, email.toLowerCase()).run();
        const appUrl = app ? app.url : "the selected app";
        return new Response(`<!DOCTYPE html><html><head><title>Unsubscribed</title><style>body{background:#050810;color:#fff;font-family:sans-serif;text-align:center;padding:100px 20px;}h1{font-size:32px;margin-bottom:20px;}p{color:#94a3b8;max-width:500px;margin:0 auto 30px auto;}.btn{background:#0088ff;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold;display:inline-block;}</style></head><body><h1>Unsubscribed</h1><p>You will no longer receive email alerts for:<br><strong style="color:#e2e8f0;">${appUrl}</strong></p></body></html>`, { headers: { "content-type": "text/html" } });
      }
      return new Response("Invalid link.", { status: 400 });
    }

    // ─── CATCH-ALL API ROUTER ───
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
    await env.DB.prepare(`DELETE FROM pending_signups WHERE expires_at < ?`).bind(Date.now()).run();
    await env.DB.prepare(`DELETE FROM password_resets WHERE expires_at < ?`).bind(Date.now()).run();

    const now = new Date();
    now.setSeconds(0); now.setMilliseconds(0);
    const currentTimestamp = now.getTime();

    // Get apps + their most recent log timestamp (to decide if we should log)
    const { results: apps } = await env.DB.prepare(`
      SELECT a.id, a.url, a.interval_min, a.last_pinged, a.consecutive_failures, a.last_known_state,
             (SELECT MAX(created_at) FROM ping_logs WHERE app_id = a.id) AS last_log_time
      FROM apps a
            WHERE a.verified = 1
        AND a.tenant_id NOT IN (SELECT id FROM tenants WHERE plan IN ('suspended', 'deleted'))
    `).all();

    for (const app of apps) {
      let isDue = false;
      if (!app.last_pinged) isDue = true;
      else if (currentTimestamp - new Date(app.last_pinged).getTime() >= app.interval_min * 60000) isDue = true;
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
      const previousState = app.last_known_state || 'up';

      // Determine if state changed
      const isDownNow = newFailures >= 2;
      const stateChanged = (isDownNow && previousState !== 'down') || (isUp && previousState === 'down');

      // Determine if we should log this ping
      // Rule: Always log state changes. Otherwise, log if it's been 5+ minutes since last log.
      const fiveMinutesAgo = currentTimestamp - (5 * 60 * 1000);
      const shouldLog = stateChanged || !app.last_log_time || (app.last_log_time < fiveMinutesAgo);

      // Update app state
      await env.DB.prepare(`UPDATE apps SET last_pinged = ?, last_status = ?, consecutive_failures = ?, last_known_state = ? WHERE id = ?`)
        .bind(currentTimestamp, newStatus, newFailures, isUp ? 'up' : (isDownNow ? 'down' : previousState), app.id).run();

      if (shouldLog) {
        await env.DB.prepare(`INSERT INTO ping_logs (id, app_id, status, latency_ms, created_at) VALUES (?, ?, ?, ?, ?)`)
          .bind(crypto.randomUUID(), app.id, newStatus, latency, currentTimestamp).run();
        await env.DB.prepare(`DELETE FROM ping_logs WHERE app_id = ? AND id NOT IN (SELECT id FROM ping_logs WHERE app_id = ? ORDER BY created_at DESC LIMIT 5)`)
          .bind(app.id, app.id).run();
      }

      // Send alerts on state changes
      if (isDownNow && previousState !== 'down') {
  console.log("ALERT_DOWN " + app.url + " prev=" + previousState + " fails=" + newFailures);
  await sendAlert(env, app, "down");
}
if (isUp && previousState === 'down') {
  console.log("ALERT_UP " + app.url + " prev=" + previousState + " status=" + newStatus);
  await sendAlert(env, app, "up");
}
    }
  }
};

async function sendAlert(env, app, state) {
  const isDown = state === "down";

  // ─── EMAILS ───
  const RESEND_API_KEY = env.RESEND_API_KEY;
  const { results: subscribers } = await env.DB.prepare(`SELECT email FROM alert_subscriptions WHERE app_id = ?`).bind(app.id).all();

  if (subscribers.length && RESEND_API_KEY) {
    const subject = isDown ? `🔴 Watcher Alert: ${app.url} is DOWN` : `🟢 Watcher Alert: ${app.url} has RECOVERED`;
    const bannerColor = isDown ? "#ef4444" : "#10b981";
    const bannerText = isDown ? "DOWN" : "RECOVERED";
    const time = new Date().toUTCString();
    const htmlBody = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#050810;font-family:sans-serif;"><div style="max-width:600px;margin:0 auto;padding:40px 20px;"><div style="text-align:center;margin-bottom:30px;"><img src="https://raw.githubusercontent.com/safarisoftwares-code/watcher/main/watcher.png?v=5" alt="Watcher" style="width:100px;"></div><div style="background:#0f1523;border:1px solid #1f293d;border-radius:8px;overflow:hidden;"><div style="background:${bannerColor};padding:20px;text-align:center;"><h1 style="color:#fff;margin:0;font-size:24px;">${bannerText}</h1></div><div style="padding:30px;"><p style="color:#e2e8f0;font-size:16px;">Hello,</p><p style="color:#94a3b8;font-size:14px;">${isDown ? 'The app you are monitoring has gone offline.' : 'Good news — your app is back online.'}</p><div style="background:#0a0f18;padding:20px;border-radius:6px;margin:20px 0;"><p style="color:#64748b;font-size:12px;margin:0 0 5px 0;">URL</p><p style="color:#e2e8f0;font-size:14px;font-weight:bold;margin:0 0 15px 0;word-break:break-all;">${app.url}</p><p style="color:#64748b;font-size:12px;margin:0 0 5px 0;">Status</p><p style="color:${bannerColor};font-size:14px;font-weight:bold;margin:0 0 15px 0;">${bannerText}</p><p style="color:#64748b;font-size:12px;margin:0 0 5px 0;">Detected</p><p style="color:#e2e8f0;font-size:14px;margin:0;">${time}</p></div></div></div><div style="text-align:center;padding:30px 20px 0 20px;"><p style="color:#64748b;font-size:11px;">You're receiving this because you subscribed to Watcher alerts.<br><a href="https://watcher.safari-pos.co.ke/unsubscribe?app=${app.id}&email=SUBSCRIBER_EMAIL" style="color:#64748b;text-decoration:underline;">Unsubscribe</a></p><p style="color:#64748b;font-size:11px;margin:20px 0 0 0;">— Watcher by Safari Softwares</p></div></div></body></html>`;

    for (const sub of subscribers) {
      const personalizedHtml = htmlBody.replace("SUBSCRIBER_EMAIL", encodeURIComponent(sub.email));
      try {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: "Watcher <watcher@safari-pos.co.ke>", reply_to: "info@safarisoftwares.co.ke", to: sub.email, subject, html: personalizedHtml }),
        });
      } catch (e) { console.error("Alert email failed", e.message); }
    }
  }

  // ─── WEBHOOKS ───
  const { results: webhooks } = await env.DB.prepare(
    `SELECT channel, webhook_url FROM webhook_subscriptions WHERE app_id = ?`
  ).bind(app.id).all();

  for (const hook of webhooks) {
    try {
      let payload, headers = { "Content-Type": "application/json" };

      if (hook.channel === "slack") {
        payload = {
          text: `${isDown ? "🔴" : "🟢"} *Watcher Alert*`,
          blocks: [
            {
              type: "header",
              text: { type: "plain_text", text: isDown ? "🔴 App DOWN" : "🟢 App RECOVERED", emoji: true }
            },
            {
              type: "section",
              fields: [
                { type: "mrkdwn", text: `*URL:*\n${app.url}` },
                { type: "mrkdwn", text: `*Status:*\n${isDown ? "DOWN" : "RECOVERED"}` }
              ]
            },
            {
              type: "context",
              elements: [{ type: "mrkdwn", text: `Detected: ${new Date().toUTCString()} • Watcher` }]
            }
          ]
        };
      } else if (hook.channel === "discord") {
        payload = {
          content: `${isDown ? "🔴" : "🟢"} **Watcher Alert**`,
          embeds: [{
            title: isDown ? "App DOWN" : "App RECOVERED",
            description: app.url,
            color: isDown ? 0xef4444 : 0x10b981,
            timestamp: new Date().toISOString(),
            footer: { text: "Watcher by Safari Softwares" }
          }]
        };
      } else if (hook.channel === "telegram") {
        const [tgUrl, chatId] = hook.webhook_url.split("|");
        if (!chatId) {
          console.error("Telegram webhook missing chat_id (format: URL|chat_id)");
          continue;
        }
        const tgRes = await fetch(tgUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({
            chat_id: chatId,
            text: `${isDown ? "🔴" : "🟢"} *Watcher Alert*\n${app.url}\nStatus: ${isDown ? "DOWN" : "RECOVERED"}`,
            parse_mode: "Markdown"
          }),
        });
        if (!tgRes.ok) console.error("Telegram send failed:", await tgRes.text());
        continue;
      } else {
        continue;
      }

      const res = await fetch(hook.webhook_url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      if (!res.ok) console.error(`${hook.channel} webhook failed: ${res.status}`, await res.text());
    } catch (e) {
      console.error(`Webhook send failed (${hook.channel}):`, e.message);
    }
  }
}

async function sendVerificationEmail(env, email, workspace, code) {
  const RESEND_API_KEY = env.RESEND_API_KEY;
  if (!RESEND_API_KEY) return;
  const link = `https://watcher.safari-pos.co.ke/verify?code=${code}`;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Watcher <watcher@safari-pos.co.ke>",
        reply_to: "info@safarisoftwares.co.ke",
        to: email,
        subject: "🔐 Verify your Watcher account",
        html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:30px;background:#050810;color:#fff;"><h2 style="color:#0088ff;">Welcome to Watcher</h2><p>Click to verify workspace <strong>${workspace}</strong>:</p><a href="${link}" style="display:inline-block;background:#0088ff;color:#fff;padding:14px 28px;text-decoration:none;border-radius:6px;font-weight:bold;margin:20px 0;">Verify Email</a><p style="color:#64748b;font-size:12px;">This link expires in 24 hours.</p></div>`
      }),
    });
  } catch (e) { console.error("Verification failed", e.message); }
}

async function sendPasswordResetEmail(env, email, workspace, token) {
  const RESEND_API_KEY = env.RESEND_API_KEY;
  if (!RESEND_API_KEY) return;
  const link = `https://watcher.safari-pos.co.ke/reset?token=${token}`;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Watcher <watcher@safari-pos.co.ke>",
        reply_to: "info@safarisoftwares.co.ke",
        to: email,
        subject: "🔑 Reset your Watcher password",
        html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:30px;background:#050810;color:#fff;"><h2 style="color:#0088ff;">Reset your password</h2><p>Someone (hopefully you) requested a password reset for your Watcher workspace <strong>${workspace}</strong>.</p><a href="${link}" style="display:inline-block;background:#0088ff;color:#fff;padding:14px 28px;text-decoration:none;border-radius:6px;font-weight:bold;margin:20px 0;">Set New Password</a><p style="color:#64748b;font-size:12px;">This link expires in 1 hour. If you didn't request this, you can ignore this email.</p></div>`
      }),
    });
  } catch (e) { console.error("Password reset failed", e.message); }
}

async function handleApi(request, env, url) {
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

  const rawWorkspace = (request.headers.get("X-Workspace") || "").trim();
  const rawPassword = (request.headers.get("X-Password") || "").trim();
  const GENERIC_MSG = { error: "This workspace is not available. Create an account to get started.", action: "signup", signup_url: "/signup" };

  if (!rawWorkspace || rawWorkspace.toLowerCase() === "null" || rawWorkspace.toLowerCase() === "default") {
    return json(GENERIC_MSG, 401);
  }
  const tenantId = rawWorkspace.toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!tenantId) return json(GENERIC_MSG, 401);

  const tenant = await env.DB.prepare(`SELECT plan, subscription_expires_at, email, verified, password FROM tenants WHERE id = ?`).bind(tenantId).first();
  if (!tenant) return json(GENERIC_MSG, 401);

  if (tenant.password) {
    if (!rawPassword) {
      return json({ error: "Password required.", action: "login" }, 401);
    }
    const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawPassword));
    const hashHex = [...new Uint8Array(hashBuf)].map(b => b.toString(16).padStart(2, "0")).join("");
    if (hashHex !== tenant.password) {
      return json({ error: "Incorrect password.", action: "login" }, 401);
    }
  } else {
    if (!rawPassword) {
      return json({ error: "Password setup required.", action: "set_password" }, 403);
    }
    const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawPassword));
    const hashHex = [...new Uint8Array(hashBuf)].map(b => b.toString(16).padStart(2, "0")).join("");
    await env.DB.prepare(`UPDATE tenants SET password = ? WHERE id = ?`).bind(hashHex, tenantId).run();
  }

    if (tenant.plan === 'suspended') return json({ error: "Account suspended by administrator." }, 403);
  if (tenant.plan === 'deleted') return json({ error: "This account has been deleted." }, 403);

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
      const { results: subs } = await env.DB.prepare(`SELECT id, email FROM alert_subscriptions WHERE app_id = ?`).bind(app.id).all();
app.subscribers = subs;
      const { results: hooks } = await env.DB.prepare(`SELECT id, channel, webhook_url FROM webhook_subscriptions WHERE app_id = ?`).bind(app.id).all();
      app.webhooks = hooks;
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

// ─── ALERT SUBSCRIPTIONS: DELETE ───
if (request.method === "DELETE" && url.pathname.startsWith("/api/alerts/subscribe/")) {
  const subId = url.pathname.split("/")[4];
  const sub = await env.DB.prepare(
    `SELECT s.id FROM alert_subscriptions s
     JOIN apps a ON a.id = s.app_id
     WHERE s.id = ? AND a.tenant_id = ?`
  ).bind(subId, tenantId).first();
  if (!sub) return json({ error: "Subscription not found" }, 404);
  await env.DB.prepare(`DELETE FROM alert_subscriptions WHERE id = ?`).bind(subId).run();
  return json({ ok: true });
}

  // ─── WEBHOOKS: LIST ───
  if (request.method === "GET" && url.pathname === "/api/webhooks") {
    const { results: hooks } = await env.DB.prepare(
      `SELECT w.id, w.app_id, w.channel, w.webhook_url, w.created_at, a.url AS app_url
       FROM webhook_subscriptions w
       JOIN apps a ON a.id = w.app_id
       WHERE a.tenant_id = ?
       ORDER BY w.created_at DESC`
    ).bind(tenantId).all();
    return json({ webhooks: hooks });
  }

  // ─── WEBHOOKS: SUBSCRIBE ───
  if (request.method === "POST" && url.pathname === "/api/webhooks/subscribe") {
    const { app_id, channel, webhook_url } = await request.json().catch(() => ({}));
    if (!app_id || !channel || !webhook_url) {
      return json({ error: "app_id, channel, and webhook_url required" }, 400);
    }
    if (!["slack", "discord", "telegram"].includes(channel)) {
      return json({ error: "Invalid channel. Use slack, discord, or telegram." }, 400);
    }
    if (!webhook_url.startsWith("https://")) {
      return json({ error: "webhook_url must start with https://" }, 400);
    }
    const app = await env.DB.prepare(
      `SELECT id, url FROM apps WHERE id = ? AND tenant_id = ?`
    ).bind(app_id, tenantId).first();
    if (!app) return json({ error: "App not found" }, 404);

    const existing = await env.DB.prepare(
      `SELECT id FROM webhook_subscriptions WHERE app_id = ? AND channel = ? AND webhook_url = ?`
    ).bind(app_id, channel, webhook_url).first();
    if (existing) return json({ ok: true, message: "Webhook already exists" });

    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO webhook_subscriptions (id, app_id, channel, webhook_url, created_at) VALUES (?, ?, ?, ?, ?)`
    ).bind(id, app_id, channel, webhook_url, Date.now()).run();
    return json({ ok: true, id });
  }

  // ─── WEBHOOKS: DELETE ───
  const whMatch = url.pathname.match(/^\/api\/webhooks\/([^/]+)$/);
  if (request.method === "DELETE" && whMatch) {
    const webhookId = whMatch[1];
    const hook = await env.DB.prepare(
      `SELECT w.id FROM webhook_subscriptions w
       JOIN apps a ON a.id = w.app_id
       WHERE w.id = ? AND a.tenant_id = ?`
    ).bind(webhookId, tenantId).first();
    if (!hook) return json({ error: "Webhook not found" }, 404);
    await env.DB.prepare(`DELETE FROM webhook_subscriptions WHERE id = ?`).bind(webhookId).run();
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
    <p>We'll send a verification email. Link expires in 24 hours.</p>
    <label>Email address</label>
    <input type="email" id="email" placeholder="you@company.com" required>
    <label>Workspace name</label>
    <input type="text" id="workspace" placeholder="my-company" required>
    <label>Password</label>
    <input type="password" id="password" placeholder="Create a secure password" required>
    <button onclick="signup()">Sign Up</button>
    <div id="status"></div>
    <div class="footer">Already have an account? <a href="/dashboard" class="link">Sign in</a></div>
  </div>
  <script>
    const params = new URLSearchParams(window.location.search);
    const prefillWs = params.get('workspace');
    if (prefillWs) {
      document.getElementById('workspace').value = prefillWs;
      document.getElementById('email').focus();
    }

    async function signup() {
      const email = document.getElementById('email').value.trim();
      const workspace = document.getElementById('workspace').value.trim();
      const password = document.getElementById('password').value.trim();
      const status = document.getElementById('status');
      if (!email || !workspace || !password) { status.style.display='block'; status.style.background='#ef4444'; status.textContent='All fields required'; return; }
      status.style.display = 'block';
      status.style.background = '#1f293d';
      status.textContent = 'Sending verification...';
      const res = await fetch('/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, workspace: workspace, password: password })
      });
      const d = await res.json();
      if (res.ok) {
        status.style.background = '#10b981';
        status.textContent = d.message || 'Verification email sent. Check your inbox.';
      } else {
        status.style.background = '#ef4444';
        status.textContent = d.error || 'Signup failed';
      }
    }
  </script>
</body>
</html>`;


const RESET_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Watcher | Reset Password</title>
  <style>
    body { background: #050810; color: #fff; font-family: sans-serif; padding: 40px; display: flex; justify-content: center; margin: 0; min-height: 100vh; align-items: center; box-sizing: border-box;}
    .card { background: #0f1523; border: 1px solid #1f293d; padding: 40px; border-radius: 8px; max-width: 450px; width: 100%; }
    h1 { font-size: 26px; margin: 0 0 10px 0; color: #fff; }
    p { color: #94a3b8; font-size: 14px; margin: 0 0 25px 0; }
    label { display: block; color: #94a3b8; font-size: 13px; margin-bottom: 6px; margin-top: 15px;}
    input { width: 100%; padding: 12px; background: #000; color: #fff; border: 1px solid #1f293d; border-radius: 4px; box-sizing: border-box; font-size: 15px; }
    button { background: #0088ff; color: #fff; padding: 12px 20px; border: none; cursor: pointer; border-radius: 4px; font-weight: bold; width: 100%; margin-top: 20px; font-size: 15px; }
    button:hover { background: #0077e6; }
    #status { margin-top: 15px; padding: 10px; border-radius: 4px; font-size: 13px; display: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Set a new password</h1>
    <p>Enter your new password below.</p>
    <label>New Password</label>
    <input type="password" id="new-password" placeholder="New password" required>
    <button onclick="resetPassword()">Update Password</button>
    <div id="status"></div>
  </div>
  <script>
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (!token) window.location.href = '/dashboard';

    async function resetPassword() {
      const pwd = document.getElementById('new-password').value.trim();
      const status = document.getElementById('status');
      if (!pwd) { status.style.display='block'; status.style.background='#ef4444'; status.textContent='Password required'; return; }
      status.style.display = 'block'; status.style.background = '#1f293d'; status.textContent = 'Updating...';
      const res = await fetch('/api/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token, new_password: pwd }) });
      const d = await res.json();
      if (res.ok) { status.style.background = '#10b981'; status.textContent = '✅ Password updated! Redirecting...'; setTimeout(() => { window.location.href = '/dashboard'; }, 2000); }
      else { status.style.background = '#ef4444'; status.textContent = '❌ ' + (d.error || 'Failed to reset password'); }
    }
  </script>
</body>
</html>`;

const ADMIN_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Watcher Admin</title>
  <style>
    body { background: #050810; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 20px; margin: 0; display: flex; justify-content: center; min-height: 100vh; align-items: center; }
    .container { max-width: 1200px; width: 100%; margin: 0 auto; }
    h1 { color: #fff; font-size: 24px; margin: 0 0 20px 0; display: flex; align-items: center; justify-content: center; gap: 10px; }
    h1 img { height: 32px; }
    .card { background: #0f1523; border: 1px solid #1f293d; border-radius: 8px; padding: 30px; margin-bottom: 20px; box-sizing: border-box; }
    .login-box { max-width: 400px; margin: 0 auto; text-align: center; }
    .login-box p { color: #94a3b8; font-size: 14px; margin: 0 0 20px 0; }
    .input-wrapper { position: relative; width: 100%; margin-bottom: 15px; }
    .input-wrapper input { width: 100%; padding: 12px 40px 12px 12px; background: #000; color: #fff; border: 1px solid #1f293d; border-radius: 4px; box-sizing: border-box; font-size: 15px; }
    .eye-btn { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); cursor: pointer; color: #64748b; font-size: 18px; background: none; border: none; }
    .btn-main { width: 100%; padding: 12px; background: #0088ff; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 15px; margin-bottom: 15px; }
    .btn-main:hover { background: #0077e6; }
    .forgot-btn { display: inline-block; background: transparent; border: none; color: #64748b; font-size: 13px; cursor: pointer; text-decoration: underline; }
    .forgot-btn:hover { color: #94a3b8; }
    .error { color: #ef4444; margin-top: 10px; font-size: 13px; }
    .success { color: #10b981; margin-top: 10px; font-size: 13px; }
    .hidden { display: none; }
    .tabs { display: flex; gap: 10px; margin-bottom: 20px; border-bottom: 1px solid #1f293d; }
    .tab { padding: 10px 20px; cursor: pointer; color: #94a3b8; border-bottom: 2px solid transparent; background: none; border: none; font-size: 15px; }
    .tab.active { color: #0088ff; border-bottom-color: #0088ff; }
    .logout-btn { float: right; background: #ef4444; color: #fff; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; padding: 12px; border-bottom: 1px solid #1f293d; color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
    td { padding: 12px; border-bottom: 1px solid #1f293d; font-size: 14px; }
    .plan-free { color: #94a3b8; }
    .plan-premium { color: #0088ff; font-weight: bold; }
    .plan-suspended { color: #ef4444; font-weight: bold; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; background: #1f293d; }
    .badge-verified { background: rgba(16, 185, 129, 0.2); color: #10b981; }
    .badge-unverified { background: rgba(245, 158, 11, 0.2); color: #f59e0b; }
    .action-btn { padding: 6px 12px; margin: 0 2px; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: bold; }
    .btn-promote { background: #0088ff; color: #fff; }
    .btn-promote:hover { background: #0077e6; }
    .btn-downgrade { background: #64748b; color: #fff; }
    .btn-suspend { background: #f59e0b; color: #fff; }
    .btn-unsuspend { background: #10b981; color: #fff; }
    .btn-delete { background: #ef4444; color: #fff; }
    @media (max-width: 768px) {
      table, thead, tbody, th, td, tr { display: block; }
      thead tr { position: absolute; top: -9999px; left: -9999px; }
      tr { border: 1px solid #1f293d; margin-bottom: 15px; border-radius: 8px; padding: 10px; background: #0f1523; }
      td { border: none; padding: 8px 0; position: relative; }
      td:before { content: attr(data-label) ": "; font-weight: bold; color: #94a3b8; font-size: 12px; display: block; }
      .action-btn { display: block; width: 100%; margin: 5px 0; padding: 10px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div id="login-view">
      <div class="card login-box">
        <h1><img src="https://raw.githubusercontent.com/safarisoftwares-code/watcher/main/watcher.png?v=5" alt="Watcher">Admin</h1>
        <p>Enter your admin password.</p>
        <div class="input-wrapper">
          <input type="password" id="admin-key-input" placeholder="8-char password" maxlength="64" autocomplete="current-password">
          <button class="eye-btn" onclick="toggleAdminEye()" id="eye-admin">👁️</button>
        </div>
        <button class="btn-main" onclick="login()">Sign In</button>
        <button class="forgot-btn" onclick="forgotAdminPassword()">Forgot password?</button>
        <div id="login-error" class="error hidden"></div>
      </div>
    </div>

    <div id="admin-view" class="hidden">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
        <h1 style="justify-content: flex-start; margin: 0;"><img src="https://raw.githubusercontent.com/safarisoftwares-code/watcher/main/watcher.png?v=5" alt="Watcher">Admin Panel</h1>
        <button class="logout-btn" onclick="logout()">Sign Out</button>
      </div>

      <div class="tabs">
        <button class="tab active" id="tab-tenants" onclick="showTab('tenants')">Tenants</button>
        <button class="tab" id="tab-pending" onclick="showTab('pending')">Pending Signups</button>
      </div>

            <div id="tenants-view">
        <div class="card">
          <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin-bottom: 20px;">
            <div style="background:#0a0f18; border:1px solid #1f293d; padding:15px; border-radius:6px; text-align:center;">
              <div style="font-size:12px; color:#94a3b8; text-transform:uppercase;">Total Tenants</div>
              <div id="metric-total" style="font-size:24px; font-weight:bold; color:#fff; margin-top:5px;">-</div>
            </div>
            <div style="background:#0a0f18; border:1px solid #1f293d; padding:15px; border-radius:6px; text-align:center;">
              <div style="font-size:12px; color:#94a3b8; text-transform:uppercase;">Suspended</div>
              <div id="metric-suspended" style="font-size:24px; font-weight:bold; color:#f59e0b; margin-top:5px;">-</div>
            </div>
            <div style="background:#0a0f18; border:1px solid #1f293d; padding:15px; border-radius:6px; text-align:center;">
              <div style="font-size:12px; color:#94a3b8; text-transform:uppercase;">Deleted (Legal)</div>
              <div id="metric-deleted" style="font-size:24px; font-weight:bold; color:#ef4444; margin-top:5px;">-</div>
            </div>
            <div style="background:#0a0f18; border:1px solid #1f293d; padding:15px; border-radius:6px; text-align:center;">
              <div style="font-size:12px; color:#94a3b8; text-transform:uppercase;">Total Subscribers</div>
              <div id="metric-subs" style="font-size:24px; font-weight:bold; color:#10b981; margin-top:5px;">-</div>
            </div>
          </div>

          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
            <h2 style="margin: 0; font-size: 18px;">All Tenants</h2>
            <div>
              <button class="action-btn btn-promote" onclick="loadTenants()">Refresh</button>
              <button class="action-btn" id="toggle-deleted-btn" style="background:#4b5563; color:#fff; margin-left:10px;" onclick="toggleDeleted()">Show Deleted</button>
            </div>
          </div>
          <div id="tenants-error" class="error hidden"></div>
          <div id="tenants-status" class="success hidden"></div>
          <table>
            <thead>
              <tr>
                <th>Workspace</th>
                <th>Email</th>
                <th>Plan</th>
                <th>Verified</th>
                <th>Apps</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="tenants-body">
              <tr><td colspan="6" style="text-align:center; color:#64748b;">Loading...</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div id="pending-view" class="hidden">
        <div class="card">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
            <h2 style="margin: 0; font-size: 18px;">Pending Signups (24h TTL)</h2>
            <button class="action-btn btn-promote" onclick="loadPending()">Refresh</button>
          </div>
          <div id="pending-error" class="error hidden"></div>
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Workspace</th>
                <th>Expires</th>
              </tr>
            </thead>
            <tbody id="pending-body">
              <tr><td colspan="3" style="text-align:center; color:#64748b;">Loading...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>

  <script>
    let adminCredential = sessionStorage.getItem('watcher_admin_cred');
    let adminCredType = sessionStorage.getItem('watcher_admin_type') || 'password';

    if (adminCredential) {
      document.getElementById('login-view').classList.add('hidden');
      document.getElementById('admin-view').classList.remove('hidden');
      loadTenants();
    }

    function toggleAdminEye() {
      const input = document.getElementById('admin-key-input');
      const btn = document.getElementById('eye-admin');
      if (input.type === 'password') { input.type = 'text'; btn.innerText = '🙈'; }
      else { input.type = 'password'; btn.innerText = '👁️'; }
    }

    async function forgotAdminPassword() {
      const email = prompt("Enter the email address associated with your admin account:");
      if (!email) return;
      try {
        const res = await fetch('/api/forgot-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email })
        });
        if (res.ok) {
          alert("✅ If that email is registered, a reset link has been sent. Check your inbox.");
        } else {
          alert("❌ Something went wrong. Please try again.");
        }
      } catch (e) {
        alert("❌ Network error. Please try again.");
      }
    }

    function authHeaders() {
      if (adminCredType === 'key') return { 'X-Admin-Key': adminCredential };
      return { 'X-Admin-Password': adminCredential };
    }

    function login() {
      const input = document.getElementById('admin-key-input').value.trim();
      const err = document.getElementById('login-error');
      if (!input) { err.textContent = 'Enter a password'; err.classList.remove('hidden'); return; }
      err.classList.add('hidden');

      let credType = input.length <= 12 ? 'password' : 'key';
      let credValue = input;
      const headers = credType === 'key' ? { 'X-Admin-Key': credValue } : { 'X-Admin-Password': credValue };

      fetch('/api/admin/tenants', { headers })
        .then(r => {
          if (r.status === 401) {
            err.textContent = 'Invalid password'; err.classList.remove('hidden');
            return;
          }
          if (!r.ok) {
            err.textContent = 'Error ' + r.status; err.classList.remove('hidden');
            return;
          }
          adminCredential = credValue;
          adminCredType = credType;
          sessionStorage.setItem('watcher_admin_cred', credValue);
          sessionStorage.setItem('watcher_admin_type', credType);
          document.getElementById('login-view').classList.add('hidden');
          document.getElementById('admin-view').classList.remove('hidden');
          loadTenants();
        })
        .catch(() => { err.textContent = 'Network error'; err.classList.remove('hidden'); });
    }

    function logout() {
      sessionStorage.removeItem('watcher_admin_cred');
      sessionStorage.removeItem('watcher_admin_type');
      adminCredential = null;
      location.reload();
    }

    function showTab(name) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.getElementById('tab-' + name).classList.add('active');
      document.getElementById('tenants-view').classList.toggle('hidden', name !== 'tenants');
      document.getElementById('pending-view').classList.toggle('hidden', name !== 'pending');
      if (name === 'tenants') loadTenants();
      if (name === 'pending') loadPending();
    }

        let showDeleted = false;
    
    function toggleDeleted() {
      showDeleted = !showDeleted;
      document.getElementById('toggle-deleted-btn').textContent = showDeleted ? 'Hide Deleted' : 'Show Deleted';
      document.getElementById('toggle-deleted-btn').style.background = showDeleted ? '#ef4444' : '#4b5563';
      loadTenants();
    }

    function loadTenants() {
      const err = document.getElementById('tenants-error');
      const ok = document.getElementById('tenants-status');
      err.classList.add('hidden');
      ok.classList.add('hidden');

      fetch('/api/admin/tenants?include_deleted=' + showDeleted, { headers: authHeaders() })
        .then(r => r.json())
        .then(d => {
          // Update Metrics
          if (d.metrics) {
            document.getElementById('metric-total').textContent = d.metrics.total;
            document.getElementById('metric-suspended').textContent = d.metrics.suspended;
            document.getElementById('metric-deleted').textContent = d.metrics.deleted;
            document.getElementById('metric-subs').textContent = d.metrics.subscribers;
          }

          const body = document.getElementById('tenants-body');
          if (!d.tenants || !d.tenants.length) {
            body.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#64748b;">No tenants</td></tr>';
            return;
          }
          
          body.innerHTML = d.tenants.map(t => {
            let planClass = 'plan-free';
            if (t.plan === 'premium') planClass = 'plan-premium';
            if (t.plan === 'suspended') planClass = 'plan-suspended';
            if (t.plan === 'deleted') planClass = 'plan-suspended';
            
            const verifiedBadge = t.verified === 1 ? '<span class="badge badge-verified">Verified</span>' : '<span class="badge badge-unverified">Pending</span>';
            
            // Format timestamp if deleted/suspended
            let statusNote = '';
            if (t.plan === 'suspended' && t.suspended_at) statusNote = '<br><small style="color:#94a3b8;">' + new Date(t.suspended_at).toLocaleDateString() + '</small>';
            if (t.plan === 'deleted' && t.deleted_at) statusNote = '<br><small style="color:#94a3b8;">Deleted: ' + new Date(t.deleted_at).toLocaleDateString() + '</small>';

            const actions = [];
            if (t.plan === 'deleted') {
                actions.push('<span style="color:#64748b;font-size:12px;">Archived</span>');
            } else {
                if (t.plan === 'premium') actions.push('<button class="action-btn btn-downgrade" onclick="action(\\''+t.id+'\\', \\'downgrade\\')">Downgrade</button>');
                else if (t.plan === 'suspended') actions.push('<button class="action-btn btn-unsuspend" onclick="action(\\''+t.id+'\\', \\'unsuspend\\')">Unsuspend</button>');
                else actions.push('<button class="action-btn btn-promote" onclick="action(\\''+t.id+'\\', \\'promote\\')">Promote</button>');
                
                if (t.plan !== 'suspended') actions.push('<button class="action-btn btn-suspend" onclick="action(\\''+t.id+'\\', \\'suspend\\')">Suspend</button>');
                
                // Tell the admin it's a soft delete now
                actions.push('<button class="action-btn btn-delete" onclick="action(\\''+t.id+'\\', \\'delete\\')">Delete</button>');
            }

            return '<tr>' +
              '<td data-label="Workspace"><strong>' + t.id + '</strong></td>' +
              '<td data-label="Email">' + (t.email || '—') + '</td>' +
              '<td data-label="Plan" class="' + planClass + '">' + t.plan.toUpperCase() + statusNote + '</td>' +
              '<td data-label="Verified">' + verifiedBadge + '</td>' +
              '<td data-label="Apps">' + t.app_count + '</td>' +
              '<td data-label="Actions">' + actions.join('') + '</td>' +
              '</tr>';
          }).join('');
        })
        .catch(() => { err.textContent = 'Failed to load tenants'; err.classList.remove('hidden'); });
    }

    function loadPending() {
      const err = document.getElementById('pending-error');
      err.classList.add('hidden');

      fetch('/api/admin/pending', { headers: authHeaders() })
        .then(r => r.json())
        .then(d => {
          const body = document.getElementById('pending-body');
          if (!d.pending || !d.pending.length) {
            body.innerHTML = '<tr><td colspan="3" style="text-align:center; color:#64748b;">No pending signups</td></tr>';
            return;
          }
          const now = Date.now();
          body.innerHTML = d.pending.map(p => {
            const msLeft = p.expires_at - now;
            const minsLeft = Math.max(0, Math.floor(msLeft / 60000));
            const hoursLeft = Math.floor(minsLeft / 60);
            const label = hoursLeft > 0 ? hoursLeft + 'h ' + (minsLeft % 60) + 'm' : minsLeft + 'm';
            return '<tr>' +
              '<td data-label="Email">' + p.email + '</td>' +
              '<td data-label="Workspace"><strong>' + p.workspace + '</strong></td>' +
              '<td data-label="Expires">' + (msLeft > 0 ? label : 'expired') + '</td>' +
              '</tr>';
          }).join('');
        })
        .catch(() => { err.textContent = 'Failed to load pending'; err.classList.remove('hidden'); });
    }

    function action(tenantId, actionType) {
      const err = document.getElementById('tenants-error');
      const ok = document.getElementById('tenants-status');
      err.classList.add('hidden');
      ok.classList.add('hidden');

      let url, method = 'POST';
      if (actionType === 'delete') {
                if (!confirm('Soft-delete "' + tenantId + '"?\\n\\nThe tenant will be hidden and their alert/webhook subscriptions removed. Apps, ping logs, and tenant data are retained for legal purposes. Can be restored by an admin.')) return;
        url = '/api/admin/tenants/' + tenantId;
        method = 'DELETE';
      } else {
        url = '/api/admin/tenants/' + tenantId + '/' + actionType;
      }

      fetch(url, { method, headers: authHeaders() })
        .then(r => r.json().then(d => ({ ok: r.ok, d })))
        .then(({ ok: wasOk, d }) => {
          if (wasOk) {
            ok.textContent = d.message || 'Success';
            ok.classList.remove('hidden');
            loadTenants();
          } else {
            err.textContent = d.error || 'Action failed';
            err.classList.remove('hidden');
          }
        })
        .catch(() => { err.textContent = 'Network error'; err.classList.remove('hidden'); });
    }
  </script>
</body>
</html>`;