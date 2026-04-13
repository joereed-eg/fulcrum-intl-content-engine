/**
 * Stage 14: Reciprocal Link Tracker
 * Scans all published Fulcrum International resources for external links.
 * Builds a ledger: { domain -> [resources linking to them, count, first date] }
 * When a domain hits 2+ outbound links AND we haven't pitched -> Slack alert.
 */

import getSanityClient from '../utils/sanity-client.js';
import { sendSlackAlert } from '../utils/slack.js';
import { readSheetRange, appendSheetRows } from '../utils/sheets-client.js';
import logger from '../utils/logger.js';

function extractExternalLinks(body) {
  if (!body || !Array.isArray(body)) return [];
  const links = [];

  for (const block of body) {
    if (block.markDefs) {
      for (const mark of block.markDefs) {
        if (mark._type === 'link' && mark.href && mark.href.startsWith('http')) {
          try {
            const domain = new URL(mark.href).hostname.replace('www.', '');
            if (!domain.includes('fulcruminternational.org')) {
              links.push({ domain, href: mark.href });
            }
          } catch (e) { /* skip invalid URLs */ }
        }
      }
    }
  }

  return links;
}

export default async function reciprocalTracker() {
  logger.info('reciprocal', 'Scanning resources for external links...');

  const sanity = getSanityClient();
  const resources = await sanity.fetch(
    `*[_type == "resource" && defined(slug.current)] { _id, title, "slug": slug.current, body, _createdAt }`
  );

  // Build the ledger: domain -> { count, resources, firstSeen }
  const ledger = {};

  for (const resource of resources) {
    const links = extractExternalLinks(resource.body);
    for (const link of links) {
      if (!ledger[link.domain]) {
        ledger[link.domain] = { count: 0, resources: [], firstSeen: resource._createdAt, hrefs: [] };
      }
      ledger[link.domain].count++;
      ledger[link.domain].resources.push(resource.title);
      ledger[link.domain].hrefs.push(link.href);
    }
  }

  // Check existing outreach tracker to see what we've already pitched
  let existingRows = [];
  try {
    existingRows = await readSheetRange('Outreach Tracker', 'A2:F200');
  } catch (e) { /* tab might not exist yet */ }

  const pitchedDomains = new Set();
  for (const row of existingRows) {
    if (row[0]) pitchedDomains.add(row[0]);
  }

  // Find domains with 2+ links that we haven't pitched
  const readyToPitch = [];

  for (const [domain, data] of Object.entries(ledger)) {
    if (data.count >= 2 && !pitchedDomains.has(domain)) {
      // Skip our own domain and common infra domains
      if (domain.includes('fulcruminternational') || domain.includes('fulcrum') || domain.includes('google') || domain.includes('facebook')) continue;

      readyToPitch.push({ domain, ...data });

      await sendSlackAlert(
        `Reciprocal Target Ready → ${domain}\n` +
        `We've linked to them ${data.count} times across ${data.resources.length} resource(s):\n` +
        `${data.resources.map(a => `- ${a}`).join('\n')}\n` +
        `Links: ${data.hrefs.slice(0, 3).join(', ')}\n` +
        `_Ready for guest post or link swap pitch_`
      );

      // Add to Outreach Tracker
      try {
        await appendSheetRows('Outreach Tracker', [[
          domain,
          'Reciprocal',
          '',
          String(data.count),
          '0',
          'Ready to Pitch',
          new Date().toISOString().split('T')[0],
          '',
          `Resources linking: ${data.resources.join('; ')}`,
          '',
          '',
        ]]);
      } catch (e) {
        logger.warn('reciprocal', `Failed to write to sheet: ${e.message}`);
      }
    }
  }

  logger.info('reciprocal', `Scanned ${resources.length} resources. ${Object.keys(ledger).length} external domains found. ${readyToPitch.length} ready to pitch.`);
  return { totalDomains: Object.keys(ledger).length, readyToPitch: readyToPitch.length };
}
