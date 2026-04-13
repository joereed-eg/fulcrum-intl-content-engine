import config from './config.js';

// Huck bot token + Fulcrum International channel
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN || config.slack?.botToken;
// Configure SLACK_CHANNEL_ID via GitHub Secrets (channel for #fulcrum-international)
const FULCRUM_INTL_CHANNEL = process.env.SLACK_CHANNEL_ID || '';

/**
 * Send a Slack alert via Huck bot to the Fulcrum International channel.
 * Falls back to webhook if bot API fails.
 */
export async function sendSlackAlert(message, { mention = false } = {}) {
  const userId = config.slack.alertUserId || 'U0A7J1JELE7';
  const text = mention ? `<@${userId}> ${message}` : message;

  // Post to Fulcrum International channel as Huck
  if (BOT_TOKEN && FULCRUM_INTL_CHANNEL) {
    try {
      const postRes = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${BOT_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          channel: FULCRUM_INTL_CHANNEL,
          text,
        }),
      });
      const postData = await postRes.json();
      if (postData.ok) return;
      console.error(`[SLACK] Bot API post failed: ${postData.error}`);
    } catch (err) {
      console.error(`[SLACK] Bot API error: ${err.message}`);
    }
  }

  // Fallback to webhook
  const webhookUrl = config.slack.webhookUrl;
  if (!webhookUrl || webhookUrl.startsWith('[')) {
    console.warn('[SLACK] No webhook URL configured, skipping alert');
    return;
  }

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    console.error(`[SLACK] Webhook failed: ${res.status}`);
  }
}

/**
 * Send a formatted outreach draft to Slack for Joe to review.
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
  await sendSlackAlert(message);
}
