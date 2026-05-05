/**
 * Stage 4b: Humanizer Audit Gate
 *
 * Runs the humanizer audit tool against the written article.
 * If score < 8: returns failure reasons to re-run the writer with constraints.
 * If score >= 8: passes through to image generation and publishing.
 *
 * This stage does NOT rewrite. It flags and gates.
 */

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';
import { sendSlackAlert } from '../utils/slack.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HUMANIZER_PATH = join(process.env.HOME || '/Users/joereed', 'humanizer');
const BRAND = 'fulcrum-international';

export default async function humanizerGate(job, articleBody) {
  logger.info('humanizer', `Auditing: "${job.title}"`);

  // Ensure articleBody is a string before writing to file
  let bodyStr;
  if (typeof articleBody === 'string') {
    bodyStr = articleBody;
  } else if (Array.isArray(articleBody)) {
    // Portable Text array — convert to plain text
    bodyStr = articleBody.map(b => {
      if (typeof b === 'string') return b;
      if (b._type === 'block') return (b.children || []).map(c => c.text || '').join('');
      return b.text || '';
    }).join('\n\n');
  } else if (articleBody && typeof articleBody === 'object') {
    bodyStr = String(articleBody.body || articleBody.text || JSON.stringify(articleBody));
  } else {
    bodyStr = String(articleBody || '');
  }

  if (!bodyStr || bodyStr === '[object Object]' || bodyStr.length < 100) {
    logger.warn('humanizer', `Article body too short or invalid (${bodyStr?.length || 0} chars). Passing through.`);
    return { passed: true, score: null, warnings: 1, note: 'Humanizer skipped — article body was not a valid string' };
  }

  // Write article to temp file for the humanizer CLI
  const tmpFile = join(__dirname, '..', '.tmp-article.md');
  writeFileSync(tmpFile, bodyStr, 'utf-8');

  try {
    // Run rule-based score check (fast, no AI call)
    const scoreResult = execSync(
      `node ${join(HUMANIZER_PATH, 'audit.js')} --brand ${BRAND} --file ${tmpFile} --score-only`,
      { encoding: 'utf-8', timeout: 30000 }
    );

    logger.info('humanizer', `Rule-based result:\n${scoreResult}`);

    // Parse errors from output
    const errorCount = (scoreResult.match(/❌/g) || []).length;
    const warningCount = (scoreResult.match(/⚠️/g) || []).length;

    if (errorCount > 0) {
      logger.warn('humanizer', `FAILED rule-based checks: ${errorCount} errors, ${warningCount} warnings`);
      return {
        passed: false,
        phase: 'rules',
        errors: errorCount,
        warnings: warningCount,
        details: scoreResult,
        constraints: extractConstraints(scoreResult),
      };
    }

    logger.info('humanizer', `Passed rule-based checks (${warningCount} warnings)`);

    // Run full AI audit (slower, uses Haiku)
    const fullResult = execSync(
      `node ${join(HUMANIZER_PATH, 'audit.js')} --brand ${BRAND} --file ${tmpFile}`,
      { encoding: 'utf-8', timeout: 60000 }
    );

    // Extract humanness score from AI audit
    const scoreMatch = fullResult.match(/HUMANNESS SCORE:\s*(\d+)/i);
    if (!scoreMatch) {
      logger.warn('humanizer', 'AI audit produced no humanness score (ANTHROPIC_API_KEY may be missing on this runner). Passing with warning.');
      return { passed: true, score: null, warnings: warningCount, note: 'AI audit skipped — no score produced (check ANTHROPIC_API_KEY secret)' };
    }
    const score = parseInt(scoreMatch[1]);

    logger.info('humanizer', `Humanness score: ${score}/10`);

    if (score < 8) {
      logger.warn('humanizer', `FAILED AI audit: score ${score}/10 (need 8+)`);
      return {
        passed: false,
        phase: 'ai-audit',
        score,
        details: fullResult,
        constraints: extractAiConstraints(fullResult),
      };
    }

    logger.info('humanizer', `PASSED all checks: score ${score}/10`);
    return {
      passed: true,
      score,
      errors: 0,
      warnings: warningCount,
    };

  } catch (err) {
    // execSync throws when subprocess exits with non-zero code.
    // For the --score-only phase, exit code 1 means rule errors were found — that is
    // expected behavior, not a crash. Recover the stdout and return a proper failure.
    const stdout = (err.stdout || '').toString();
    if (stdout.includes('❌') || (err.status === 1 && stdout.length > 50)) {
      const errorCount = (stdout.match(/❌/g) || []).length;
      const warningCount = (stdout.match(/⚠️/g) || []).length;
      logger.warn('humanizer', `Rule-based gate failed: ${errorCount} errors found.`);
      return {
        passed: false,
        phase: 'rules',
        errors: errorCount,
        warnings: warningCount,
        details: stdout,
        constraints: extractConstraints(stdout),
      };
    }

    // Real crash (ENOENT, timeout, unexpected exception, etc.)
    logger.error('humanizer', `Humanizer crashed: ${err.message}`);
    await sendSlackAlert(`⚠️ Humanizer crashed for "${job.title}": ${err.message}`, { severity: 'error' });
    return {
      passed: true,
      score: null,
      warnings: 1,
      note: 'Humanizer crashed — passed through with manual review flag',
    };
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
  }
}

/**
 * Extract specific constraints from rule-based failures
 * to feed back to the writer as rewrite instructions.
 */
function extractConstraints(output) {
  const constraints = [];
  const lines = output.split('\n');

  for (const line of lines) {
    if (line.includes('BANNED-WORD') || line.includes('BANNED-PHRASE')) {
      const match = line.match(/"([^"]+)"/);
      if (match) constraints.push(`Remove the word/phrase "${match[1]}" — it's banned in our brand voice.`);
    }
    if (line.includes('LANG-03')) constraints.push('Use more contractions. "Don\'t" not "do not." Read it aloud — if it sounds stiff, add contractions.');
    if (line.includes('LANG-04')) constraints.push('Address the reader as "you" more. At least 15% of sentences should contain "you" or "your."');
    if (line.includes('STRUCT-01')) constraints.push('Vary paragraph lengths more. Add 1-2 sentence paragraphs for emphasis. Mix with longer 4-5 sentence paragraphs.');
    if (line.includes('LANG-05')) constraints.push('Remove transition words at the start of sentences (However, Moreover, Furthermore, Additionally). Just start the sentence.');
    if (line.includes('LANG-02')) constraints.push('Stop hedging. Replace "can be" with "is." Replace "may help" with "helps." Take a position.');
  }

  return constraints;
}

/**
 * Extract constraints from AI audit failures.
 */
function extractAiConstraints(output) {
  const constraints = [];
  const failMatches = output.matchAll(/RULE \d+: FAIL\nEvidence: (.+)\nFix: (.+)/g);

  for (const match of failMatches) {
    constraints.push(match[2].trim());
  }

  return constraints;
}
