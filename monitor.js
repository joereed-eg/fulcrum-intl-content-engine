#!/usr/bin/env node

import seoMonitor from './stages/08-seo-monitor.js';
import trendRadar from './stages/09-trend-radar.js';
import contentRefresh from './stages/10-content-refresh.js';
import clusterPlanner from './stages/00b-cluster-planner.js';
import competitorWatch from './stages/09c-competitor-watch.js';
import postPublishCheck from './stages/11-post-publish-check.js';
import linkChecker from './stages/12-link-checker.js';
import cwvMonitor from './stages/12b-cwv-monitor.js';
import brokenLinkProspector from './stages/13-broken-link-prospector.js';
import reciprocalTracker from './stages/14-reciprocal-tracker.js';
import logger from './utils/logger.js';
import { sendSlackAlert } from './utils/slack.js';

function getRunUrl() {
  if (process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID) {
    return `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  }
  return null;
}

async function run() {
  logger.info('monitor', 'Starting weekly monitor...');

  // SEO performance check
  try {
    const seoResult = await seoMonitor();
    logger.info('monitor', `SEO: ${seoResult.pagesAnalyzed} pages, ${seoResult.alerts.length} alerts.`);
  } catch (err) {
    logger.error('monitor', `SEO monitor failed: ${err.message}`);
    const runUrl = getRunUrl();
    await sendSlackAlert(`🚨 SEO monitor failed: ${err.message}${runUrl ? `\nLogs: ${runUrl}` : ''}`, { severity: 'error' });
  }

  // Content refresh check — flag declining articles
  try {
    const refreshResult = await contentRefresh();
    logger.info('monitor', `Refresh: ${refreshResult.refreshQueue.length} flagged, ${refreshResult.refreshResults?.length || 0} auto-refreshed.`);
  } catch (err) {
    logger.error('monitor', `Content refresh check failed: ${err.message}`);
    const runUrl = getRunUrl();
    await sendSlackAlert(`🚨 Content refresh check failed: ${err.message}${runUrl ? `\nLogs: ${runUrl}` : ''}`, { severity: 'error' });
  }

  // ICP trend radar — rotating focus across audience segments
  try {
    const trendResult = await trendRadar();
    logger.info('monitor', `Trends: focused on "${trendResult.focusIcp}"`);
  } catch (err) {
    logger.error('monitor', `Trend radar failed: ${err.message}`);
    const runUrl = getRunUrl();
    await sendSlackAlert(`🚨 Trend radar failed: ${err.message}${runUrl ? `\nLogs: ${runUrl}` : ''}`, { severity: 'error' });
  }

  // Topic cluster health analysis
  try {
    const clusterResult = await clusterPlanner();
    logger.info('monitor', `Clusters: ${clusterResult.clusters.length} analyzed, ${clusterResult.uncategorized} uncategorized.`);
  } catch (err) {
    logger.error('monitor', `Cluster planner failed: ${err.message}`);
    const runUrl = getRunUrl();
    await sendSlackAlert(`🚨 Cluster planner failed: ${err.message}${runUrl ? `\nLogs: ${runUrl}` : ''}`, { severity: 'error' });
  }

  // Quick wins detection + post-publish checks
  try {
    const ppResult = await postPublishCheck();
    logger.info('monitor', `Post-publish: ${ppResult.checked} checked, ${ppResult.alerts.length} alerts.`);
  } catch (err) {
    logger.error('monitor', `Post-publish check failed: ${err.message}`);
    const runUrl = getRunUrl();
    await sendSlackAlert(`🚨 Post-publish check failed: ${err.message}${runUrl ? `\nLogs: ${runUrl}` : ''}`, { severity: 'error' });
  }

  // Broken link detection
  try {
    const linkResult = await linkChecker();
    logger.info('monitor', `Links: ${linkResult.checked} checked, ${linkResult.broken.length} broken.`);
  } catch (err) {
    logger.error('monitor', `Link checker failed: ${err.message}`);
  }

  // Core Web Vitals monitoring
  try {
    const cwvResult = await cwvMonitor();
    logger.info('monitor', `CWV: ${cwvResult.checked} pages checked, ${cwvResult.alerts} alerts.`);
  } catch (err) {
    logger.error('monitor', `CWV monitor failed: ${err.message}`);
  }

  // Competitor content monitoring
  try {
    const compResult = await competitorWatch();
    logger.info('monitor', `Competitors: ${compResult.competitors} domains monitored.`);
  } catch (err) {
    logger.error('monitor', `Competitor watch failed: ${err.message}`);
    const runUrl = getRunUrl();
    await sendSlackAlert(`🚨 Competitor watch failed: ${err.message}${runUrl ? `\nLogs: ${runUrl}` : ''}`, { severity: 'error' });
  }

  // Broken link prospecting — find replacement opportunities on competitor/industry sites
  try {
    const blResult = await brokenLinkProspector();
    logger.info('monitor', `Broken links: ${blResult.opportunities} opportunities across ${blResult.domains} domains.`);
  } catch (err) {
    logger.error('monitor', `Broken link prospector failed: ${err.message}`);
    const runUrl = getRunUrl();
    await sendSlackAlert(`Broken link prospector failed: ${err.message}${runUrl ? `\nLogs: ${runUrl}` : ''}`, { severity: 'error' });
  }

  // Reciprocal link tracking — flag domains we link to heavily for outreach
  try {
    const rlResult = await reciprocalTracker();
    logger.info('monitor', `Reciprocal: ${rlResult.totalDomains} domains tracked, ${rlResult.readyToPitch} ready to pitch.`);
  } catch (err) {
    logger.error('monitor', `Reciprocal tracker failed: ${err.message}`);
    const runUrl = getRunUrl();
    await sendSlackAlert(`Reciprocal tracker failed: ${err.message}${runUrl ? `\nLogs: ${runUrl}` : ''}`, { severity: 'error' });
  }

  logger.save();
}

run().catch(err => {
  console.error('Fatal monitor error:', err);
  process.exit(1);
});
