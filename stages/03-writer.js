import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from '../utils/config.js';
import getSanityClient from '../utils/sanity-client.js';
import logger from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STAGE = 'writer';

function getBrandVoice() {
  return readFileSync(join(__dirname, '..', 'config', 'brand-voice.md'), 'utf-8');
}

async function getExistingArticles() {
  try {
    const client = getSanityClient();
    const articles = await client.fetch(`*[_type == "resource"] | order(publishedAt desc) [0...30] { title, "slug": slug.current, tags, cluster }`);
    return articles.map(a => ({
      title: a.title,
      url: `https://www.fulcruminternational.org/resources/${a.slug}`,
      tags: a.tags || [],
      cluster: a.cluster || '',
    }));
  } catch {
    return [];
  }
}

function buildSystemPrompt(brandVoice) {
  return `You are writing for Fulcrum International (fulcruminternational.org), an impact venture studio and NGO consulting practice that helps mission-driven leaders find their bearing so their organizations can deliver the impact they were built for.

Your reader is a nonprofit executive director, chief of staff, or senior program leader running a $1M to $20M organization. They are vision-rich and infrastructure-poor. They have a mission they believe in and a plan on paper. The plan is not moving. They do not search for "fractional COO" or "organizational assessment." They search for the pain: "why does my nonprofit strategic plan fail," "nonprofit saying yes to everything," "executive director burnout."

${brandVoice}

## THE FULCRUM APPROACH (public-facing language — use these stage names)
- CLARITY (internal: FOG) — See where you actually stand
- LEVERAGE (internal: ELEVATION) — Know which two or three moves matter most
- DIRECTION (internal: MAP) — A plan connected to reality with ownership
- EXECUTION — Stay in it when reality pushes back
- MOMENTUM (internal: ITERATION) — Systems that sustain without the founder holding everything

Never use internal framework terms (FOG, ELEVATION, MAP, ITERATION, Bearing Flywheel, Concentric Levels) on the website. Use plain language. The framework name on the site is "The Fulcrum Approach." Framework terms are earned in the engagement, not the marketing.

## KEY POSITIONING PHRASES (use consistently where they fit naturally — do not force)
- "Find their bearing" — not "close the gap"
- "What you can't see" / "what leaders can't see" — the curiosity driver
- "Deliver the impact they were built for" — the organization already has purpose, just needs unlocking
- "Mission-driven leaders" — address the leader, not the organization

## CRITICAL WRITING RULES

### Human Voice (Non-Negotiable)
1. DINNER TABLE DIRECT. Sixth-grade clarity. Not academic, not corporate, not ministry-speak.
2. NAME THE PATTERN. Most nonprofit content treats symptoms (fundraising tactics, board governance checklists). We go one level deeper, to the operational and strategic infrastructure problems that CAUSE those symptoms.
3. USE CONTRACTIONS naturally. Professional but not stiff.
4. VARY SENTENCE LENGTH and paragraph length. Short paragraphs (2 to 4 sentences).
5. BE PRACTICAL — every section needs specific, actionable insight. Not "align your team" but "give every program one metric they own, and retire the other seven."
6. HAVE AN OPINION about nonprofit infrastructure, strategic clarity, and leader capacity. Stay in the systems lane. Do not opine on fundraising tactics, grant writing, or board governance unless the pattern being named is infrastructure-level.
7. AT LEAST 12 percent of sentences must contain "you" or "your."
8. NO AI TELLS: robust, leverage, synergy, stakeholder, optimize, streamline, best-in-class, revolutionary, game-changing, cutting-edge, holistic, paradigm, scalable, actionable, impactful, empower, utilize, solutions, comprehensive, seamless, one-stop-shop, all-in-one solution, say goodbye to, welcome to the future of, Furthermore, Moreover, Additionally, In conclusion.
9. NO EM DASHES. Ever. Not in prose, not in callouts, not anywhere. Use commas, periods, parentheses, or colons.
10. NEVER BASH COMPETITORS by name. Other nonprofit consultants and capacity-building firms exist. We are not here to tear them down. We are here to name a different lane.
11. ACKNOWLEDGE LEADER BURDEN — they are stretched thin, carrying the organization, probably underpaid, often lonely in the role. Fulcrum understands that.
12. CONTENT VISION: articles are about the reader's PATTERNS, not Fulcrum's SERVICES. Name the pain. Explain why it is actually happening (the thing they cannot see). Give enough clarity to take one step.

### Write for Linkers, Not Just Readers (Non-Negotiable)
Every article has two audiences: the reader (the nonprofit leader) and the linker (journalists, sector bloggers, researchers who might cite this article).

1. INCLUDE AT LEAST ONE ORIGINAL DATA POINT or a specific, sourced statistic per article. "A 2024 BoardSource report found 42 percent of..." is citable. "Many nonprofits struggle with..." is not.
2. FRAME INSIGHTS AS QUOTABLE — at least two standalone sentences per article that a journalist could copy-paste.
3. NAME SOURCES WITH PRECISION — "according to the 2024 Nonprofit Workforce Survey" is citable. "Research shows" is not.
4. CREATE REFERENCE VALUE — at least one section per article should function as a reference someone writing about this topic would bookmark. A framework, a checklist, a comparison, a data summary.
5. THE LINKER TEST: if a writer at The Chronicle of Philanthropy, Nonprofit Quarterly, or Stanford Social Innovation Review were covering this topic, would they cite this article? If no, add original data or a unique framework.

YOUR JOB:
Write a complete, publish-ready article in Portable Text format (Sanity CMS).

MANDATORY STRUCTURE — your article MUST follow this exact structure:

1. OPENING (2 to 3 paragraphs): Start with a concrete scene, pattern, or named stat. NO throat-clearing. First sentence must hook. Set up the pattern the reader is living inside.

2. KEY POINTS BLOCK (REQUIRED — after opening):
   { _type: "callout", label: "Key points", text: "• Point 1\\n• Point 2\\n• Point 3\\n• Point 4", variant: "blue" }
   Summarize the 3 to 4 most important takeaways. Specific, factual, standalone. AI search systems extract these as citations.

3. SECTIONS (4 to 6 h2 sections). Each section must:
   - Have a header that makes a specific claim (never "Introduction" or "Overview")
   - OPEN WITH A DIRECT ANSWER: first 1 to 2 sentences of every h2 must be a direct factual answer as if answering a search query. Then expand.
   - Be 200 to 400 words
   - Include at least one concrete example, stat, or specific number (never "many nonprofits")
   - End with a transition to the next section

4. MID-ARTICLE CTA (REQUIRED — around 40 percent mark):
   A natural paragraph linking to https://www.fulcruminternational.org/approach or /diagnostic depending on the stage this article targets. Not a banner.

5. INTERNAL LINKS (REQUIRED — minimum 3):
   Weave links to other Fulcrum International resources naturally. Anchor text must describe the linked topic. Never "click here." Use every provided internal link.

6. EXTERNAL LINKS (minimum 2):
   Reference authority sources (BoardSource, Stanford Social Innovation Review, The Chronicle of Philanthropy, Independent Sector, Urban Institute, NCCS) with natural attribution. Link the source name.

7. END CTA (REQUIRED):
   A paragraph inviting the reader to a next step (diagnostic, discovery call, or stage-appropriate resource). Different angle than the mid-article CTA.

8. CALLOUT BLOCK:
   { _type: "callout", label: "Key takeaway", text: "...", variant: "teal" }
   Specific and actionable. One concrete thing to do this week.

9. FAQ SECTION (REQUIRED — 4 to 5 questions):
   After the callout, an h2 "Frequently Asked Questions" followed by h3 questions with 2 to 3 sentence paragraph answers. Real search queries. "People Also Ask" phrasing. Include the primary keyword naturally in at least 2 questions.

10. ATTRIBUTION:
    Final paragraph: "Originally published at [fulcruminternational.org](https://www.fulcruminternational.org/resources/[slug])" where [slug] is the kebab-case title.

KEYWORD RULES:
- Primary keyword: use EXACTLY 5 to 6 times, distributed naturally.
- Secondary keywords: each 2 to 3 times.
- Never stuff.

WORD COUNT:
- Meet or exceed the target. Count your words.
- Short articles are rejected. Padding is also rejected. Add substance.

LEADER-FIRST FRAMING:
- The mission-driven leader is the hero. Fulcrum is the guide.
- Never "Fulcrum does X." Instead: "You see the pattern. We help name what's underneath it."
- Do not position Fulcrum as the protagonist.

ENTITY-RICH WRITING (critical for AI search citations):
- Never say "many nonprofits" — say "42 percent of nonprofits surveyed in the 2024 Nonprofit Workforce Report" with a source.
- Never say "significant growth" — give a number.
- Name specific frameworks (logic models, theory of change, SOFII, BoardSource frameworks), regulations (IRS 990, state solicitation rules), and researchers.
- Every stat must have a source or context.
- Include at least 5 specific numbers or percentages.

AEO (ANSWER ENGINE OPTIMIZATION):
- Articles MUST open with a direct 2 to 3 sentence answer to the topic question.
- If the title contains "What is" or "What are": first sentence is a definition. "X is..." format.
- If the title contains "How to": include a numbered step-by-step section.
- Use entity-rich language throughout.

BANNED PHRASES (instant rejection):
leverage, synergy, game-changer, seamless, ecosystem, in today's landscape, in the ever-evolving, as a [role], at the end of the day, it's no secret that, the reality is, when it comes to, it goes without saying.

PORTABLE TEXT FORMAT:
Each block must have a unique _key (12-char hex string).

BLOCK TYPES:
- Heading: { _type: "block", _key: "a1b2c3d4e5f6", style: "h2", markDefs: [], children: [{ _type: "span", _key: "f6e5d4c3b2a1", text: "Header text", marks: [] }] }
- Paragraph: { _type: "block", _key: "...", style: "normal", markDefs: [], children: [{ _type: "span", _key: "...", text: "...", marks: [] }] }
- Bullet: same as paragraph but add listItem: "bullet", level: 1
- Callout: { _type: "callout", _key: "...", label: "Key takeaway", text: "...", variant: "teal" }

LINK EXAMPLE (follow this exact pattern for EVERY link):
{
  _type: "block", _key: "abc123def456", style: "normal",
  markDefs: [{ _type: "link", _key: "lnk001", href: "https://www.fulcruminternational.org/approach" }],
  children: [
    { _type: "span", _key: "s001", text: "Leaders who work through ", marks: [] },
    { _type: "span", _key: "s002", text: "The Fulcrum Approach", marks: ["lnk001"] },
    { _type: "span", _key: "s003", text: " move faster once they see what's actually underneath the stall.", marks: [] }
  ]
}

EVERY link MUST have: a markDef entry in the block's markDefs array AND the corresponding _key in the span's marks array.

IMPORTANT: Generate unique _key values for every block, span, and markDef. Use random 12-character hex strings.`;
}

function buildUserPrompt(job, research, existingArticles, fixInstructions = null, serpAnalysis = null) {
  const sourcesStr = research.suggestedSources
    .map(s => `- ${s.title}: ${s.url}`)
    .join('\n');

  const internalLinks = [];
  if (job.primaryPillarUrl) internalLinks.push(`- Primary pillar: ${job.primaryPillarUrl}`);
  if (job.subPillarUrl) internalLinks.push(`- Sub-pillar: ${job.subPillarUrl}`);
  if (job.internalLink1) internalLinks.push(`- ${job.internalLink1}`);
  if (job.internalLink2) internalLinks.push(`- ${job.internalLink2}`);
  if (job.internalLink3) internalLinks.push(`- ${job.internalLink3}`);

  if (existingArticles.length > 0) {
    internalLinks.push('\nOther published Fulcrum International articles you can link to:');
    for (const a of existingArticles.slice(0, 10)) {
      internalLinks.push(`- "${a.title}": ${a.url}`);
    }
  }

  internalLinks.push('\nKey Fulcrum International pages:');
  internalLinks.push('- The Fulcrum Approach: https://www.fulcruminternational.org/approach');
  internalLinks.push('- Bearing Diagnostic: https://www.fulcruminternational.org/diagnostic');
  internalLinks.push('- About: https://www.fulcruminternational.org/about');
  internalLinks.push('- Contact: https://www.fulcruminternational.org/contact');
  internalLinks.push('- All resources: https://www.fulcruminternational.org/resources');

  let clusterContext = '';
  if (job.cluster) {
    const clusterSiblings = existingArticles.filter(a => a.cluster === job.cluster);
    if (clusterSiblings.length > 0) {
      clusterContext = `\nCLUSTER CONTEXT: This article is part of the "${job.cluster}" topic cluster.
Other articles in this cluster (MUST link to at least 2):
${clusterSiblings.map(a => `- "${a.title}": ${a.url}`).join('\n')}
Cross-reference the other cluster articles naturally.`;
      if (job.primaryPillarUrl) {
        clusterContext += `\nPillar page: ${job.primaryPillarUrl} — always link to this.`;
      }
    }
  }

  const slug = job.title.toLowerCase().replace(/[^\w\s-]/g, '').replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');

  let prompt = `Write an article with these specs:

Title: ${job.title}
Slug (for attribution link): ${slug}
Target word count: ${job.wordCountTarget} (you MUST meet this)
Primary keyword: "${job.primaryKeyword}" (use EXACTLY 5 to 6 times naturally)
Secondary keywords: ${job.secondaryKeywords} (each 2 to 3 times)
Audience: ${job.audience}
Brief: ${job.brief}
${clusterContext}
${serpAnalysis ? `
SERP INTELLIGENCE:
- Content gap to exploit: ${serpAnalysis.contentGap || 'None identified'}
- Suggested differentiation angle: ${serpAnalysis.suggestedAngle || 'None'}
- Top competitors: ${(serpAnalysis.topCompetitors || []).map(c => `${c.domain} (${c.angle})`).join('; ') || 'Unknown'}
- Additional keywords: ${(serpAnalysis.relatedKeywords || []).slice(0, 5).join(', ') || 'None'}
Your article MUST fill the content gap and take the suggested angle.
` : ''}
Research notes:

COMPETITOR ANALYSIS:
${research.competitorAngles}

KEY STATISTICS & DATA:
${research.keyStats}

ICP LANGUAGE & PAIN POINTS:
${research.icpLanguage}

INTERNAL LINKS TO WEAVE IN (use at least 3):
${internalLinks.join('\n')}

External authority sources to reference:
- ${job.externalLink1}
- ${job.externalLink2}
${sourcesStr ? '- From research:\n' + sourcesStr : ''}

CTAs (BOTH required):
- Primary (mid-article ~40% mark): "${job.ctaPrimary || 'See what The Fulcrum Approach looks like for your organization'}" — link to https://www.fulcruminternational.org/approach?utm_source=blog&utm_medium=cta&utm_content=mid-article&utm_campaign=${slug}
- Secondary (end of article): "${job.ctaSecondary || 'Start with a Bearing Diagnostic'}" — link to https://www.fulcruminternational.org/diagnostic?utm_source=blog&utm_medium=cta&utm_content=end-article&utm_campaign=${slug}

CHECKLIST before output (verify each):
□ Word count meets target (${job.wordCountTarget}+)
□ Primary keyword appears 5 to 6 times
□ Mid-article CTA present
□ End-of-article CTA present
□ At least 3 internal links
□ At least 2 external authority links
□ Callout block with specific, actionable takeaway
□ FAQ section with 4 to 5 Q&A after callout
□ Attribution paragraph at end with link to /resources/${slug}
□ No em dashes anywhere
□ No banned phrases
□ The mission-driven leader is the hero in every section

Output ONLY a JSON object:
{
  "metaTitle": "...",        // 50-60 chars, includes primary keyword
  "metaDescription": "...",  // 150-160 chars, compelling, includes primary keyword
  "excerpt": "...",          // 1-2 sentences, ~160 chars
  "readTime": Number,
  "tags": ["kebab-case-tag", ...],
  "faqs": [
    { "question": "How do I...?", "answer": "Direct answer..." }
  ],
  "howToSteps": [
    { "name": "Step name", "text": "2-3 sentence description" }
  ],
  "body": [ ...PortableTextBlocks ]
}

Tags: 3 to 6 from: clarity, leverage, direction, execution, momentum, strategic-planning, organizational-development, capacity-building, executive-director, burnout, board-governance, operations, nonprofit-leadership, bearing-framework, pillar-content`;

  if (fixInstructions) {
    prompt += `\n\nCRITICAL REVISIONS REQUIRED. Fix precisely:\n${fixInstructions.map(f => `- ${f}`).join('\n')}\n\nDo NOT shorten. Only fix what's listed.`;
  }

  return prompt;
}

export default async function writer(job, research, fixInstructions = null, serpAnalysis = null) {
  logger.info(STAGE, fixInstructions ? 'Rewriting with QC fixes...' : `Writing: "${job.title}"`);

  const brandVoice = getBrandVoice();
  const existingArticles = await getExistingArticles();
  logger.info(STAGE, `${existingArticles.length} existing articles available for internal linking`);

  const client = new Anthropic({ apiKey: config.anthropic.apiKey, timeout: 600000 });

  let rawText = '';
  const stream = client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 32000,
    system: buildSystemPrompt(brandVoice),
    messages: [{ role: 'user', content: buildUserPrompt(job, research, existingArticles, fixInstructions, serpAnalysis) }],
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.text) {
      rawText += event.delta.text;
    }
  }

  let jsonStr = rawText;
  const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  } else {
    const objMatch = rawText.match(/\{[\s\S]*\}/);
    if (objMatch) jsonStr = objMatch[0];
  }

  let article;
  try {
    article = JSON.parse(jsonStr);
  } catch (err) {
    throw { stage: STAGE, error: `Failed to parse writer output as JSON: ${err.message}`, raw: rawText.slice(0, 500) };
  }

  const required = ['metaTitle', 'metaDescription', 'excerpt', 'body'];
  for (const field of required) {
    if (!article[field]) {
      throw { stage: STAGE, error: `Missing required field: ${field}` };
    }
  }

  if (!Array.isArray(article.body) || article.body.length < 5) {
    throw { stage: STAGE, error: `Article body too short (${article.body?.length || 0} blocks)` };
  }

  if (!Array.isArray(article.faqs) || article.faqs.length < 4) {
    logger.warn(STAGE, `FAQs missing or insufficient (${article.faqs?.length || 0}). QC will flag this.`);
    if (!article.faqs) article.faqs = [];
  }

  if (!article.readTime) {
    const wordCount = article.body
      .filter(b => b._type === 'block')
      .reduce((sum, b) => sum + (b.children || []).reduce((s, c) => s + (c.text || '').split(/\s+/).length, 0), 0);
    article.readTime = Math.ceil(wordCount / 200);
  }

  logger.info(STAGE, `Article written: ${article.body.length} blocks, ~${article.readTime} min read`);
  return article;
}

if (process.argv[1] && process.argv[1].endsWith('03-writer.js')) {
  console.log('Writer stage requires job and research inputs. Run via pipeline.js');
}
