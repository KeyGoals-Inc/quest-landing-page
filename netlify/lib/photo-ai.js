/**
 * Shared AI photo review logic (used by send-verify-email and photo-ai-admin).
 *
 * Flow for each new photo submission:
 *   1. Free checks (no AI): same image reused on another quest/account, or
 *      unusual volume from one user. Always run, even when AI is off.
 *   2. If AI mode is 'trial' or 'auto' and the monthly caps allow it, Claude
 *      looks at the photo and the quest and returns approve / review / suspicious.
 *   3. In 'auto' mode, a clean "approve" (no free-check flags) is approved through
 *      the normal photo-verify endpoint, so the user gets the usual push.
 *   The AI never denies. Anything else stays in the human queue.
 *
 * Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
 */

const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { z } = require('zod');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://gxlabrmxzcffefgfpogn.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BASE_URL = 'https://questgoals.com';
const PHOTO_PREFIX = `${SUPABASE_URL}/storage/v1/object/public/quest-photos/`;

// USD per 1M tokens (input, output). Thinking tokens bill as output.
const PRICING = {
  'claude-haiku-5-5': { input: 0.10, output: 0.50 },
  'claude-sonnet-5-5': { input: 2.00, output: 10.00 },
  'claude-opus-5-5': { input: 4.00, output: 20.00 },
};
const MODELS = Object.keys(PRICING);
const HIGH_VOLUME_PER_HOUR = 20;

const sbHeaders = () => ({
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
});

async function sb(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: { ...sbHeaders(), ...(options.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status} on ${path.split('?')[0]}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** Start of the current month in Eastern Time, as an ISO string. */
function monthStartIso(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit' })
    .formatToParts(now);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  // Midnight ET on the 1st. ET is UTC-5 or UTC-4; use the offset that applies on that date.
  const probe = new Date(`${y}-${m}-01T12:00:00Z`);
  const tzName = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' })
    .formatToParts(probe).find(p => p.type === 'timeZoneName').value; // e.g. "GMT-5"
  const offsetHours = Number((tzName.match(/GMT([+-]\d+)/) || [])[1] || -5);
  return new Date(Date.UTC(Number(y), Number(m) - 1, 1, -offsetHours)).toISOString();
}

async function getSettings() {
  const rows = await sb('photo_ai_settings?id=eq.1&select=*');
  const s = rows && rows[0];
  return s || { mode: 'off', model: 'claude-haiku-5-5', monthly_photo_cap: 10000, monthly_dollar_cap: 10 };
}

/** Photos the AI reviewed this month and what that cost. */
async function getMonthUsage() {
  const rows = await sb(
    `photo_ai_reviews?ai_called=eq.true&created_at=gte.${encodeURIComponent(monthStartIso())}&select=cost_usd`
  );
  const photos = rows.length;
  const cost = rows.reduce((sum, r) => sum + Number(r.cost_usd || 0), 0);
  return { photos, cost: Math.round(cost * 10000) / 10000 };
}

const ReviewSchema = z.object({
  decision: z.enum(['approve', 'review', 'suspicious']),
  reason: z.string(),
});

const SYSTEM_PROMPT = `You review photos that users of Quest, a real-life goal app, submit as proof they completed a quest. You decide whether the photo plausibly shows the quest was done.

Return one decision:
- "approve": the photo clearly and plausibly shows this quest was completed (the right place, activity, object, document, or result). Real-life photos are imperfect; a reasonable, relevant photo is enough. Do not require the person to appear in the photo.
- "review": unclear. The photo is relevant but doesn't clearly show completion, it is too dark or blurry to judge, or the quest is hard to prove with any photo.
- "suspicious": signs of cheating. A stock or professional marketing image, a screenshot of a web page or search result rather than the user's own photo or account, an image of a screen showing someone else's photo, an AI-generated look, or a photo unrelated to the quest.

When unsure between approve and review, choose review. Your reason is one short sentence for the human reviewers, naming what you see.`;

async function classify({ imageBase64, mediaType, questName, questDescription, model }) {
  const client = new Anthropic({ timeout: 7000, maxRetries: 0 });
  const response = await client.messages.parse({
    model,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    output_config: { effort: 'low', format: zodOutputFormat(ReviewSchema) },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
        {
          type: 'text',
          text: `Quest: ${questName}\n${questDescription ? `Quest description: ${questDescription}\n` : ''}Does this photo show the quest was completed?`,
        },
      ],
    }],
  });

  const price = PRICING[model] || PRICING['claude-haiku-5-5'];
  const usage = response.usage || {};
  const inputTokens = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  const outputTokens = usage.output_tokens || 0;
  const cost = (inputTokens * price.input + outputTokens * price.output) / 1e6;

  if (response.stop_reason === 'refusal' || !response.parsed_output) {
    return { decision: 'review', reason: 'AI could not judge this photo.', inputTokens, outputTokens, cost };
  }
  return { ...response.parsed_output, inputTokens, outputTokens, cost };
}

/**
 * Reviews one submission by its verification token. Safe to call more than
 * once: a token is only ever reviewed (and billed) once.
 */
async function reviewSubmission(verificationToken) {
  if (!SERVICE_KEY || !verificationToken) return { skipped: 'not configured' };

  // Trust only the database, never the request body
  const uqs = await sb(
    `user_quests?verification_token=eq.${encodeURIComponent(verificationToken)}` +
    `&select=id,user_id,quest_id,status,photo_url,completed_at,verified`
  );
  const uq = uqs && uqs[0];
  if (!uq || uq.status !== 'pending_photo' || !uq.photo_url) return { skipped: 'not pending' };
  if (!uq.photo_url.startsWith(PHOTO_PREFIX)) return { skipped: 'unexpected photo location' };

  const existing = await sb(`photo_ai_reviews?verification_token=eq.${encodeURIComponent(verificationToken)}&select=id`);
  if (existing.length) return { skipped: 'already reviewed' };

  // Photo bytes, for the duplicate check and for the AI
  const imgRes = await fetch(uq.photo_url);
  if (!imgRes.ok) throw new Error(`photo fetch ${imgRes.status}`);
  const bytes = Buffer.from(await imgRes.arrayBuffer());
  const imageHash = crypto.createHash('sha256').update(bytes).digest('hex');
  const ct = (imgRes.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  const mediaType = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(ct) ? ct : 'image/jpeg';

  // Free checks
  const flags = [];
  const sameImage = await sb(
    `photo_ai_reviews?image_hash=eq.${imageHash}&verification_token=neq.${encodeURIComponent(verificationToken)}&select=user_id,quest_id&limit=5`
  );
  if (sameImage.some(r => r.user_id !== uq.user_id || r.quest_id !== uq.quest_id)) flags.push('reused_photo');
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  const recent = await sb(
    `photo_ai_reviews?user_id=eq.${uq.user_id}&created_at=gte.${encodeURIComponent(hourAgo)}&select=id`
  );
  if (recent.length + 1 > HIGH_VOLUME_PER_HOUR) flags.push('high_volume');

  const settings = await getSettings();
  const model = MODELS.includes(settings.model) ? settings.model : 'claude-haiku-5-5';
  const row = {
    verification_token: verificationToken,
    user_quest_id: uq.id,
    user_id: uq.user_id,
    quest_id: uq.quest_id,
    photo_url: uq.photo_url,
    image_hash: imageHash,
    prior_completed_at: uq.completed_at,
    mode: settings.mode,
    model: null,
    flags,
    ai_called: false,
    decision: 'not_reviewed',
    reason: null,
  };

  let canCallAi = settings.mode === 'trial' || settings.mode === 'auto';
  if (canCallAi && !process.env.ANTHROPIC_API_KEY) {
    canCallAi = false;
    row.reason = 'AI is on but no Anthropic API key is set.';
  }
  if (canCallAi) {
    const usage = await getMonthUsage();
    if (usage.photos >= Number(settings.monthly_photo_cap) || usage.cost >= Number(settings.monthly_dollar_cap)) {
      canCallAi = false;
      row.decision = 'cap_reached';
      row.reason = 'Monthly AI cap reached; review by hand.';
    }
  }

  if (canCallAi) {
    const quests = await sb(`quests?id=eq.${encodeURIComponent(uq.quest_id)}&select=name,description`);
    const quest = (quests && quests[0]) || {};
    try {
      const result = await classify({
        imageBase64: bytes.toString('base64'),
        mediaType,
        questName: quest.name || uq.quest_id,
        questDescription: quest.description,
        model,
      });
      Object.assign(row, {
        ai_called: true,
        model,
        decision: result.decision,
        reason: result.reason,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        cost_usd: result.cost,
      });
    } catch (err) {
      console.error('AI review failed:', err && err.message);
      row.decision = 'error';
      row.reason = 'AI review failed; review by hand.';
    }
  }

  const inserted = await sb('photo_ai_reviews', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  const reviewId = inserted && inserted[0] && inserted[0].id;

  // Auto-approve only clean approvals in auto mode
  if (settings.mode === 'auto' && row.decision === 'approve' && flags.length === 0) {
    const res = await fetch(
      `${BASE_URL}/.netlify/functions/photo-verify?action=approve&token=${encodeURIComponent(verificationToken)}`
    );
    if (res.ok && reviewId) {
      await sb(`photo_ai_reviews?id=eq.${reviewId}`, {
        method: 'PATCH',
        body: JSON.stringify({ auto_approved: true }),
      });
    }
    return { decision: row.decision, autoApproved: res.ok };
  }
  return { decision: row.decision, flags };
}

module.exports = { reviewSubmission, getSettings, getMonthUsage, monthStartIso, sb, MODELS, PRICING };
