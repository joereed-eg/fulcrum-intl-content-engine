import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from '../utils/config.js';
import logger from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRENDS_FILE = join(__dirname, '..', 'runs', 'latest-trends.json');
const STAGE = 'researcher';

async function loadLatestTrends() {
  // Try local file first (works when running locally)
  if (existsSync(TRENDS_FILE)) {
    try {
      const data = JSON.parse(readFileSync(TRENDS_FILE, 'utf-8'));
      const age = Date.now() - new Date(data.generatedAt).getTime();
      if (age < 10 * 24 * 60 * 60 * 1000) return data;
    } catch { /* fall through */ }
  }

  // Fall back to Google Sheet (works in GitHub Actions where files don't persist)
  try {
    const { getSheetsClient } = await import('../utils/sheets-client.js');
    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: config.google.sheetsSpreadsheetId,
      range: "'Trend Radar'!A1:B5",
    });
    const rows = res.data.values || [];
    if (rows.length < 5) return null;

    const data = {
      generatedAt: rows[0][1],
      focusIcp: rows[1][1],
      trendingQuestions: rows[2][1],
      painPoints: rows[3][1],
      competitorGaps: rows[4][1],
    };

    const age = Date.now() - new Date(data.generatedAt).getTime();
    if (age > 10 * 24 * 60 * 60 * 1000) return null;
    return data;
  } catch { return null; }
}

async function queryPerplexity(apiKey, query) {
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
    throw { stage: STAGE, error: `Perplexity API ${res.status}: ${text}` };
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

export default async function researcher(job, serpAnalysis = null) {
  logger.info(STAGE, `Researching: "${job.primaryKeyword}" for ${job.audience}`);

  const apiKey = config.perplexity.apiKey;
  const briefSummary = job.brief.slice(0, 200);

  // If SERP analysis provided, make research more targeted
  const competitorContext = serpAnalysis?.topCompetitors?.length
    ? `The top competitors are: ${serpAnalysis.topCompetitors.map(c => `${c.domain} (angle: ${c.angle})`).join('; ')}. Focus on how to beat these specific angles.`
    : '';

  const gapContext = serpAnalysis?.contentGap
    ? `The identified content gap is: ${serpAnalysis.contentGap}. Research data and examples that fill this gap specifically.`
    : '';

  const queries = [
    {
      name: 'competitorAngles',
      query: competitorContext
        ? `Analyze the top-ranking articles for "${job.primaryKeyword}". ${competitorContext} What specific arguments, frameworks, and data do they use? What weaknesses can we exploit?`
        : `What are the top-ranking articles for "${job.primaryKeyword}"? What angles, statistics, and arguments do they use? What are they missing?`,
    },
    {
      name: 'keyStats',
      query: `What are the most current statistics, studies, and real-world examples related to ${job.primaryKeyword} in the context of ${job.audience}? ${gapContext} Include sources with URLs.`,
    },
    {
      name: 'icpLanguage',
      query: `What are the biggest pain points and questions that ${job.audience} have about ${briefSummary}? What language do they use to describe these problems?`,
    },
    {
      name: 'backlinkTargets',
      query: `What websites and blogs frequently link to content about "${job.primaryKeyword}" or related topics like provider directories, agency networks, and referral platforms? List specific domains that accept guest posts, have resource pages, or regularly cite industry content. Focus on sites relevant to ${job.audience}.`,
    },
  ];

  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const results = [];
  for (const q of queries) {
    try {
      const result = await queryPerplexity(apiKey, q.query);
      results.push(result);
    } catch (err) {
      logger.warn(STAGE, `Query "${q.name}" failed: ${err.error || err.message}`);
      results.push(`Research query failed — proceed with available information.`);
    }
    if (queries.indexOf(q) < queries.length - 1) await delay(1500);
  }

  const suggestedSources = [];
  const urlRegex = /https?:\/\/[^\s)>\]]+/g;
  const urls = results[1].match(urlRegex) || [];
  urls.slice(0, 5).forEach(url => {
    suggestedSources.push({ title: 'Research source', url: url.replace(/[.,;]+$/, '') });
  });

  // Load latest trend radar data (from Sunday's run)
  const trends = await loadLatestTrends();
  let trendContext = '';
  if (trends) {
    logger.info(STAGE, `Injecting trend radar data (focus: ${trends.focusIcp})`);
    trendContext = `\n\nWEEKLY TREND INTELLIGENCE (from ICP research):\n` +
      `Trending questions: ${(trends.trendingQuestions || '').slice(0, 600)}\n` +
      `Emerging pain points: ${(trends.painPoints || '').slice(0, 600)}\n` +
      `Competitor gaps: ${(trends.competitorGaps || '').slice(0, 600)}`;
  }

  // Extract backlink targets from the 4th query
  const backlinkUrls = (results[3] || '').match(urlRegex) || [];
  const backlinkTargets = backlinkUrls.slice(0, 8).map(url => url.replace(/[.,;]+$/, ''));

  const researchNotes = {
    competitorAngles: results[0],
    keyStats: results[1],
    icpLanguage: results[2] + trendContext,
    backlinkTargets,
    suggestedSources,
  };

  logger.info(STAGE, `Research complete. ${suggestedSources.length} sources, ${backlinkTargets.length} backlink targets found.`);
  return researchNotes;
}

if (process.argv[1] && process.argv[1].endsWith('02-researcher.js')) {
  const testJob = {
    primaryKeyword: 'provider directory for agencies',
    audience: 'behavioral health agencies',
    brief: 'How agencies can build and monetize a provider directory',
  };
  researcher(testJob)
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch(err => { console.error(err); process.exit(1); });
}
