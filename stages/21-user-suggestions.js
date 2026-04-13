import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import { getAuthClient } from '../utils/sheets-client.js';
import getSanityClient from '../utils/sanity-client.js';
import { sendSlackAlert } from '../utils/slack.js';
import { SITE_URL, RESOURCES_URL } from '../utils/config.js';
import logger from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STAGE = 'user-suggestions';
const DASHBOARD_URL = 'https://joe-dashboard-joe-reeds-projects.vercel.app';
const SC_SITE_URL = process.env.GSC_SITE_URL || 'sc-domain:' + new URL(SITE_URL).hostname.replace(/^www\./, '');

const SUGGESTIONS_FILE = join(__dirname, '..', 'runs', 'user-suggestions.json');

// Minimum impressions for a query to be considered a signal
const MIN_IMPRESSIONS = 10;
// How many top suggestions to output
const TOP_N = 10;

function dateStr(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

async function getQueryAnalytics(searchconsole, siteUrl, startDate, endDate) {
  const res = await searchconsole.searchanalytics.query({
    siteUrl,
    requestBody: {
      startDate,
      endDate,
      dimensions: ['query', 'page'],
      rowLimit: 1000,
    },
  });
  return res.data.rows || [];
}

async function getQueryOnlyAnalytics(searchconsole, siteUrl, startDate, endDate) {
  const res = await searchconsole.searchanalytics.query({
    siteUrl,
    requestBody: {
      startDate,
      endDate,
      dimensions: ['query'],
      rowLimit: 1000,
    },
  });
  return res.data.rows || [];
}

export default async function userSuggestions() {
  logger.info(STAGE, 'Collecting user behavior signals for content planning...');

  const sanityClient = getSanityClient();

  // 1. Query Sanity for user-submitted suggestions/searches (future schema)
  let sanitySuggestions = [];
  try {
    sanitySuggestions = await sanityClient.fetch(
      `*[_type in ["suggestion", "searchQuery"] && !(_id in path("drafts.**"))]{
        query,
        source,
        count,
        _createdAt
      } | order(_createdAt desc)[0...50]`
    );
  } catch {
    // Schema may not exist yet — that's expected
    logger.info(STAGE, 'No suggestion/search documents in Sanity (schema not yet created)');
  }

  // Get all published articles from Sanity for gap detection
  const articles = await sanityClient.fetch(
    `*[_type == "resource" && defined(slug.current)]{
      title,
      "slug": slug.current,
      primaryKeyword,
      tags
    }`
  );

  // Build a set of existing keywords/slugs for matching
  const existingKeywords = new Set();
  const existingSlugs = new Set();
  for (const article of articles) {
    existingSlugs.add(article.slug);
    if (article.primaryKeyword) {
      existingKeywords.add(article.primaryKeyword.toLowerCase());
    }
    // Also add slug words as keyword fragments
    article.slug.split('-').forEach(w => {
      if (w.length > 3) existingKeywords.add(w);
    });
    // Add title words
    article.title.toLowerCase().split(/\s+/).forEach(w => {
      if (w.length > 4) existingKeywords.add(w);
    });
  }

  // 2. Query GSC for all queries where FSD appears
  const authClient = await getAuthClient(['https://www.googleapis.com/auth/webmasters.readonly']);
  const searchconsole = google.searchconsole({ version: 'v1', auth: authClient });

  // Get query+page data for the last 4 weeks
  const queryPageData = await getQueryAnalytics(searchconsole, SC_SITE_URL, dateStr(31), dateStr(3));

  // Get query-only data for impression counts
  const queryOnlyData = await getQueryOnlyAnalytics(searchconsole, SC_SITE_URL, dateStr(31), dateStr(3));

  // Build a map of queries to their landing pages
  const queryPages = {};
  for (const row of queryPageData) {
    const query = row.keys[0];
    const page = row.keys[1];
    if (!queryPages[query]) queryPages[query] = [];
    queryPages[query].push(page);
  }

  // Build query impressions lookup
  const queryImpressions = {};
  for (const row of queryOnlyData) {
    const query = row.keys[0];
    queryImpressions[query] = {
      impressions: row.impressions,
      clicks: row.clicks,
      ctr: row.ctr,
      position: row.position,
    };
  }

  // 3. Find content gaps: queries with impressions but no matching article URL
  const contentGaps = [];

  for (const [query, metrics] of Object.entries(queryImpressions)) {
    if (metrics.impressions < MIN_IMPRESSIONS) continue;

    const landingPages = queryPages[query] || [];
    const hasArticleMatch = landingPages.some(page =>
      page.startsWith(RESOURCES_URL + '/')
    );

    if (hasArticleMatch) continue;

    // Check if any existing article already targets this keyword closely
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const matchScore = queryWords.filter(w => existingKeywords.has(w)).length;
    const overlapRatio = queryWords.length > 0 ? matchScore / queryWords.length : 0;

    // If less than 60% word overlap with existing content, it's a true gap
    if (overlapRatio < 0.6) {
      contentGaps.push({
        query,
        impressions: metrics.impressions,
        clicks: metrics.clicks,
        ctr: metrics.ctr,
        position: metrics.position,
        overlapRatio,
      });
    }
  }

  // 4. Score each suggestion: impressions + recency + uniqueness
  const scoredSuggestions = [];

  // Score GSC content gaps
  for (const gap of contentGaps) {
    const impressionScore = Math.min(gap.impressions / 100, 10); // cap at 10
    const uniquenessScore = (1 - gap.overlapRatio) * 5;          // 0-5
    const positionScore = gap.position < 20 ? 3 : gap.position < 50 ? 1 : 0; // already ranking = opportunity

    scoredSuggestions.push({
      query: gap.query,
      source: 'gsc-gap',
      score: impressionScore + uniquenessScore + positionScore,
      impressions: gap.impressions,
      clicks: gap.clicks,
      avgPosition: gap.position,
      overlapWithExisting: gap.overlapRatio,
    });
  }

  // Score Sanity user suggestions
  for (const suggestion of sanitySuggestions) {
    if (!suggestion.query) continue;
    const recencyDays = (Date.now() - new Date(suggestion._createdAt)) / (1000 * 60 * 60 * 24);
    const recencyScore = recencyDays < 7 ? 5 : recencyDays < 14 ? 3 : 1;
    const countScore = Math.min((suggestion.count || 1) / 5, 5);

    scoredSuggestions.push({
      query: suggestion.query,
      source: suggestion.source || 'user-search',
      score: recencyScore + countScore + 2, // +2 bonus for direct user signal
      impressions: null,
      clicks: null,
      avgPosition: null,
      overlapWithExisting: null,
    });
  }

  // Sort by score descending
  scoredSuggestions.sort((a, b) => b.score - a.score);

  // 5. Take top N
  const topSuggestions = scoredSuggestions.slice(0, TOP_N);

  // Write to file
  const output = {
    generatedAt: new Date().toISOString(),
    totalGapsFound: contentGaps.length,
    totalSanitySuggestions: sanitySuggestions.length,
    suggestions: topSuggestions,
  };
  writeFileSync(SUGGESTIONS_FILE, JSON.stringify(output, null, 2));
  logger.info(STAGE, `${topSuggestions.length} top suggestions saved to ${SUGGESTIONS_FILE}`);

  // 7. Slack summary
  const gscCount = topSuggestions.filter(s => s.source === 'gsc-gap').length;
  const userCount = topSuggestions.filter(s => s.source !== 'gsc-gap').length;

  let slackMsg = `User Signals: ${topSuggestions.length} topic suggestions (${gscCount} from search data, ${userCount} from user behavior)\n`;

  if (topSuggestions.length > 0) {
    slackMsg += '\n*Top Suggestions:*\n';
    slackMsg += topSuggestions.slice(0, 7).map((s, i) =>
      `${i + 1}. "${s.query}" (score: ${s.score.toFixed(1)}${s.impressions ? `, ${s.impressions} impr` : ''}, via ${s.source})`
    ).join('\n');
    slackMsg += '\n\n_These suggestions will be factored into the next calendar generation run._';
  }

  slackMsg += `\n\n<${DASHBOARD_URL}/?view=dashboard|View SEO Dashboard>`;

  await sendSlackAlert(slackMsg);

  logger.info(STAGE, `User suggestions collection complete. ${contentGaps.length} GSC gaps, ${sanitySuggestions.length} user suggestions.`);
  return { suggestions: topSuggestions.length, gscGaps: contentGaps.length, userSuggestions: sanitySuggestions.length };
}

// Standalone
if (process.argv[1] && process.argv[1].endsWith('21-user-suggestions.js')) {
  userSuggestions()
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch(err => { console.error(err); process.exit(1); });
}
