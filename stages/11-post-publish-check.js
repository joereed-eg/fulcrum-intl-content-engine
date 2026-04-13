import { google } from 'googleapis';
import { getAuthClient } from '../utils/sheets-client.js';
import getSanityClient from '../utils/sanity-client.js';
import googleIndexing from './06b-indexing.js';
import metaOptimizer from './11b-meta-optimizer.js';
import config, { SITE_URL, RESOURCES_URL } from '../utils/config.js';
import logger from '../utils/logger.js';
import { sendSlackAlert } from '../utils/slack.js';

const STAGE = 'post-publish-check';
const DASHBOARD_URL = 'https://joe-dashboard-joe-reeds-projects.vercel.app';
const MONITOR_DAYS = 30;

function daysSince(dateStr) {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

function dateStr(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

async function getSearchConsoleData(authClient, pageUrl) {
  const searchconsole = google.searchconsole({ version: 'v1', auth: authClient });

  try {
    const res = await searchconsole.searchanalytics.query({
      siteUrl: SITE_URL + '/',
      requestBody: {
        startDate: dateStr(10),
        endDate: dateStr(3),
        dimensions: ['query'],
        dimensionFilterGroups: [{
          filters: [{
            dimension: 'page',
            operator: 'equals',
            expression: pageUrl,
          }],
        }],
        rowLimit: 30,
      },
    });
    return res.data.rows || [];
  } catch {
    return [];
  }
}

async function checkIndexStatus(authClient, pageUrl) {
  const searchconsole = google.searchconsole({ version: 'v1', auth: authClient });

  try {
    const res = await searchconsole.urlInspection.index.inspect({
      requestBody: {
        inspectionUrl: pageUrl,
        siteUrl: SITE_URL + '/',
      },
    });
    const verdict = res.data.inspectionResult?.indexStatusResult?.verdict;
    const coverageState = res.data.inspectionResult?.indexStatusResult?.coverageState;
    return { indexed: verdict === 'PASS', verdict, coverageState };
  } catch (err) {
    logger.warn(STAGE, `Index inspection failed for ${pageUrl}: ${err.message}`);
    return { indexed: null, verdict: 'UNKNOWN', coverageState: 'UNKNOWN' };
  }
}

export default async function postPublishCheck() {
  logger.info(STAGE, 'Running post-publish checks for recent articles...');

  const sanityClient = getSanityClient();

  // Fetch articles published in the last MONITOR_DAYS days
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - MONITOR_DAYS);

  const recentArticles = await sanityClient.fetch(
    `*[_type == "resource" && defined(publishedAt) && publishedAt > $cutoff] {
      _id, title, "slug": slug.current, publishedAt, firstPublishedAt,
      tags, seo, "primaryKeyword": tags[0]
    }`,
    { cutoff: cutoffDate.toISOString() }
  );

  if (recentArticles.length === 0) {
    logger.info(STAGE, 'No recent articles to check.');
    return { checked: 0, alerts: [] };
  }

  logger.info(STAGE, `Checking ${recentArticles.length} article(s) published in last ${MONITOR_DAYS} days`);

  let authClient;
  try {
    authClient = await getAuthClient(['https://www.googleapis.com/auth/webmasters.readonly']);
  } catch (err) {
    logger.warn(STAGE, `Cannot connect to Search Console: ${err.message}`);
    return { checked: 0, alerts: [] };
  }

  const alerts = [];
  const metaOptQueue = [];

  for (const article of recentArticles) {
    const age = daysSince(article.firstPublishedAt || article.publishedAt);
    const pageUrl = `${RESOURCES_URL}/${article.slug}`;

    // Days 3-5: Index verification
    if (age >= 3 && age <= 7) {
      const indexStatus = await checkIndexStatus(authClient, pageUrl);

      if (indexStatus.indexed === false && age >= 5) {
        logger.warn(STAGE, `${article.slug} not indexed after ${age} days. Re-submitting.`);
        alerts.push(`Not indexed after ${age} days: "${article.title}" (${pageUrl}). Re-submitting to Google.`);
        try {
          await googleIndexing(pageUrl);
        } catch (err) {
          logger.warn(STAGE, `Re-indexing failed: ${err.message}`);
        }
      } else if (indexStatus.indexed) {
        logger.info(STAGE, `${article.slug} indexed (age: ${age}d)`);
      }
    }

    // Days 7-30: Performance analysis
    if (age >= 7) {
      const queryData = await getSearchConsoleData(authClient, pageUrl);

      if (queryData.length > 0) {
        const totalImpressions = queryData.reduce((sum, r) => sum + r.impressions, 0);
        const totalClicks = queryData.reduce((sum, r) => sum + r.clicks, 0);
        const avgCtr = totalImpressions > 0 ? (totalClicks / totalImpressions * 100) : 0;
        const topQuery = queryData.sort((a, b) => b.impressions - a.impressions)[0];
        const primaryKw = (article.primaryKeyword || '').replace(/-/g, ' ');

        logger.info(STAGE, `${article.slug} (${age}d): ${totalImpressions} imp, ${totalClicks} clicks, ${avgCtr.toFixed(1)}% CTR, top query: "${topQuery.keys[0]}"`);

        // Intent drift detection
        if (primaryKw && topQuery) {
          const topQueryText = topQuery.keys[0].toLowerCase();
          const kwLower = primaryKw.toLowerCase();
          if (!topQueryText.includes(kwLower) && !kwLower.includes(topQueryText)) {
            const driftMsg = `Intent drift: "${article.title}" targets "${primaryKw}" but ranks for "${topQuery.keys[0]}" (pos ${topQuery.position.toFixed(1)}, ${topQuery.impressions} imp)`;
            logger.info(STAGE, driftMsg);
            alerts.push(driftMsg);
          }
        }

        // Low CTR detection — queue for meta optimization
        if (avgCtr < 2 && totalImpressions > 50) {
          logger.info(STAGE, `Low CTR detected for ${article.slug}: ${avgCtr.toFixed(1)}% with ${totalImpressions} impressions`);
          metaOptQueue.push({
            docId: article._id,
            slug: article.slug,
            title: article.title,
            currentSeo: article.seo,
            topQueries: queryData.slice(0, 10).map(r => ({
              query: r.keys[0],
              impressions: r.impressions,
              clicks: r.clicks,
              ctr: (r.ctr * 100).toFixed(1) + '%',
              position: r.position.toFixed(1),
            })),
            avgCtr,
          });
        }

        // Declining after day 21 — early refresh candidate
        if (age >= 21 && age <= 28) {
          const avgPosition = queryData.reduce((sum, r) => sum + r.position * r.impressions, 0) / Math.max(totalImpressions, 1);
          if (avgPosition > 15 && totalImpressions > 30) {
            alerts.push(`Early decline: "${article.title}" averaging position ${avgPosition.toFixed(1)} after ${age} days. Consider early refresh.`);
          }
        }
      } else if (age >= 10) {
        logger.info(STAGE, `${article.slug} (${age}d): no Search Console data yet`);
      }
    }
  }

  // Run meta optimizer for low-CTR pages (max 2 per run)
  for (const item of metaOptQueue.slice(0, 2)) {
    try {
      await metaOptimizer(item);
    } catch (err) {
      logger.warn(STAGE, `Meta optimization failed for ${item.slug}: ${err.message}`);
    }
  }

  // Send consolidated alerts
  if (alerts.length > 0) {
    await sendSlackAlert(
      `📊 Post-publish check — ${alerts.length} alert(s):\n\n${alerts.map(a => `• ${a}`).join('\n')}\n\n<${DASHBOARD_URL}/?view=dashboard|View SEO Dashboard>`
    );
  }

  logger.info(STAGE, `Post-publish check complete. ${recentArticles.length} checked, ${alerts.length} alerts, ${metaOptQueue.length} queued for meta optimization.`);
  return { checked: recentArticles.length, alerts, metaOptimized: metaOptQueue.length };
}

// Standalone
if (process.argv[1] && process.argv[1].endsWith('11-post-publish-check.js')) {
  postPublishCheck()
    .then(r => console.log(`Checked ${r.checked} articles. ${r.alerts.length} alerts.`))
    .catch(err => { console.error(err); process.exit(1); });
}
