import config from '../utils/config.js';
import logger from '../utils/logger.js';
import { portableTextToMarkdown } from '../utils/portable-text.js';

const STAGE = 'devto';

export default async function devtoPublisher(job, article, publishedUrl) {
  const apiKey = config.devto?.apiKey;

  if (!apiKey) {
    logger.info(STAGE, 'dev.to not configured (DEVTO_API_KEY missing). Skipping.');
    return { status: 'not-configured' };
  }

  logger.info(STAGE, `Publishing "${job.title}" to dev.to...`);

  const tags = buildTags(job);
  const markdown = buildMarkdown(article, publishedUrl);

  const payload = {
    article: {
      title: article.metaTitle || job.title,
      body_markdown: markdown,
      published: true,
      canonical_url: publishedUrl,
      tags,
      description: article.metaDescription || article.excerpt || '',
    },
  };

  const res = await fetch('https://dev.to/api/articles', {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    logger.warn(STAGE, `dev.to publish failed: ${res.status} ${text}`);
    return { status: 'error', error: text };
  }

  const data = await res.json();
  logger.info(STAGE, `dev.to published: ${data.url}`);
  return { status: 'published', url: data.url, id: data.id };
}

function buildTags(job) {
  // dev.to allows max 4 tags, lowercase, no spaces, alphanumeric + hyphens only
  const raw = [
    job.primaryKeyword,
    ...(job.tags || []),
    ...(job.categories || []),
  ]
    .filter(Boolean)
    .map(t => t.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30))
    .filter(t => t.length > 0);

  // Dedupe and limit to 4
  return [...new Set(raw)].slice(0, 4);
}

function buildMarkdown(article, publishedUrl) {
  // Use the article body as markdown, append a canonical note at the bottom
  const raw = article.markdown || article.body || '';
  const body = Array.isArray(raw) ? portableTextToMarkdown(raw) : String(raw);
  return `${body}

---

*Originally published at [fulcruminternational.org](${publishedUrl})*`;
}

if (process.argv[1] && process.argv[1].endsWith('07-devto.js')) {
  console.log('dev.to publisher — runs as part of pipeline. Requires DEVTO_API_KEY.');
}
