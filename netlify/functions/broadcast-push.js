/**
 * Netlify Function: broadcast-push
 *
 * Sends one push notification to every Quest user who can receive pushes and
 * hasn't turned off "Competition & Tips" in the app's Settings
 * (user_metadata.promo_push_opt_out). Used from questgoals.com/verify-queue.
 * Same password as the queue (VERIFY_QUEUE_KEY), plus a second send code
 * (BROADCAST_PIN) that's typed in for every send and never stored in the browser.
 * If BROADCAST_PIN isn't set, sending is blocked (fail closed).
 *
 *   GET  ?key=...                              → { recipients, devices, optedOut }
 *   POST { key, pin, title, body, confirm }    → sends; { sent, devices, errors }
 *
 * Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VERIFY_QUEUE_KEY, BROADCAST_PIN
 */

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://gxlabrmxzcffefgfpogn.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const QUEUE_KEY = process.env.VERIFY_QUEUE_KEY;
const BROADCAST_PIN = process.env.BROADCAST_PIN;

/** Constant-time string compare (hash both so lengths match). */
function safeEqual(a, b) {
  const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

const sbHeaders = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` });

/** Push tokens of users who haven't opted out, grouped for counting. */
async function getAudience() {
  const tokRes = await fetch(`${SUPABASE_URL}/rest/v1/user_push_tokens?select=user_id,push_token`, { headers: sbHeaders() });
  if (!tokRes.ok) throw new Error(`tokens ${tokRes.status}`);
  const tokens = (await tokRes.json()).filter(t => t.push_token);

  // Opt-out flags live on the account (all users fit on one page at current scale; page through to be safe)
  const optedOut = new Set();
  for (let page = 1; page <= 20; page++) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=1000`, { headers: sbHeaders() });
    if (!res.ok) throw new Error(`users ${res.status}`);
    const data = await res.json();
    const users = Array.isArray(data) ? data : data.users || [];
    users.forEach(u => { if (u.user_metadata && u.user_metadata.promo_push_opt_out) optedOut.add(u.id); });
    if (users.length < 1000) break;
  }

  const allowed = tokens.filter(t => !optedOut.has(t.user_id));
  return {
    tokens: [...new Set(allowed.map(t => t.push_token))],
    recipients: new Set(allowed.map(t => t.user_id)).size,
    optedOut: new Set(tokens.filter(t => optedOut.has(t.user_id)).map(t => t.user_id)).size,
  };
}

exports.handler = async (event) => {
  if (!QUEUE_KEY || !SERVICE_KEY) return json(500, { error: 'Not configured' });

  let body = {};
  if (event.httpMethod === 'POST') {
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  }
  const key = event.httpMethod === 'POST' ? body.key : (event.queryStringParameters || {}).key;
  if (key !== QUEUE_KEY) return json(401, { error: 'Unauthorized' });

  try {
    const audience = await getAudience();

    if (event.httpMethod === 'GET') {
      return json(200, { recipients: audience.recipients, devices: audience.tokens.length, optedOut: audience.optedOut });
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    // Second layer: the send code
    if (!BROADCAST_PIN) return json(503, { error: 'Sending is locked: the send code has not been set up yet.' });
    if (!body.pin || !safeEqual(body.pin, BROADCAST_PIN)) {
      console.warn('broadcast: wrong send code');
      await new Promise(r => setTimeout(r, 1500)); // slow down guessing
      return json(403, { error: 'Wrong send code. Nothing was sent.' });
    }

    const title = String(body.title || '').trim();
    const message = String(body.body || '').trim();
    if (!title || !message) return json(400, { error: 'Title and message are both required.' });
    if (title.length > 65 || message.length > 178) return json(400, { error: 'Keep the title under 65 and the message under 178 characters.' });
    if (body.confirm !== true) return json(400, { error: 'Not confirmed.' });

    // Expo accepts up to 100 messages per request
    let sent = 0;
    const errors = [];
    for (let i = 0; i < audience.tokens.length; i += 100) {
      const chunk = audience.tokens.slice(i, i + 100).map(to => ({
        to, title, body: message, sound: 'default', data: { kind: 'broadcast' },
      }));
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(chunk),
      });
      const out = await res.json().catch(() => ({}));
      (out.data || []).forEach(r => {
        if (r.status === 'ok') sent++;
        else errors.push((r.details && r.details.error) || r.message || 'error');
      });
      if (!res.ok && !out.data) errors.push(`expo ${res.status}`);
    }
    console.log(`broadcast: "${title}" → ${sent}/${audience.tokens.length} devices, ${errors.length} errors`);
    return json(200, { sent, devices: audience.tokens.length, recipients: audience.recipients, errors: errors.slice(0, 10) });
  } catch (err) {
    console.error('broadcast-push error:', err && err.message);
    return json(500, { error: 'Server error', detail: String(err && err.message || err).slice(0, 200) });
  }
};
