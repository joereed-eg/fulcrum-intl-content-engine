import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from '../utils/config.js';
import logger from '../utils/logger.js';
import { sendSlackAlert } from '../utils/slack.js';
import writer from './03-writer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STAGE = 'qc';
const MAX_RETRIES = 4;

function getBrandVoice() {
  return readFileSync(join(__dirname, '..', 'config', 'brand-voice.md'), 'utf-8');
}

async function runQcCheck(job, article) {
  const client = new Anthropic({ apiKey: config.anthropic.apiKey, timeout: 120000 });
  const brandVoice = getBrandVoice();

  // Extract text with link annotations visible for QC
  const articleText = article.body
    .map(b => {
      if (b._type === 'callout') return `[CALLOUT: ${b.label}] ${b.text}`;
      if (b._type === 'block') {
        const linkMap = {};
        (b.markDefs || []).forEach(md => {
          if (md._type === 'link') linkMap[md._key] = md.href;
        });
        const text = (b.children || []).map(c => {
          const t = c.text || '';
          const linkMark = (c.marks || []).find(m => linkMap[m]);
          if (linkMark) return `[${t}](${linkMap[linkMark]})`;
          return t;
        }).join('');
        const prefix = b.style === 'h2' ? '## ' : b.style === 'h3' ? '### ' : b.listItem ? '- ' : '';
        return prefix + text;
      }
      return '';
    })
    .join('\n\n');

  // Pre-count metrics for QC
  const allPlainText = article.body.filter(b => b._type === 'block').map(b => (b.children || []).map(c => c.text || '').join('')).join(' ');
  const wordCount = allPlainText.split(/\s+/).filter(w => w).length;
  const kwRegex = new RegExp(job.primaryKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const keywordCount = (allPlainText.match(kwRegex) || []).length;
  const allLinks = article.body.flatMap(b => (b.markDefs || []).filter(m => m._type === 'link').map(m => m.href));
  const internalLinks = allLinks.filter(l => l.includes('fulcruminternational.org'));
  const externalLinks = allLinks.filter(l => !l.includes('fulcruminternational.org'));
  const ctaLinks = allLinks.filter(l => l.includes('fulcruminternational.org/approach') || l.includes('fulcruminternational.org/diagnostic'));

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `You are a strict brand voice editor for Fulcrum International. Score this article on a 12-point scale using the rubric below.

BRAND VOICE:
${brandVoice}

ARTICLE TITLE: ${job.title}
TARGET WORD COUNT: ${job.wordCountTarget}
PRIMARY KEYWORD: ${job.primaryKeyword}

ARTICLE TEXT:
${articleText}

META TITLE: ${article.metaTitle}
META DESCRIPTION: ${article.metaDescription}

PRE-COUNTED METRICS (verified by code — do not recount):
- Word count: ${wordCount} (target: ${job.wordCountTarget})
- Primary keyword "${job.primaryKeyword}" occurrences: ${keywordCount} (target: 5-6)
- Internal links (fulcruminternational.org): ${internalLinks.length} [${internalLinks.join(', ')}]
- External links: ${externalLinks.length} [${externalLinks.join(', ')}]
- CTA links (/approach or /diagnostic): ${ctaLinks.length}

SCORING RUBRIC — each criterion is pass/fail. Start at 12, subtract 1 for each failure:

1. WORD COUNT: Does it meet or exceed ${job.wordCountTarget} words? Count the actual words in ARTICLE TEXT above. If more than 10% short, fail.
2. PRIMARY KEYWORD: Does "${job.primaryKeyword}" appear 5-6 times naturally? Count exact occurrences. Fewer than 4 = fail.
3. MID-ARTICLE CTA: Is there a CTA with a link to /approach or /diagnostic in the first half of the article? Must be a real paragraph, not just a link. Missing = fail.
4. END CTA: Is there a CTA with a link to /approach or /diagnostic in the final section (after the last h2)? Missing = fail.
5. INTERNAL LINKS: Are there at least 3 links to other fulcruminternational.org pages or articles? Count them. Fewer than 3 = fail.
6. EXTERNAL LINKS: Are there at least 2 links to external authority sources? Count them. Fewer than 2 = fail.
7. LEADER-FIRST: Is the mission-driven leader the hero in every section? Does any sentence start with "Fulcrum is..." or "Fulcrum enables..." or position Fulcrum as the protagonist? Any instance = fail.
8. HUMAN VOICE: Does it sound like a human wrote it? Any banned phrases (leverage, synergy, game-changer, seamless, in today's landscape, ecosystem, it's no secret, the reality is)? Any em dashes? Any AI tells (hollow transitions, vague triple-lists, "and more")? Any instance = fail.
9. OPENING: Does the first paragraph start with something concrete (stat, story, scenario)? Any throat-clearing = fail.
10. CALLOUT: Does the callout block give a specific, actionable takeaway (not a generic summary)? Generic = fail.
11. FAQ SECTION: Is there a "Frequently Asked Questions" h2 with 4-5 h3 questions and paragraph answers after the callout block? Questions should be real search queries. Missing or fewer than 4 = fail.
12. DIRECT ANSWER LEADS: Does every h2 section open with a direct, factual answer statement (1-2 sentences) before expanding? If any h2 section opens with a question, a transition phrase, or vague generality instead of a concrete answer = fail. AI search systems extract these opening sentences as citations.

For each failure, provide:
- Which criterion failed (1-12)
- The specific text that caused the failure
- A concrete fix instruction (e.g., "Add a CTA paragraph after the third h2 section: 'See how agencies...'")

Return ONLY a JSON object:
{
  "pass": true/false,
  "score": 0-12,
  "issues": [ "Criterion X: specific description with quoted problematic text" ],
  "fixes": [ "specific fix instruction that can be applied without ambiguity" ]
}`,
    }],
  });

  const rawText = response.content[0].text;
  let jsonStr = rawText;
  const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonStr = jsonMatch[1].trim();
  else {
    const objMatch = rawText.match(/\{[\s\S]*\}/);
    if (objMatch) jsonStr = objMatch[0];
  }

  try {
    return JSON.parse(jsonStr);
  } catch (err) {
    logger.warn('qc', `QC response JSON parse failed: ${err.message}. Defaulting to pass.`);
    return { pass: true, score: 7, issues: ['QC response was not valid JSON — auto-passed'], fixes: [] };
  }
}

export default async function qc(job, article, research, serpAnalysis = null) {
  logger.info(STAGE, 'Running quality check...');

  let currentArticle = article;
  let retries = 0;

  while (retries <= MAX_RETRIES) {
    const result = await runQcCheck(job, currentArticle);
    logger.info(STAGE, `QC score: ${result.score}/12 (pass: ${result.pass})`);

    if (result.issues?.length) {
      result.issues.forEach(issue => logger.info(STAGE, `Issue: ${issue}`));
    }

    if (result.score >= 10) {
      logger.info(STAGE, `QC passed (score: ${result.score})`);
      return { pass: true, article: currentArticle, score: result.score };
    }

    // On last retry, accept score >= 8 (4 minor failures out of 12 is still publishable)
    if (retries === MAX_RETRIES && result.score >= 8) {
      logger.info(STAGE, `QC passed on final attempt (score: ${result.score})`);
      return { pass: true, article: currentArticle, score: result.score };
    }

    if (result.score >= 6 && retries < MAX_RETRIES) {
      retries++;
      logger.info(STAGE, `Score ${result.score} — sending back for revision (retry ${retries}/${MAX_RETRIES})`);
      currentArticle = await writer(job, research, result.fixes, serpAnalysis);
      continue;
    }

    logger.error(STAGE, `QC failed after ${retries} retries. Score: ${result.score}`);
    await sendSlackAlert(
      `Content pipeline QC failure for "${job.title}"\nScore: ${result.score}/12\nIssues: ${(result.issues || []).join(', ')}\nRow ${job.rowIndex} set to "Needs Review"`
    );
    return { pass: false, article: currentArticle, score: result.score, issues: result.issues };
  }

  // Fallback — should not reach here, but prevents undefined return
  logger.error(STAGE, 'QC loop exited unexpectedly');
  return { pass: false, article: currentArticle, score: 0, issues: ['QC loop exited without result'] };
}

if (process.argv[1] && process.argv[1].endsWith('04-qc.js')) {
  console.log('QC stage requires job and article inputs. Run via pipeline.js');
}
