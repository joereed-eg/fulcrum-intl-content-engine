import config from '../utils/config.js';
import logger from '../utils/logger.js';

const STAGE = 'linkedin';

export default async function linkedinPublisher(job, article, publishedUrl) {
  if (!config.linkedin.clientId || config.linkedin.clientId.startsWith('[')) {
    logger.info(STAGE, 'LinkedIn not configured. Skipping.');
    return { status: 'not-configured' };
  }

  const accessToken = config.linkedin.accessToken;
  const personUrn = config.linkedin.personUrn;

  // Check token validity before attempting to post
  try {
    const meRes = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    if (meRes.status === 401) {
      const { sendSlackAlert } = await import('../utils/slack.js');
      await sendSlackAlert(
        '⚠️ LinkedIn access token has EXPIRED. Syndication is disabled until the token is refreshed. Generate a new token and update the LINKEDIN_ACCESS_TOKEN secret.',
        { mention: true, severity: 'action' }
      );
      return { posted: false, reason: 'token-expired' };
    }
  } catch (e) {
    // Network error — continue and let the post attempt handle it
  }

  if (!accessToken || !personUrn) {
    logger.info(STAGE, 'LinkedIn tokens not set. Run: node stages/07-linkedin.js --auth');
    return { status: 'no-token' };
  }

  logger.info(STAGE, `Posting "${job.title}" to LinkedIn...`);

  const commentary = buildCommentary(job, article, publishedUrl);

  const payload = {
    author: personUrn,
    commentary,
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: 'PUBLISHED',
    content: {
      article: {
        source: publishedUrl,
        title: article.metaTitle || job.title,
        description: article.metaDescription || article.excerpt,
      },
    },
  };

  const res = await fetch('https://api.linkedin.com/rest/posts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'LinkedIn-Version': '202401',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    logger.warn(STAGE, `LinkedIn post failed: ${res.status} ${text}`);
    return { status: 'error', error: text };
  }

  const postId = res.headers.get('x-restli-id') || 'unknown';
  logger.info(STAGE, `LinkedIn post published: ${postId}`);
  return { status: 'published', postId };
}

function buildCommentary(job, article, url) {
  const excerpt = article.excerpt || '';
  return `${excerpt}

${article.metaDescription || ''}

Read the full breakdown → ${url}

#ProviderDirectories #AgencyGrowth #NetworkBuilding`;
}

if (process.argv[1] && process.argv[1].endsWith('07-linkedin.js')) {
  if (process.argv.includes('--auth')) {
    import('./07-linkedin-auth.js').then(m => m.default()).catch(console.error);
  } else {
    console.log('Usage:');
    console.log('  node stages/07-linkedin.js --auth    # One-time OAuth setup');
  }
}
