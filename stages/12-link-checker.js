import getSanityClient from '../utils/sanity-client.js';
import logger from '../utils/logger.js';
import { sendSlackAlert } from '../utils/slack.js';

const STAGE = 'link-checker';

export default async function linkChecker() {
  logger.info(STAGE, 'Checking for broken internal links...');

  const client = getSanityClient();

  const articles = await client.fetch(
    `*[_type == "resource" && defined(body)]{ _id, title, "slug": slug.current, body }`
  );

  if (articles.length === 0) {
    logger.info(STAGE, 'No articles to check.');
    return { checked: 0, broken: [] };
  }

  // Extract all internal links from all articles
  const linkMap = []; // { articleSlug, articleTitle, href }
  for (const article of articles) {
    for (const block of article.body || []) {
      if (block._type !== 'block' || !block.markDefs) continue;
      for (const md of block.markDefs) {
        if (md._type === 'link' && md.href && md.href.includes('fulcruminternational.org')) {
          linkMap.push({
            articleSlug: article.slug,
            articleTitle: article.title,
            href: md.href,
          });
        }
      }
    }
  }

  // Deduplicate URLs to check
  const uniqueUrls = [...new Set(linkMap.map(l => l.href))];
  logger.info(STAGE, `Found ${linkMap.length} internal links across ${articles.length} articles (${uniqueUrls.length} unique URLs)`);

  const broken = [];

  for (const url of uniqueUrls) {
    try {
      const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
      if (res.status >= 400) {
        const affectedArticles = linkMap
          .filter(l => l.href === url)
          .map(l => l.articleSlug);
        broken.push({ url, status: res.status, articles: affectedArticles });
        logger.warn(STAGE, `Broken link: ${url} (${res.status}) — in ${affectedArticles.join(', ')}`);
      }
    } catch (err) {
      const affectedArticles = linkMap
        .filter(l => l.href === url)
        .map(l => l.articleSlug);
      broken.push({ url, status: 'NETWORK_ERROR', articles: affectedArticles });
      logger.warn(STAGE, `Link check failed: ${url} — ${err.message}`);
    }
  }

  if (broken.length > 0) {
    const list = broken.map(b =>
      `• ${b.url} (${b.status})\n  Found in: ${b.articles.join(', ')}`
    ).join('\n');

    await sendSlackAlert(
      `🔗 Broken internal links detected (${broken.length}):\n\n${list}`
    );
  } else {
    logger.info(STAGE, 'All internal links are healthy.');
  }

  logger.info(STAGE, `Link check complete. ${uniqueUrls.length} URLs checked, ${broken.length} broken.`);
  return { checked: uniqueUrls.length, broken };
}

if (process.argv[1] && process.argv[1].endsWith('12-link-checker.js')) {
  linkChecker()
    .then(r => console.log(`${r.checked} URLs checked, ${r.broken.length} broken`))
    .catch(err => { console.error(err); process.exit(1); });
}
