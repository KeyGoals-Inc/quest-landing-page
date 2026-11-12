/**
 * Netlify Function: photo-ai-admin
 *
 * Backend for the AI controls on questgoals.com/verify-queue. Same password
 * as the queue (VERIFY_QUEUE_KEY).
 *
 *   GET  ?key=...&view=status   settings + this month's AI usage
 *   GET  ?key=...&view=auto     auto-approved photos from the last 30 days
 *   POST { key, action: 'settings', mode, model, monthly_photo_cap, monthly_dollar_cap }
 *   POST { key, action: 'reverse', review_id }   undo an auto-approval
 */

const { getSettings, getMonthUsage, sb, MODELS } = require('../lib/photo-ai');

const QUEUE_KEY = process.env.VERIFY_QUEUE_KEY;
const MODES = ['off', 'trial', 'auto'];

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (!QUEUE_KEY || !process.env.SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: 'Not configured' });

  let body = {};
  if (event.httpMethod === 'POST') {
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  }
  const qs = event.queryStringParameters || {};
  const key = event.httpMethod === 'POST' ? body.key : qs.key;
  if (key !== QUEUE_KEY) return json(401, { error: 'Unauthorized' });

  try {
    if (event.httpMethod === 'GET' && qs.view === 'status') {
      const [settings, usage] = await Promise.all([getSettings(), getMonthUsage()]);
      return json(200, { settings, usage, models: MODELS, hasApiKey: !!process.env.ANTHROPIC_API_KEY });
    }

    if (event.httpMethod === 'GET' && qs.view === 'auto') {
      const since = new Date(Date.now() - 30 * 86400000).toISOString();
      const rows = await sb(
        `photo_ai_reviews?auto_approved=eq.true&created_at=gte.${encodeURIComponent(since)}` +
        `&select=id,quest_id,user_id,photo_url,reason,created_at,reversed_at&order=created_at.desc&limit=200`
      );
      const ids = [...new Set(rows.map(r => r.quest_id))];
      const names = {};
      if (ids.length) {
        const inList = ids.map(id => '"' + String(id).replace(/"/g, '') + '"').join(',');
        const qs2 = await sb(`quests?id=in.(${encodeURIComponent(inList)})&select=id,name`);
        qs2.forEach(q => { names[q.id] = q.name; });
      }
      return json(200, { items: rows.map(r => ({ ...r, quest_name: names[r.quest_id] || r.quest_id })) });
    }

    if (event.httpMethod === 'POST' && body.action === 'settings') {
      const patch = { updated_at: new Date().toISOString() };
      if (body.mode !== undefined) {
        if (!MODES.includes(body.mode)) return json(400, { error: 'Bad mode' });
        if (body.mode !== 'off' && !process.env.ANTHROPIC_API_KEY) {
          return json(400, { error: 'Add ANTHROPIC_API_KEY in Netlify before turning AI on.' });
        }
        patch.mode = body.mode;
      }
      if (body.model !== undefined) {
        if (!MODELS.includes(body.model)) return json(400, { error: 'Bad model' });
        patch.model = body.model;
      }
      if (body.monthly_photo_cap !== undefined) {
        const n = Math.floor(Number(body.monthly_photo_cap));
        if (!(n >= 0 && n <= 1000000)) return json(400, { error: 'Bad photo cap' });
        patch.monthly_photo_cap = n;
      }
      if (body.monthly_dollar_cap !== undefined) {
        const d = Math.round(Number(body.monthly_dollar_cap) * 100) / 100;
        if (!(d >= 0 && d <= 10000)) return json(400, { error: 'Bad dollar cap' });
        patch.monthly_dollar_cap = d;
      }
      await sb('photo_ai_settings?id=eq.1', { method: 'PATCH', body: JSON.stringify(patch) });
      const [settings, usage] = await Promise.all([getSettings(), getMonthUsage()]);
      return json(200, { settings, usage });
    }

    if (event.httpMethod === 'POST' && body.action === 'reverse') {
      const reviews = await sb(`photo_ai_reviews?id=eq.${Number(body.review_id)}&select=*`);
      const r = reviews[0];
      if (!r || !r.auto_approved) return json(404, { error: 'Not found' });
      if (r.reversed_at) return json(200, { ok: true, already: true });

      // Same outcome as a manual deny: the photo no longer verifies the quest.
      // If the quest was already completed before the photo, it stays completed (Unverified).
      const now = new Date().toISOString();
      const restore = r.prior_completed_at
        ? { status: 'completed', completed_at: r.prior_completed_at }
        : { status: 'active', completed_at: null };
      await sb(`user_quests?id=eq.${r.user_quest_id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ...restore, verified: false, photo_url: null, verification_token: null,
          photo_submitted_at: null, photo_denied_at: now,
        }),
      });
      await sb(`photo_ai_reviews?id=eq.${r.id}`, { method: 'PATCH', body: JSON.stringify({ reversed_at: now }) });

      try {
        const tokens = await sb(`user_push_tokens?user_id=eq.${r.user_id}&select=push_token`);
        const to = tokens.map(t => t.push_token).filter(Boolean);
        if (to.length) {
          await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(to.map(t => ({
              to: t, title: '📸 Photo Not Accepted', sound: 'default',
              body: "Your photo wasn't accepted. You can submit a new photo to try again.",
            }))),
          });
        }
      } catch (err) {
        console.warn('push failed (non-fatal):', err.message);
      }
      return json(200, { ok: true });
    }

    return json(400, { error: 'Unknown request' });
  } catch (err) {
    console.error('photo-ai-admin error:', err && err.message);
    return json(500, { error: 'Server error', detail: String(err && err.message || err).slice(0, 300) });
  }
};
