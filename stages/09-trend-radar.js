import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from '../utils/config.js';
import logger from '../utils/logger.js';
import { sendSlackAlert } from '../utils/slack.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRENDS_FILE = join(__dirname, '..', 'runs', 'latest-trends.json');

const STAGE = 'trend-radar';

const ICP_SEGMENTS = [
  'behavioral health agency network managers',
  'therapy practice owners managing provider directories',
  'coaching agency founders building referral networks',
  'nonprofit organizations managing provider networks',
];

const RESEARCH_QUERIES = [
  {
    name: 'trending-questions',
    template: (icp) =>
      `What are the most common questions ${icp} are asking right now in 2026? What are they searching for on Google? Include specific search queries and phrases they use. Focus on provider directories, referral networks, and network management.`,
  },
  {
    name: 'pain-points',
    template: (icp) =>
      `What are the biggest emerging pain points for ${icp} in 2026? What new challenges have appeared in the last 3-6 months? Include industry trends, regulatory changes, and technology shifts affecting them.`,
  },
  {
    name: 'competitor-content',
    template: () =>
      `What are the top-performing blog posts and articles about "provider directory software", "therapist directory platform", "provider network management", and "white-label directory" published in the last 3 months? What topics are getting the most engagement? What gaps exist?`,
  },
];

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
      max_tokens: 2000,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Perplexity ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

export default async function trendRadar() {
  logger.info(STAGE, 'Running ICP trend radar...');

  const findings = [];

  // Pick one ICP segment to deep-dive each week (rotate)
  const weekOfYear = Math.ceil((Date.now() - new Date(new Date().getFullYear(), 0, 1)) / 604800000);
  const icpIndex = weekOfYear % ICP_SEGMENTS.length;
  const focusIcp = ICP_SEGMENTS[icpIndex];

  logger.info(STAGE, `This week's ICP focus: ${focusIcp}`);

  for (const query of RESEARCH_QUERIES) {
    try {
      const prompt = query.template(focusIcp);
      const result = await queryPerplexity(prompt);
      findings.push({ name: query.name, result });
    } catch (err) {
      logger.warn(STAGE, `Query "${query.name}" failed: ${err.message}`);
      findings.push({ name: query.name, result: 'Query failed' });
    }
  }

  // LinkedIn scout — find recent posts to engage with
  let linkedinOpportunities = '';
  try {
    const linkedinResult = await queryPerplexity(
      `Find 5-10 recent LinkedIn posts (last 7 days) about provider directories, therapist referral networks, nonprofit technology platforms, behavioral health networks, or coaching agency management. For each post, provide: the author's name, their title/role, a one-sentence summary of the post, and the LinkedIn URL if available. Focus on posts with high engagement (likes, comments) where a thoughtful comment about provider network management or directory platforms would add value.`
    );
    findings.push({ name: 'linkedin-scout', result: linkedinResult });
    linkedinOpportunities = linkedinResult;
  } catch (err) {
    logger.warn(STAGE, `LinkedIn scout query failed: ${err.message}`);
  }

  // Build LinkedIn search links for manual scouting
  const linkedinSearches = [
    'provider directory challenges',
    'therapist referral network',
    'behavioral health technology',
    'nonprofit technology stack',
    'coaching platform management',
    'provider network management',
  ].map(q => `• <https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(q)}&datePosted=%22past-week%22&sortBy=%22date_posted%22|${q}>`);

  // Build Slack digest
  const digest = `*ICP Trend Radar — Week ${weekOfYear}*
Focus: ${focusIcp}

*Trending Questions:*
${findings.find(f => f.name === 'trending-questions')?.result?.slice(0, 800) || 'N/A'}

*Emerging Pain Points:*
${findings.find(f => f.name === 'pain-points')?.result?.slice(0, 800) || 'N/A'}

*Competitor Content Gaps:*
${findings.find(f => f.name === 'competitor-content')?.result?.slice(0, 800) || 'N/A'}

_Use these insights to add new rows to the content calendar or update existing article briefs._`;

  await sendSlackAlert(digest);

  // Send LinkedIn opportunities as a separate message
  const linkedinDigest = `*LinkedIn Comment Opportunities — Week ${weekOfYear}*

${linkedinOpportunities ? linkedinOpportunities.slice(0, 1500) : 'No specific posts found this week.'}

*Manual search links (click to find recent posts):*
${linkedinSearches.join('\n')}

_Comment with value first, share expertise, not links. Only drop a Fulcrum International link if it genuinely answers their question._`;

  await sendSlackAlert(linkedinDigest);

  // Save findings so daily pipeline can inject them into article writing
  const trendData = {
    week: weekOfYear,
    focusIcp,
    generatedAt: new Date().toISOString(),
    trendingQuestions: findings.find(f => f.name === 'trending-questions')?.result || '',
    painPoints: findings.find(f => f.name === 'pain-points')?.result || '',
    competitorGaps: findings.find(f => f.name === 'competitor-content')?.result || '',
  };
  writeFileSync(TRENDS_FILE, JSON.stringify(trendData, null, 2));
  logger.info(STAGE, `Trend data saved to ${TRENDS_FILE}`);

  // Also persist to Google Sheet (tab "Trend Radar") so daily pipeline can read it
  // GitHub Actions is stateless — file won't persist between runs
  try {
    const { getSheetsClient } = await import('../utils/sheets-client.js');
    const sheets = await getSheetsClient();
    const spreadsheetId = config.google.sheetsSpreadsheetId;

    // Write trend data to a "Trend Radar" tab (create if needed)
    try {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: "'Trend Radar'!A1:B5",
        valueInputOption: 'RAW',
        requestBody: {
          values: [
            ['generatedAt', trendData.generatedAt],
            ['focusIcp', trendData.focusIcp],
            ['trendingQuestions', trendData.trendingQuestions],
            ['painPoints', trendData.painPoints],
            ['competitorGaps', trendData.competitorGaps],
          ],
        },
      });
    } catch {
      // Tab might not exist — create it
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: 'Trend Radar' } } }],
        },
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: "'Trend Radar'!A1:B5",
        valueInputOption: 'RAW',
        requestBody: {
          values: [
            ['generatedAt', trendData.generatedAt],
            ['focusIcp', trendData.focusIcp],
            ['trendingQuestions', trendData.trendingQuestions],
            ['painPoints', trendData.painPoints],
            ['competitorGaps', trendData.competitorGaps],
          ],
        },
      });
    }
    logger.info(STAGE, 'Trend data also saved to Google Sheet (Trend Radar tab)');
  } catch (err) {
    logger.warn(STAGE, `Failed to save trends to sheet: ${err.message}`);
  }

  logger.info(STAGE, 'Trend radar complete. Findings sent to Slack + saved for daily pipeline.');
  return { focusIcp, findings };
}

// Standalone
if (process.argv[1] && process.argv[1].endsWith('09-trend-radar.js')) {
  trendRadar()
    .then(r => console.log('Done. Focus:', r.focusIcp))
    .catch(err => { console.error(err); process.exit(1); });
}
