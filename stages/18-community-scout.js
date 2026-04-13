/**
 * Stage 18: Community Scout (Reddit)
 * Scans target subreddits for posts matching Fulcrum International resource keywords.
 * Suggests value-first comment angles -> Slack for Joe to post manually.
 * NEVER drops links. Value-first only.
 * Runs twice weekly (Tuesday + Thursday).
 */

import config from '../utils/config.js';
import getSanityClient from '../utils/sanity-client.js';
import { sendSlackAlert } from '../utils/slack.js';
import logger from '../utils/logger.js';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

async function verifyRedditUrl(url) {
  try {
    const jsonUrl = url.endsWith('/') ? `${url}.json` : `${url}/.json`;
    const res = await fetch(jsonUrl, {
      headers: { 'User-Agent': 'ContentEngine/1.0' },
    });
    if (!res.ok) return false;
    const data = await res.json();
    const post = data?.[0]?.data?.children?.[0]?.data;
    if (!post) return false;
    if (post.removed_by_category || post.selftext === '[removed]' || post.selftext === '[deleted]' || post.author === '[deleted]') return false;
    return true;
  } catch {
    return false;
  }
}

const SUBREDDITS = [
  'nonprofit', 'NonProfitOrgs', 'philanthropy', 'NPOMarketing',
  'Grantwriting', 'volunteer', 'Leadership', 'NGO',
  'Entrepreneur', 'startups', 'sweatystartup', 'AskExecutives',
];

const SEARCH_TERMS = [
  'strategic plan', 'executive director burnout', 'nonprofit board',
  'capacity building', 'fractional COO', 'organizational development',
  'theory of change', 'nonprofit operations', 'mission creep',
  'saying yes to everything', 'scale nonprofit', 'leadership transition',
];

async function searchRedditViaPerplexity(subreddit, keywords) {
  if (!config.perplexity.apiKey) return '';

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
        content: `Search r/${subreddit} on Reddit for recent posts (last 7 days) about: ${keywords.join(', ')}

For each relevant post, give me:
1. Post title
2. Post URL
3. Number of comments
4. What the person is asking or struggling with
5. Whether the comments have good answers already

List up to 5 relevant posts. Skip posts with fewer than 3 comments.`,
      }],
    }),
  });

  if (!res.ok) return '';
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function suggestComment(threadInfo, relatedResource) {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `A nonprofit leader posted on Reddit about a strategic, operational, or leadership pain. I want to leave a helpful comment that establishes credibility WITHOUT linking to my site.

THREAD:
${threadInfo}

MY RELATED RESOURCE:
"${relatedResource.title}", covers: ${relatedResource.primaryKeyword || relatedResource.title}

Write a 3-4 sentence Reddit comment that:
1. Directly addresses their question or pain point
2. Shares one specific, actionable insight about nonprofit infrastructure, strategic clarity, or executive capacity (name the pattern underneath the symptom they described)
3. Sounds like a real person who has actually run or advised a nonprofit, NOT a marketer
4. Does NOT mention Fulcrum International, does NOT include any links
5. Uses casual Reddit tone, lowercase "i" is fine, contractions, no em dashes.

Just the comment text, nothing else.`,
    }],
  });

  return response.content[0].text;
}

export default async function communityScout() {
  logger.info('community', 'Scanning Reddit for engagement opportunities...');

  const sanity = getSanityClient();
  const resources = await sanity.fetch(
    `*[_type == "resource" && defined(slug.current)] { title, "slug": slug.current, primaryKeyword, cluster, tags }`
  );

  if (resources.length === 0) {
    logger.info('community', 'No resources published yet — skipping community scout');
    return { scanned: 0, opportunities: 0 };
  }

  // Combine article keywords with our static search terms
  const resourceKeywords = resources
    .map(a => a.primaryKeyword || a.title)
    .filter(Boolean);
  const allKeywords = [...new Set([...SEARCH_TERMS, ...resourceKeywords.slice(0, 5)])];

  let totalOpportunities = 0;

  for (const sub of SUBREDDITS) {
    logger.info('community', `Scanning r/${sub}...`);

    const results = await searchRedditViaPerplexity(sub, allKeywords.slice(0, 8));

    if (!results || results.length < 50) {
      logger.info('community', `No relevant threads in r/${sub}`);
      continue;
    }

    const matchResponse = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `Match these Reddit threads to the most relevant resource from our site, then suggest which ones are worth engaging with.

REDDIT THREADS FROM r/${sub}:
${results}

OUR RESOURCES:
${resources.map(a => `- "${a.title}" (keyword: ${a.primaryKeyword || 'n/a'})`).join('\n')}

Return JSON:
[
  {
    "threadTitle": "...",
    "threadUrl": "...",
    "matchedResource": "Resource Title",
    "worthEngaging": true/false,
    "reason": "why engage or not"
  }
]

Only include threads where worthEngaging is true. Skip threads that already have great answers or are too old.`,
      }],
    });

    try {
      const text = matchResponse.content[0].text;
      const matches = JSON.parse(text.match(/\[[\s\S]*\]/)[0]);

      for (const match of matches.filter(m => m.worthEngaging)) {
        if (match.threadUrl && match.threadUrl.includes('reddit.com')) {
          const isLive = await verifyRedditUrl(match.threadUrl);
          if (!isLive) {
            logger.info('community', `Skipping dead/hallucinated URL: ${match.threadUrl}`);
            continue;
          }
          await new Promise(r => setTimeout(r, 600));
        }

        const resource = resources.find(a => a.title === match.matchedResource) || resources[0];
        const comment = await suggestComment(
          `Title: ${match.threadTitle}\nURL: ${match.threadUrl}\nReason: ${match.reason}`,
          resource
        );

        await sendSlackAlert(
          `Reddit Opportunity → r/${sub}\n` +
          `*Thread:* ${match.threadTitle}\n` +
          `*URL:* ${match.threadUrl}\n` +
          `*Related resource:* "${resource.title}"\n` +
          `━━━━━━━━━━━━\n` +
          `*Suggested comment:*\n${comment}\n` +
          `━━━━━━━━━━━━\n` +
          `_Copy, edit if needed, and post manually. NO LINKS._`
        );

        totalOpportunities++;
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (e) {
      logger.warn('community', `Failed to parse matches for r/${sub}: ${e.message}`);
    }

    // Rate limit between subreddits
    await new Promise(r => setTimeout(r, 2000));
  }

  logger.info('community', `Scanned ${SUBREDDITS.length} subreddits, found ${totalOpportunities} opportunities`);
  return { scanned: SUBREDDITS.length, opportunities: totalOpportunities };
}

// Standalone entry point for GitHub Actions
if (import.meta.url === `file://${process.argv[1]}`) {
  communityScout()
    .then(r => console.log('Community scout complete:', r))
    .catch(err => { console.error('Fatal:', err); process.exit(1); });
}
