#!/usr/bin/env node

/**
 * Daily VA Assignment Bot, Fulcrum International
 *
 * Posts ICP-focused engagement tasks with:
 * - LinkedIn: topic-specific briefs per person (what to look for, your angle, how to comment)
 * - Reddit: pulls actual thread URLs from recent Scout alerts in Slack history
 * - Medium: syndication assignments on scheduled days
 * - Follow-ups: reminds to continue active conversations
 */

const BRAND = 'Fulcrum International';
// Set SLACK_CHANNEL_ID via GitHub Secrets
const SLACK_CHANNEL = process.env.SLACK_CHANNEL_ID || '';

// NOTE: ENDORSEMENT_TARGETS below were copied from the Hunhu pipeline as a scaffold.
// Replace with Fulcrum International ICP targets (nonprofit ED voices, sector funders,
// thought leaders writing about org infrastructure, capacity building, ED burnout)
// before this file is wired into the daily-va-assignments workflow.
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const MEDIUM_DAYS = [3]; // Wednesday

// ─── LinkedIn Targets with ICP Context ───

const ENDORSEMENT_TARGETS = [
  {
    name: 'Maureen Werrbach',
    url: 'https://www.linkedin.com/in/maurwer/recent-activity/all/',
    org: 'Group Practice Exchange',
    lookFor: 'scaling group practices, hiring providers, managing multi-clinician teams',
    yourAngle: 'agency infrastructure that lets owners focus on growth, not back-office',
    commentAs: 'someone building tools that solve the exact operational problems she teaches about',
  },
  {
    name: 'Joe Sanok',
    url: 'https://www.linkedin.com/in/joe-sanok-8b140023/recent-activity/all/',
    org: 'Practice of the Practice',
    lookFor: 'therapist business growth, private practice revenue, scaling beyond solo',
    yourAngle: 'streamlining the provider experience so they can focus on clients, not admin',
    commentAs: 'a founder who\'s seen the spreadsheet-to-software pain firsthand with agencies',
  },
  {
    name: 'Howard Spector',
    url: 'https://www.linkedin.com/in/howardspector/recent-activity/all/',
    org: 'SimplePractice co-founder',
    lookFor: 'practice management trends, therapist tools, health-tech infrastructure',
    yourAngle: 'the next layer beyond solo practice management — agency-level directory distribution',
    commentAs: 'someone building what comes after SimplePractice for agencies managing provider networks',
  },
  {
    name: 'Margaret Moore',
    url: 'https://www.linkedin.com/in/coachmeg/recent-activity/all/',
    org: 'Wellcoaches / NBHWC co-founder',
    lookFor: 'health coaching standards, coaching credentialing, wellness industry growth',
    yourAngle: 'how coaching agencies can better serve and retain their provider networks',
    commentAs: 'a platform builder who respects the credentialing ecosystem she helped create',
  },
];

const THOUGHT_LEADERS = [
  {
    name: 'Alison Pidgeon',
    url: 'https://www.linkedin.com/in/alison-pidgeon/recent-activity/all/',
    org: 'Move Forward Counseling',
    lookFor: 'group practice operations, hiring therapists, scaling counseling businesses',
    yourAngle: 'tools that help agency owners stop managing spreadsheets and start growing',
  },
  {
    name: 'Whitney Owens',
    url: 'https://www.linkedin.com/in/whitney-owens-85376a27/recent-activity/all/',
    org: 'Wise Practice Consulting',
    lookFor: 'faith-based practice growth, group practice consulting, provider management',
    yourAngle: 'embeddable directories for faith-based communities (churches listing their counselors)',
  },
  {
    name: 'Kathy Caprino',
    url: 'https://www.linkedin.com/in/kathycaprino/recent-activity/all/',
    org: 'Forbes contributor / career coach',
    lookFor: 'coaching industry trends, career coaching, the business of coaching',
    yourAngle: 'how coaches can build sustainable practices through agency partnerships',
  },
  {
    name: 'Ellen Lindsey',
    url: 'https://www.linkedin.com/in/ellen-lindsey-821ba63b/recent-activity/all/',
    org: 'Therapy Austin (120+ counselors)',
    lookFor: 'large group practice operations, multi-location management, provider directories',
    yourAngle: 'what running 120 counselors across 5 locations teaches about agency infrastructure',
  },
  {
    name: 'Jake Cooper',
    url: 'https://www.linkedin.com/in/jake-l-cooper/recent-activity/all/',
    org: 'Grow Therapy',
    lookFor: 'therapist platforms, measurement-informed care, provider networks at scale',
    yourAngle: 'how agency-level tools differ from individual provider platforms',
  },
];

// ─── Reddit URL Verifier ───

async function verifyRedditUrl(url) {
  try {
    const jsonUrl = url.endsWith('/') ? `${url}.json` : `${url}/.json`;
    const res = await fetch(jsonUrl, {
      headers: { 'User-Agent': 'DailyAssignments/1.0' },
    });
    if (!res.ok) return false;
    const data = await res.json();
    const post = data?.[0]?.data?.children?.[0]?.data;
    if (!post) return false;
    if (post.removed_by_category || post.selftext === '[removed]' || post.selftext === '[deleted]' || post.author === '[deleted]') return false;
    return true;
  } catch {
    return false;
  }
}

// ─── LinkedIn URL Verifier ───

async function verifyLinkedInUrl(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible)' },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    // LinkedIn returns 302 (redirect to login) for valid profiles
    // 999 is LinkedIn's anti-bot status — not a real 404
    if (res.status === 404) return false;
    return true;
  } catch {
    // Timeout or network error — fail open (assume valid)
    return true;
  }
}

// ─── Reddit Thread Fetcher ───

async function getRecentRedditAlerts() {
  if (!BOT_TOKEN) return [];

  try {
    // Read last 50 messages from this channel to find Reddit Scout alerts
    const res = await fetch(`https://slack.com/api/conversations.history?channel=${SLACK_CHANNEL}&limit=50`, {
      headers: { Authorization: `Bearer ${BOT_TOKEN}` },
    });
    const data = await res.json();
    if (!data.ok) return [];

    const threads = [];
    for (const msg of data.messages || []) {
      const text = msg.text || '';
      // Reddit Scout posts contain "Reddit Opportunity" and a URL
      if (text.includes('Reddit Opportunity') || text.includes('reddit.com/r/')) {
        // Extract URLs
        const urlMatches = text.match(/https?:\/\/(?:www\.)?reddit\.com\/r\/[^\s>|]+/g) || [];
        // Extract thread title
        const titleMatch = text.match(/\*Thread:\*\s*(.+)/);
        const title = titleMatch ? titleMatch[1].trim() : null;
        // Extract suggested comment
        const commentMatch = text.match(/Suggested comment[:\s]*\n?([\s\S]*?)(?:\n━|$)/i);
        const suggestedComment = commentMatch ? commentMatch[1].trim().slice(0, 200) : null;

        for (const url of urlMatches) {
          threads.push({ url, title, suggestedComment, ts: msg.ts });
        }
      }
    }

    // Deduplicate by URL and return most recent 5
    const seen = new Set();
    const unique = threads.filter(t => {
      if (seen.has(t.url)) return false;
      seen.add(t.url);
      return true;
    });

    // Verify URLs are still live
    const verified = [];
    for (const thread of unique.slice(0, 8)) {
      const isLive = await verifyRedditUrl(thread.url);
      if (isLive) {
        verified.push(thread);
        if (verified.length >= 5) break;
      }
      await new Promise(r => setTimeout(r, 600));
    }
    return verified;
  } catch {
    return [];
  }
}

// ─── Build and Post ───

async function run() {
  const today = new Date();
  const dow = today.getDay();
  if (dow === 0 || dow === 6) return;

  const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow];
  const dateStr = today.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const isMedium = MEDIUM_DAYS.includes(dow);

  // Rotate thought leaders (show 3 per day, cycling through all)
  const dayNum = Math.floor((today - new Date(today.getFullYear(), 0, 0)) / 86400000);
  const todayLeaders = [];
  for (let i = 0; i < 3; i++) {
    todayLeaders.push(THOUGHT_LEADERS[(dayNum * 3 + i) % THOUGHT_LEADERS.length]);
  }

  // Verify LinkedIn URLs are live
  const verifiedTargets = [];
  for (const target of ENDORSEMENT_TARGETS) {
    if (target.url && target.url.includes('linkedin.com')) {
      const isLive = await verifyLinkedInUrl(target.url);
      if (!isLive) {
        console.log(`Skipping broken LinkedIn URL: ${target.url}`);
        continue;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    verifiedTargets.push(target);
  }

  const verifiedLeaders = [];
  for (const leader of todayLeaders) {
    if (leader.url && leader.url.includes('linkedin.com')) {
      const isLive = await verifyLinkedInUrl(leader.url);
      if (!isLive) {
        console.log(`Skipping broken LinkedIn URL: ${leader.url}`);
        continue;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    verifiedLeaders.push(leader);
  }

  // Fetch real Reddit threads from Scout alerts
  const redditThreads = await getRecentRedditAlerts();

  const lines = [];
  lines.push(`*${dayName} ${dateStr} — ${BRAND} Daily Assignment*`);
  lines.push('');

  // ── LinkedIn ──
  lines.push(':briefcase: *LINKEDIN ENGAGEMENT*');
  lines.push('');
  lines.push('*Priority 1 — Endorsement Targets*');
  lines.push('_Open each link. Find their most recent post. Leave a substantive comment (3-5 sentences)._');
  lines.push('');

  for (const t of verifiedTargets) {
    lines.push(`<${t.url}|:arrow_right: ${t.name}> — ${t.org}`);
    lines.push(`   _Look for:_ posts about ${t.lookFor}`);
    lines.push(`   _Your angle:_ ${t.yourAngle}`);
    lines.push(`   _Comment as:_ ${t.commentAs}`);
    lines.push('');
  }

  lines.push('*Priority 2 — Thought Leaders (today\'s rotation)*');
  lines.push('_Comment on 3-5 of their recent posts._');
  lines.push('');

  for (const t of verifiedLeaders) {
    lines.push(`<${t.url}|:arrow_right: ${t.name}> — ${t.org}`);
    lines.push(`   _Look for:_ ${t.lookFor}`);
    lines.push(`   _Your angle:_ ${t.yourAngle}`);
    lines.push('');
  }

  lines.push('_Also: reply to any comments on our last 3 days of brand page posts._');
  lines.push('');

  // ── Reddit ──
  lines.push(':speech_balloon: *REDDIT ENGAGEMENT*');
  lines.push('');

  if (redditThreads.length > 0) {
    lines.push(`_${redditThreads.length} recent threads found from Reddit Scout:_`);
    lines.push('');
    for (const thread of redditThreads) {
      lines.push(`<${thread.url}|:arrow_right: ${thread.title || 'Open thread'}>`);
      if (thread.suggestedComment) {
        lines.push(`   _Suggested angle:_ ${thread.suggestedComment}`);
      }
      lines.push('');
    }
  } else {
    lines.push('_No recent Reddit Scout alerts found. Browse these for new conversations:_');
    lines.push(`<https://www.reddit.com/r/therapists/new/|:arrow_right: r/therapists — new posts>`);
    lines.push(`<https://www.reddit.com/r/privatepractice/new/|:arrow_right: r/privatepractice — new posts>`);
    lines.push('');
    lines.push('_Find 2-3 threads where someone is asking about practice management, directories, or agency tools._');
  }

  lines.push('');
  lines.push('_Rules: No links. No brand mentions. Answer their question like a person who\'s been there._');
  lines.push('');

  // ── Medium ──
  if (isMedium) {
    lines.push(':newspaper: *MEDIUM*');
    lines.push('Publish 1 syndicated article to Fulcrum International\'s Medium publication.');
    lines.push('Pick the next published article not yet on Medium from the content calendar.');
    lines.push('');
  }

  // ── Follow-ups ──
  lines.push(':arrows_counterclockwise: *FOLLOW-UPS*');
  lines.push('Open LinkedIn notifications — reply to anyone who responded to your comments.');
  lines.push('Open Reddit inbox — continue any active threads from previous days.');
  lines.push('_Continuing conversations > starting new ones._');

  const message = lines.join('\n');

  if (!BOT_TOKEN) {
    console.log(message);
    return;
  }

  // Severity gate: daily VA assignments are status-level. Silenced when
  // SLACK_NOTIFY_LEVEL=error (default for Joe). Set to 'status' to re-enable.
  const level = (process.env.SLACK_NOTIFY_LEVEL || 'action').toLowerCase();
  if (level === 'error' || level === 'action') {
    console.log('[daily-assignments] Skipped Slack post — SLACK_NOTIFY_LEVEL=' + level);
    return;
  }

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: SLACK_CHANNEL, text: message, unfurl_links: false, mrkdwn: true }),
  });

  const data = await res.json();
  console.log(data.ok ? `Posted to ${BRAND} channel.` : `Error: ${data.error}`);
}

run().catch(err => { console.error(err); process.exit(1); });
