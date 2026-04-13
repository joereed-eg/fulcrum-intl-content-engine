#!/usr/bin/env node

/**
 * FAQ Backfill Script
 *
 * Reads all published resource articles from Sanity, extracts FAQ sections
 * from the body content (h2 "Frequently Asked Questions" → h3/paragraph pairs),
 * and populates the structured `faqs` field for schema markup.
 *
 * Usage:
 *   node scripts/backfill-faqs.js              # dry run — show what would be patched
 *   node scripts/backfill-faqs.js --apply      # actually patch Sanity documents
 */

import crypto from 'crypto';
import getSanityClient from '../utils/sanity-client.js';

const DRY_RUN = !process.argv.includes('--apply');

function extractFaqsFromBody(body) {
  if (!body || !Array.isArray(body)) return [];
  const faqs = [];
  let inFaqSection = false;
  let currentQuestion = '';

  for (const block of body) {
    if (block._type !== 'block') continue;
    const text = (block.children || []).map(c => c.text || '').join('');

    // Detect FAQ section start
    if (block.style === 'h2' && text.toLowerCase().includes('frequently asked')) {
      inFaqSection = true;
      continue;
    }
    // Stop at next h2 after FAQ section
    if (inFaqSection && block.style === 'h2') break;

    if (inFaqSection) {
      if (block.style === 'h3') {
        // If we had a question without an answer, skip it
        currentQuestion = text;
      } else if (currentQuestion && block.style === 'normal' && text.trim()) {
        faqs.push({ question: currentQuestion, answer: text });
        currentQuestion = '';
      }
    }
  }
  return faqs;
}

async function run() {
  const client = getSanityClient();

  console.log(DRY_RUN ? '🔍 DRY RUN — showing what would be patched\n' : '🔧 APPLYING patches to Sanity\n');

  // Fetch all resources — only those without faqs or with empty faqs
  const articles = await client.fetch(
    `*[_type == "resource" && defined(body)]{
      _id, title, "slug": slug.current, body, faqs
    }`
  );

  console.log(`Found ${articles.length} total resource articles\n`);

  let patched = 0;
  let skipped = 0;
  let noFaqs = 0;

  for (const article of articles) {
    // Skip if already has structured FAQs
    if (Array.isArray(article.faqs) && article.faqs.length > 0) {
      skipped++;
      continue;
    }

    const faqs = extractFaqsFromBody(article.body);

    if (faqs.length === 0) {
      noFaqs++;
      console.log(`  ⬜ ${article.slug} — no FAQ section found in body`);
      continue;
    }

    const faqDocs = faqs.map(faq => ({
      _type: 'articleFaq',
      _key: crypto.randomUUID().replace(/-/g, '').slice(0, 12),
      question: faq.question,
      answer: faq.answer,
    }));

    console.log(`  ✅ ${article.slug} — ${faqs.length} FAQs extracted:`);
    for (const faq of faqs) {
      console.log(`     Q: ${faq.question.slice(0, 80)}`);
    }

    if (!DRY_RUN) {
      const docId = article._id.replace(/^drafts\./, '');
      await client.patch(docId).set({ faqs: faqDocs }).commit();
      console.log(`     → Patched ${docId}`);
    }

    patched++;
  }

  console.log(`\n--- Summary ---`);
  console.log(`Total articles: ${articles.length}`);
  console.log(`Already had FAQs: ${skipped}`);
  console.log(`No FAQ section in body: ${noFaqs}`);
  console.log(`${DRY_RUN ? 'Would patch' : 'Patched'}: ${patched}`);

  if (DRY_RUN && patched > 0) {
    console.log(`\nRun with --apply to actually patch these documents.`);
  }
}

run().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
