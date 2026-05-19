/**
 * Netlify Function: photo-verify
 *
 * Called when the admin clicks Approve or Deny in the verification email.
 * Updates user_quests in Supabase and returns an HTML confirmation page.
 *
 * GET ?action=approve&token=xxx  — approves the quest (status → completed)
 * GET ?action=deny&token=xxx     — denies the quest (status → active, so user can retry)
 *
 * Required env vars:
 *   SUPABASE_URL              — https://gxlabrmxzcffefgfpogn.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY — from Supabase dashboard → Settings → API
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://gxlabrmxzcffefgfpogn.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

exports.handler = async (event) => {
  const { action, token } = event.queryStringParameters || {};

  if (!token || !action) {
    return htmlResponse(400, errorPage('Invalid Link', 'This verification link is missing required parameters.'));
  }

  if (action !== 'approve' && action !== 'deny') {
    return htmlResponse(400, errorPage('Invalid Action', 'Action must be approve or deny.'));
  }

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error('SUPABASE_SERVICE_ROLE_KEY not set');
    return htmlResponse(500, errorPage('Server Error', 'Verification service is not configured. Please contact support.'));
  }

  const supabaseHeaders = {
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  };

  // 1. Look up the user_quest by verification token
  let record;
  try {
    const lookupRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_quests?verification_token=eq.${encodeURIComponent(token)}&select=id,user_id,quest_id,status,photo_url`,
      { headers: supabaseHeaders }
    );
    const records = await lookupRes.json();

    if (!lookupRes.ok || !Array.isArray(records) || records.length === 0) {
      console.error('Lookup failed:', records);
      return htmlResponse(404, errorPage('Not Found', 'This verification link has expired or is invalid.'));
    }

    record = records[0];
  } catch (err) {
    console.error('Supabase lookup error:', err);
    return htmlResponse(500, errorPage('Server Error', 'Could not look up the quest. Please try again.'));
  }

  // 2. Prevent double-processing
  if (record.status === 'completed') {
    return htmlResponse(200, successPage('Already Approved', 'This quest was already approved.', '✅'));
  }
  if (record.status === 'active' && action === 'deny') {
    return htmlResponse(200, successPage('Already Denied', 'This quest was already denied and the user can retry.', '🔄'));
  }

  // 3. Update the status
  const newStatus = action === 'approve' ? 'completed' : 'active';

  try {
    const updateRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_quests?id=eq.${record.id}`,
      {
        method: 'PATCH',
        headers: supabaseHeaders,
        body: JSON.stringify({
          status: newStatus,
          // Clear the pending photo fields after decision
          ...(action === 'approve' ? {} : { photo_url: null, verification_token: null, photo_submitted_at: null }),
        }),
      }
    );

    if (!updateRes.ok) {
      const errData = await updateRes.json();
      console.error('Update failed:', errData);
      return htmlResponse(500, errorPage('Update Failed', 'Could not update the quest status. Please try again.'));
    }
  } catch (err) {
    console.error('Supabase update error:', err);
    return htmlResponse(500, errorPage('Server Error', 'Could not update the quest. Please try again.'));
  }

  // 4. Return confirmation page
  if (action === 'approve') {
    return htmlResponse(200, successPage(
      'Quest Approved! 🏆',
      'The quest has been marked as completed. The user will see it as done in the app.',
      '✅'
    ));
  } else {
    return htmlResponse(200, successPage(
      'Quest Denied',
      'The quest has been reset to active. The user can submit a new photo to try again.',
      '🔄'
    ));
  }
};

// ─── HTML helpers ────────────────────────────────────────────────────────────

function htmlResponse(statusCode, html) {
  return {
    statusCode,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: html,
  };
}

function successPage(title, message, icon) {
  const isApprove = title.includes('Approved') || title.includes('Already Approved');
  const accent = isApprove ? '#16a34a' : '#C4972A';
  return page(title, message, icon, accent);
}

function errorPage(title, message) {
  return page(title, message, '⚠️', '#dc2626');
}

function page(title, message, icon, accent) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} — Quest</title>
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap" rel="stylesheet" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Poppins', sans-serif;
      background: #F2E8DC;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }
    .card {
      background: white;
      border-radius: 16px;
      padding: 3rem 2.5rem;
      max-width: 420px;
      width: 100%;
      text-align: center;
      box-shadow: 0 4px 24px rgba(27,58,75,0.1);
    }
    .icon { font-size: 3.5rem; margin-bottom: 1.25rem; }
    .title { font-size: 1.5rem; font-weight: 700; color: #1B3A4B; margin-bottom: 0.75rem; }
    .message { font-size: 0.95rem; color: #6B7280; line-height: 1.6; margin-bottom: 2rem; }
    .back-link {
      display: inline-block;
      background: #1B3A4B;
      color: white;
      text-decoration: none;
      padding: 0.75rem 2rem;
      border-radius: 8px;
      font-weight: 600;
      font-size: 0.9rem;
      transition: background 0.2s;
    }
    .back-link:hover { background: ${accent}; }
    .brand { margin-top: 2rem; font-size: 0.75rem; color: #9CA3AF; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1 class="title">${title}</h1>
    <p class="message">${message}</p>
    <a href="https://questgoals.com" class="back-link">Back to Quest</a>
    <p class="brand">Quest by KeyGoals, Inc.</p>
  </div>
</body>
</html>`;
}
