import config from '../utils/config.js';
import logger from '../utils/logger.js';
import { sendSlackAlert } from '../utils/slack.js';

const STAGE = 'competitor-watch';

async function queryPerplexity(query) {
  const apiKey = config.perplexity.apiKey;
  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'sonar-pro',
      messages: [{ role: 'user', content: query }],
      max_tokens: 1500,
    }),
  });
  if (!res.ok) throw new Error(`Perplexity ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

export default async function competitorWatch() {
  const competitors = config.competitors || [];
  if (competitors.length === 0) {
    logger.info(STAGE, 'No competitors configured. Skipping.');
    return { competitors: 0, insights: [] };
  }

  logger.info(STAGE, `Monitoring ${competitors.length} competitors...`);

  const insights = [];

  // Query in batches of 3 to avoid rate limits
  for (let i = 0; i < competitors.length; i += 3) {
    const batch = competitors.slice(i, i + 3);
    const domainList = batch.join(', ');

    try {
      const result = await queryPerplexity(
        `What new blog posts, articles, or content pages have ${domainList} published in the last month ` +
        `about provider directories, therapist directories, agency networks, white-label platforms, ` +
        `practice management software, referral networks, or coaching platforms? ` +
        `For each piece of content found, list: the domain, article title, topic, and what angle they took. ` +
        `Also note any topics they cover that a competitor focused on "white-label provider directory platform for agencies" might not have covered yet.`
      );

      insights.push({ domains: batch, intel: result });
    } catch (err) {
      logger.warn(STAGE, `Competitor query failed for ${domainList}: ${err.message}`);
    }
  }

  if (insights.length > 0) {
    const digest = insights.map(i =>
      `*${i.domains.join(', ')}:*\n${i.intel.slice(0, 600)}`
    ).join('\n\n---\n\n');

    await sendSlackAlert(
      `🔍 Competitor Content Watch\n\n${digest}\n\n_Use these insights to identify content gaps and add new topics to the calendar._`
    );
  }

  logger.info(STAGE, `Competitor watch complete. ${insights.length} batch(es) analyzed.`);
  return { competitors: competitors.length, insights };
}

if (process.argv[1] && process.argv[1].endsWith('09c-competitor-watch.js')) {
  competitorWatch()
    .then(r => console.log(`Watched ${r.competitors} competitors`))
    .catch(err => { console.error(err); process.exit(1); });
}
