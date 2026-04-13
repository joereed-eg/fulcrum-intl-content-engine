import { createClient } from '@sanity/client';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import config, { RESOURCES_URL, SITE_URL } from '../utils/config.js';
import logger from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadPillarPages() {
  try {
    const raw = readFileSync(join(__dirname, '..', 'pillar-pages.json'), 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    logger.warn('interlinker', `Could not load pillar-pages.json: ${err.message}`);
    return [];
  }
}

const STAGE = 'interlinker';

function getSanityClient() {
  return createClient({
    projectId: config.sanity.projectId,
    dataset: config.sanity.dataset,
    apiVersion: config.sanity.apiVersion,
    token: config.sanity.token,
    useCdn: false,
  });
}

function genKey() {
  return crypto.randomBytes(6).toString('hex');
}

// Extract plain text from a Portable Text block
function blockToText(block) {
  if (block._type !== 'block') return '';
  return (block.children || []).map(c => c.text || '').join('');
}

// Check if a block already contains a link to a given URL
function blockHasLink(block, url) {
  if (!block.markDefs) return false;
  return block.markDefs.some(md => md._type === 'link' && md.href && md.href.includes(url));
}

// Find the best span in a block to add a link (matches keyword phrase)
function findLinkableSpan(block, keywords) {
  if (block._type !== 'block' || block.style === 'h2' || block.style === 'h3') return null;
  if (block.listItem) return null; // skip list items to keep it clean

  const text = blockToText(block);
  const textLower = text.toLowerCase();

  for (const keyword of keywords) {
    const kwLower = keyword.toLowerCase();
    if (kwLower.length < 4) continue; // skip tiny keywords
    const idx = textLower.indexOf(kwLower);
    if (idx === -1) continue;

    // Found a match — check this span doesn't already have marks
    let charPos = 0;
    for (const child of block.children) {
      const childText = child.text || '';
      const childEnd = charPos + childText.length;

      if (idx >= charPos && idx < childEnd && (!child.marks || child.marks.length === 0)) {
        return {
          childIndex: block.children.indexOf(child),
          matchStart: idx - charPos,
          matchEnd: idx - charPos + keyword.length,
          keyword,
        };
      }
      charPos = childEnd;
    }
  }
  return null;
}

// Insert a link into a block by splitting the span
function insertLink(block, spanInfo, href) {
  const child = block.children[spanInfo.childIndex];
  const text = child.text;
  const before = text.slice(0, spanInfo.matchStart);
  const match = text.slice(spanInfo.matchStart, spanInfo.matchEnd);
  const after = text.slice(spanInfo.matchEnd);

  const linkKey = genKey();
  const newMarkDef = { _type: 'link', _key: linkKey, href };

  const newChildren = [];
  if (before) newChildren.push({ _type: 'span', _key: genKey(), text: before, marks: [] });
  newChildren.push({ _type: 'span', _key: genKey(), text: match, marks: [linkKey] });
  if (after) newChildren.push({ _type: 'span', _key: genKey(), text: after, marks: [] });

  // Replace the original child with the new split children
  const updatedChildren = [
    ...block.children.slice(0, spanInfo.childIndex),
    ...newChildren,
    ...block.children.slice(spanInfo.childIndex + 1),
  ];

  return {
    ...block,
    children: updatedChildren,
    markDefs: [...(block.markDefs || []), newMarkDef],
  };
}

export default async function interlinker(job, publishedDoc) {
  logger.info(STAGE, `Scanning existing articles for internal link opportunities to "${job.title}"`);

  const client = getSanityClient();
  const newSlug = publishedDoc.slug;
  const newUrl = `${RESOURCES_URL}/${newSlug}`;

  // Build keywords to search for in existing articles
  const keywords = [job.primaryKeyword];
  if (job.secondaryKeywords) {
    job.secondaryKeywords.split(',').forEach(kw => {
      const trimmed = kw.trim();
      if (trimmed) keywords.push(trimmed);
    });
  }
  // Add title words as fallback (3+ word phrases)
  const titleWords = job.title.split(/[\s:–—-]+/).filter(w => w.length > 3);
  if (titleWords.length >= 3) {
    keywords.push(titleWords.slice(0, 3).join(' '));
  }

  // Fetch all existing published resources except the new one — include cluster + tags for smart linking
  const existing = await client.fetch(
    `*[_type == "resource" && slug.current != $slug] { _id, title, "slug": slug.current, body, cluster, tags }`,
    { slug: newSlug }
  );

  // Sort: cluster siblings first (higher priority for interlinking)
  const newCluster = job.cluster || '';
  existing.sort((a, b) => {
    const aMatch = a.cluster && a.cluster === newCluster ? 1 : 0;
    const bMatch = b.cluster && b.cluster === newCluster ? 1 : 0;
    return bMatch - aMatch;
  });

  let updatedCount = 0;

  for (const doc of existing) {
    if (!doc.body || !Array.isArray(doc.body)) continue;

    // Check if this doc already links to the new article
    const alreadyLinked = doc.body.some(block => blockHasLink(block, newSlug));
    if (alreadyLinked) continue;

    const isClusterSibling = newCluster && doc.cluster === newCluster;
    const maxLinksPerDoc = isClusterSibling ? 2 : 1;

    // For cluster siblings, also use the target's primary keyword (first tag) as anchor text
    const searchKeywords = [...keywords];
    if (isClusterSibling && doc.tags?.length > 0) {
      searchKeywords.unshift(doc.tags[0].replace(/-/g, ' ')); // target's keyword as priority anchor
    }

    let linksAdded = 0;
    const newBody = doc.body.map(block => {
      if (linksAdded >= maxLinksPerDoc) return block;
      if (block._type !== 'block') return block;
      if (blockHasLink(block, newSlug)) return block;

      const spanInfo = findLinkableSpan(block, searchKeywords);
      if (spanInfo) {
        linksAdded++;
        return insertLink(block, spanInfo, newUrl);
      }
      return block;
    });

    if (linksAdded > 0) {
      try {
        await client.patch(doc._id).set({ body: newBody }).commit();
        logger.info(STAGE, `Added link to "${job.title}" in "${doc.title}"`);
        updatedCount++;
      } catch (err) {
        logger.warn(STAGE, `Failed to update "${doc.title}": ${err.message}`);
      }
    }
  }

  // Also: add links FROM the new article TO existing articles
  const newDoc = await client.fetch(
    `*[_type == "resource" && slug.current == $slug][0] { _id, body }`,
    { slug: newSlug }
  );

  if (newDoc?.body) {
    let reverseUpdated = false;
    const existingSlugs = existing.map(d => ({
      slug: d.slug,
      title: d.title,
      url: `${RESOURCES_URL}/${d.slug}`,
      keywords: d.title.toLowerCase().split(/[\s:–—-]+/).filter(w => w.length > 4).slice(0, 3),
    }));

    const updatedNewBody = newDoc.body.map(block => {
      if (block._type !== 'block') return block;

      for (const ex of existingSlugs) {
        if (blockHasLink(block, ex.slug)) continue;

        const spanInfo = findLinkableSpan(block, ex.keywords);
        if (spanInfo) {
          reverseUpdated = true;
          return insertLink(block, spanInfo, ex.url);
        }
      }
      return block;
    });

    if (reverseUpdated) {
      try {
        await client.patch(newDoc._id).set({ body: updatedNewBody }).commit();
        logger.info(STAGE, `Added reverse links in new article`);
      } catch (err) {
        logger.warn(STAGE, `Failed to update new article with reverse links: ${err.message}`);
      }
    }
  }

  // Part 3: Add pillar page links to the new article
  const pillarPages = loadPillarPages();
  let pillarLinksAdded = 0;

  if (pillarPages.length > 0 && newDoc?.body) {
    // Re-fetch the new doc since it may have been updated with reverse links above
    const freshDoc = await client.fetch(
      `*[_type == "resource" && slug.current == $slug][0] { _id, body }`,
      { slug: newSlug }
    );

    if (freshDoc?.body) {
      const articleText = freshDoc.body
        .filter(b => b._type === 'block')
        .map(b => blockToText(b))
        .join(' ')
        .toLowerCase();

      // Score each pillar page by keyword matches in the article text
      const scoredPillars = pillarPages.map(p => {
        const matchCount = p.keywords.filter(kw => articleText.includes(kw.toLowerCase())).length;
        return { ...p, matchCount };
      }).filter(p => p.matchCount > 0)
        .sort((a, b) => b.matchCount - a.matchCount);

      // Ensure at least 2 pillar links (relax matching if needed)
      let pillarsToLink = scoredPillars;
      if (pillarsToLink.length < 2) {
        const remaining = pillarPages.filter(p => !pillarsToLink.find(sp => sp.url === p.url));
        pillarsToLink = [...pillarsToLink, ...remaining.slice(0, 2 - pillarsToLink.length)];
      }

      let updatedBody = [...freshDoc.body];

      for (const pillar of pillarsToLink) {
        const fullUrl = `${SITE_URL}${pillar.url}`;

        // Check if article already links to this pillar page
        const alreadyLinked = updatedBody.some(block => blockHasLink(block, pillar.url));
        if (alreadyLinked) continue;

        // Try to find a keyword match in the article body and insert an inline link
        let linked = false;
        updatedBody = updatedBody.map(block => {
          if (linked) return block;
          if (block._type !== 'block') return block;
          if (blockHasLink(block, pillar.url)) return block;

          const spanInfo = findLinkableSpan(block, pillar.keywords);
          if (spanInfo) {
            linked = true;
            pillarLinksAdded++;
            return insertLink(block, spanInfo, fullUrl);
          }
          return block;
        });
      }

      if (pillarLinksAdded > 0) {
        try {
          await client.patch(freshDoc._id).set({ body: updatedBody }).commit();
          logger.info(STAGE, `Added ${pillarLinksAdded} pillar page link(s) to new article`);
        } catch (err) {
          logger.warn(STAGE, `Failed to add pillar page links: ${err.message}`);
        }
      }
    }
  }

  logger.info(STAGE, `Interlinking complete. Updated ${updatedCount} existing article(s), ${pillarLinksAdded} pillar link(s).`);
  return { updatedCount, pillarLinksAdded };
}

// Standalone
if (process.argv[1] && process.argv[1].endsWith('06c-interlinker.js')) {
  console.log('Interlinker requires job and publishedDoc inputs. Run via pipeline.js');
}
