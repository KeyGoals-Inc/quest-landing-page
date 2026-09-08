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
 *   VERIFY_QUEUE_KEY          — shared password for the queue page        (NEW — add this in Netlify)
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://gxlabrmxzcffefgfpogn.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const QUEUE_KEY = process.env.VERIFY_QUEUE_KEY;

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  if (!SERVICE_KEY) {
    console.error('SUPABASE_SERVICE_ROLE_KEY not set');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server not configured' }) };
  }
  if (!QUEUE_KEY) {
    console.error('VERIFY_QUEUE_KEY not set');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Queue password not configured' }) };
  }

  const provided = (event.queryStringParameters || {}).key || '';
  if (provided !== QUEUE_KEY) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const sb = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

  // 1. Pending photo submissions, oldest first, with the quest name/description
  let rows;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/user_quests` +
        `?status=eq.pending_photo` +
        `&select=id,user_id,quest_id,status,photo_url,photo_submitted_at,verification_token,quests(name,description)` +
        `&order=photo_submitted_at.asc`,
      { headers: sb }
    );
    rows = await res.json();
    if (!res.ok || !Array.isArray(rows)) {
      console.error('user_quests query failed:', rows);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not load queue', details: rows }) };
    }
  } catch (err) {
    console.error('user_quests fetch error:', err);
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not load queue' }) };
  }

  // 2. Best-effort map of user_id -> { email, name } via the Auth admin API
  const userMap = {};
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=1000`, { headers: sb });
    const data = await res.json();
    const users = Array.isArray(data) ? data : data.users || [];
    for (const u of users) {
      userMap[u.id] = {
        email: u.email || null,
        name: (u.user_metadata && u.user_metadata.full_name) || null,
      };
    }
  } catch (err) {
    console.warn('Auth users lookup failed (non-fatal):', err.message);
  }

  const items = rows.map((r) => ({
    id: r.id,
    quest_id: r.quest_id,
    quest_name: (r.quests && r.quests.name) || r.quest_id,
    quest_description: (r.quests && r.quests.description) || null,
    photo_url: r.photo_url,
    submitted_at: r.photo_submitted_at,
    verification_token: r.verification_token,
    user_email: (userMap[r.user_id] && userMap[r.user_id].email) || null,
    user_name: (userMap[r.user_id] && userMap[r.user_id].name) || null,
    user_id: r.user_id,
  }));

  return { statusCode: 200, headers, body: JSON.stringify({ count: items.length, items }) };
};
