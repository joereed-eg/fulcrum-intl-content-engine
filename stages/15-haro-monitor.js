/**
 * Stage 15: HARO/Connectively Monitor
 * Uses Gmail API to scan inbox for HARO query emails.
 * Filters for behavioral health / agency / directory relevant queries.
 * Drafts expert responses using Claude -> Slack for Joe to approve.
 *
 * Runs 3x daily via GitHub Actions (6am, 1pm, 6pm ET).
 */

import { google } from 'googleapis';
import { getAuthClient } from '../utils/sheets-client.js';
import config from '../utils/config.js';
import { sendOutreachDraft } from '../utils/slack.js';
import { appendSheetRows } from '../utils/sheets-client.js';
import logger from '../utils/logger.js';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

const HARO_KEYWORDS = [
  'nonprofit', 'executive director', 'NGO', 'social impact',
  'capacity building', 'strategic planning', 'organizational development',
  'fractional COO', 'nonprofit operations', 'board governance',
  'mission-driven', 'philanthropy', 'social sector', 'theory of change',
  'impact measurement', 'nonprofit leadership', 'nonprofit strategy',
];

const CREDENTIAL_LINE = 'Joe Reed is the founder of Fulcrum International, an impact venture studio and NGO consulting practice that helps mission-driven leaders find their bearing so their organizations can deliver the impact they were built for. His work focuses on the operational and strategic infrastructure problems that cause the symptoms most nonprofit consultants treat.';

async function getGmailClient() {
  const { writeFileSync, existsSync } = await import('fs');
  const { join } = await import('path');
  const { tmpdir } = await import('os');

  let keyFile;
  if (config.google.serviceAccountJson) {
    keyFile = join(tmpdir(), 'gcp-sa-key-gmail.json');
    if (!existsSync(keyFile)) {
      writeFileSync(keyFile, config.google.serviceAccountJson);
    }
  } else {
    const saPath = config.google.serviceAccountPath;
    if (!saPath) throw new Error('No Google service account configured');
    const { dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    keyFile = saPath.startsWith('.') ? join(__dirname, '..', saPath) : saPath;
  }

  const targetEmail = process.env.GMAIL_USER_EMAIL || 'joe@exponentgroup.org';

  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    clientOptions: { subject: targetEmail },
  });

  const authClient = await auth.getClient();
  return google.gmail({ version: 'v1', auth: authClient });
}

function isRelevantQuery(queryText) {
  const lower = queryText.toLowerCase();
  return HARO_KEYWORDS.some(kw => lower.includes(kw));
}

function parseHaroEmail(body) {
  const queries = [];
  const sections = body.split(/(?:^|\n)[-=]{3,}|\n\d+\)\s/gm).filter(s => s.trim().length > 50);

  for (const section of sections) {
    const summaryMatch = section.match(/(?:Summary|Query|Subject):\s*(.+)/i);
    const outletMatch = section.match(/(?:Media Outlet|Publication|Name of Outlet):\s*(.+)/i);
    const nameMatch = section.match(/(?:Name|Reporter|Journalist):\s*(.+)/i);
    const deadlineMatch = section.match(/(?:Deadline|Due):\s*(.+)/i);
    const requirementsMatch = section.match(/(?:Requirements|Details|Description):\s*([\s\S]+?)(?=\n\s*(?:Deadline|Name|Media|$))/i);

    if (summaryMatch) {
      queries.push({
        summary: summaryMatch[1].trim(),
        outlet: outletMatch?.[1]?.trim() || 'Unknown outlet',
        journalist: nameMatch?.[1]?.trim() || 'Unknown',
        deadline: deadlineMatch?.[1]?.trim() || 'ASAP',
        requirements: requirementsMatch?.[1]?.trim() || section.trim(),
        fullText: section.trim(),
      });
    }
  }

  if (queries.length === 0 && body.length > 100) {
    queries.push({
      summary: body.substring(0, 200),
      outlet: 'Unknown',
      journalist: 'Unknown',
      deadline: 'Check email',
      requirements: body,
      fullText: body,
    });
  }

  return queries;
}

async function draftResponse(query) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: `Draft a HARO response for this journalist query. I am Joe Reed, founder of Fulcrum International, an impact venture studio and NGO consulting practice that helps mission-driven leaders find their bearing so their organizations can deliver the impact they were built for. My work focuses on the operational and strategic infrastructure problems that cause the symptoms most nonprofit consultants treat (executive director burnout, stalled strategic plans, capacity ceilings).

QUERY:
${query.fullText}

OUTLET: ${query.outlet}
JOURNALIST: ${query.journalist}
DEADLINE: ${query.deadline}

Write a 2-3 paragraph expert response that:
1. Directly answers their question with specific insights
2. Includes a relevant stat or data point if possible (BoardSource data, Nonprofit Workforce Survey, Stanford Social Innovation Review)
3. Positions me as an expert in nonprofit infrastructure and strategic clarity without being salesy
4. Is quotable, short, punchy sentences they can lift directly
5. Ends with my credential line

Use this credential line exactly:
"${CREDENTIAL_LINE}"

Tone: authoritative but warm. Like someone who has actually run, advised, and built nonprofit organizations.
Do NOT use any AI-sounding language. Write like a real person emailing a journalist.`,
    }],
  });

  return response.content[0].text;
}

export default async function haroMonitor() {
  logger.info('haro', 'Checking inbox for HARO queries...');

  let gmail;
  try {
    gmail = await getGmailClient();
  } catch (e) {
    logger.warn('haro', `Gmail API not configured: ${e.message}. Skipping HARO monitor.`);
    return { checked: 0, relevant: 0 };
  }

  const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;
  let messages;
  try {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: `from:haro@helpareporter.com OR from:@connectively.us after:${oneDayAgo}`,
      maxResults: 10,
    });
    messages = res.data.messages || [];
  } catch (e) {
    logger.warn('haro', `Gmail search failed: ${e.message}`);
    return { checked: 0, relevant: 0 };
  }

  if (messages.length === 0) {
    logger.info('haro', 'No new HARO emails found');
    return { checked: 0, relevant: 0 };
  }

  logger.info('haro', `Found ${messages.length} HARO email(s)`);

  let relevantCount = 0;

  for (const msg of messages) {
    try {
      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full',
      });

      const parts = detail.data.payload?.parts || [detail.data.payload];
      let body = '';
      for (const part of parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          body = Buffer.from(part.body.data, 'base64').toString('utf-8');
          break;
        }
      }

      if (!body) continue;

      const queries = parseHaroEmail(body);

      for (const query of queries) {
        if (!isRelevantQuery(query.summary + ' ' + query.requirements)) continue;

        relevantCount++;
        logger.info('haro', `Relevant query: "${query.summary.substring(0, 80)}..." → ${query.outlet}`);

        const draft = await draftResponse(query);

        await sendOutreachDraft({
          type: 'HARO Response Draft',
          target: `${query.outlet} (journalist: ${query.journalist})`,
          subject: `Re: ${query.summary.substring(0, 100)}`,
          body: draft,
          notes: `Deadline: ${query.deadline} | Reply to the journalist directly — do not reply to HARO`,
        });

        try {
          await appendSheetRows('Outreach Tracker', [[
            query.outlet,
            'HARO',
            query.journalist,
            '0',
            '0',
            'Draft Sent to Slack',
            new Date().toISOString().split('T')[0],
            query.deadline,
            `Query: ${query.summary.substring(0, 100)}`,
            '',
            '',
          ]]);
        } catch (e) {
          logger.warn('haro', `Failed to write to sheet: ${e.message}`);
        }

        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (e) {
      logger.warn('haro', `Failed to process message ${msg.id}: ${e.message}`);
    }
  }

  logger.info('haro', `Processed ${messages.length} emails, ${relevantCount} relevant queries drafted`);
  return { checked: messages.length, relevant: relevantCount };
}

// Standalone entry point for GitHub Actions
if (import.meta.url === `file://${process.argv[1]}`) {
  haroMonitor()
    .then(r => console.log('HARO monitor complete:', r))
    .catch(err => { console.error('Fatal:', err); process.exit(1); });
}
