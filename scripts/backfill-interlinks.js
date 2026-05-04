#!/usr/bin/env node
/**
 * Backfill Internal Links — Fulcrum International
 *
 * Runs the full pairwise link insertion across all published posts.
 * The regular interlinker was silently broken (_type bug) and applied
 * zero links since launch. This script repairs that.
 *
 * Usage:
 *   node scripts/backfill-interlinks.js              # dry run (default)
 *   node scripts/backfill-interlinks.js --apply      # write to Sanity
 *
 * Requires a Sanity write token:
 *   SANITY_TOKEN=sk... node scripts/backfill-interlinks.js --apply
 *
 * To get the token: Sanity Manage > Project tur3pati > API > Tokens > Add Editor token.
 */

import getSanityClient from '../utils/sanity-client.js';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = !process.argv.includes('--apply');
const SITE_URL = 'https://www.fulcruminternational.org';
const RESOURCES_URL = `${SITE_URL}/resources`;

if (DRY_RUN) {
  console.log('\n[DRY RUN] Pass --apply to write changes to Sanity.\n');
}

function genKey() {
  return crypto.randomBytes(6).toString('hex');
}

function blockToText(block) {
  if (block._type !== 'block') return '';
  return (block.children || []).map(c => c.text || '').join('');
}

function blockHasLink(block, slug) {
  if (!block.markDefs) return false;
  return block.markDefs.some(md => md._type === 'link' && md.href && md.href.includes(slug));
}

function findLinkableSpan(block, keywords) {
  if (block._type !== 'block' || block.style === 'h2' || block.style === 'h3') return null;
  if (block.listItem) return null;

  const text = blockToText(block);
  const textLower = text.toLowerCase();

  for (const keyword of keywords) {
    const kwLower = keyword.toLowerCase();
    if (kwLower.length < 4) continue;
    const idx = textLower.indexOf(kwLower);
    if (idx === -1) continue;

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

function buildKeywords(post) {
  const keywords = [];

  // From tags
  if (Array.isArray(post.tags)) {
    for (const tag of post.tags) {
      if (typeof tag === 'string') {
        keywords.push(tag.replace(/-/g, ' '));
      }
    }
  }

  // From title — split on delimiters, take 3-word runs of 4+ char words
  const titleWords = (post.title || '')
    .split(/[\s:–—\-,]+/)
    .filter(w => w.length > 3);
  if (titleWords.length >= 2) {
    keywords.push(titleWords.slice(0, 3).join(' '));
    if (titleWords.length >= 4) {
      keywords.push(titleWords.slice(1, 4).join(' '));
    }
  }

  return [...new Set(keywords)].filter(k => k.length >= 4);
}

async function run() {
  const client = getSanityClient();

  console.log('Fetching all published posts...');
  const posts = await client.fetch(
    `*[_type == "post" && defined(slug.current) && !(_id in path("drafts.**"))]{
      _id, title, "slug": slug.current, body, tags, cluster
    }`
  );

  console.log(`Found ${posts.length} posts.\n`);

  if (posts.length === 0) {
    console.error('No posts found. Check SANITY_TOKEN and project credentials.');
    process.exit(1);
  }

  let totalPatches = 0;
  let totalLinksInserted = 0;

  // For each target post, scan all others for link opportunities
  for (const target of posts) {
    const targetUrl = `${RESOURCES_URL}/${target.slug}`;
    const targetKeywords = buildKeywords(target);

    if (targetKeywords.length === 0) continue;

    for (const source of posts) {
      if (source._id === target._id) continue;
      if (!source.body || !Array.isArray(source.body)) continue;

      // Skip if source already links to target
      const alreadyLinked = source.body.some(block => blockHasLink(block, target.slug));
      if (alreadyLinked) continue;

      const isClusterSibling = target.cluster && source.cluster === target.cluster;
      const maxLinks = isClusterSibling ? 2 : 1;
      let linksAdded = 0;

      const newBody = source.body.map(block => {
        if (linksAdded >= maxLinks) return block;
        if (block._type !== 'block') return block;
        if (blockHasLink(block, target.slug)) return block;

        const spanInfo = findLinkableSpan(block, targetKeywords);
        if (spanInfo) {
          linksAdded++;
          return insertLink(block, spanInfo, targetUrl);
        }
        return block;
      });

      if (linksAdded > 0) {
        totalLinksInserted += linksAdded;
        console.log(`  "${source.title}" → add ${linksAdded} link(s) to "${target.title}"`);

        if (!DRY_RUN) {
          try {
            await client.patch(source._id).set({ body: newBody }).commit();
            totalPatches++;
          } catch (err) {
            console.error(`  ERROR patching "${source.title}": ${err.message}`);
          }
        } else {
          totalPatches++;
        }
      }
    }
  }

  console.log(`\n${ DRY_RUN ? '[DRY RUN] Would have applied' : 'Applied'} ${totalPatches} document patch(es) inserting ${totalLinksInserted} internal link(s).`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
