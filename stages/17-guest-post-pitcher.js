/**
 * Stage 17: Guest Post Pitch Generator
 * For sites flagged by reciprocal tracker (2+ links from us, not yet pitched)
 * plus priority targets in the behavioral health / agency directory space.
 * Claude reads their recent content, drafts topic proposals that fill THEIR gaps
 * while naturally including a link back to Fulcrum International.
 * Runs monthly. Posts pitches to Slack for Joe to review and send.
 */

import config from '../utils/config.js';
import { findContactEmail } from '../utils/find-contact-email.js';
import { sendOutreachDraft } from '../utils/slack.js';
import { readSheetRange, writeSheetRange } from '../utils/sheets-client.js';
import logger from '../utils/logger.js';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

const PRIORITY_TARGETS = [
  { domain: 'simplepractice.com', name: 'SimplePractice blog', contactHint: 'Check their blog contributor/write-for-us page', pitchAngle: 'Provider network management for group practices' },
  { domain: 'psychologytoday.com', name: 'Psychology Today (contributor)', contactHint: 'Apply as a verified contributor via their submission portal', pitchAngle: 'Future of therapist directories' },
  { domain: 'samhsa.gov', name: 'SAMHSA blog', contactHint: 'Submit via their public comment or guest blog process', pitchAngle: 'Behavioral health network coordination' },
  { domain: 'thenationalcouncil.org', name: 'The National Council', contactHint: 'Submit through their member content or blog portal', pitchAngle: 'Agency network management for members' },
  { domain: 'openreferral.org', name: 'Open Referral', contactHint: 'Contribute via their community or blog', pitchAngle: 'Technical standards for provider directories' },
  { domain: 'behavioralhealthnews.org', name: 'BehavioralHealthNews.org', contactHint: 'Submit articles via their contributor form', pitchAngle: 'White-label directory technology' },
  { domain: 'coachfoundation.com', name: 'CoachFoundation', contactHint: 'Check their contributor or guest post page', pitchAngle: 'Coaching agency directory tools' },
  { domain: 'psychcentral.com', name: 'PsychCentral', contactHint: 'Check their write-for-us or contributor guidelines', pitchAngle: 'Mental health provider discovery' },
  { domain: 'theranest.com', name: 'TheraNest blog', contactHint: 'Check their blog for contributor info', pitchAngle: 'Practice management + directory integration' },
];

async function researchTargetContent(domain) {
  if (!config.perplexity.apiKey) return '';

  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.perplexity.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'sonar',
      messages: [{
        role: 'user',
        content: `What are the most recent blog posts on ${domain}? List 5-10 recent article titles and topics. Also tell me: what topics do they cover a lot, and what's MISSING from their content that they should have?`,
      }],
    }),
  });

  if (!res.ok) return '';
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function draftGuestPostPitch(target, targetContent, ourLinksToThem) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: `Draft a guest post pitch email for ${target.name} (${target.domain}).

THEIR RECENT CONTENT:
${targetContent}

OUR RELATIONSHIP:
We've linked to ${target.domain} ${ourLinksToThem} times from our resources on fulcruminternational.org.

PITCH ANGLE: ${target.pitchAngle || 'Operational and strategic infrastructure for nonprofit organizations'}

I am Joe Reed, founder of Fulcrum International, an impact venture studio and NGO consulting practice that helps mission-driven leaders find their bearing so their organizations can deliver the impact they were built for.

Write a pitch that:
1. Opens by referencing a SPECIFIC article of theirs (pick one from their recent content)
2. Mentions that we've been linking to their content (builds reciprocity) — skip if 0 links
3. Proposes 2-3 guest post topics that fill THEIR content gaps — not ours
4. Each topic should naturally allow a link back to fulcruminternational.org
5. Includes a writing sample link (use: fulcruminternational.org/resources)
6. Is SHORT — under 150 words
7. Human tone. Not corporate. Not salesy.

Subject line format: "Guest post idea for [their blog/site name]"

${target.contactHint ? `Contact hint: ${target.contactHint}` : ''}`,
    }],
  });

  return response.content[0].text;
}

export default async function guestPostPitcher() {
  logger.info('guest-posts', 'Generating guest post pitches...');

  let rows = [];
  try {
    rows = await readSheetRange('Outreach Tracker', 'A2:K200');
  } catch (e) {
    logger.warn('guest-posts', `Can't read Outreach Tracker: ${e.message}`);
  }

  // Find domains marked "Ready to Pitch" from reciprocal tracker
  const readyToPitch = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const domain = row[0] || '';
    const type = row[1] || '';
    const status = row[5] || '';
    const linksToThem = parseInt(row[3] || '0', 10);

    if (status === 'Ready to Pitch' && type === 'Reciprocal') {
      const priority = PRIORITY_TARGETS.find(t => domain.includes(t.domain));
      readyToPitch.push({
        domain,
        name: priority?.name || domain,
        contactHint: priority?.contactHint || '',
        pitchAngle: priority?.pitchAngle || '',
        linksToThem,
        rowIndex: i + 2,
      });
    }
  }

  // Also add priority targets that haven't been tracked yet
  const trackedDomains = new Set(rows.map(r => r[0]));
  for (const target of PRIORITY_TARGETS) {
    if (!trackedDomains.has(target.domain) && readyToPitch.length < 10) {
      readyToPitch.push({
        domain: target.domain,
        name: target.name,
        contactHint: target.contactHint,
        pitchAngle: target.pitchAngle,
        linksToThem: 0,
        rowIndex: null,
      });
    }
  }

  let pitchCount = 0;
  const MAX_PITCHES = 5;

  for (const target of readyToPitch) {
    if (pitchCount >= MAX_PITCHES) break;

    logger.info('guest-posts', `Researching ${target.domain} for pitch...`);

    const targetContent = await researchTargetContent(target.domain);

    const pitch = await draftGuestPostPitch(target, targetContent, target.linksToThem);

    const subjectMatch = pitch.match(/Subject:?\s*(.+)/i);
    const subject = subjectMatch?.[1]?.trim() || `Guest post idea for ${target.name}`;
    const bodyWithoutSubject = pitch.replace(/Subject:?\s*.+\n?/i, '').trim();

    const contactResult = await findContactEmail(target.domain, {
      perplexityApiKey: process.env.PERPLEXITY_API_KEY,
      brandName: config.brand?.name || 'Fulcrum International',
    });
    const contactNote = contactResult.source === 'guesses'
      ? `No email found. Try: ${contactResult.candidates.slice(0, 4).join(', ')}`
      : `📧 Contact (${contactResult.source}): ${contactResult.email}`;

    await sendOutreachDraft({
      type: 'Guest Post Pitch',
      target: `${target.name} (${target.domain})`,
      subject,
      body: bodyWithoutSubject,
      notes: `${contactNote}\n${target.contactHint || 'Find contact info on their website'}`,
    });

    if (target.rowIndex) {
      try {
        await writeSheetRange('Outreach Tracker', `F${target.rowIndex}:G${target.rowIndex}`, [
          ['Pitch Drafted', new Date().toISOString().split('T')[0]],
        ]);
      } catch (e) {
        logger.warn('guest-posts', `Failed to update sheet: ${e.message}`);
      }
    }

    pitchCount++;
    await new Promise(r => setTimeout(r, 2000));
  }

  logger.info('guest-posts', `Generated ${pitchCount} guest post pitches from ${readyToPitch.length} candidates`);
  return { candidates: readyToPitch.length, pitched: pitchCount };
}
