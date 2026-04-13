/**
 * Stage 16: Podcast Guest Prospector
 * Finds behavioral health / agency / directory podcasts accepting guests.
 * Drafts personalized pitches. Runs monthly.
 * Posts 3-5 pitches to Slack for Joe to review and send.
 */

import config from '../utils/config.js';
import { findContactEmail } from '../utils/find-contact-email.js';
import { sendOutreachDraft } from '../utils/slack.js';
import { readSheetRange, appendSheetRows } from '../utils/sheets-client.js';
import logger from '../utils/logger.js';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

const SEED_PODCASTS = [
  'The Therapy Reimagined Podcast',
  'Practice of the Practice',
  'The Modern Therapist\'s Survival Guide',
  'Selling the Couch',
  'The Therapist Experience',
  'Abundant Practice Podcast',
  'The Private Practice Startup',
  'Group Practice Exchange',
  'Smart Practice',
  'Behind the Business (behavioral health)',
];

const SEARCH_QUERIES = [
  'behavioral health technology podcast',
  'therapy practice management podcast',
  'SaaS directory podcast guests',
];

async function findPodcasts() {
  if (!config.perplexity.apiKey) return [];

  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.perplexity.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'sonar-pro',
      messages: [{
        role: 'user',
        content: `Find 15 podcasts about behavioral health, therapy practice management, provider networks, or health tech SaaS that accept guest pitches in 2025-2026. For each, give me:
1. Podcast name
2. Host name
3. Guest submission page URL or contact email (if available)
4. Estimated audience size (downloads per episode)
5. Main topics they cover

Focus on: therapy practice management, behavioral health technology, provider directories, group practice management, mental health innovation, coaching agency growth.
Also search for podcasts related to: ${SEARCH_QUERIES.join(', ')}
Skip sports or fitness podcasts. Include both large shows and mid-size niche shows.
Format as a list.`,
      }],
    }),
  });

  if (!res.ok) return [];
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function draftPitch(podcastInfo) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: `Draft a podcast guest pitch email. Keep it under 150 words. Be personalized and specific.

PODCAST INFO:
${podcastInfo}

I am Joe Reed, founder of Fulcrum International, an impact venture studio and NGO consulting practice that helps mission-driven leaders find their bearing so their organizations can deliver the impact they were built for. My work centers on showing nonprofit leaders what they cannot see, the operational and strategic infrastructure problems that cause the symptoms most consultants treat. I can speak to:
- Why nonprofit strategic plans stall after launch (and the infrastructure problem underneath it)
- The pattern behind executive director burnout that is not about workload
- How $1M to $20M nonprofits hit a capacity ceiling that fundraising cannot fix
- The Fulcrum Approach: Clarity, Leverage, Direction, Execution, Momentum
- Why "saying yes to everything" is a strategy problem, not a discipline problem
- Building an impact venture studio for the social sector

Write a SHORT pitch email:
- Reference a specific recent topic they covered (make one up that fits their show)
- Propose 2 specific episode topics that would serve their audience
- One line about my credibility
- Warm, human tone. Not salesy.

Subject line format: "Guest idea: [specific topic]"`,
    }],
  });

  return response.content[0].text;
}

export default async function podcastProspector() {
  logger.info('podcasts', 'Prospecting nonprofit leadership + social impact podcasts...');

  let existingPitches = [];
  try {
    existingPitches = await readSheetRange('Podcast Targets', 'A2:F100');
  } catch (e) { /* tab might not exist yet */ }
  const pitchedShows = new Set(existingPitches.map(r => r[0]?.toLowerCase()).filter(Boolean));

  const podcastData = await findPodcasts();
  if (!podcastData) {
    logger.warn('podcasts', 'No podcast data returned from Perplexity');
    return { found: 0, pitched: 0 };
  }

  let pitchCount = 0;
  const MAX_PITCHES = 5;

  const allPodcastInfo = `Known relevant podcasts: ${SEED_PODCASTS.join(', ')}\n\nDiscovered:\n${podcastData}`;

  const parseResponse = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `Parse this podcast information and return a JSON array of podcast objects:

${allPodcastInfo}

Return JSON:
[
  {
    "name": "Podcast Name",
    "host": "Host Name",
    "guestPageUrl": "URL or empty string",
    "audienceSize": "estimated",
    "topics": "main topics"
  }
]

Include up to 15 podcasts. Skip any that are about sports or fitness coaching.`,
    }],
  });

  let podcasts = [];
  try {
    const text = parseResponse.content[0].text;
    podcasts = JSON.parse(text.match(/\[[\s\S]*\]/)[0]);
  } catch (e) {
    logger.warn('podcasts', `Failed to parse podcast list: ${e.message}`);
    return { found: 0, pitched: 0 };
  }

  for (const podcast of podcasts) {
    if (pitchCount >= MAX_PITCHES) break;
    if (pitchedShows.has(podcast.name.toLowerCase())) continue;

    const pitch = await draftPitch(JSON.stringify(podcast));

    const subjectMatch = pitch.match(/Subject:?\s*(.+)/i);
    const subject = subjectMatch?.[1]?.trim() || `Guest idea for ${podcast.name}`;
    const bodyWithoutSubject = pitch.replace(/Subject:?\s*.+\n?/i, '').trim();

    // Try to find contact email from guest page URL or podcast domain
    let podcastDomain = '';
    try {
      if (podcast.guestPageUrl) podcastDomain = new URL(podcast.guestPageUrl).hostname;
    } catch { /* ignore */ }
    let contactNote = '';
    if (podcastDomain) {
      const contactResult = await findContactEmail(podcastDomain, {
        perplexityApiKey: process.env.PERPLEXITY_API_KEY,
        brandName: config.brand?.name || 'Fulcrum International',
      });
      contactNote = contactResult.source === 'guesses'
        ? `No email found. Try: ${contactResult.candidates.slice(0, 4).join(', ')}`
        : `📧 Contact (${contactResult.source}): ${contactResult.email}`;
    }

    await sendOutreachDraft({
      type: 'Podcast Pitch',
      target: `${podcast.name} (host: ${podcast.host})`,
      subject,
      body: bodyWithoutSubject,
      notes: [
        contactNote,
        podcast.guestPageUrl ? `Guest page: ${podcast.guestPageUrl}` : 'No guest page found — search their website',
      ].filter(Boolean).join('\n'),
    });

    try {
      await appendSheetRows('Podcast Targets', [[
        podcast.name,
        podcast.host,
        podcast.guestPageUrl || '',
        podcast.audienceSize || '',
        podcast.topics || '',
        'Pitch Drafted',
        new Date().toISOString().split('T')[0],
        '',
      ]]);
    } catch (e) {
      logger.warn('podcasts', `Failed to write to sheet: ${e.message}`);
    }

    pitchCount++;
    await new Promise(r => setTimeout(r, 1000));
  }

  logger.info('podcasts', `Found ${podcasts.length} podcasts, drafted ${pitchCount} pitches`);
  return { found: podcasts.length, pitched: pitchCount };
}
