import config from './config.js';

// Huck bot token + Fulcrum International channel
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN || config.slack?.botToken;
const FULCRUM_INTL_CHANNEL = process.env.SLACK_CHANNEL_ID || '';
const LOG_CHANNEL = process.env.SLACK_LOG_CHANNEL_ID || '';

// Severity gate — research stages should pass severity:'digest' so they are
// silenced unless SLACK_NOTIFY_LEVEL allows them. Outreach drafts and errors
// pass 'action' or 'error' and land in the configured channel.
const RANK = { error: 3, action: 2, status: 1, digest: 0 };
function threshold() {
  const v = (process.env.SLACK_NOTIFY_LEVEL || 'action').toLowerCase();
  return RANK[v] ?? RANK.action;
}

async function postToSlack(channelId, text) {
  if (!BOT_TOKEN || !channelId) return false;
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channel: channelId, text }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error(`[SLACK] post failed to ${channelId}: ${data.error}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[SLACK] error: ${err.message}`);
    return false;
  }
}

/**
 * Send a Slack alert via Huck. Default severity is 'status' (gated). Pass
 * severity:'error' for failures, 'action' for things that need Joe's reply,
 * 'digest' for pure research output that should only land in the log channel.
 */
export async function sendSlackAlert(message, opts = {}) {
  const { mention = false, severity = 'status' } = opts;
  const userId = config.slack.alertUserId || 'U0A7J1JELE7';
  const text = mention ? `<@${userId}> ${message}` : message;

  const rank = RANK[severity] ?? RANK.status;
  const pass = rank >= threshold();

  if (pass) {
    if (await postToSlack(FULCRUM_INTL_CHANNEL, text)) return;
    // Webhook fallback only for above-threshold sends
    const webhookUrl = config.slack.webhookUrl;
    if (webhookUrl && !webhookUrl.startsWith('[')) {
      try {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
      } catch (err) {
        console.error(`[SLACK] Webhook failed: ${err.message}`);
      }
    }
    return;
  }

  // Below threshold — route to log channel or drop silently
  if (LOG_CHANNEL) {
    await postToSlack(LOG_CHANNEL, text);
  }
}

/**
 * Outreach drafts are research output (e.g. broken-link prospects, reciprocal
 * pitches). Default severity 'status' so they route to the log channel instead
 * of blowing up Joe's DM. Flip SLACK_NOTIFY_LEVEL=status to resume DM delivery.
 */
export async function sendOutreachDraft({ type, target, subject, body, notes }) {
  const message = [
    `${type} → ${target}`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    `*Subject:* ${subject}`,
    ``,
    body,
    ``,
    `---`,
    `Joe Reed, Founder, Fulcrum International\nfulcruminternational.org | joe@fulcrumcollective.io`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    notes ? `_${notes}_` : '',
    `Reply with ✅ to approve or ✏️ to edit`,
  ].filter(Boolean).join('\n');
  await sendSlackAlert(message, { severity: 'status' });
}
