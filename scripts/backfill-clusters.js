#!/usr/bin/env node

/**
 * Cluster Backfill Script
 *
 * Maps existing articles to topic clusters based on their tags and title.
 * Uses the same cluster definitions as the frontend topic pages.
 *
 * Usage:
 *   node scripts/backfill-clusters.js              # dry run
 *   node scripts/backfill-clusters.js --apply      # patch Sanity documents
 */

import getSanityClient from '../utils/sanity-client.js';

const DRY_RUN = !process.argv.includes('--apply');

// Same mapping as frontend CLUSTER_META + tag associations
const CLUSTER_RULES = [
  {
    cluster: 'revenue',
    contentLayer: 'supporting',
    matchTags: ['revenue', 'roi', 'commission'],
    matchTitle: ['revenue', 'earn', 'monetiz', 'commission', 'referral'],
  },
  {
    cluster: 'ghost-directories',
    contentLayer: 'supporting',
    matchTags: ['directories', 'network-building'],
    matchTitle: ['ghost', 'stale', 'dead director', 'keep.*alive'],
  },
  {
    cluster: 'white-label',
    contentLayer: 'supporting',
    matchTags: ['white-label', 'platform-guides'],
    matchTitle: ['white-label', 'white label', 'branded director'],
  },
  {
    cluster: 'multi-agency',
    contentLayer: 'supporting',
    matchTags: ['network-building', 'provider-directory'],
    matchTitle: ['multi-agency', 'multi agency', 'cross-network', 'listing'],
  },
  {
    cluster: 'commission-pricing',
    contentLayer: 'supporting',
    matchTags: ['commission', 'revenue', 'strategy'],
    matchTitle: ['commission', 'pricing', 'subscription', 'cost'],
  },
  {
    cluster: 'directory-vs-marketplace',
    contentLayer: 'supporting',
    matchTags: ['directories', 'strategy'],
    matchTitle: ['marketplace', 'directory vs', 'three-sided', 'platform'],
  },
];

function detectCluster(article) {
  const tags = (article.tags || []).map(t => t.toLowerCase());
  const titleLower = article.title.toLowerCase();

  let bestMatch = null;
  let bestScore = 0;

  for (const rule of CLUSTER_RULES) {
    let score = 0;

    // Tag matches
    for (const tag of rule.matchTags) {
      if (tags.includes(tag)) score += 2;
    }

    // Title matches
    for (const pattern of rule.matchTitle) {
      if (titleLower.includes(pattern) || new RegExp(pattern, 'i').test(titleLower)) {
        score += 3;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = rule;
    }
  }

  return bestScore >= 2 ? bestMatch : null;
}

async function run() {
  const client = getSanityClient();

  console.log(DRY_RUN ? '🔍 DRY RUN — showing what would be patched\n' : '🔧 APPLYING patches to Sanity\n');

  const articles = await client.fetch(
    `*[_type == "resource"]{
      _id, title, "slug": slug.current, tags, cluster, contentLayer
    }`
  );

  console.log(`Found ${articles.length} total articles\n`);

  let patched = 0;
  let skipped = 0;
  let noMatch = 0;

  for (const article of articles) {
    if (article.cluster) {
      skipped++;
      console.log(`  ⏭️  ${article.slug} — already has cluster "${article.cluster}"`);
      continue;
    }

    const match = detectCluster(article);

    if (!match) {
      noMatch++;
      console.log(`  ⬜ ${article.slug} — no cluster match found`);
      console.log(`     Tags: ${(article.tags || []).join(', ')}`);
      continue;
    }

    console.log(`  ✅ ${article.slug} → cluster: "${match.cluster}", layer: "${match.contentLayer}"`);

    if (!DRY_RUN) {
      const docId = article._id.replace(/^drafts\./, '');
      await client.patch(docId).set({
        cluster: match.cluster,
        contentLayer: match.contentLayer,
      }).commit();
      console.log(`     → Patched ${docId}`);
    }

    patched++;
  }

  console.log(`\n--- Summary ---`);
  console.log(`Total: ${articles.length}`);
  console.log(`Already clustered: ${skipped}`);
  console.log(`No match: ${noMatch}`);
  console.log(`${DRY_RUN ? 'Would patch' : 'Patched'}: ${patched}`);

  if (DRY_RUN && patched > 0) {
    console.log(`\nRun with --apply to patch these documents.`);
  }
}

run().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
