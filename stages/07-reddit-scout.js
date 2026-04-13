import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';
import { sendSlackAlert } from '../utils/slack.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STAGE = 'reddit-scout';

// Subreddits where Fulcrum International's audience hangs out
const TARGET_SUBREDDITS = [
  // Core ICP
  'nonprofit',
  'NonProfitOrgs',
  'nonprofits',
  'NPOMarketing',
  'philanthropy',
  'NGO',
  'Grantwriting',
  'volunteer',
  // Adjacent audiences
  'Leadership',
  'AskExecutives',
  'Entrepreneur',
  'startups',
  'sweatystartup',
  'smallbusiness',
  'projectmanagement',
  'ExperiencedDevs',
  // Sector-adjacent
  'socialwork',
  'publichealth',
  'humanresources',
  'communityorganizing',
];

// Search terms to find relevant conversations
function buildSearchTerms(job) {
  const terms = [
    job.primaryKeyword,
    'strategic plan not working',
    'executive director burnout',
    'nonprofit board dysfunction',
    'capacity building',
    'fractional COO nonprofit',
    'organizational development',
    'mission creep',
    'saying yes to everything',
    'scale nonprofit',
  ];
  // Add secondary keywords
  if (job.secondaryKeywords) {
    job.secondaryKeywords.split(',').forEach(kw => {
      const trimmed = kw.trim();
      if (trimmed) terms.push(trimmed);
    });
  }
  return terms.slice(0, 8); // cap at 8 searches
}

export default async function redditScout(job, publishedUrl) {
  logger.info(STAGE, `Scouting Reddit for "${job.primaryKeyword}" conversations...`);

  // Note: This stage uses the Reddit MCP tools when run inside Claude Code.
  // When running autonomously via cron, it uses Reddit's public JSON API.

  const searchTerms = buildSearchTerms(job);
  const relevantThreads = [];

  for (const subreddit of TARGET_SUBREDDITS) {
    for (const term of searchTerms.slice(0, 3)) { // 3 terms per subreddit
      try {
        const url = `https://www.reddit.com/r/${subreddit}/search.json?q=${encodeURIComponent(term)}&restrict_sr=1&sort=new&t=month&limit=3`;
        const res = await fetch(url, {
          headers: { 'User-Agent': 'FulcrumIntlContentPipeline/1.0' },
        });

        if (!res.ok) continue;

        const data = await res.json();
        const posts = data?.data?.children || [];

        for (const post of posts) {
          const p = post.data;
          // Only recent posts (< 7 days) with some engagement
          const ageHours = (Date.now() / 1000 - p.created_utc) / 3600;
          if (ageHours < 168 && p.num_comments > 2) {
            relevantThreads.push({
              subreddit: p.subreddit,
              title: p.title,
              url: `https://reddit.com${p.permalink}`,
              comments: p.num_comments,
              score: p.score,
              ageHours: Math.round(ageHours),
            });
          }
        }
      } catch (err) {
        // Skip failed searches silently
      }

      // Rate limit: 1 req/sec for Reddit
      await new Promise(r => setTimeout(r, 1100));
    }
  }

  // Deduplicate by URL
  const seen = new Set();
  const unique = relevantThreads.filter(t => {
    if (seen.has(t.url)) return false;
    seen.add(t.url);
    return true;
  });

  // Sort by engagement
  unique.sort((a, b) => (b.score + b.comments) - (a.score + a.comments));
  const top = unique.slice(0, 5);

  if (top.length === 0) {
    logger.info(STAGE, 'No relevant Reddit threads found this cycle.');
    return { status: 'no-threads', threads: [] };
  }

  // Build a suggested comment
  const suggestedComment = buildSuggestedComment(job, publishedUrl);

  // Send to Slack so Joe can manually drop comments
  const threadList = top.map(t =>
    `• r/${t.subreddit}: "${t.title}" (${t.comments} comments, ${t.ageHours}h old)\n  ${t.url}`
  ).join('\n');

  await sendSlackAlert(
    `Reddit opportunities for "${job.title}":\n\n${threadList}\n\nSuggested comment:\n\`\`\`${suggestedComment}\`\`\`\n\nArticle: ${publishedUrl}`
  );

  logger.info(STAGE, `Found ${top.length} Reddit threads. Sent to Slack for manual engagement.`);
  return { status: 'found', threads: top };
}

function buildSuggestedComment(job, url) {
  // Rotate through natural comment styles — Reddit hates obvious marketing
  const templates = [
    // Value-first, no links
    `We ran into this exact problem. The short version: {{insight}}. The TLDR is that most orgs are doing marketplace work with directory tools and that gap is where the value leaks.`,
    // Question + answer format
    `Dealt with this firsthand. The thing nobody tells you is {{insight}}.`,
    // Pure value, no pitch
    `One thing that helped us: {{insight}}. Happy to share more if useful.`,
  ];

  const insights = {
    'provider directory': 'directories go stale because nobody owns the update cycle',
    'referral network': 'referrals without tracking are just free labor for providers',
    'marketplace': 'the line between directory and marketplace is whether you capture the transaction',
    'revenue': 'most networks are leaving money on the table by not monetizing the referral flow',
    'white-label': 'white-labeling only works if the provider experience is as good as yours',
    'ghost directory': 'over 80% of listed providers in most directories are unreachable',
    'multi-agency': 'providers listed in multiple directories get 3-4x the referral volume',
  };

  // Pick insight based on job keywords
  const keyword = Object.keys(insights).find(k =>
    (job.primaryKeyword || '').toLowerCase().includes(k) ||
    (job.title || '').toLowerCase().includes(k)
  ) || 'provider directory';

  const template = templates[Math.floor(Math.random() * templates.length)];
  return template
    .replace('{{insight}}', insights[keyword]);
}

// Standalone
if (process.argv[1] && process.argv[1].endsWith('07-reddit-scout.js')) {
  const job = {
    primaryKeyword: 'provider directory',
    secondaryKeywords: 'therapist network, referral management',
    title: 'Test Article',
  };
  redditScout(job, 'https://www.fulcruminternational.org/resources/test')
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch(err => { console.error(err); process.exit(1); });
}
