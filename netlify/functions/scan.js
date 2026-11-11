/**
 * Netlify Function: scan
 *
 * Behind printed QR codes (e.g. questgoals.com/cie). Adds 1 to an anonymous
 * per-source counter in Supabase, then sends phones straight to the right
 * app store (desktop goes to /download). Stores nothing about the visitor.
 *
 * The redirect never waits more than ~1.5s on the counter and never fails
 * because of it, so a printed code keeps working even if the count can't be saved.
 *
 * Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://gxlabrmxzcffefgfpogn.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const APP_STORE = 'https://apps.apple.com/us/app/quest-achieve-your-goals/id6793369051';
const PLAY_STORE = 'https://play.google.com/store/apps/details?id=com.keygoals.quest';

async function countScan(source) {
  if (!SUPABASE_SERVICE_ROLE_KEY) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/increment_qr_scan`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ scan_source: source }),
      signal: controller.signal,
    });
  } catch (err) {
    console.error('scan count failed:', err.message);
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async (event) => {
  // Source comes from the redirect rule (?src=cie); fall back to the path (/cie)
  const fromPath = (event.path || '').split('/').filter(Boolean).pop();
  const raw = (event.queryStringParameters || {}).src
    || (fromPath && fromPath !== 'scan' ? fromPath : 'unknown');
  const source = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'unknown';
  const ua = (event.headers || {})['user-agent'] || '';

  let target = '/download';
  if (/iPhone|iPad|iPod/i.test(ua)) target = APP_STORE;
  else if (/Android/i.test(ua)) target = PLAY_STORE;

  await countScan(source);

  return {
    statusCode: 302,
    headers: { Location: target, 'Cache-Control': 'no-store' },
    body: '',
  };
};
