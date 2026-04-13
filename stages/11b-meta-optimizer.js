import Anthropic from '@anthropic-ai/sdk';
import getSanityClient from '../utils/sanity-client.js';
import config from '../utils/config.js';
import logger from '../utils/logger.js';
import { sendSlackAlert } from '../utils/slack.js';

const STAGE = 'meta-optimizer';

export default async function metaOptimizer({ docId, slug, title, currentSeo, topQueries, avgCtr }) {
  logger.info(STAGE, `Optimizing meta for "${title}" (CTR: ${avgCtr.toFixed(1)}%)`);

  const currentTitle = currentSeo?.metaTitle || title;
  const currentDesc = currentSeo?.metaDescription || '';

  const queryList = topQueries.map(q =>
    `"${q.query}" — ${q.impressions} impressions, ${q.clicks} clicks, position ${q.position}, CTR ${q.ctr}`
  ).join('\n');

  const client = new Anthropic({ apiKey: config.anthropic.apiKey, timeout: 30000 });

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: `You are an SEO specialist optimizing meta titles and descriptions to improve click-through rate (CTR).

CURRENT META:
Title: "${currentTitle}"
Description: "${currentDesc}"
Current average CTR: ${avgCtr.toFixed(1)}%

TOP SEARCH QUERIES (what people actually search to find this page):
${queryList}

TASK: Generate the single best meta title and description that will maximize CTR for these actual search queries.

RULES:
- Title: 50-60 characters. Must include the top search query (or close variant) prominently.
- Description: 150-160 characters. Must be compelling, include a benefit, and match search intent.
- Use power words: "proven", "complete", "step-by-step", "free", numbers, current year
- Match the searcher's intent — if they're looking for "how to", frame it as a guide
- The title should make the searcher feel THIS is the result they were looking for

Return ONLY a JSON object:
{
  "metaTitle": "...",
  "metaDescription": "...",
  "reasoning": "Why this will improve CTR"
}`,
    }],
  });

  const rawText = response.content[0].text;
  let result;
  try {
    let jsonStr = rawText;
    const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1].trim();
    else {
      const objMatch = rawText.match(/\{[\s\S]*\}/);
      if (objMatch) jsonStr = objMatch[0];
    }
    result = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(`Failed to parse meta optimizer output: ${err.message}`);
  }

  if (!result.metaTitle || !result.metaDescription) {
    throw new Error('Meta optimizer returned empty title or description');
  }

  // Auto-patch Sanity
  const sanityClient = getSanityClient();
  const publishedId = docId.replace(/^drafts\./, '');

  await sanityClient.patch(publishedId).set({
    'seo.metaTitle': result.metaTitle,
    'seo.metaDescription': result.metaDescription,
  }).commit();

  logger.info(STAGE, `Meta patched for ${slug}`);

  // Notify via Slack
  await sendSlackAlert(
    `🔧 Meta auto-optimized for "${title}"\n` +
    `CTR was: ${avgCtr.toFixed(1)}%\n` +
    `Old title: "${currentTitle}"\n` +
    `New title: "${result.metaTitle}"\n` +
    `New description: "${result.metaDescription}"\n` +
    `Reason: ${result.reasoning}\n` +
    `_Revert in Sanity Studio if needed._`
  );

  return result;
}

// Standalone
if (process.argv[1] && process.argv[1].endsWith('11b-meta-optimizer.js')) {
  console.log('Meta optimizer requires input from post-publish-check. Run via pipeline.js');
}
