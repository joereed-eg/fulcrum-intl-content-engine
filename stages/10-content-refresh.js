import { google } from 'googleapis';
import { getAuthClient, getSheetsClient } from '../utils/sheets-client.js';
import refreshWriter from './10b-refresh-writer.js';
import config, { SITE_URL, RESOURCES_URL } from '../utils/config.js';
import logger from '../utils/logger.js';
import { sendSlackAlert } from '../utils/slack.js';
import getSanityClient from '../utils/sanity-client.js';

const STAGE = 'content-refresh';
const DASHBOARD_URL = 'https://joe-dashboard-joe-reeds-projects.vercel.app';
const SC_SITE_URL = SITE_URL + '/';
const URL_PREFIX = RESOURCES_URL + '/';
const MAX_AUTO_REFRESH = 2; // Cap auto-refreshes per run to control API spend
const MIN_AGE_DAYS = 30; // Don't refresh articles published less than 30 days ago
const COOLDOWN_DAYS = 30; // Don't re-refresh an article within 30 days

function dateStr(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

export default async function contentRefresh() {
  logger.info(STAGE, 'Checking for articles that need refreshing...');

  let authClient;
  try {
    authClient = await getAuthClient(['https://www.googleapis.com/auth/webmasters.readonly']);
  } catch (err) {
    logger.warn(STAGE, `Cannot connect to Search Console: ${err.message}`);
    return { refreshQueue: [] };
  }

  const searchconsole = google.searchconsole({ version: 'v1', auth: authClient });

  // Get this week vs 4 weeks ago for comparison
  let thisWeek, lastMonth;
  try {
    const res1 = await searchconsole.searchanalytics.query({
      siteUrl: SC_SITE_URL,
      requestBody: {
        startDate: dateStr(10), endDate: dateStr(3),
        dimensions: ['page'],
        dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'includingRegex', expression: URL_PREFIX.replace(/[/.]/g, '\\$&') }] }],
        rowLimit: 500,
      },
    });
    thisWeek = res1.data.rows || [];

    const res2 = await searchconsole.searchanalytics.query({
      siteUrl: SC_SITE_URL,
      requestBody: {
        startDate: dateStr(38), endDate: dateStr(31),
        dimensions: ['page'],
        dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'includingRegex', expression: URL_PREFIX.replace(/[/.]/g, '\\$&') }] }],
        rowLimit: 500,
      },
    });
    lastMonth = res2.data.rows || [];
  } catch (err) {
    logger.warn(STAGE, `Search Console query failed: ${err.message}`);
    return { refreshQueue: [] };
  }

  const lastMonthMap = {};
  for (const row of lastMonth) {
    lastMonthMap[row.keys[0]] = row;
  }

  const refreshQueue = [];

  for (const row of thisWeek) {
    const page = row.keys[0];
    const prev = lastMonthMap[page];

    if (!prev) continue;

    const positionDrop = row.position - prev.position;
    const clicksDrop = prev.clicks > 0 ? ((prev.clicks - row.clicks) / prev.clicks) * 100 : 0;
    const impressionsDrop = prev.impressions > 0 ? ((prev.impressions - row.impressions) / prev.impressions) * 100 : 0;

    // Flag for refresh if:
    // - Position dropped 3+ spots
    // - Clicks dropped 30%+
    // - Impressions dropped 40%+
    if (positionDrop > 3 || clicksDrop > 30 || impressionsDrop > 40) {
      refreshQueue.push({
        url: page,
        slug: page.replace(URL_PREFIX, ''),
        currentPosition: row.position.toFixed(1),
        previousPosition: prev.position.toFixed(1),
        positionDrop: positionDrop.toFixed(1),
        clicksDrop: clicksDrop.toFixed(0) + '%',
        impressionsDrop: impressionsDrop.toFixed(0) + '%',
        reason: positionDrop > 3 ? 'position-drop' : clicksDrop > 30 ? 'clicks-drop' : 'impressions-drop',
      });
    }
  }

  if (refreshQueue.length > 0) {
    const list = refreshQueue.map(r =>
      `• ${r.slug}\n  Position: ${r.previousPosition} → ${r.currentPosition} (${r.positionDrop > 0 ? '+' : ''}${r.positionDrop})\n  Clicks: ${r.clicksDrop} drop | Impressions: ${r.impressionsDrop} drop`
    ).join('\n');

    await sendSlackAlert(
      `📉 Content refresh needed — ${refreshQueue.length} article(s) declining:\n\n${list}\n\nThese articles are losing position/traffic and should be updated with fresh stats, new sections, or better keyword targeting.\n\n<${DASHBOARD_URL}/?view=dashboard|View SEO Dashboard>`
    );

    // Also write to Google Sheet "Refresh Queue" tab
    try {
      const sheets = await getSheetsClient();
      const spreadsheetId = config.google.sheetsSpreadsheetId;

      try {
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: "'Refresh Queue'!A1:G1",
          valueInputOption: 'RAW',
          requestBody: { values: [['URL', 'Slug', 'Current Position', 'Previous Position', 'Reason', 'Flagged Date', 'Status']] },
        });
      } catch {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: [{ addSheet: { properties: { title: 'Refresh Queue' } } }] },
        });
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: "'Refresh Queue'!A1:G1",
          valueInputOption: 'RAW',
          requestBody: { values: [['URL', 'Slug', 'Current Position', 'Previous Position', 'Reason', 'Flagged Date', 'Status']] },
        });
      }

      const rows = refreshQueue.map(r => [r.url, r.slug, r.currentPosition, r.previousPosition, r.reason, new Date().toISOString().split('T')[0]]);
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: "'Refresh Queue'!A:F",
        valueInputOption: 'RAW',
        requestBody: { values: rows },
      });
      logger.info(STAGE, `Added ${rows.length} articles to Refresh Queue sheet`);
    } catch (err) {
      logger.warn(STAGE, `Failed to write refresh queue to sheet: ${err.message}`);
    }
  }

  // Auto-refresh the worst-performing articles (capped to control spend)
  const refreshResults = [];

  // Filter out articles that are too new or were recently refreshed
  const sanityClient = getSanityClient();
  const slugs = refreshQueue.map(r => r.slug);
  let publishDates = {};
  try {
    const docs = await sanityClient.fetch(
      `*[_type == "resource" && slug.current in $slugs]{ "slug": slug.current, publishedAt, _updatedAt }`,
      { slugs }
    );
    for (const doc of docs) {
      publishDates[doc.slug] = { publishedAt: doc.publishedAt, updatedAt: doc._updatedAt };
    }
  } catch (err) {
    logger.warn(STAGE, `Failed to fetch publish dates: ${err.message}`);
  }

  // Check refresh queue sheet for recent refreshes (cooldown)
  let recentRefreshes = new Set();
  try {
    const sheets = await getSheetsClient();
    const spreadsheetId = config.google.sheetsSpreadsheetId;
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "'Refresh Queue'!A:G",
    });
    const rows = existing.data.values || [];
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - COOLDOWN_DAYS);
    for (const row of rows) {
      if (row[6] && row[6].startsWith('Refreshed ')) {
        const refreshDate = new Date(row[6].replace('Refreshed ', ''));
        if (refreshDate > cutoff) {
          recentRefreshes.add(row[1]); // slug column
        }
      }
    }
  } catch (err) {
    logger.warn(STAGE, `Failed to check refresh cooldowns: ${err.message}`);
  }

  const now = Date.now();
  const eligible = refreshQueue.filter(item => {
    // Skip if recently refreshed (cooldown)
    if (recentRefreshes.has(item.slug)) {
      logger.info(STAGE, `Skipping ${item.slug} — refreshed within last ${COOLDOWN_DAYS} days`);
      return false;
    }
    // Skip if published less than MIN_AGE_DAYS ago
    const pubDate = publishDates[item.slug]?.publishedAt;
    if (pubDate && (now - new Date(pubDate).getTime()) < MIN_AGE_DAYS * 86400000) {
      logger.info(STAGE, `Skipping ${item.slug} — published less than ${MIN_AGE_DAYS} days ago`);
      return false;
    }
    return true;
  });

  const toRefresh = eligible
    .sort((a, b) => parseFloat(b.positionDrop) - parseFloat(a.positionDrop))
    .slice(0, MAX_AUTO_REFRESH);

  logger.info(STAGE, `${refreshQueue.length} flagged, ${eligible.length} eligible, ${toRefresh.length} will auto-refresh`);

  for (const item of toRefresh) {
    try {
      logger.info(STAGE, `Auto-refreshing: ${item.slug} (${item.reason})`);
      const result = await refreshWriter(item);
      if (result) {
        refreshResults.push(result);
        logger.info(STAGE, `Refreshed: ${result.url}`);

        // Update sheet row status
        try {
          const sheets = await getSheetsClient();
          const spreadsheetId = config.google.sheetsSpreadsheetId;
          // Find and update the row in Refresh Queue
          const existing = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: "'Refresh Queue'!A:G",
          });
          const rows = existing.data.values || [];
          for (let i = 0; i < rows.length; i++) {
            if (rows[i][1] === item.slug) {
              await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `'Refresh Queue'!G${i + 1}`,
                valueInputOption: 'RAW',
                requestBody: { values: [['Refreshed ' + new Date().toISOString().split('T')[0]]] },
              });
              break;
            }
          }
        } catch (err) {
          logger.warn(STAGE, `Failed to update refresh status in sheet: ${err.message}`);
        }
      }
    } catch (err) {
      logger.error(STAGE, `Failed to refresh ${item.slug}: ${err.message}`);
    }
  }

  logger.info(STAGE, `Content refresh complete. ${refreshQueue.length} flagged, ${refreshResults.length} auto-refreshed.`);
  return { refreshQueue, refreshResults };
}

if (process.argv[1] && process.argv[1].endsWith('10-content-refresh.js')) {
  contentRefresh()
    .then(r => console.log(`${r.refreshQueue.length} articles need refresh`))
    .catch(err => { console.error(err); process.exit(1); });
}
