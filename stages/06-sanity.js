import crypto from 'crypto';
import getSanityClient from '../utils/sanity-client.js';
import slugify from '../utils/slugify.js';
import { getSheetsClient, getSheetConfig } from '../utils/sheets-client.js';
import { RESOURCES_URL } from '../utils/config.js';
import { markdownToPortableText } from '../utils/portable-text.js';
import logger from '../utils/logger.js';

const STAGE = 'sanity-publisher';

export default async function sanityPublisher(job, article, imageAssetId) {
  logger.info(STAGE, `Publishing "${job.title}" to Sanity...`);

  const client = getSanityClient();
  const slug = slugify(job.title);
  const docId = crypto.randomUUID().replace(/-/g, '').slice(0, 24);

  const doc = {
    _id: docId,
    _type: 'resource',
    title: job.title,
    slug: { _type: 'slug', current: slug },
    excerpt: article.excerpt,
    body: markdownToPortableText(article.body || ''),
    author: { _type: 'reference', _ref: '16114936-76f4-4c08-a587-93ac31f3b47a' },
    category: 'for-organizations',
    tags: article.tags || [],
    cluster: job.cluster || '',
    contentLayer: job.contentLayer || 'supporting',
    publishedAt: new Date(job.publishDate).toISOString(),
    firstPublishedAt: new Date(job.publishDate).toISOString(),
    readTime: article.readTime || Math.ceil(job.wordCountTarget / 200),
    faqs: (article.faqs || []).map(faq => ({
      _type: 'articleFaq',
      _key: crypto.randomUUID().replace(/-/g, '').slice(0, 12),
      question: faq.question,
      answer: faq.answer,
    })),
    howToSteps: (article.howToSteps || []).map(step => ({
      _type: 'howToStep',
      _key: crypto.randomUUID().replace(/-/g, '').slice(0, 12),
      name: step.name,
      text: step.text,
    })),
  };

  // Add cover image if available
  if (imageAssetId) {
    doc.coverImage = {
      _type: 'image',
      asset: { _ref: imageAssetId, _type: 'reference' },
    };
  }

  // Add SEO fields if available
  if (article.metaTitle || article.metaDescription) {
    doc.seo = {
      metaTitle: article.metaTitle,
      metaDescription: article.metaDescription,
    };
  }

  // Publish directly (no draft prefix = published immediately)
  await client.createOrReplace(doc);
  logger.info(STAGE, `Published document: ${docId}`);

  const liveUrl = `${RESOURCES_URL}/${slug}`;
  logger.info(STAGE, `Published: ${liveUrl} (ID: ${docId})`);

  // Update Google Sheet — set Stage to "Published"
  try {
    const sheets = await getSheetsClient();
    const sheetConfig = getSheetConfig();

    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetConfig.spreadsheetId,
      range: `'${sheetConfig.tab}'!A${job.rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [['Published']] },
    });

    // If Primary Pillar URL column is empty, fill it with the live URL
    if (!job.primaryPillarUrl) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetConfig.spreadsheetId,
        range: `'${sheetConfig.tab}'!J${job.rowIndex}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[liveUrl]] },
      });
    }

    logger.info(STAGE, `Sheet row ${job.rowIndex} updated to "Published"`);
  } catch (err) {
    logger.warn(STAGE, `Failed to update sheet: ${err.message}`);
  }

  return { docId, url: liveUrl, slug };
}

// Standalone
if (process.argv[1] && process.argv[1].endsWith('06-sanity.js')) {
  console.log('Sanity publisher requires job, article, and imageAssetId inputs. Run via pipeline.js');
}
