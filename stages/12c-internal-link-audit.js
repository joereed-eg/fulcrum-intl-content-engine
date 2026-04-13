import getSanityClient from '../utils/sanity-client.js';
import logger from '../utils/logger.js';
import { sendSlackAlert } from '../utils/slack.js';
import { getSheetsClient, getSheetConfig } from '../utils/sheets-client.js';

const STAGE = 'internal-link-audit';
const SITE_URL = 'https://www.fulcruminternational.org';

/**
 * Monthly Internal Link Audit
 *
 * 1. Broken link check (HEAD request every internal link)
 * 2. Orphan detection (published pages with zero inbound internal links)
 * 3. Link distribution analysis (pages with too few or too many links)
 * 4. Anchor text audit (flag generic anchors like "click here", "read more")
 * 5. Reports results to Slack and optionally to a Google Sheet tab
 */
export default async function internalLinkAudit() {
  logger.info(STAGE, 'Starting monthly internal link audit...');

  const client = getSanityClient();

  // Fetch all published articles/resources
  const articles = await client.fetch(
    `*[_type == "resource" && defined(body) && !(_id in path("drafts.**"))]{
      _id, title, "slug": slug.current, body, _createdAt, _updatedAt
    }`
  );

  if (articles.length === 0) {
    logger.info(STAGE, 'No articles found to audit.');
    return { checked: 0, issues: [] };
  }

  logger.info(STAGE, `Auditing ${articles.length} published articles...`);

  // ─── 1. Extract all internal links ───
  const allLinks = []; // { fromSlug, fromTitle, href, anchorText }
  const articleSlugs = new Set(articles.map(a => a.slug).filter(Boolean));

  for (const article of articles) {
    for (const block of article.body || []) {
      if (block._type !== 'block') continue;

      // Get link markDefs
      const linkDefs = {};
      for (const md of block.markDefs || []) {
        if (md._type === 'link' && md.href) {
          linkDefs[md._key] = md.href;
        }
      }

      // Extract anchor text for each link
      for (const child of block.children || []) {
        if (!child.marks) continue;
        for (const mark of child.marks) {
          if (linkDefs[mark]) {
            const href = linkDefs[mark];
            if (href.includes('fulcruminternational.org') || href.startsWith('/')) {
              allLinks.push({
                fromSlug: article.slug,
                fromTitle: article.title,
                href: href.startsWith('/') ? `${SITE_URL}${href}` : href,
                anchorText: child.text || '',
              });
            }
          }
        }
      }
    }
  }

  const uniqueUrls = [...new Set(allLinks.map(l => l.href))];
  logger.info(STAGE, `Found ${allLinks.length} internal links (${uniqueUrls.length} unique URLs)`);

  // ─── 2. Check for broken links ───
  const broken = [];
  const redirects = [];

  for (const url of uniqueUrls) {
    try {
      const res = await fetch(url, { method: 'HEAD', redirect: 'manual' });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location') || 'unknown';
        const affectedArticles = [...new Set(allLinks.filter(l => l.href === url).map(l => l.fromSlug))];
        redirects.push({ url, status: res.status, location, articles: affectedArticles });
        logger.warn(STAGE, `Redirect: ${url} → ${location}`);
      } else if (res.status >= 400) {
        const affectedArticles = [...new Set(allLinks.filter(l => l.href === url).map(l => l.fromSlug))];
        broken.push({ url, status: res.status, articles: affectedArticles });
        logger.warn(STAGE, `Broken: ${url} (${res.status})`);
      }
    } catch (err) {
      const affectedArticles = [...new Set(allLinks.filter(l => l.href === url).map(l => l.fromSlug))];
      broken.push({ url, status: 'NETWORK_ERROR', articles: affectedArticles });
      logger.warn(STAGE, `Network error: ${url} — ${err.message}`);
    }
  }

  // ─── 3. Orphan detection ───
  const inboundCounts = {};
  for (const slug of articleSlugs) {
    inboundCounts[slug] = 0;
  }

  for (const link of allLinks) {
    // Normalize URL to slug
    const urlPath = link.href.replace(SITE_URL, '').replace(/^\//, '').replace(/\/$/, '');
    const slug = urlPath.replace(/^resources\//, '');
    if (inboundCounts[slug] !== undefined && slug !== link.fromSlug) {
      inboundCounts[slug]++;
    }
  }

  const orphans = articles
    .filter(a => a.slug && inboundCounts[a.slug] === 0)
    .map(a => ({ slug: a.slug, title: a.title, created: a._createdAt }));

  // ─── 4. Link distribution ───
  const outboundCounts = {};
  for (const article of articles) {
    outboundCounts[article.slug] = allLinks.filter(l => l.fromSlug === article.slug).length;
  }

  const underLinked = articles
    .filter(a => outboundCounts[a.slug] === 0 && a.slug)
    .map(a => ({ slug: a.slug, title: a.title }));

  const overLinked = articles
    .filter(a => outboundCounts[a.slug] > 15 && a.slug)
    .map(a => ({ slug: a.slug, title: a.title, count: outboundCounts[a.slug] }));

  // ─── 5. Anchor text audit ───
  const genericAnchors = ['click here', 'read more', 'learn more', 'here', 'this', 'link', 'this article', 'this post'];
  const badAnchors = allLinks
    .filter(l => genericAnchors.includes(l.anchorText.toLowerCase().trim()))
    .map(l => ({ fromSlug: l.fromSlug, href: l.href, anchor: l.anchorText }));

  // ─── 6. Compute health score ───
  const totalArticles = articles.length;
  const brokenPenalty = broken.length * 10;
  const orphanPenalty = orphans.length * 5;
  const underLinkedPenalty = underLinked.length * 3;
  const badAnchorPenalty = badAnchors.length * 2;
  const rawScore = Math.max(0, 100 - brokenPenalty - orphanPenalty - underLinkedPenalty - badAnchorPenalty);
  const healthScore = Math.round(rawScore);

  // ─── 7. Build report ───
  const issues = [];
  const report = [];

  report.push(`*Monthly Internal Link Audit — Fulcrum International*`);
  report.push(`Score: ${healthScore}/100 | ${totalArticles} articles | ${allLinks.length} internal links | ${uniqueUrls.length} unique URLs\n`);

  if (broken.length > 0) {
    report.push(`*Broken Links (${broken.length}):*`);
    for (const b of broken.slice(0, 10)) {
      report.push(`  ${b.url} (${b.status}) — in: ${b.articles.join(', ')}`);
      issues.push({ type: 'broken', severity: 'high', ...b });
    }
    if (broken.length > 10) report.push(`  ...and ${broken.length - 10} more`);
    report.push('');
  }

  if (redirects.length > 0) {
    report.push(`*Redirects (${redirects.length}):*`);
    for (const r of redirects.slice(0, 5)) {
      report.push(`  ${r.url} → ${r.location}`);
      issues.push({ type: 'redirect', severity: 'medium', ...r });
    }
    if (redirects.length > 5) report.push(`  ...and ${redirects.length - 5} more`);
    report.push('');
  }

  if (orphans.length > 0) {
    report.push(`*Orphan Pages — No Inbound Links (${orphans.length}):*`);
    for (const o of orphans.slice(0, 10)) {
      report.push(`  /resources/${o.slug} — "${o.title}"`);
      issues.push({ type: 'orphan', severity: 'medium', slug: o.slug, title: o.title });
    }
    if (orphans.length > 10) report.push(`  ...and ${orphans.length - 10} more`);
    report.push('');
  }

  if (underLinked.length > 0) {
    report.push(`*Under-Linked — Zero Outbound Links (${underLinked.length}):*`);
    for (const u of underLinked.slice(0, 10)) {
      report.push(`  /resources/${u.slug} — "${u.title}"`);
      issues.push({ type: 'under-linked', severity: 'low', slug: u.slug, title: u.title });
    }
    if (underLinked.length > 10) report.push(`  ...and ${underLinked.length - 10} more`);
    report.push('');
  }

  if (badAnchors.length > 0) {
    report.push(`*Generic Anchor Text (${badAnchors.length}):*`);
    for (const ba of badAnchors.slice(0, 5)) {
      report.push(`  "${ba.anchor}" in /${ba.fromSlug} → ${ba.href}`);
      issues.push({ type: 'generic-anchor', severity: 'low', ...ba });
    }
    if (badAnchors.length > 5) report.push(`  ...and ${badAnchors.length - 5} more`);
    report.push('');
  }

  if (overLinked.length > 0) {
    report.push(`*Over-Linked (>15 outbound):*`);
    for (const ol of overLinked) {
      report.push(`  /resources/${ol.slug} — ${ol.count} links`);
    }
    report.push('');
  }

  if (issues.length === 0) {
    report.push('All internal links are healthy. No orphans or issues detected.');
  }

  const fullReport = report.join('\n');
  logger.info(STAGE, fullReport);

  // Send to Slack
  await sendSlackAlert(fullReport);

  // ─── 8. Write summary to Google Sheet (optional) ───
  try {
    const sheets = await getSheetsClient();
    const config = getSheetConfig();

    // Try to write to a "Link Audit" tab
    const auditTab = 'Link Audit';
    const now = new Date().toISOString().split('T')[0];

    const rows = [
      [now, healthScore, totalArticles, allLinks.length, broken.length, orphans.length, underLinked.length, badAnchors.length, redirects.length],
    ];

    try {
      await sheets.spreadsheets.values.append({
        spreadsheetId: config.spreadsheetId,
        range: `'${auditTab}'!A:I`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: rows },
      });
      logger.info(STAGE, 'Audit summary written to Google Sheet');
    } catch {
      // Tab might not exist — create it
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: config.spreadsheetId,
          requestBody: {
            requests: [{ addSheet: { properties: { title: auditTab } } }],
          },
        });
        // Add headers + data
        await sheets.spreadsheets.values.update({
          spreadsheetId: config.spreadsheetId,
          range: `'${auditTab}'!A1:I2`,
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: [
              ['Date', 'Health Score', 'Total Articles', 'Total Links', 'Broken', 'Orphans', 'Under-Linked', 'Bad Anchors', 'Redirects'],
              ...rows,
            ],
          },
        });
        logger.info(STAGE, 'Created Link Audit tab and wrote summary');
      } catch (sheetErr) {
        logger.warn(STAGE, `Could not write to sheet: ${sheetErr.message}`);
      }
    }
  } catch {
    logger.warn(STAGE, 'Sheet write skipped (no sheets client)');
  }

  logger.info(STAGE, `Audit complete. Score: ${healthScore}/100, ${issues.length} issues found.`);

  return {
    healthScore,
    totalArticles,
    totalLinks: allLinks.length,
    uniqueUrls: uniqueUrls.length,
    broken: broken.length,
    orphans: orphans.length,
    underLinked: underLinked.length,
    badAnchors: badAnchors.length,
    redirects: redirects.length,
    issues,
  };
}

if (process.argv[1] && process.argv[1].endsWith('12c-internal-link-audit.js')) {
  internalLinkAudit()
    .then(r => {
      console.log(`\nAudit complete. Health score: ${r.healthScore}/100`);
      console.log(`${r.broken} broken, ${r.orphans} orphans, ${r.underLinked} under-linked, ${r.badAnchors} bad anchors`);
    })
    .catch(err => { console.error(err); process.exit(1); });
}
