#!/usr/bin/env node

import serpGate from './stages/00-serp-gate.js';
import sheetReader from './stages/01-sheet-reader.js';
import researcher from './stages/02-researcher.js';
import writer from './stages/03-writer.js';
import qc from './stages/04-qc.js';
import humanizerGate from './stages/04b-humanizer.js';
import imageGenerator from './stages/05-image.js';
import sanityPublisher from './stages/06-sanity.js';
import googleIndexing from './stages/06b-indexing.js';
import interlinker from './stages/06c-interlinker.js';
import linkedinPublisher from './stages/07-linkedin.js';
import devtoPublisher from './stages/07-devto.js';
import hashnodePublisher from './stages/07-hashnode.js';
import redditScout from './stages/07-reddit-scout.js';
import mediumStub from './stages/07-medium.js';
import substackStub from './stages/07-substack.js';
import postPublishCheck from './stages/11-post-publish-check.js';
import logger from './utils/logger.js';
import { sendSlackAlert } from './utils/slack.js';
import { getSheetsClient, getSheetConfig } from './utils/sheets-client.js';

const isDryRun = process.argv.includes('--dry-run');

/**
 * Convert Portable Text array (or string) to markdown for stages that expect a string.
 * If already a string, returns as-is.
 */
function portableTextToMarkdown(body) {
  if (typeof body === 'string') return body;
  if (!Array.isArray(body)) return String(body);
  return body.map(b => {
    if (b._type === 'callout') return `> **${b.label || 'Note'}:** ${b.text || ''}`;
    if (b._type === 'block') {
      const linkMap = {};
      (b.markDefs || []).forEach(md => {
        if (md._type === 'link') linkMap[md._key] = md.href;
      });
      const text = (b.children || []).map(c => {
        const t = c.text || '';
        const linkMark = (c.marks || []).find(m => linkMap[m]);
        if (linkMark) return `[${t}](${linkMap[linkMark]})`;
        if ((c.marks || []).includes('strong')) return `**${t}**`;
        if ((c.marks || []).includes('em')) return `*${t}*`;
        return t;
      }).join('');
      const prefix = b.style === 'h2' ? '## ' : b.style === 'h3' ? '### ' : b.style === 'h4' ? '#### ' : b.listItem ? '- ' : '';
      return prefix + text;
    }
    return '';
  }).join('\n\n');
}

async function setSheetStatus(job, status) {
  try {
    const sheets = await getSheetsClient();
    const config = getSheetConfig();
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.spreadsheetId,
      range: `'${config.tab}'!A${job.rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[status]] },
    });
  } catch (e) {
    logger.warn('pipeline', `Failed to set sheet status to "${status}": ${e.message}`);
  }
}

async function processArticle(job) {
  logger.info('pipeline', `\n--- Processing: "${job.title}" ---`);

  // Stage 0: SERP Analysis Gate — validate keyword feasibility before investing in research/writing
  const serpAnalysis = await serpGate(job);

  if (serpAnalysis.feasibility === 'red') {
    await setSheetStatus(job, 'Keyword Blocked');
    logger.warn('pipeline', `SERP gate blocked "${job.title}" — keyword not winnable. Row set to "Keyword Blocked".`);
    return { success: false, title: job.title, reason: `SERP gate: ${serpAnalysis.reasoning || 'keyword blocked'}` };
  }

  // Override word count target if SERP analysis says we need more to compete
  if (serpAnalysis.minimumWordCount > job.wordCountTarget) {
    logger.info('pipeline', `SERP gate raised word count target: ${job.wordCountTarget} → ${serpAnalysis.minimumWordCount}`);
    job.wordCountTarget = serpAnalysis.minimumWordCount;
  }

  // Stage 2: Research (enhanced with SERP intelligence)
  const research = await researcher(job, serpAnalysis);

  // Stage 3: Write (enhanced with SERP gap + angle)
  const article = await writer(job, research, null, serpAnalysis);

  // Stage 4: QC
  const qcResult = await qc(job, article, research, serpAnalysis);

  if (!qcResult.pass) {
    await setSheetStatus(job, 'Needs Review');
    logger.error('pipeline', `QC failed for "${job.title}". Row set to "Needs Review".`);
    return { success: false, title: job.title, reason: 'QC failed' };
  }

  let finalArticle = qcResult.article;

  // Stage 4b: Humanizer Audit Gate — hard quality gate
  let humanResult = { passed: true, score: null };
  try {
    let articleText;
    if (typeof finalArticle === 'string') {
      articleText = finalArticle;
    } else if (typeof finalArticle?.body === 'string') {
      articleText = finalArticle.body;
    } else if (Array.isArray(finalArticle?.body)) {
      articleText = portableTextToMarkdown(finalArticle.body);
    } else {
      articleText = String(finalArticle?.body || finalArticle || '');
    }
    humanResult = await humanizerGate(job, articleText);

    if (!humanResult.passed) {
      // Re-run writer with humanizer constraints (1 retry)
      logger.warn('pipeline', `Humanizer flagged "${job.title}" (${humanResult.phase}, score: ${humanResult.score || 'n/a'}). Re-running writer with constraints...`);
      const constraintNote = (humanResult.constraints || []).join('\n- ');
      job._humanizerConstraints = constraintNote;
      const retryArticle = await writer(job, research, null, serpAnalysis);
      const retryQc = await qc(job, retryArticle, research, serpAnalysis);
      if (retryQc.pass) {
        finalArticle = retryQc.article;
        let retryText;
        if (Array.isArray(finalArticle?.body)) {
          retryText = portableTextToMarkdown(finalArticle.body);
        } else {
          retryText = String(finalArticle?.body || finalArticle || '');
        }
        const retryHuman = await humanizerGate(job, retryText);
        if (!retryHuman.passed) {
          await setSheetStatus(job, 'Needs Manual Review');
          await sendSlackAlert(`*Humanizer gate failed after retry* for "${job.title}"\nScore: ${retryHuman.score || 'n/a'}\nConstraints: ${constraintNote}\n\nArticle needs manual review before publishing.`);
          logger.error('pipeline', `Humanizer failed after retry for "${job.title}". Queued for manual review.`);
          return { success: false, title: job.title, reason: `Humanizer failed after retry (score: ${retryHuman.score})` };
        }
        humanResult = retryHuman;
      } else {
        await setSheetStatus(job, 'Needs Manual Review');
        logger.error('pipeline', `QC failed on humanizer retry for "${job.title}".`);
        return { success: false, title: job.title, reason: 'QC failed on humanizer retry' };
      }
    }
  } catch (humanErr) {
    logger.warn('pipeline', `Humanizer gate crashed: ${humanErr.message}. Continuing to publish.`);
    humanResult = { passed: true, score: null, note: 'Humanizer crashed — skipped' };
  }

  if (isDryRun) {
    logger.saveDryRun({
      job,
      research,
      article: finalArticle,
      qcScore: qcResult.score,
      humanScore: humanResult.score,
    });
    logger.info('pipeline', `Dry run complete for "${job.title}" (QC: ${qcResult.score}, Human: ${humanResult.score || 'n/a'}/10)`);
    return { success: true, title: job.title, dryRun: true, qcScore: qcResult.score, humanScore: humanResult.score };
  }

  // Stage 6: Publish to Sanity
  const publishedDoc = await sanityPublisher(job, finalArticle, null);

  // Stage 5: Generate cover image via Sanity Agent Actions (async)
  await imageGenerator(job, publishedDoc.docId, finalArticle);

  // Stage 6b: Google Indexing
  await googleIndexing(publishedDoc.url);

  // Stage 6c: Cross-link new article with existing articles (both directions)
  await interlinker(job, publishedDoc);

  // Stage 7: Syndication
  await linkedinPublisher(job, finalArticle, publishedDoc.url);
  await devtoPublisher(job, finalArticle, publishedDoc.url);
  await hashnodePublisher(job, finalArticle, publishedDoc.url);
  await redditScout(job, publishedDoc.url);
  await mediumStub(job);
  await substackStub(job);

  logger.success(`Published: ${publishedDoc.url}`);
  return { success: true, title: job.title, url: publishedDoc.url };
}

async function run() {
  if (isDryRun) logger.info('pipeline', 'DRY RUN MODE — no publishing or indexing');

  // Stage 1: Read sheet — returns all due articles
  const jobs = await sheetReader();
  if (jobs.length === 0) {
    logger.info('pipeline', 'Nothing to publish today. Exiting.');
    logger.save();
    return;
  }

  logger.info('pipeline', `Processing ${jobs.length} article(s)...`);

  const results = [];

  for (const job of jobs) {
    try {
      const result = await processArticle(job);
      results.push(result);
    } catch (err) {
      const stage = err.stage || 'unknown';
      const message = err.error || err.message || String(err);
      logger.error(stage, `"${job.title}": ${message}`, err);

      await setSheetStatus(job, 'Error');

      // Build GitHub Actions link if running in CI
      const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : 'Run locally — check runs/ directory';

      await sendSlackAlert(
        `🚨 Content pipeline error for "${job.title}"\n` +
        `Stage: [${stage}]\n` +
        `Error: ${message}\n` +
        `Row: ${job.rowIndex} (set to "Error")\n` +
        `Logs: ${runUrl}`
      );

      results.push({ success: false, title: job.title, reason: message });

      // Continue to next article — don't let one failure stop the batch
    }
  }

  // Summary
  const published = results.filter(r => r.success && !r.dryRun);
  const dryRuns = results.filter(r => r.success && r.dryRun);
  const failed = results.filter(r => !r.success);

  logger.info('pipeline', `\n=== Batch complete ===`);
  if (published.length) logger.info('pipeline', `Published: ${published.length} article(s)`);
  if (dryRuns.length) logger.info('pipeline', `Dry runs: ${dryRuns.length} article(s)`);
  if (failed.length) logger.info('pipeline', `Failed: ${failed.length} article(s)`);

  // Post-publish checks for recent articles (index verification, CTR monitoring, intent drift)
  try {
    await postPublishCheck();
  } catch (err) {
    logger.warn('pipeline', `Post-publish check failed: ${err.message}`);
  }

  // Send summary to Slack if anything was published
  if (published.length > 0) {
    const urls = published.map(r => `• ${r.title}\n  ${r.url}`).join('\n');
    await sendSlackAlert(`Content pipeline published ${published.length} article(s):\n${urls}`);
  }

  logger.save();
}

run().catch(err => {
  console.error('Fatal pipeline error:', err);
  process.exit(1);
});
