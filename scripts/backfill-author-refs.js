#!/usr/bin/env node

/**
 * Author Reference Backfill Script
 *
 * Converts existing articles with string author fields ("Joe Reed")
 * to proper Sanity references pointing to the authorProfile document.
 *
 * Usage:
 *   node scripts/backfill-author-refs.js              # dry run
 *   node scripts/backfill-author-refs.js --apply      # patch Sanity documents
 */

import getSanityClient from '../utils/sanity-client.js';

const DRY_RUN = !process.argv.includes('--apply');
const JOE_REED_AUTHOR_ID = '16114936-76f4-4c08-a587-93ac31f3b47a';

async function run() {
  const client = getSanityClient();

  console.log(DRY_RUN ? '🔍 DRY RUN — showing what would be patched\n' : '🔧 APPLYING patches to Sanity\n');

  // Fetch articles where author is a string (not already a reference)
  const articles = await client.fetch(
    `*[_type == "resource" && defined(author) && !defined(author._ref)]{
      _id, title, "slug": slug.current, author
    }`
  );

  console.log(`Found ${articles.length} articles with string author fields\n`);

  let patched = 0;

  for (const article of articles) {
    console.log(`  ✅ ${article.slug} — author: "${article.author}" → reference to Joe Reed`);

    if (!DRY_RUN) {
      const docId = article._id.replace(/^drafts\./, '');
      await client.patch(docId).set({
        author: {
          _type: 'reference',
          _ref: JOE_REED_AUTHOR_ID,
        },
      }).commit();
      console.log(`     → Patched ${docId}`);
    }

    patched++;
  }

  console.log(`\n--- Summary ---`);
  console.log(`${DRY_RUN ? 'Would patch' : 'Patched'}: ${patched}`);

  if (DRY_RUN && patched > 0) {
    console.log(`\nRun with --apply to patch these documents.`);
  }
}

run().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
