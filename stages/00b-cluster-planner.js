import config from '../utils/config.js';
import getSanityClient from '../utils/sanity-client.js';
import { getSheetsClient } from '../utils/sheets-client.js';
import logger from '../utils/logger.js';
import { sendSlackAlert } from '../utils/slack.js';

const STAGE = 'cluster-planner';

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
      max_tokens: 1500,
    }),
  });
  if (!res.ok) throw new Error(`Perplexity ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

export default async function clusterPlanner() {
  logger.info(STAGE, 'Analyzing topic cluster health...');

  const client = getSanityClient();

  // Fetch all published resources with cluster info
  const articles = await client.fetch(
    `*[_type == "resource" && defined(publishedAt)] {
      _id, title, "slug": slug.current, cluster, tags,
      "isPillar": contentLayer == "pillar" || contentLayer == "Pillar"
    }`
  );

  if (articles.length === 0) {
    logger.info(STAGE, 'No articles found.');
    return { clusters: [] };
  }

  // Group by cluster
  const clusterMap = {};
  for (const article of articles) {
    const cluster = article.cluster || 'uncategorized';
    if (!clusterMap[cluster]) {
      clusterMap[cluster] = { articles: [], pillarUrl: null };
    }
    clusterMap[cluster].articles.push(article);
    if (article.isPillar) {
      clusterMap[cluster].pillarUrl = `https://www.fulcruminternational.org/resources/${article.slug}`;
    }
  }

  const clusterNames = Object.keys(clusterMap).filter(c => c !== 'uncategorized');
  logger.info(STAGE, `Found ${clusterNames.length} clusters, ${articles.length} total articles`);

  const clusterResults = [];

  for (const clusterName of clusterNames) {
    const cluster = clusterMap[clusterName];

    // Query Perplexity for essential subtopics
    let subtopics = [];
    try {
      const result = await queryPerplexity(
        `For a comprehensive content hub about "${clusterName}" targeting agency network managers and provider directory operators, ` +
        `what are the 10 essential subtopics that must be covered? ` +
        `List them as a numbered list — just the subtopic names, no descriptions. ` +
        `Focus on practical, search-optimized topics that people actually search for.`
      );
      // Parse numbered list
      subtopics = result.split('\n')
        .map(line => line.replace(/^\d+[\.\)]\s*/, '').trim())
        .filter(line => line.length > 5 && line.length < 100);
    } catch (err) {
      logger.warn(STAGE, `Subtopic query failed for "${clusterName}": ${err.message}`);
      subtopics = [];
    }

    // Score coverage
    const articleTitlesLower = cluster.articles.map(a => a.title.toLowerCase());
    const covered = subtopics.filter(st => {
      const stLower = st.toLowerCase();
      return articleTitlesLower.some(t =>
        t.includes(stLower.split(' ').slice(0, 2).join(' ')) ||
        stLower.split(' ').filter(w => w.length > 4).some(w => t.includes(w))
      );
    });

    const coverage = subtopics.length > 0
      ? Math.round((covered.length / subtopics.length) * 100)
      : 0;

    const gaps = subtopics.filter(st => !covered.includes(st));

    clusterResults.push({
      cluster: clusterName,
      pillarUrl: cluster.pillarUrl || 'No pillar page',
      articleCount: cluster.articles.length,
      coverage: coverage + '%',
      gaps: gaps.slice(0, 5),
      articles: cluster.articles.map(a => a.title),
    });

    logger.info(STAGE, `"${clusterName}": ${cluster.articles.length} articles, ${coverage}% coverage, ${gaps.length} gaps`);
  }

  // Handle uncategorized articles
  const uncategorized = clusterMap['uncategorized']?.articles || [];
  if (uncategorized.length > 0) {
    logger.warn(STAGE, `${uncategorized.length} articles have no cluster: ${uncategorized.map(a => a.slug).join(', ')}`);
  }

  // Write to Google Sheet "Cluster Map" tab
  try {
    const sheets = await getSheetsClient();
    const spreadsheetId = config.google.sheetsSpreadsheetId;

    const header = [['Cluster', 'Pillar URL', 'Articles', 'Coverage', 'Gaps', 'Last Updated']];
    const rows = clusterResults.map(c => [
      c.cluster,
      c.pillarUrl,
      c.articleCount.toString(),
      c.coverage,
      c.gaps.join('; '),
      new Date().toISOString().split('T')[0],
    ]);

    try {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: "'Cluster Map'!A1:F1",
        valueInputOption: 'RAW',
        requestBody: { values: header },
      });
    } catch {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: 'Cluster Map' } } }] },
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: "'Cluster Map'!A1:F1",
        valueInputOption: 'RAW',
        requestBody: { values: header },
      });
    }

    // Clear old data and write new
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: "'Cluster Map'!A2:F100",
    });
    if (rows.length > 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `'Cluster Map'!A2:F${rows.length + 1}`,
        valueInputOption: 'RAW',
        requestBody: { values: rows },
      });
    }
    logger.info(STAGE, `Cluster map written to sheet (${rows.length} clusters)`);
  } catch (err) {
    logger.warn(STAGE, `Failed to write cluster map to sheet: ${err.message}`);
  }

  // Slack digest
  if (clusterResults.length > 0) {
    const digest = clusterResults.map(c =>
      `*${c.cluster}*: ${c.articleCount} articles, ${c.coverage} coverage` +
      (c.gaps.length > 0 ? `\n  Gaps: ${c.gaps.slice(0, 3).join(', ')}` : ' (fully covered)')
    ).join('\n\n');

    await sendSlackAlert(
      `📊 Topic Cluster Health Report\n\n${digest}` +
      (uncategorized.length > 0 ? `\n\n⚠️ ${uncategorized.length} uncategorized article(s)` : '')
    );
  }

  return { clusters: clusterResults, uncategorized: uncategorized.length };
}

if (process.argv[1] && process.argv[1].endsWith('00b-cluster-planner.js')) {
  clusterPlanner()
    .then(r => console.log(`${r.clusters.length} clusters analyzed`))
    .catch(err => { console.error(err); process.exit(1); });
}
