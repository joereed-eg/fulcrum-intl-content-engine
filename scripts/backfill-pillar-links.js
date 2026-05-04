#!/usr/bin/env node
/**
 * Backfill Pillar Page Links — Fulcrum International
 *
 * Adds inline links to pillar pages in all existing published posts.
 * The regular interlinker handles this for new articles, but existing posts
 * never got these links because the engine was broken at launch.
 *
 * Usage:
 *   node scripts/backfill-pillar-links.js              # dry run
 *   node scripts/backfill-pillar-links.js --apply      # write to Sanity
 *
 * Requires: SANITY_TOKEN env var with editor access to project tur3pati.
 */

import getSanityClient from '../utils/sanity-client.js';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = !process.argv.includes('--apply');
const SITE_URL = 'https://www.fulcruminternational.org';

if (DRY_RUN) console.log('\n[DRY RUN] Pass --apply to write changes to Sanity.\n');

function genKey() { return crypto.randomBytes(6).toString('hex'); }

function blockToText(block) {
  if (block._type !== 'block') return '';
  return (block.children || []).map(c => c.text || '').join('');
}

function blockHasLink(block, url) {
  if (!block.markDefs) return false;
  return block.markDefs.some(md => md._type === 'link' && md.href && md.href.includes(url));
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
      const childEnd = charPos + (child.text || '').length;
      if (idx >= charPos && idx < childEnd && (!child.marks || child.marks.length === 0)) {
        return { childIndex: block.children.indexOf(child), matchStart: idx - charPos, matchEnd: idx - charPos + keyword.length };
      }
      charPos = childEnd;
    }
  }
  return null;
}

function insertLink(block, spanInfo, href) {
  const child = block.children[spanInfo.childIndex];
  const before = child.text.slice(0, spanInfo.matchStart);
  const match = child.text.slice(spanInfo.matchStart, spanInfo.matchEnd);
  const after = child.text.slice(spanInfo.matchEnd);
  const linkKey = genKey();
  const newChildren = [];
  if (before) newChildren.push({ _type: 'span', _key: genKey(), text: before, marks: [] });
  newChildren.push({ _type: 'span', _key: genKey(), text: match, marks: [linkKey] });
  if (after) newChildren.push({ _type: 'span', _key: genKey(), text: after, marks: [] });
  return {
    ...block,
    children: [...block.children.slice(0, spanInfo.childIndex), ...newChildren, ...block.children.slice(spanInfo.childIndex + 1)],
    markDefs: [...(block.markDefs || []), { _type: 'link', _key: linkKey, href }],
  };
}

async function run() {
  const client = getSanityClient();

  const pillarPages = JSON.parse(readFileSync(join(__dirname, '..', 'pillar-pages.json'), 'utf-8'));
  console.log(`Loaded ${pillarPages.length} pillar pages.`);

  const posts = await client.fetch(
    `*[_type == "post" && defined(slug.current) && !(_id in path("drafts.**"))]{_id, title, "slug": slug.current, body}`
  );
  console.log(`Found ${posts.length} posts.\n`);

  let totalPatches = 0;
  let totalLinks = 0;

  for (const post of posts) {
    if (!post.body || !Array.isArray(post.body)) continue;

    const articleText = post.body.filter(b => b._type === 'block').map(b => blockToText(b)).join(' ').toLowerCase();

    const scoredPillars = pillarPages
      .map(p => ({ ...p, matchCount: p.keywords.filter(kw => articleText.includes(kw.toLowerCase())).length }))
      .filter(p => p.matchCount > 0)
      .sort((a, b) => b.matchCount - a.matchCount);

    let pillarsToLink = scoredPillars;
    if (pillarsToLink.length < 2) {
      const remaining = pillarPages.filter(p => !pillarsToLink.find(sp => sp.url === p.url));
      pillarsToLink = [...pillarsToLink, ...remaining.slice(0, 2 - pillarsToLink.length)];
    }

    let updatedBody = [...post.body];
    let linksAdded = 0;

    for (const pillar of pillarsToLink) {
      const fullUrl = `${SITE_URL}${pillar.url}`;
      const alreadyLinked = updatedBody.some(block => blockHasLink(block, pillar.url));
      if (alreadyLinked) continue;

      let linked = false;
      updatedBody = updatedBody.map(block => {
        if (linked || block._type !== 'block' || blockHasLink(block, pillar.url)) return block;
        const spanInfo = findLinkableSpan(block, pillar.keywords);
        if (spanInfo) { linked = true; linksAdded++; return insertLink(block, spanInfo, fullUrl); }
        return block;
      });
    }

    if (linksAdded > 0) {
      totalLinks += linksAdded;
      totalPatches++;
      console.log(`  "${post.title}" → ${linksAdded} pillar link(s)`);
      if (!DRY_RUN) {
        try {
          await client.patch(post._id).set({ body: updatedBody }).commit();
        } catch (err) {
          console.error(`  ERROR: ${err.message}`);
        }
      }
    }
  }

  console.log(`\n${DRY_RUN ? '[DRY RUN] Would apply' : 'Applied'} ${totalPatches} patch(es) with ${totalLinks} pillar link(s).`);
}

run().catch(err => { console.error(err); process.exit(1); });
