/**
 * Stage 13: Broken Link Prospector
 * Crawls competitor/industry blogs for broken outbound links.
 * When a broken link's topic matches a Fulcrum International resource, flags as replacement opportunity.
 * Posts to Slack for Joe to review and send a pitch.
 */

import config from '../utils/config.js';
import { findContactEmail } from '../utils/find-contact-email.js';
import getSanityClient from '../utils/sanity-client.js';
import { sendOutreachDraft } from '../utils/slack.js';
import { appendSheetRows, readSheetRange } from '../utils/sheets-client.js';
import logger from '../utils/logger.js';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

const OUTREACH_TARGETS = [
  'honeybook.com',
  'profi.io',
  'simplepractice.com',
  'coachaccountable.com',
  'psychologytoday.com',
  'mentalhealth.gov',
  'behavioralhealthnews.org',
  'thenationalcouncil.org',
  'openreferral.org',
];

async function fetchPageLinks(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'FulcrumIntl-LinkChecker/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const html = await res.text();

    const linkRegex = /href=["'](https?:\/\/[^"']+)["']/gi;
    const links = [];
    let match;
    while ((match = linkRegex.exec(html)) !== null) {
      const href = match[1];
      const linkDomain = new URL(href).hostname;
      const pageDomain = new URL(url).hostname;
      if (linkDomain !== pageDomain) {
        links.push(href);
      }
    }
    return [...new Set(links)];
  } catch (e) {
    logger.warn('broken-links', `Failed to fetch ${url}: ${e.message}`);
    return [];
  }
}

async function checkLink(url) {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': 'FulcrumIntl-LinkChecker/1.0' },
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    });
    return { url, status: res.status, broken: res.status >= 400 };
  } catch (e) {
    return { url, status: 0, broken: true, error: e.message };
  }
}

async function findBlogPages(domain) {
  if (!config.perplexity.apiKey) return [];

  try {
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.perplexity.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [{
          role: 'user',
          content: `List 5-10 recent blog post URLs from ${domain}. I need the actual full URLs of their most recent articles or blog posts. Just the URLs, one per line.`,
        }],
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    const urlRegex = /https?:\/\/[^\s)>\]]+/g;
    return (text.match(urlRegex) || []).slice(0, 10);
  } catch (e) {
    return [];
  }
}

export default async function brokenLinkProspector() {
  logger.info('broken-links', 'Starting broken link prospector...');

  const sanity = getSanityClient();
  const ourResources = await sanity.fetch(
    `*[_type == "resource" && defined(slug.current)] { title, "slug": slug.current, primaryKeyword, cluster }`
  );

  let existingPitches = [];
  try {
    existingPitches = await readSheetRange('Outreach Tracker', 'A2:A200');
  } catch (e) { /* tab might not exist yet */ }
  const pitchedDomains = new Set(existingPitches.flat());

  const opportunities = [];

  for (const target of OUTREACH_TARGETS) {
    const domain = target.replace(/\/.*/, '');
    logger.info('broken-links', `Scanning ${domain}...`);

    const pages = await findBlogPages(target);
    if (pages.length === 0) {
      logger.warn('broken-links', `No blog pages found for ${domain}`);
      continue;
    }

    for (const page of pages.slice(0, 5)) {
      const outboundLinks = await fetchPageLinks(page);
      if (outboundLinks.length === 0) continue;

      const checks = await Promise.all(
        outboundLinks.slice(0, 20).map(link => checkLink(link))
      );

      const brokenLinks = checks.filter(c => c.broken);

      for (const broken of brokenLinks) {
        try {
          const matchResult = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 300,
            messages: [{
              role: 'user',
              content: `A page at ${page} has a broken link to: ${broken.url}

Our resources:
${ourResources.map(a => `- "${a.title}" (${a.primaryKeyword || 'no keyword'}) → /resources/${a.slug}`).join('\n')}

Is any of our resources a good replacement for the broken link? If yes, return JSON:
{"match": true, "resourceSlug": "the-slug", "resourceTitle": "The Title", "reason": "why it's a match"}
If no match: {"match": false}`,
            }],
          });

          const text = matchResult.content[0].text;
          const json = JSON.parse(text.match(/\{[\s\S]*\}/)[0]);

          if (json.match) {
            opportunities.push({
              sourcePage: page,
              sourceDomain: domain,
              brokenUrl: broken.url,
              ourResource: json.resourceTitle,
              ourSlug: json.resourceSlug,
              reason: json.reason,
            });
          }
        } catch (e) {
          // Skip matching errors
        }
      }
    }

    // Rate limit between domains
    await new Promise(r => setTimeout(r, 2000));
  }

  // Send opportunities to Slack and record in Sheet
  for (const opp of opportunities) {
    if (pitchedDomains.has(opp.sourceDomain)) continue;

    const contactResult = await findContactEmail(opp.sourceDomain, {
      perplexityApiKey: process.env.PERPLEXITY_API_KEY,
      brandName: config.brand?.name || 'Fulcrum International',
    });
    const contactNote = contactResult.source === 'guesses'
      ? `No email found. Try: ${contactResult.candidates.slice(0, 4).join(', ')}`
      : `📧 Contact (${contactResult.source}): ${contactResult.email}`;

    await sendOutreachDraft({
      type: 'Broken Link Opportunity',
      target: opp.sourceDomain,
      subject: `Broken link on your site — we have a replacement`,
      body: `Hi there,\n\nI noticed a broken link on your page:\n${opp.sourcePage}\n\nThe link to ${opp.brokenUrl} appears to be dead.\n\nWe have a resource that covers the same topic: "${opp.ourResource}"\nhttps://www.fulcruminternational.org/resources/${opp.ourSlug}\n\nWould you consider updating the link? Happy to help if needed.`,
      notes: `${contactNote}\nMatch reason: ${opp.reason}`,
    });

    try {
      await appendSheetRows('Outreach Tracker', [[
        opp.sourceDomain,
        'Broken Link',
        '',
        '0',
        '0',
        'Opportunity Found',
        new Date().toISOString().split('T')[0],
        '',
        `Broken: ${opp.brokenUrl} → Our: ${opp.ourResource}`,
        '',
        '',
      ]]);
    } catch (e) {
      logger.warn('broken-links', `Failed to write to Outreach Tracker: ${e.message}`);
    }
  }

  logger.info('broken-links', `Found ${opportunities.length} broken link opportunities`);
  return { opportunities: opportunities.length, domains: OUTREACH_TARGETS.length };
}
