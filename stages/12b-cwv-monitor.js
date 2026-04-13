import { SITE_URL } from '../utils/config.js';
import logger from '../utils/logger.js';
import { sendSlackAlert } from '../utils/slack.js';

const STAGE = 'cwv-monitor';
const PSI_API = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

// Pages to always check
const CORE_PAGES = [
  SITE_URL,
  `${SITE_URL}/agencies`,
  `${SITE_URL}/pricing`,
];

async function checkPageSpeed(url) {
  try {
    const apiUrl = `${PSI_API}?url=${encodeURIComponent(url)}&strategy=mobile&category=performance`;
    const res = await fetch(apiUrl);
    if (!res.ok) {
      logger.warn(STAGE, `PageSpeed API returned ${res.status} for ${url}`);
      return null;
    }
    const data = await res.json();

    const audits = data.lighthouseResult?.audits || {};
    const lcp = audits['largest-contentful-paint']?.numericValue;
    const cls = audits['cumulative-layout-shift']?.numericValue;
    const inp = audits['interaction-to-next-paint']?.numericValue;
    const score = data.lighthouseResult?.categories?.performance?.score;

    return {
      url,
      lcp: lcp ? Math.round(lcp) : null,
      cls: cls ? cls.toFixed(3) : null,
      inp: inp ? Math.round(inp) : null,
      score: score ? Math.round(score * 100) : null,
    };
  } catch (err) {
    logger.warn(STAGE, `PageSpeed check failed for ${url}: ${err.message}`);
    return null;
  }
}

export default async function cwvMonitor() {
  logger.info(STAGE, 'Checking Core Web Vitals...');

  // Get top articles from Sanity (by most recent — GSC data may not be available)
  let articleUrls = [];
  try {
    const { default: getSanityClient } = await import('../utils/sanity-client.js');
    const client = getSanityClient();
    const articles = await client.fetch(
      `*[_type == "resource" && defined(publishedAt)] | order(publishedAt desc) [0...5] { "slug": slug.current }`
    );
    articleUrls = articles.map(a => `${SITE_URL}/resources/${a.slug}`);
  } catch {
    logger.warn(STAGE, 'Could not fetch articles from Sanity. Checking core pages only.');
  }

  const urlsToCheck = [...CORE_PAGES, ...articleUrls];
  logger.info(STAGE, `Checking ${urlsToCheck.length} pages...`);

  const results = [];
  const alerts = [];

  for (const url of urlsToCheck) {
    const result = await checkPageSpeed(url);
    if (!result) continue;
    results.push(result);

    const issues = [];
    if (result.lcp && result.lcp > 2500) issues.push(`LCP: ${result.lcp}ms (target: <2500ms)`);
    if (result.cls && parseFloat(result.cls) > 0.1) issues.push(`CLS: ${result.cls} (target: <0.1)`);
    if (result.inp && result.inp > 200) issues.push(`INP: ${result.inp}ms (target: <200ms)`);

    if (issues.length > 0) {
      alerts.push(`${url}\n  Score: ${result.score}/100\n  ${issues.join(', ')}`);
    }

    logger.info(STAGE, `${url} — score: ${result.score}, LCP: ${result.lcp}ms, CLS: ${result.cls}, INP: ${result.inp}ms`);

    // Rate limit: PSI API allows ~60 requests/minute for unauthenticated
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  if (alerts.length > 0) {
    await sendSlackAlert(
      `⚡ Core Web Vitals alerts (${alerts.length} pages failing):\n\n${alerts.map(a => `• ${a}`).join('\n\n')}`
    );
  } else {
    logger.info(STAGE, 'All pages pass Core Web Vitals thresholds.');
  }

  logger.info(STAGE, `CWV check complete. ${results.length} pages checked, ${alerts.length} alerts.`);
  return { checked: results.length, alerts: alerts.length, results };
}

if (process.argv[1] && process.argv[1].endsWith('12b-cwv-monitor.js')) {
  cwvMonitor()
    .then(r => console.log(`${r.checked} pages checked, ${r.alerts} alerts`))
    .catch(err => { console.error(err); process.exit(1); });
}
