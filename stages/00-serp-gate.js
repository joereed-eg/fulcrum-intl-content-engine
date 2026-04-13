import Anthropic from '@anthropic-ai/sdk';
import config, { SITE_URL, RESOURCES_URL } from '../utils/config.js';
import logger from '../utils/logger.js';
import { sendSlackAlert } from '../utils/slack.js';

const STAGE = 'serp-gate';

async function queryPerplexity(query) {
  const apiKey = config.perplexity.apiKey;
  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'sonar-pro',
      messages: [{ role: 'user', content: query }],
      max_tokens: 2000,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Perplexity ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

async function getGscSignals(keyword) {
  // Query Google Search Console for existing impressions on this keyword or variants
  // Uses the googleapis library already in the pipeline (same pattern as seo-monitor)
  try {
    const { google } = await import('googleapis');
    const { getAuthClient } = await import('../utils/sheets-client.js');
    const authClient = await getAuthClient(['https://www.googleapis.com/auth/webmasters.readonly']);
    const searchconsole = google.searchconsole({ version: 'v1', auth: authClient });

    const endDate = new Date();
    endDate.setDate(endDate.getDate() - 3); // GSC data lag
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 31);

    const res = await searchconsole.searchanalytics.query({
      siteUrl: SITE_URL + '/',
      requestBody: {
        startDate: startDate.toISOString().split('T')[0],
        endDate: endDate.toISOString().split('T')[0],
        dimensions: ['query'],
        dimensionFilterGroups: [{
          filters: [{
            dimension: 'query',
            operator: 'contains',
            expression: keyword.toLowerCase(),
          }],
        }],
        rowLimit: 20,
      },
    });

    const rows = res.data.rows || [];
    return {
      hasExistingPresence: rows.length > 0,
      totalImpressions: rows.reduce((sum, r) => sum + r.impressions, 0),
      bestPosition: rows.length > 0 ? Math.min(...rows.map(r => r.position)) : null,
      relatedQueries: rows.map(r => ({
        query: r.keys[0],
        impressions: r.impressions,
        clicks: r.clicks,
        position: r.position.toFixed(1),
      })),
    };
  } catch (err) {
    logger.warn(STAGE, `GSC query failed: ${err.message}. Proceeding without GSC data.`);
    return { hasExistingPresence: false, totalImpressions: 0, bestPosition: null, relatedQueries: [] };
  }
}

async function checkCannibalization(keyword) {
  try {
    const { default: getSanityClient } = await import('../utils/sanity-client.js');
    const client = getSanityClient();
    const existing = await client.fetch(
      `*[_type == "resource"]{ title, tags, "slug": slug.current }`
    );

    const kwLower = keyword.toLowerCase();
    for (const article of existing) {
      const firstTag = (article.tags?.[0] || '').replace(/-/g, ' ').toLowerCase();
      const titleLower = article.title.toLowerCase();
      if (firstTag && (kwLower.includes(firstTag) || firstTag.includes(kwLower))) {
        return { cannibalized: true, existingTitle: article.title, existingSlug: article.slug, matchedOn: 'tag' };
      }
      if (titleLower.includes(kwLower) || kwLower.includes(titleLower.split(':')[0].trim().toLowerCase())) {
        return { cannibalized: true, existingTitle: article.title, existingSlug: article.slug, matchedOn: 'title' };
      }
    }
    return { cannibalized: false };
  } catch {
    return { cannibalized: false };
  }
}

export default async function serpGate(job) {
  logger.info(STAGE, `Analyzing SERP for "${job.primaryKeyword}"...`);

  // Step 0: Cannibalization check — does an existing article already target this keyword?
  const cannibal = await checkCannibalization(job.primaryKeyword);
  if (cannibal.cannibalized) {
    logger.warn(STAGE, `Potential cannibalization: "${cannibal.existingTitle}" already targets "${job.primaryKeyword}" (matched on ${cannibal.matchedOn})`);
    await sendSlackAlert(
      `⚠️ Cannibalization warning for "${job.title}"\n` +
      `Keyword: "${job.primaryKeyword}"\n` +
      `Existing article: "${cannibal.existingTitle}" (/resources/${cannibal.existingSlug})\n` +
      `Consider updating the existing article instead of writing a new one.`
    );
    return { feasibility: "red", reasoning: `Cannibalization: "${cannibal.existingTitle}" already targets this keyword. Update the existing article instead.`, cannibalized: true, existingSlug: cannibal.existingSlug };
  }

  // Step 1: Check GSC for existing presence
  const gscSignals = await getGscSignals(job.primaryKeyword);
  if (gscSignals.hasExistingPresence) {
    logger.info(STAGE, `Existing GSC presence: ${gscSignals.totalImpressions} impressions, best position ${gscSignals.bestPosition}`);
  }

  // Step 2: SERP analysis via Perplexity
  let serpData;
  try {
    serpData = await queryPerplexity(
      `Search Google for "${job.primaryKeyword}" and list the actual top 5 ranking pages. ` +
      `For EACH result, provide this exact format:\n\n` +
      `1. URL: [full url]\n   Domain: [domain.com]\n   Authority: [low/medium/high]\n   Word count: [estimated]\n   Format: [article/tool/listicle/product/directory]\n   Angle: [their main argument]\n\n` +
      `After listing all 5 results, answer:\n` +
      `- Search intent: [informational/commercial/transactional/mixed]\n` +
      `- Content gap: What specific topic or angle is MISSING from the current top results?\n` +
      `- Opportunity: Can a new, focused article from a niche site realistically rank in the top 10?\n\n` +
      `IMPORTANT: I need actual current Google search results with real domains and URLs, not a general topic overview.`
    );
  } catch (err) {
    logger.warn(STAGE, `SERP analysis failed: ${err.message}. Proceeding without SERP data.`);
    return {
      feasibility: 'green',
      serpIntent: 'article',
      topCompetitors: [],
      contentGap: '',
      suggestedAngle: '',
      relatedKeywords: gscSignals.relatedQueries.map(q => q.query),
      minimumWordCount: job.wordCountTarget || 1500,
      gscSignals,
    };
  }

  // Sanity check: if Perplexity didn't return anything that looks like SERP data,
  // default to yellow instead of passing garbage to the feasibility scorer
  const looksLikeSerpData = serpData && (
    serpData.includes('.com') || serpData.includes('.org') || serpData.includes('.io') ||
    serpData.toLowerCase().includes('domain') || serpData.toLowerCase().includes('url:')
  );
  if (!looksLikeSerpData) {
    logger.warn(STAGE, `Perplexity response doesn't contain SERP data. Defaulting to yellow.`);
    return {
      feasibility: 'yellow',
      reasoning: 'SERP data unavailable — proceeding with caution. Perplexity did not return actual search results.',
      serpIntent: 'article',
      topCompetitors: [],
      contentGap: '',
      suggestedAngle: '',
      relatedKeywords: gscSignals.relatedQueries.map(q => q.query),
      minimumWordCount: job.wordCountTarget || 1500,
      gscSignals,
    };
  }

  // Step 3: Feasibility scoring via Claude Haiku
  const client = new Anthropic({ apiKey: config.anthropic.apiKey, timeout: 30000 });

  const gscContext = gscSignals.hasExistingPresence
    ? `\nEXISTING GSC DATA: We already have ${gscSignals.totalImpressions} impressions for related queries. Best position: ${gscSignals.bestPosition}. Related queries: ${gscSignals.relatedQueries.slice(0, 5).map(q => q.query).join(', ')}`
    : '\nNo existing Search Console presence for this keyword.';

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: `You are an SEO strategist. Analyze this SERP data and determine if a new article can realistically rank for this keyword.

KEYWORD: "${job.primaryKeyword}"
TARGET AUDIENCE: ${job.audience}
OUR SITE: www.fulcruminternational.org (relatively new domain, low authority, niche: NGO consulting and impact venture studio focused on operational and strategic infrastructure for nonprofit leaders running $1M-$20M organizations)
${gscContext}

SERP ANALYSIS:
${serpData}

Score the keyword feasibility and return ONLY a JSON object:
{
  "feasibility": "green" | "yellow" | "red",
  "reasoning": "1-2 sentence explanation",
  "serpIntent": "article" | "tool" | "listicle" | "product" | "mixed",
  "topCompetitors": [
    { "domain": "example.com", "wordCount": 2500, "angle": "Their key angle" }
  ],
  "contentGap": "What the top results are missing — specific and actionable",
  "suggestedAngle": "How fulcruminternational.org should differentiate to win, specific recommendation",
  "relatedKeywords": ["long-tail keyword 1", "long-tail keyword 2", "long-tail keyword 3"],
  "minimumWordCount": 2500
}

SCORING RULES:
- RED: ONLY if ALL top 5 results are high-authority tool/product pages with no articles at all, AND there is zero content gap. This should be rare.
- YELLOW: Mixed intent, moderate competition, or incomplete SERP data. Default to yellow when uncertain. We proceed with a differentiated angle.
- GREEN: Top results include articles from comparable or lower authority sites. Clear content gaps exist. Our niche angle gives us an advantage.

IMPORTANT:
- If we already have GSC impressions (existing presence), bias toward green/yellow — we already have a foothold.
- If the SERP data is incomplete or unclear, default to YELLOW — never red on insufficient data.
- minimumWordCount should match or beat the longest top-3 article, rounded up to nearest 500.`,
    }],
  });

  const rawText = response.content[0].text;
  let analysis;
  try {
    let jsonStr = rawText;
    const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1].trim();
    else {
      const objMatch = rawText.match(/\{[\s\S]*\}/);
      if (objMatch) jsonStr = objMatch[0];
    }
    analysis = JSON.parse(jsonStr);
  } catch (err) {
    logger.warn(STAGE, `Failed to parse SERP analysis: ${err.message}. Defaulting to green.`);
    return {
      feasibility: 'green',
      serpIntent: 'article',
      topCompetitors: [],
      contentGap: '',
      suggestedAngle: '',
      relatedKeywords: gscSignals.relatedQueries.map(q => q.query),
      minimumWordCount: job.wordCountTarget || 1500,
      gscSignals,
    };
  }

  // Merge GSC related keywords into the analysis
  const gscKeywords = gscSignals.relatedQueries.map(q => q.query);
  analysis.relatedKeywords = [...new Set([...(analysis.relatedKeywords || []), ...gscKeywords])];
  analysis.gscSignals = gscSignals;

  // Ensure minimumWordCount is reasonable
  if (!analysis.minimumWordCount || analysis.minimumWordCount < 1500) {
    analysis.minimumWordCount = job.wordCountTarget || 1500;
  }

  logger.info(STAGE, `SERP feasibility: ${analysis.feasibility} | Intent: ${analysis.serpIntent} | Min words: ${analysis.minimumWordCount}`);
  if (analysis.contentGap) logger.info(STAGE, `Content gap: ${analysis.contentGap.slice(0, 200)}`);

  // Handle RED — block the article
  if (analysis.feasibility === 'red') {
    const alternatives = (analysis.relatedKeywords || []).slice(0, 3);
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${config.google.sheetsSpreadsheetId}/edit`;
    const altList = alternatives.length > 0
      ? alternatives.map((kw, i) => `  ${i + 1}. "${kw}"`).join('\n')
      : '  None found — research manually';
    await sendSlackAlert(
      `:no_entry_sign: *SERP Gate blocked:* "${job.title}"\n` +
      `*Keyword:* \`${job.primaryKeyword}\`\n` +
      `*Why:* ${analysis.reasoning}\n\n` +
      `*Your options:*\n` +
      `1. *Swap keyword* — try one of these alternatives:\n${altList}\n` +
      `2. *Override* — edit the row in the <${sheetUrl}|Content Calendar> and set SERP Gate to "override"\n` +
      `3. *Delete* — remove this topic from the calendar if it's not worth pursuing\n\n` +
      `<${sheetUrl}|Open Content Calendar>`
    );
  }

  return analysis;
}

// Standalone
if (process.argv[1] && process.argv[1].endsWith('00-serp-gate.js')) {
  const keyword = process.argv[2];
  if (!keyword) {
    console.error('Usage: node stages/00-serp-gate.js "your keyword here"');
    process.exit(1);
  }
  serpGate({ primaryKeyword: keyword, audience: 'agencies', wordCountTarget: 2000 })
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch(err => { console.error(err); process.exit(1); });
}
