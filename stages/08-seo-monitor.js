import { google } from 'googleapis';
import { getAuthClient } from '../utils/sheets-client.js';
import { sendSlackAlert } from '../utils/slack.js';
import { SITE_URL, RESOURCES_URL } from '../utils/config.js';
import logger from '../utils/logger.js';

const STAGE = 'seo-monitor';
const DASHBOARD_URL = 'https://joe-dashboard-joe-reeds-projects.vercel.app';
const SC_SITE_URL = SITE_URL + '/';
const URL_PREFIX = RESOURCES_URL + '/';

function dateStr(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
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

export default async function seoMonitor() {
  logger.info(STAGE, 'Running weekly SEO monitor...');

  const authClient = await getAuthClient(['https://www.googleapis.com/auth/webmasters.readonly']);
  const searchconsole = google.searchconsole({ version: 'v1', auth: authClient });

  // This week vs previous week — offset by 3 days for Search Console data lag
  const thisWeek = await getSearchAnalytics(searchconsole, SC_SITE_URL, dateStr(10), dateStr(3));
  const lastWeek = await getSearchAnalytics(searchconsole, SC_SITE_URL, dateStr(17), dateStr(10));

  // Build lookup for last week
  const lastWeekMap = {};
  for (const row of lastWeek) {
    const page = row.keys[0];
    lastWeekMap[page] = row;
  }

  const alerts = [];

  // Check each page
  for (const row of thisWeek) {
    const page = row.keys[0];
    const prev = lastWeekMap[page];

    if (prev) {
      // Position drop > 5
      const posDrop = row.position - prev.position;
      if (posDrop > 5) {
        alerts.push(`Position drop: ${page} dropped ${posDrop.toFixed(1)} positions (${prev.position.toFixed(1)} → ${row.position.toFixed(1)})`);
      }
    }

    // CTR below 1% after being indexed for 4+ weeks (rough check: has prev data)
    if (prev && row.ctr < 0.01 && row.impressions > 50) {
      alerts.push(`Low CTR: ${page} has ${(row.ctr * 100).toFixed(2)}% CTR with ${row.impressions} impressions — possible meta description issue`);
    }
  }

  // Site-wide impression drop > 20%
  const thisWeekImpressions = thisWeek.reduce((sum, r) => sum + r.impressions, 0);
  const lastWeekImpressions = lastWeek.reduce((sum, r) => sum + r.impressions, 0);

  if (lastWeekImpressions > 0) {
    const dropPct = ((lastWeekImpressions - thisWeekImpressions) / lastWeekImpressions) * 100;
    if (dropPct > 20) {
      alerts.push(`Site-wide impression drop: ${dropPct.toFixed(1)}% decrease (${lastWeekImpressions} → ${thisWeekImpressions})`);
    }
  }

  // Log results
  logger.info(STAGE, `Analyzed ${thisWeek.length} URLs. ${alerts.length} alerts.`);

  if (alerts.length > 0) {
    const message = `SEO Monitor Alert for fulcruminternational.org/resources:\n${alerts.map(a => `• ${a}`).join('\n')}\n\n<${DASHBOARD_URL}/?view=dashboard|View SEO Dashboard>`;
    await sendSlackAlert(message);
    logger.warn(STAGE, `Sent ${alerts.length} alerts to Slack`);
  } else {
    logger.info(STAGE, 'All clear — no SEO issues detected');
  }

  return { pagesAnalyzed: thisWeek.length, alerts };
}

// Standalone
if (process.argv[1] && process.argv[1].endsWith('08-seo-monitor.js')) {
  seoMonitor()
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch(err => { console.error(err); process.exit(1); });
}
