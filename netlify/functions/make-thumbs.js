/**
 * Netlify Function: make-thumbs
 *
 * One-time backfill: creates the small grid copy (`<photo>-thumb.jpg`, 400px wide)
 * for quest photos uploaded before the app started making them (2026-11-20).
 * Run from questgoals.com/verify-queue ("Make thumbnails for older photos").
 * The page calls this repeatedly; each call works for about 7 seconds and
 * returns where to continue. Photos that already have a thumbnail are skipped,
 * so it's safe to run more than once.
 *
 *   POST { key, offset } → { nextOffset, done, made, skipped, failed, total }
 *
 * Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VERIFY_QUEUE_KEY
 */

const { Jimp } = require('jimp');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://gxlabrmxzcffefgfpogn.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const QUEUE_KEY = process.env.VERIFY_QUEUE_KEY;

const BUCKET = 'quest-photos';
const PUBLIC_PREFIX = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/`;
const THUMB_WIDTH = 400;
const TIME_BUDGET_MS = 7000;
const PAGE = 40;

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});
const auth = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` });
const objectUrl = (path) => `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`;

async function makeOne(photoUrl) {
  const clean = String(photoUrl).split('?')[0];
  if (!clean.startsWith(PUBLIC_PREFIX) || !/\.jpg$/i.test(clean) || /-thumb\.jpg$/i.test(clean)) return 'skipped';
  const path = decodeURIComponent(clean.slice(PUBLIC_PREFIX.length));
  const thumbPath = path.replace(/\.jpg$/i, '-thumb.jpg');

  const exists = await fetch(objectUrl(thumbPath), { method: 'HEAD', headers: auth() });
  if (exists.ok) return 'skipped';

  const full = await fetch(objectUrl(path), { headers: auth() });
  if (!full.ok) return full.status === 404 || full.status === 400 ? 'skipped' : 'failed';

  const img = await Jimp.read(Buffer.from(await full.arrayBuffer()));
  if (img.width > THUMB_WIDTH) img.resize({ w: THUMB_WIDTH });
  const out = await img.getBuffer('image/jpeg', { quality: 60 });

  const up = await fetch(objectUrl(thumbPath), {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'image/jpeg', 'x-upsert': 'true', 'cache-control': 'max-age=31536000' },
    body: out,
  });
  return up.ok ? 'made' : 'failed';
}

exports.handler = async (event) => {
  if (!QUEUE_KEY || !SERVICE_KEY) return json(500, { error: 'Not configured' });
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  if (body.key !== QUEUE_KEY) return json(401, { error: 'Unauthorized' });

  const started = Date.now();
  let offset = Math.max(0, parseInt(body.offset, 10) || 0);
  const counts = { made: 0, skipped: 0, failed: 0 };

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/user_quests?select=photo_url&photo_url=not.is.null&order=user_id.asc,quest_id.asc&offset=${offset}&limit=${PAGE}`,
      { headers: { ...auth(), Prefer: 'count=exact' } },
    );
    if (!res.ok) throw new Error(`user_quests ${res.status}`);
    const total = parseInt((res.headers.get('content-range') || '').split('/')[1], 10) || 0;
    const rows = await res.json();

    for (const row of rows) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      try { counts[await makeOne(row.photo_url)]++; } catch (e) { counts.failed++; console.warn('make-thumbs:', e && e.message); }
      offset++;
    }
    return json(200, { ...counts, nextOffset: offset, total, done: rows.length === 0 || offset >= total });
  } catch (err) {
    console.error('make-thumbs error:', err && err.message);
    return json(500, { error: 'Server error', detail: String(err && err.message || err).slice(0, 200) });
  }
};
