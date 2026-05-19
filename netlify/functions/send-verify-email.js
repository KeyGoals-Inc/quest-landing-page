/**
 * Netlify Function: send-verify-email
 *
 * Called by the Quest app when a user submits a photo for quest verification.
 * Sends an email to admin@questgoals.com with the photo and Approve/Deny buttons.
 *
 * POST body: { quest_name, user_email, user_id, photo_url, verification_token }
 *
 * Required env vars (set in Netlify dashboard → Site config → Environment variables):
 *   RESEND_API_KEY          — from resend.com
 *   ADMIN_EMAIL             — admin@questgoals.com
 */

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@questgoals.com';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const BASE_URL = 'https://questgoals.com';

exports.handler = async (event) => {
  // CORS headers — needed so the React Native app can POST here
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: 'Method Not Allowed' };
  }

  if (!RESEND_API_KEY) {
    console.error('RESEND_API_KEY not set');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Email service not configured' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { quest_name, user_email, user_id, photo_url, verification_token } = body;

  if (!quest_name || !photo_url || !verification_token) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields' }) };
  }

  const approveUrl = `${BASE_URL}/.netlify/functions/photo-verify?action=approve&token=${encodeURIComponent(verification_token)}`;
  const denyUrl    = `${BASE_URL}/.netlify/functions/photo-verify?action=deny&token=${encodeURIComponent(verification_token)}`;
  const submittedAt = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' });

  const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0;padding:0;background:#F2E8DC;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F2E8DC;padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

          <!-- Header -->
          <tr>
            <td style="background:#1B3A4B;padding:24px 32px;text-align:center;">
              <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#C4972A;">Quest App</p>
              <h1 style="margin:8px 0 0;font-size:22px;font-weight:700;color:#F2E8DC;">📸 Photo Verification Request</h1>
            </td>
          </tr>

          <!-- Quest details -->
          <tr>
            <td style="padding:28px 32px 0;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:8px 0;border-bottom:1px solid #F2E8DC;">
                    <span style="font-size:12px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:0.08em;">Quest</span><br/>
                    <span style="font-size:16px;font-weight:700;color:#1B3A4B;">${escapeHtml(quest_name)}</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding:8px 0;border-bottom:1px solid #F2E8DC;">
                    <span style="font-size:12px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:0.08em;">User</span><br/>
                    <span style="font-size:14px;color:#333;">${escapeHtml(user_email || user_id || 'Unknown')}</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding:8px 0;">
                    <span style="font-size:12px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:0.08em;">Submitted</span><br/>
                    <span style="font-size:14px;color:#333;">${submittedAt}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Photo -->
          <tr>
            <td style="padding:24px 32px;">
              <p style="margin:0 0 12px;font-size:12px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:0.08em;">Submitted Photo</p>
              <img
                src="${photo_url}"
                alt="Quest verification photo"
                width="496"
                style="display:block;width:100%;max-width:496px;height:auto;border-radius:8px;border:1px solid #E4D8C8;"
              />
            </td>
          </tr>

          <!-- Approve / Deny buttons -->
          <tr>
            <td style="padding:0 32px 32px;">
              <p style="margin:0 0 16px;font-size:13px;color:#6B7280;text-align:center;">
                Does this photo verify the quest above? Tap a button to respond.
              </p>
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td width="48%" align="center">
                    <a href="${approveUrl}"
                       style="display:block;background:#16a34a;color:#ffffff;font-size:16px;font-weight:700;text-decoration:none;text-align:center;padding:16px 24px;border-radius:8px;letter-spacing:0.02em;">
                      ✅ Approve
                    </a>
                  </td>
                  <td width="4%"></td>
                  <td width="48%" align="center">
                    <a href="${denyUrl}"
                       style="display:block;background:#dc2626;color:#ffffff;font-size:16px;font-weight:700;text-decoration:none;text-align:center;padding:16px 24px;border-radius:8px;letter-spacing:0.02em;">
                      ❌ Deny
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#F9F5F0;padding:16px 32px;text-align:center;border-top:1px solid #E4D8C8;">
              <p style="margin:0;font-size:11px;color:#9CA3AF;">
                Quest by KeyGoals, Inc. &nbsp;·&nbsp; <a href="https://questgoals.com" style="color:#3B9E8E;text-decoration:none;">questgoals.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  // Send via Resend REST API
  try {
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Quest Verification <verification@questgoals.com>',
        to: [ADMIN_EMAIL],
        subject: `📸 Verify Quest: ${quest_name}`,
        html: emailHtml,
      }),
    });

    const resendData = await resendRes.json();

    if (!resendRes.ok) {
      console.error('Resend error:', resendData);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Failed to send email', details: resendData }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, email_id: resendData.id }),
    };
  } catch (err) {
    console.error('Send email error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
