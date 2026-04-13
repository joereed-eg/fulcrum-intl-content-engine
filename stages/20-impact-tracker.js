import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import { getAuthClient } from '../utils/sheets-client.js';
import getSanityClient from '../utils/sanity-client.js';
import { sendSlackAlert } from '../utils/slack.js';
import { SITE_URL, RESOURCES_URL } from '../utils/config.js';
import logger from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STAGE = 'impact-tracker';
const DASHBOARD_URL = 'https://joe-dashboard-joe-reeds-projects.vercel.app';
const SC_SITE_URL = process.env.GSC_SITE_URL || 'sc-domain:' + new URL(SITE_URL).hostname.replace(/^www\./, '');
const URL_PREFIX = RESOURCES_URL + '/';

const HISTORY_FILE = join(__dirname, '..', 'runs', 'impact-history.json');
const LATEST_FILE = join(__dirname, '..', 'runs', 'latest-impact.json');
const HIGH_POTENTIAL_FILE = join(__dirname, '..', 'runs', 'high-potential-clusters.json');

// Thresholds
const CLIMBING_THRESHOLD = 3;   // position improved by 3+
const DECLINING_THRESHOLD = 3;  // position dropped by 3+
const INVISIBLE_MIN_AGE_DAYS = 30;

function dateStr(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

function loadHistory() {
  if (existsSync(HISTORY_FILE)) {
    try {
      return JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
    } catch { /* corrupted — start fresh */ }
  }
  return { runs: [] };
}

function saveHistory(history) {
  writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

async function getSearchAnalytics(searchconsole, siteUrl, startDate, endDate) {
  const res = await searchconsole.searchanalytics.query({
    siteUrl,
    requestBody: {
      startDate,
      endDate,
      dimensions: ['page'],
      dimensionFilterGroups: [{
        filters: [{
          dimension: 'page',
          operator: 'includingRegex',
          expression: URL_PREFIX.replace(/[/.]/g, '\\$&'),
        }],
      }],
      rowLimit: 500,
    },
  });
  return res.data.rows || [];
}

export default async function impactTracker() {
  logger.info(STAGE, 'Running weekly content impact tracker...');

  // 1. Get published articles from Sanity
  const sanityClient = getSanityClient();
  const articles = await sanityClient.fetch(
    `*[_type == "resource" && defined(slug.current)]{
      title,
      "slug": slug.current,
      cluster,
      tags,
      _createdAt
    }`
  );

  if (articles.length === 0) {
    logger.info(STAGE, 'No published articles found in Sanity');
    return { tracked: 0, climbing: 0, stable: 0, declining: 0, invisible: 0 };
  }

  logger.info(STAGE, `Found ${articles.length} published articles in Sanity`);

  // Build slug-to-article lookup
  const articleMap = {};
  for (const article of articles) {
    const url = `${RESOURCES_URL}/${article.slug}`;
    articleMap[url] = article;
  }

  // 2. Query GSC for the last 4 weeks (offset 3 days for data lag)
  const authClient = await getAuthClient(['https://www.googleapis.com/auth/webmasters.readonly']);
  const searchconsole = google.searchconsole({ version: 'v1', auth: authClient });

  const currentData = await getSearchAnalytics(searchconsole, SC_SITE_URL, dateStr(31), dateStr(3));

  // Build current metrics lookup by page URL
  const currentMetrics = {};
  for (const row of currentData) {
    const page = row.keys[0];
    currentMetrics[page] = {
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    };
  }

  // 3. Compare to previous run
  const history = loadHistory();
  const previousRun = history.runs.length > 0 ? history.runs[history.runs.length - 1] : null;
  const previousMetrics = previousRun?.metrics || {};

  // 4. Classify each article
  const now = new Date();
  const results = [];
  const climbingClusters = {};

  for (const article of articles) {
    const url = `${RESOURCES_URL}/${article.slug}`;
    const current = currentMetrics[url] || null;
    const previous = previousMetrics[url] || null;
    const articleAge = (now - new Date(article._createdAt)) / (1000 * 60 * 60 * 24);

    let status;
    let positionDelta = null;

    if (!current || current.impressions === 0) {
      // No impressions at all
      if (articleAge > INVISIBLE_MIN_AGE_DAYS) {
        status = 'invisible';
      } else {
        status = 'new'; // too early to judge
      }
    } else if (previous) {
      positionDelta = previous.position - current.position; // positive = improved
      if (positionDelta >= CLIMBING_THRESHOLD) {
        status = 'climbing';
      } else if (positionDelta <= -DECLINING_THRESHOLD) {
        status = 'declining';
      } else {
        status = 'stable';
      }
    } else {
      // First time seeing this article — baseline
      status = 'baseline';
    }

    const entry = {
      title: article.title,
      slug: article.slug,
      url,
      cluster: article.cluster || 'uncategorized',
      status,
      positionDelta,
      current: current || { clicks: 0, impressions: 0, ctr: 0, position: null },
      articleAgeDays: Math.round(articleAge),
    };

    results.push(entry);

    // 6. Track climbing clusters
    if (status === 'climbing' && article.cluster) {
      if (!climbingClusters[article.cluster]) {
        climbingClusters[article.cluster] = { cluster: article.cluster, articles: [], avgPositionDelta: 0 };
      }
      climbingClusters[article.cluster].articles.push({
        title: article.title,
        slug: article.slug,
        positionDelta,
      });
    }
  }

  // Compute avg position delta for climbing clusters
  for (const cluster of Object.values(climbingClusters)) {
    const deltas = cluster.articles.map(a => a.positionDelta).filter(Boolean);
    cluster.avgPositionDelta = deltas.length > 0
      ? deltas.reduce((sum, d) => sum + d, 0) / deltas.length
      : 0;
  }

  // Counts
  const counts = {
    climbing: results.filter(r => r.status === 'climbing').length,
    stable: results.filter(r => r.status === 'stable').length,
    declining: results.filter(r => r.status === 'declining').length,
    invisible: results.filter(r => r.status === 'invisible').length,
    baseline: results.filter(r => r.status === 'baseline').length,
    new: results.filter(r => r.status === 'new').length,
  };

  // 5. Flag invisible articles older than 30 days for refresh
  const refreshCandidates = results
    .filter(r => r.status === 'invisible')
    .map(r => ({ title: r.title, slug: r.slug, ageDays: r.articleAgeDays }));

  // Save history (keep last 12 runs = ~3 months)
  history.runs.push({
    date: new Date().toISOString(),
    metrics: currentMetrics,
  });
  if (history.runs.length > 12) {
    history.runs = history.runs.slice(-12);
  }
  saveHistory(history);
  logger.info(STAGE, `Impact history updated (${history.runs.length} runs stored)`);

  // Save high-potential clusters
  const highPotentialData = {
    generatedAt: new Date().toISOString(),
    clusters: Object.values(climbingClusters).sort((a, b) => b.avgPositionDelta - a.avgPositionDelta),
  };
  writeFileSync(HIGH_POTENTIAL_FILE, JSON.stringify(highPotentialData, null, 2));
  logger.info(STAGE, `${highPotentialData.clusters.length} high-potential clusters saved`);

  // 8. Save full report for calendar generator
  const report = {
    generatedAt: new Date().toISOString(),
    counts,
    articles: results,
    refreshCandidates,
    highPotentialClusters: highPotentialData.clusters,
  };
  writeFileSync(LATEST_FILE, JSON.stringify(report, null, 2));
  logger.info(STAGE, `Full impact report saved to ${LATEST_FILE}`);

  // 7. Slack summary
  const climbingList = results
    .filter(r => r.status === 'climbing')
    .slice(0, 5)
    .map(r => `  +${r.positionDelta.toFixed(1)} pos — "${r.title}"`)
    .join('\n');

  const decliningList = results
    .filter(r => r.status === 'declining')
    .slice(0, 5)
    .map(r => `  ${r.positionDelta.toFixed(1)} pos — "${r.title}"`)
    .join('\n');

  const invisibleList = refreshCandidates
    .slice(0, 3)
    .map(r => `  "${r.title}" (${r.ageDays}d old)`)
    .join('\n');

  let slackMsg = `Content Impact Report:\n` +
    `${counts.climbing} climbing | ${counts.stable} stable | ${counts.declining} declining | ${counts.invisible} invisible\n`;

  if (climbingList) slackMsg += `\n*Climbing:*\n${climbingList}`;
  if (decliningList) slackMsg += `\n\n*Declining:*\n${decliningList}`;
  if (invisibleList) slackMsg += `\n\n*Needs Refresh (invisible 30+ days):*\n${invisibleList}`;
  if (highPotentialData.clusters.length > 0) {
    slackMsg += `\n\n*High-Potential Clusters:* ${highPotentialData.clusters.map(c => c.cluster).join(', ')}`;
  }

  slackMsg += `\n\n<${DASHBOARD_URL}/?view=dashboard|View SEO Dashboard>`;

  await sendSlackAlert(slackMsg);

  logger.info(STAGE, `Impact tracking complete. ${results.length} articles analyzed.`);
  return { tracked: results.length, ...counts };
}

// Standalone
if (process.argv[1] && process.argv[1].endsWith('20-impact-tracker.js')) {
  impactTracker()
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch(err => { console.error(err); process.exit(1); });
}
