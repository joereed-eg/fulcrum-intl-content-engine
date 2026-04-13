import Anthropic from '@anthropic-ai/sdk';
import config from '../utils/config.js';
import getSanityClient from '../utils/sanity-client.js';
import { getSheetsClient, getSheetConfig, readSheetRange } from '../utils/sheets-client.js';
import logger from '../utils/logger.js';
import { sendSlackAlert } from '../utils/slack.js';

const AUTO_SCHEDULE = (process.env.AUTO_SCHEDULE ?? 'true') !== 'false';

/**
 * Calculate Mon/Wed/Fri publish slots for the next 4 weeks,
 * starting from the next Monday after the given date.
 */
function getPublishSlots(fromDate = new Date()) {
  const slots = [];
  // Find next Monday
  const d = new Date(fromDate);
  d.setHours(0, 0, 0, 0);
  const dayOfWeek = d.getDay();
  const daysUntilMonday = dayOfWeek === 0 ? 1 : dayOfWeek === 1 ? 0 : 8 - dayOfWeek;
  d.setDate(d.getDate() + daysUntilMonday);

  // Generate 4 weeks of Mon(1), Wed(3), Fri(5)
  for (let week = 0; week < 4; week++) {
    for (const targetDay of [1, 3, 5]) {
      const slot = new Date(d);
      slot.setDate(d.getDate() + (week * 7) + (targetDay - 1));
      slots.push(slot.toISOString().split('T')[0]); // YYYY-MM-DD
    }
  }
  return slots;
}

const STAGE = 'calendar-generator';

async function queryPerplexity(query) {
  const apiKey = config.perplexity.apiKey;
  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'sonar-pro',
      messages: [{ role: 'user', content: query }],
      max_tokens: 2000,
    }),
  });
  if (!res.ok) throw new Error(`Perplexity ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

export default async function calendarGenerator() {
  logger.info(STAGE, 'Generating content calendar suggestions...');

  const sanityClient = getSanityClient();

  // Get existing articles to avoid duplicates
  const existing = await sanityClient.fetch(
    `*[_type == "resource"]{ title, "slug": slug.current, cluster, tags }`
  );
  const existingTitles = existing.map(a => a.title.toLowerCase());
  const existingClusters = [...new Set(existing.map(a => a.cluster).filter(Boolean))];

  // Get cluster gaps from the Cluster Map sheet
  let clusterGaps = '';
  try {
    const sheets = await getSheetsClient();
    const spreadsheetId = config.google.sheetsSpreadsheetId;
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "'Cluster Map'!A2:E20",
    });
    const rows = res.data.values || [];
    clusterGaps = rows
      .filter(r => r[4]) // has gaps
      .map(r => `Cluster "${r[0]}": missing ${r[4]}`)
      .join('\n');
  } catch { /* sheet might not exist yet */ }

  // Get trend radar data
  let trendData = '';
  try {
    const sheets = await getSheetsClient();
    const spreadsheetId = config.google.sheetsSpreadsheetId;
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "'Trend Radar'!A1:B5",
    });
    const rows = res.data.values || [];
    trendData = rows.map(r => `${r[0]}: ${(r[1] || '').slice(0, 300)}`).join('\n');
  } catch { /* sheet might not exist yet */ }

  // Use Claude to generate calendar suggestions based on all intelligence
  const client = new Anthropic({ apiKey: config.anthropic.apiKey, timeout: 60000 });

  // Also get fresh competitive intel
  let competitorTopics = '';
  try {
    competitorTopics = await queryPerplexity(
      `What are the most popular and highest-performing blog topics in the provider directory, ` +
      `therapist directory, and agency network management space right now? ` +
      `What topics are trending? What questions are people asking? Focus on topics ` +
      `relevant to agency owners who manage provider directories and referral networks.`
    );
  } catch { /* proceed without */ }

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [{
      role: 'user',
      content: `You are a content strategist for Fulcrum International (www.fulcruminternational.org), an impact venture studio and NGO consulting practice. Audience: nonprofit executive directors, chiefs of staff, and senior program leaders running $1M-$20M organizations. Content must name operational and strategic infrastructure patterns (clarity, leverage, direction, execution, momentum). Avoid fundraising tactics, grant writing how-to, and board governance checklists unless framed at the systems level.

EXISTING ARTICLES (${existing.length} total):
${existingTitles.slice(0, 20).join('\n')}

EXISTING CLUSTERS: ${existingClusters.join(', ') || 'None defined'}

CLUSTER GAPS:
${clusterGaps || 'No cluster gap data available'}

TREND INTELLIGENCE:
${trendData || 'No trend data available'}

COMPETITIVE LANDSCAPE:
${competitorTopics || 'No competitive data available'}

TASK: Generate 15 content calendar entries that will help Fulcrum International rank higher on Google. Topics should map to one of the 5 Bearing Framework stages (CLARITY, LEVERAGE, DIRECTION, EXECUTION, MOMENTUM). Prioritize:
1. CLUSTER GAP FILLS — articles that fill identified gaps in existing topic clusters
2. QUICK WIN TOPICS — long-tail keywords where a new site can rank quickly
3. TRENDING TOPICS — topics with growing search interest
4. COMPETITOR COUNTERS — topics competitors cover that we don't

For each entry, provide:
- title: Compelling, keyword-optimized article title
- primaryKeyword: Main keyword to target (long-tail preferred for a new site)
- cluster: Which topic cluster this belongs to
- wordCountTarget: Recommended word count (1500-3000)
- brief: 1-2 sentence description of what the article should cover
- priority: "high", "medium", or "low"
- reason: Why this topic was chosen (gap fill, trending, competitive counter, etc.)

Return ONLY a JSON array:
[
  {
    "title": "...",
    "primaryKeyword": "...",
    "cluster": "...",
    "wordCountTarget": 2000,
    "brief": "...",
    "priority": "high",
    "reason": "cluster gap fill"
  }
]`,
    }],
  });

  const rawText = response.content[0].text;
  let suggestions;
  try {
    let jsonStr = rawText;
    const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1].trim();
    else {
      const arrMatch = rawText.match(/\[[\s\S]*\]/);
      if (arrMatch) jsonStr = arrMatch[0];
    }
    suggestions = JSON.parse(jsonStr);
  } catch (err) {
    logger.error(STAGE, `Failed to parse calendar suggestions: ${err.message}`);
    return { generated: 0 };
  }

  // Filter out duplicates
  suggestions = suggestions.filter(s =>
    !existingTitles.some(t => t.includes(s.primaryKeyword?.toLowerCase() || ''))
  );

  // Determine publish dates if auto-scheduling is enabled
  let scheduledCount = 0;
  let backlogCount = 0;
  const sheetConfig = getSheetConfig();
  const calendarTab = sheetConfig.tab;

  if (AUTO_SCHEDULE) {
    // Read existing rows to find dates already taken
    let existingDates = new Set();
    try {
      const existingRows = await readSheetRange(calendarTab, 'A2:B500');
      for (const row of existingRows) {
        const status = (row[0] || '').trim();
        const date = (row[1] || '').trim();
        if (date && (status === 'Planned' || status === 'In Progress')) {
          existingDates.add(date);
        }
      }
    } catch { /* sheet might be empty */ }

    const slots = getPublishSlots();
    const availableSlots = slots.filter(d => !existingDates.has(d));

    // Assign dates to topics in priority order (high first)
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    suggestions.sort((a, b) => (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1));

    for (let i = 0; i < suggestions.length; i++) {
      if (i < availableSlots.length) {
        suggestions[i]._publishDate = availableSlots[i];
        suggestions[i]._status = 'Planned';
        scheduledCount++;
      } else {
        suggestions[i]._publishDate = '';
        suggestions[i]._status = 'Suggested';
        backlogCount++;
      }
    }
  }

  // Write to Google Sheet
  try {
    const sheets = await getSheetsClient();

    const rows = suggestions.map(s => [
      AUTO_SCHEDULE ? s._status : 'Suggested',  // A: Stage
      AUTO_SCHEDULE ? (s._publishDate || '') : '', // B: Publish Date
      '',                    // C: Content Layer
      s.cluster || '',       // D: Cluster
      s.title,               // E: Title
      'agency network managers', // F: Audience
      String(s.wordCountTarget || 2000), // G: Word Count
      s.primaryKeyword || '',// H: Primary Keyword
      '',                    // I: Secondary Keywords
      '',                    // J: Primary Pillar URL
      '',                    // K: Sub-Pillar URL
      '', '', '',            // L-N: Internal Links
      '', '',                // O-P: External Links
      '', '',                // Q-R: CTAs
      s.brief || '',         // S: Brief
      '',                    // T: Categories
      `[${s.priority}] ${s.reason || ''}`, // U: Notes
    ]);

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetConfig.spreadsheetId,
      range: `'${calendarTab}'!A:U`,
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });

    logger.info(STAGE, `Added ${rows.length} articles to content calendar (${scheduledCount} scheduled, ${backlogCount} backlog)`);
  } catch (err) {
    logger.warn(STAGE, `Failed to write suggestions to sheet: ${err.message}`);
  }

  // Slack summary
  const highPriority = suggestions.filter(s => s.priority === 'high');
  const digest = highPriority.slice(0, 5).map(s =>
    `• *${s.title}*\n  Keyword: "${s.primaryKeyword}" | Cluster: ${s.cluster || 'new'} | ${s.reason}`
  ).join('\n');

  const scheduleMsg = AUTO_SCHEDULE
    ? `Auto-scheduled ${scheduledCount} articles (Mon/Wed/Fri) with ${backlogCount} in backlog.`
    : `Review the "Suggested" rows in the content calendar sheet. Change status to "Planned" and set publish dates for approved topics.`;

  await sendSlackAlert(
    `Content Calendar: ${suggestions.length} new article suggestions generated\n\n` +
    `High priority (${highPriority.length}):\n${digest || 'None'}\n\n` +
    `_${scheduleMsg}_`
  );

  logger.info(STAGE, `Calendar generation complete. ${suggestions.length} suggestions.`);
  return { generated: suggestions.length };
}

if (process.argv[1] && process.argv[1].endsWith('09b-calendar-generator.js')) {
  calendarGenerator()
    .then(r => console.log(`Generated ${r.generated} suggestions`))
    .catch(err => { console.error(err); process.exit(1); });
}
