import config from '../utils/config.js';
import logger from '../utils/logger.js';
import { portableTextToMarkdown } from '../utils/portable-text.js';

const STAGE = 'hashnode';
const HASHNODE_GQL = 'https://gql.hashnode.com';

export default async function hashnodePublisher(job, article, publishedUrl) {
  const apiKey = config.hashnode?.apiKey;
  const publicationId = config.hashnode?.publicationId;

  if (!apiKey) {
    logger.info(STAGE, 'Hashnode not configured (HASHNODE_API_KEY missing). Skipping.');
    return { status: 'not-configured' };
  }

  if (!publicationId) {
    logger.info(STAGE, 'Hashnode publication ID not configured. Skipping.');
    return { status: 'not-configured' };
  }

  logger.info(STAGE, `Publishing "${job.title}" to Hashnode...`);

  const tags = buildTags(job);
  const markdown = buildMarkdown(article, publishedUrl);

  const mutation = `
    mutation PublishPost($input: PublishPostInput!) {
      publishPost(input: $input) {
        post {
          id
          url
          title
        }
      }
    }
  `;

  const variables = {
    input: {
      title: article.metaTitle || job.title,
      contentMarkdown: markdown,
      publicationId,
      originalArticleURL: publishedUrl,
      tags: tags.map(t => ({ name: t, slug: t.toLowerCase().replace(/[^a-z0-9]+/g, '-') })),
      metaTags: {
        title: article.metaTitle || job.title,
        description: article.metaDescription || article.excerpt || '',
      },
    },
  };

  const res = await fetch(HASHNODE_GQL, {
    method: 'POST',
    headers: {
      'Authorization': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: mutation, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    logger.warn(STAGE, `Hashnode publish failed: ${res.status} ${text}`);
    return { status: 'error', error: text };
  }

  const data = await res.json();

  if (data.errors) {
    logger.warn(STAGE, `Hashnode GQL errors: ${JSON.stringify(data.errors)}`);
    return { status: 'error', error: data.errors };
  }

  const post = data.data?.publishPost?.post;
  logger.info(STAGE, `Hashnode published: ${post?.url}`);
  return { status: 'published', url: post?.url, id: post?.id };
}

function buildTags(job) {
  return [
    job.primaryKeyword,
    ...(job.tags || []),
    ...(job.categories || []),
  ]
    .filter(Boolean)
    .slice(0, 5); // Hashnode allows up to 5 tags
}

function buildMarkdown(article, publishedUrl) {
  const raw = article.markdown || article.body || '';
  const body = Array.isArray(raw) ? portableTextToMarkdown(raw) : String(raw);
  return `${body}

---

*Originally published at [fulcruminternational.org](${publishedUrl})*`;
}

if (process.argv[1] && process.argv[1].endsWith('07-hashnode.js')) {
  console.log('Hashnode publisher — runs as part of pipeline. Requires HASHNODE_API_KEY + HASHNODE_PUBLICATION_ID.');
}
