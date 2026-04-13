import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { google } from 'googleapis';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getAuthClient, getSheetsClient } from '../utils/sheets-client.js';
import getSanityClient from '../utils/sanity-client.js';
import googleIndexing from './06b-indexing.js';
import interlinker from './06c-interlinker.js';
import config, { SITE_URL, RESOURCES_URL } from '../utils/config.js';
import logger from '../utils/logger.js';
import { sendSlackAlert } from '../utils/slack.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STAGE = 'refresh-writer';
const SC_SITE_URL = SITE_URL + '/';
const URL_PREFIX = RESOURCES_URL + '/';

function getBrandVoice() {
  return readFileSync(join(__dirname, '..', 'config', 'brand-voice.md'), 'utf-8');
}

function dateStr(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

async function getSearchConsoleData(slug) {
  try {
    const authClient = await getAuthClient(['https://www.googleapis.com/auth/webmasters.readonly']);
    const searchconsole = google.searchconsole({ version: 'v1', auth: authClient });
    const pageUrl = `${URL_PREFIX}${slug}`;

    // Get query-level data for this specific page
    const res = await searchconsole.searchanalytics.query({
      siteUrl: SC_SITE_URL,
      requestBody: {
        startDate: dateStr(28),
        endDate: dateStr(0),
        dimensions: ['query'],
        dimensionFilterGroups: [{
          filters: [{
            dimension: 'page',
            operator: 'equals',
            expression: pageUrl,
          }],
        }],
        rowLimit: 50,
      },
    });

    const rows = res.data.rows || [];
    return rows.map(r => ({
      query: r.keys[0],
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: (r.ctr * 100).toFixed(2) + '%',
      position: r.position.toFixed(1),
    }));
  } catch (err) {
    logger.warn(STAGE, `Search Console query failed for ${slug}: ${err.message}`);
    return [];
  }
}

async function fetchSanityArticle(slug) {
  const client = getSanityClient();
  return client.fetch(
    `*[_type == "resource" && slug.current == $slug][0]{
      _id, title, slug, excerpt, category, author, publishedAt, readTime, tags,
      body, faqs, seo,
      "coverImageRef": coverImage.asset._ref
    }`,
    { slug }
  );
}

function articleToMarkdown(article) {
  if (!article?.body) return '';
  return article.body.map(b => {
    if (b._type === 'callout') return `[CALLOUT: ${b.label}] ${b.text}`;
    if (b._type === 'block') {
      const linkMap = {};
      (b.markDefs || []).forEach(md => {
        if (md._type === 'link') linkMap[md._key] = md.href;
      });
      const text = (b.children || []).map(c => {
        const t = c.text || '';
        const linkMark = (c.marks || []).find(m => linkMap[m]);
        if (linkMark) return `[${t}](${linkMap[linkMark]})`;
        return t;
      }).join('');
      const prefix = b.style === 'h2' ? '## ' : b.style === 'h3' ? '### ' : b.listItem ? '- ' : '';
      return prefix + text;
    }
    return '';
  }).join('\n\n');
}

function buildRefreshPrompt(article, searchData, refreshReason) {
  const articleText = articleToMarkdown(article);
  const slug = article.slug.current;

  const topQueries = searchData.slice(0, 20).map(q =>
    `"${q.query}" — ${q.clicks} clicks, ${q.impressions} impressions, position ${q.position}, CTR ${q.ctr}`
  ).join('\n');

  const lowCtrQueries = searchData.filter(q => parseFloat(q.ctr) < 3 && q.impressions > 10);
  const highPosQueries = searchData.filter(q => parseFloat(q.position) > 10 && q.impressions > 5);

  return `You are refreshing an existing article to recover declining search performance.

REFRESH REASON: ${refreshReason}

CURRENT ARTICLE:
Title: ${article.title}
Slug: ${slug}
Tags: ${(article.tags || []).join(', ')}
Published: ${article.publishedAt}

CURRENT BODY:
${articleText}

SEARCH CONSOLE DATA (last 28 days):
${topQueries || 'No search data available'}

${lowCtrQueries.length > 0 ? `LOW CTR QUERIES (showing in search but not getting clicks — possible meta/title issue):
${lowCtrQueries.map(q => `"${q.query}" — position ${q.position}, ${q.impressions} impressions, ${q.ctr} CTR`).join('\n')}` : ''}

${highPosQueries.length > 0 ? `RANKING OPPORTUNITY QUERIES (position 10+ but getting impressions — could rank higher with better content):
${highPosQueries.map(q => `"${q.query}" — position ${q.position}, ${q.impressions} impressions`).join('\n')}` : ''}

YOUR TASK:
Rewrite this article to recover and improve its search rankings. Specifically:

1. PRESERVE the overall structure and topic — don't change the article's subject
2. UPDATE any outdated statistics, references, or examples with current data (use 2025-2026 stats where possible)
3. ADD new sections addressing the high-opportunity queries that the article currently doesn't cover well
4. IMPROVE sections that correspond to low-CTR queries — make the content more specific and actionable
5. STRENGTHEN the meta title and description to improve CTR for the top search queries
6. ADD/UPDATE the FAQ section with questions that match actual search queries from the data above
7. KEEP all existing internal and external links — add new ones where they fit naturally
8. MAINTAIN the brand voice: leader-first, Fulcrum International is the guide not the hero. No em dashes.

IMPORTANT:
- The article should be BETTER and LONGER than the original, not shorter
- Keep the same slug and attribution link
- Include at least 2 new subsections addressing ranking opportunity queries
- Update the FAQ section to reflect actual search queries people are using

Output ONLY a JSON object:
{
  "metaTitle": "...",
  "metaDescription": "...",
  "excerpt": "...",
  "readTime": Number,
  "tags": ["kebab-case-tag", ...],
  "faqs": [
    { "question": "...", "answer": "..." }
  ],
  "body": [ ...PortableTextBlocks ],
  "refreshNotes": "Brief summary of what was changed and why"
}`;
}

export default async function refreshWriter(refreshItem) {
  const { slug, reason } = refreshItem;
  logger.info(STAGE, `Refreshing article: ${slug} (reason: ${reason})`);

  // Fetch existing article from Sanity
  const article = await fetchSanityArticle(slug);
  if (!article) {
    logger.warn(STAGE, `Article not found in Sanity: ${slug}`);
    return null;
  }

  // Get Search Console query data for this article
  const searchData = await getSearchConsoleData(slug);
  logger.info(STAGE, `Got ${searchData.length} search queries for ${slug}`);

  // Generate refreshed article via Claude
  const brandVoice = getBrandVoice();
  const client = new Anthropic({ apiKey: config.anthropic.apiKey, timeout: 600000 });

  let rawText = '';
  const stream = client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 32000,
    system: `You are a content refresh specialist for Fulcrum International (fulcruminternational.org). You take existing articles that are declining in search performance and rewrite them to recover rankings.\n\nBRAND VOICE:\n${brandVoice}`,
    messages: [{ role: 'user', content: buildRefreshPrompt(article, searchData, reason) }],
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.text) {
      rawText += event.delta.text;
    }
  }

  // Parse JSON response
  let jsonStr = rawText;
  const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonStr = jsonMatch[1].trim();
  else {
    const objMatch = rawText.match(/\{[\s\S]*\}/);
    if (objMatch) jsonStr = objMatch[0];
  }

  let refreshed;
  try {
    refreshed = JSON.parse(jsonStr);
  } catch (err) {
    throw { stage: STAGE, error: `Failed to parse refresh output: ${err.message}` };
  }

  if (!refreshed.body || !Array.isArray(refreshed.body)) {
    throw { stage: STAGE, error: 'Refresh output missing body array' };
  }

  // Patch the existing Sanity document
  const sanityClient = getSanityClient();
  const docId = article._id.replace(/^drafts\./, '');

  // Validate Portable Text blocks have required structure
  for (const block of refreshed.body) {
    if (!block._type) throw { stage: STAGE, error: 'Refresh output has block without _type' };
    if (!block._key) {
      block._key = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    }
  }

  const patch = {
    body: refreshed.body,
    excerpt: refreshed.excerpt || article.excerpt,
    readTime: refreshed.readTime || article.readTime,
    tags: refreshed.tags || article.tags,
    lastRefreshedAt: new Date().toISOString(),
    publishedAt: new Date().toISOString(), // Update publish date for freshness signal
  };

  // Update FAQs if present
  if (Array.isArray(refreshed.faqs) && refreshed.faqs.length > 0) {
    patch.faqs = refreshed.faqs.map(faq => ({
      _type: 'articleFaq',
      _key: crypto.randomUUID().replace(/-/g, '').slice(0, 12),
      question: faq.question,
      answer: faq.answer,
    }));
  }

  // Update SEO fields — merge with existing to avoid wiping fields
  if (refreshed.metaTitle || refreshed.metaDescription) {
    const existingSeo = article.seo || {};
    patch.seo = {
      metaTitle: refreshed.metaTitle || existingSeo.metaTitle,
      metaDescription: refreshed.metaDescription || existingSeo.metaDescription,
    };
  }

  // Patch published document
  await sanityClient.patch(docId).set(patch).commit();
  logger.info(STAGE, `Patched published article ${docId} (${slug})`);

  // Also delete any existing draft to prevent stale draft from overwriting on next Studio publish
  const draftId = `drafts.${docId}`;
  await sanityClient.delete(draftId).catch(() => {
    // No draft exists — that's fine
  });

  const url = `${URL_PREFIX}${slug}`;

  // Trigger Vercel on-demand revalidation so updated content is served immediately
  if (config.revalidationSecret) {
    try {
      const revalUrl = `${SITE_URL}/api/revalidate?path=/resources/${slug}&secret=${config.revalidationSecret}`;
      const revalRes = await fetch(revalUrl);
      if (revalRes.ok) {
        logger.info(STAGE, `Vercel cache revalidated for /resources/${slug}`);
      }
    } catch (err) {
      logger.warn(STAGE, `Vercel revalidation failed: ${err.message}`);
    }
  }

  // Notify Google of updated content
  try {
    await googleIndexing(url);
    logger.info(STAGE, `Google indexing notified for ${url}`);
  } catch (err) {
    logger.warn(STAGE, `Google indexing notification failed: ${err.message}`);
  }

  // Re-run interlinker to restore cross-links in the new body
  try {
    const tagKeywords = (article.tags || []).map(t => t.replace(/-/g, ' '));
    const primaryKw = tagKeywords[0] || article.title.split(':')[0].trim();
    const secondaryKw = tagKeywords.slice(1).join(', ');
    await interlinker({ title: article.title, primaryKeyword: primaryKw, secondaryKeywords: secondaryKw }, { docId, url, slug });
    logger.info(STAGE, `Interlinker re-ran for ${slug}`);
  } catch (err) {
    logger.warn(STAGE, `Interlinker failed after refresh: ${err.message}`);
  }

  await sendSlackAlert(
    `♻️ Article refreshed: "${article.title}"\n` +
    `URL: ${url}\n` +
    `Reason: ${reason}\n` +
    `Changes: ${refreshed.refreshNotes || 'Updated content and SEO'}`
  );

  return { docId, slug, url, refreshNotes: refreshed.refreshNotes };
}

if (process.argv[1] && process.argv[1].endsWith('10b-refresh-writer.js')) {
  const slug = process.argv[2];
  if (!slug) {
    console.error('Usage: node stages/10b-refresh-writer.js <slug> [reason]');
    process.exit(1);
  }
  const reason = process.argv[3] || 'manual-refresh';
  refreshWriter({ slug, reason })
    .then(r => r ? console.log(`Refreshed: ${r.url}`) : console.log('Article not found'))
    .catch(err => { console.error(err); process.exit(1); });
}
