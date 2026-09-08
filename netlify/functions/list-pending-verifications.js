/**
 * Netlify Function: list-pending-verifications
 *
 * Powers the private admin page at questgoals.com/verify-queue.
 * Returns every user_quests row still awaiting a photo decision
 * (status = 'pending_photo'), enriched with the quest name and the submitter.
 *
 *   GET ?key=<VERIFY_QUEUE_KEY>
 *
 * Env vars:
 *   SUPABASE_URL              — https://gxlabrmxzcffefgfpogn.supabase.co  (already set, shared with photo-verify)
 *   SUPABASE_SERVICE_ROLE_KEY — service_role key, bypasses RLS            (already set, shared with photo-verify)
 *   VERIFY_QUEUE_KEY          — shared password for the queue page        (added in Netlify)
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://gxlabrmxzcffefgfpogn.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const QUEUE_KEY = process.env.VERIFY_QUEUE_KEY;

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  if (!SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'SUPABASE_SERVICE_ROLE_KEY not set' }) };
  }
  if (!QUEUE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'VERIFY_QUEUE_KEY not set' }) };
  }

  const provided = (event.queryStringParameters || {}).key || '';
  if (provided !== QUEUE_KEY) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const sb = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
  const fail = (where, status, detail) => ({
    statusCode: 502,
    headers,
    body: JSON.stringify({ error: 'Could not load queue', where, status, detail }),
  });

  // 1. Pending photo submissions, oldest first (no table joins)
  let rows;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/user_quests` +
        `?status=eq.pending_photo` +
        `&select=id,user_id,quest_id,status,photo_url,photo_submitted_at,verification_token` +
        `&order=photo_submitted_at.asc`,
      { headers: sb }
    );
    const text = await res.text();
    if (!res.ok) return fail('user_quests', res.status, text.slice(0, 500));
    rows = JSON.parse(text);
    if (!Array.isArray(rows)) return fail('user_quests', res.status, 'not an array: ' + text.slice(0, 300));
  } catch (err) {
    return fail('user_quests', 0, String(err && err.message || err));
  }

  // 2. Quest names/descriptions for the quest_ids we have (best-effort)
  const questMap = {};
  const questIds = Array.from(new Set(rows.map((r) => r.quest_id).filter(Boolean)));
  if (questIds.length) {
    try {
      const inList = questIds.map((id) => '"' + String(id).replace(/"/g, '') + '"').join(',');
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/quests?id=in.(${encodeURIComponent(inList)})&select=id,name,description`,
        { headers: sb }
      );
      if (res.ok) {
        const qs = await res.json();
        if (Array.isArray(qs)) qs.forEach((q) => { questMap[q.id] = q; });
      } else {
        console.warn('quests lookup failed:', res.status, (await res.text()).slice(0, 200));
      }
    } catch (err) {
      console.warn('quests lookup error (non-fatal):', err.message);
    }
  }

  // 3. Submitter email/name via the Auth admin API (best-effort)
  const userMap = {};
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=1000`, { headers: sb });
    if (res.ok) {
      const data = await res.json();
      const users = Array.isArray(data) ? data : data.users || [];
      users.forEach((u) => {
        userMap[u.id] = {
          email: u.email || null,
          name: (u.user_metadata && u.user_metadata.full_name) || null,
        };
      });
    } else {
      console.warn('auth users lookup failed:', res.status);
    }
  } catch (err) {
    console.warn('auth users lookup error (non-fatal):', err.message);
  }

  const items = rows.map((r) => {
    const q = questMap[r.quest_id] || {};
    const u = userMap[r.user_id] || {};
    return {
      id: r.id,
      quest_id: r.quest_id,
      quest_name: q.name || r.quest_id,
      quest_description: q.description || null,
      photo_url: r.photo_url,
      submitted_at: r.photo_submitted_at,
      verification_token: r.verification_token,
      user_email: u.email || null,
      user_name: u.name || null,
      user_id: r.user_id,
    };
  });

  return { statusCode: 200, headers, body: JSON.stringify({ count: items.length, items }) };
};
