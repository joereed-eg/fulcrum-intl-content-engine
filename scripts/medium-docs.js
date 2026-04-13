#!/usr/bin/env node

/**
 * Create Google Docs for Medium cross-posting.
 * Each article gets its own doc in the target Drive folder,
 * fully formatted with hyperlinks, bullet points, images,
 * and backlinks naturally embedded in the content.
 *
 * Usage:
 *   node scripts/medium-docs.js                    # All articles
 *   node scripts/medium-docs.js --days=7            # Last 7 days only
 *   node scripts/medium-docs.js --delete-existing   # Clear folder first
 */

import { google } from 'googleapis';
import { createClient } from '@sanity/client';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';
import config from '../utils/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_URL = 'https://www.fulcruminternational.org';
// Configure via DRIVE_FOLDER_ID env var (Google Drive folder for Fulcrum Intl Medium drafts)
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || '';

// All articles with their titles for cross-linking
let ALL_ARTICLES = [];

// Cross-link map: slug -> related slugs for backlinks
const BACKLINK_MAP = {
  'earn-revenue-from-referrals': ['how-agencies-earn', 'three-sided-marketplace'],
  'three-sided-marketplace': ['your-network-is-already-a-marketplace', 'earn-revenue-from-referrals'],
  'managing-clients-across-platforms': ['networks-into-revenue'],
  'cost-of-no-directory': ['why-directories-go-stale', 'how-to-prevent-ghost-directories-and-keep-provider-networks-alive'],
  'multi-agency-listing': ['multi-agency-provider-listing-the-network-effect-for-providers', 'how-agencies-earn'],
  'how-agencies-earn': ['networks-into-revenue', 'earn-revenue-from-referrals'],
  'why-directories-go-stale': ['how-to-prevent-ghost-directories-and-keep-provider-networks-alive', 'cost-of-no-directory'],
  'networks-into-revenue': ['how-agencies-earn', 'earn-revenue-from-referrals'],
  'your-network-is-already-a-marketplace': ['three-sided-marketplace', 'white-label-provider-marketplaces'],
  'multi-agency-provider-listing-the-network-effect-for-providers': ['multi-agency-listing', 'how-agencies-earn'],
  'white-label-provider-marketplaces': ['your-network-is-already-a-marketplace', 'networks-into-revenue'],
  'how-to-prevent-ghost-directories-and-keep-provider-networks-alive': ['why-directories-go-stale', 'cost-of-no-directory'],
};

function getAuth() {
  let credentials;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } else {
    const saPath = config.google.serviceAccountPath || join(__dirname, '..', 'config', 'google-service-account.json');
    credentials = JSON.parse(readFileSync(saPath, 'utf-8'));
  }

  return new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: [
      'https://www.googleapis.com/auth/documents',
      'https://www.googleapis.com/auth/drive',
    ],
    subject: process.env.GOOGLE_IMPERSONATE_EMAIL || 'joe@fulcrumcollective.io',
  });
}

async function fetchArticles(days) {
  const client = createClient({
    projectId: config.sanity.projectId,
    dataset: config.sanity.dataset,
    token: config.sanity.token,
    apiVersion: config.sanity.apiVersion,
    useCdn: false,
  });

  let query, params = {};
  if (days) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    query = `*[_type == "resource" && defined(slug.current) && publishedAt >= $since] | order(publishedAt desc)`;
    params = { since };
  } else {
    query = `*[_type == "resource" && defined(slug.current)] | order(publishedAt desc)`;
  }

  return client.fetch(
    `${query} {
      _id, title, "slug": slug.current, publishedAt, excerpt,
      metaTitle, metaDescription, primaryKeyword,
      "categories": categories[]->title,
      "imageUrl": coalesce(coverImage.asset->url, mainImage.asset->url, heroImage.asset->url),
      body
    }`,
    params
  );
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderSpan(child, markDefs) {
  let text = escapeHtml(child.text || '');
  if (!text) return '';

  const marks = child.marks || [];

  // Apply link marks (from markDefs)
  for (const markKey of marks) {
    const markDef = (markDefs || []).find(m => m._key === markKey);
    if (markDef?._type === 'link' && markDef?.href) {
      text = `<a href="${escapeHtml(markDef.href)}">${text}</a>`;
    }
    // Handle strong/em defined as markDefs (some schemas do this)
    if (markDef?._type === 'strong') {
      text = `<strong>${text}</strong>`;
    }
    if (markDef?._type === 'em') {
      text = `<em>${text}</em>`;
    }
  }

  // Apply decorator marks
  if (marks.includes('strong')) text = `<strong>${text}</strong>`;
  if (marks.includes('em')) text = `<em>${text}</em>`;
  if (marks.includes('code')) text = `<code>${text}</code>`;
  if (marks.includes('underline')) text = `<u>${text}</u>`;
  if (marks.includes('strike-through')) text = `<s>${text}</s>`;

  return text;
}

function portableTextToHtml(body, slug) {
  if (!body || !Array.isArray(body)) return '';

  const parts = [];
  let inList = null; // 'bullet' or 'number'
  let listCounter = 1;

  for (let i = 0; i < body.length; i++) {
    const block = body[i];
    const nextBlock = body[i + 1];

    if (block._type === 'block') {
      const children = (block.children || []).map(c => renderSpan(c, block.markDefs)).join('');
      if (!children.trim()) continue;

      const listItem = block.listItem;
      const style = block.style || 'normal';

      // Handle list transitions — no HTML lists, use plain bullet chars
      // to avoid Google Docs adding paragraph spacing between items
      if (!listItem && inList) {
        inList = null;
      }
      if (listItem) {
        inList = listItem;
      }

      if (listItem) {
        const prefix = listItem === 'number' ? `${listCounter++}.` : '•';
        parts.push(`<p style="margin:0;padding:0;">${prefix} ${children}</p>`);
      } else {
        listCounter = 1;
        const headingMap = { h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h5', h6: 'h6' };
        const tag = headingMap[style] || 'p';
        if (style === 'blockquote') {
          parts.push(`<blockquote style="border-left: 3px solid #ccc; padding-left: 12px; margin: 16px 0;"><p>${children}</p></blockquote>`);
        } else {
          parts.push(`<${tag}>${children}</${tag}>`);
        }
      }
    } else if (block._type === 'image' && block.asset) {
      // Inline images
      const ref = block.asset._ref || '';
      if (ref) {
        // Convert Sanity image ref to URL
        const [, id, dims, ext] = ref.split('-');
        if (id && dims && ext) {
          const imageUrl = `https://cdn.sanity.io/images/${config.sanity.projectId}/${config.sanity.dataset}/${id}-${dims}.${ext}?w=800`;
          parts.push(`<p><img src="${imageUrl}" width="600" /></p>`);
        }
      }
    }
  }

  // No list tags to close — using plain text bullets

  return parts.join('\n');
}

function buildBacklinkParagraphs(slug) {
  const relatedSlugs = BACKLINK_MAP[slug] || [];
  if (relatedSlugs.length === 0) return '';

  const links = relatedSlugs.map(s => {
    const article = ALL_ARTICLES.find(a => a.slug === s);
    const title = article ? (article.metaTitle || article.title) : s.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const url = `${SITE_URL}/resources/${s}`;
    return { title, url };
  });

  // Build "Related reading" section that looks natural
  const parts = [];
  parts.push(`<h2>Related reading</h2>`);
  parts.push(`<p>If you found this useful, these related articles go deeper on specific aspects:</p>`);
  for (const link of links) {
    parts.push(`<p style="margin:0;padding:0;">• <a href="${link.url}">${escapeHtml(link.title)}</a></p>`);
  }
  parts.push(`<p>Explore the full <a href="${SITE_URL}/resources">Fulcrum International resource library</a> for more on the operational and strategic infrastructure that lets nonprofits deliver the impact they were built for.</p>`);

  return parts.join('\n');
}

function buildMediumTags(slug, article) {
  // First 4 are always the same
  const tags = ['Provider Networks', 'Technology', 'Behavioral Health', 'SaaS'];

  // 5th tag based on article cluster
  const clusterMap = {
    'earn-revenue-from-referrals': 'Revenue Model',
    'how-agencies-earn': 'Revenue Model',
    'networks-into-revenue': 'Revenue Model',
    'cost-of-no-directory': 'Data Quality',
    'why-directories-go-stale': 'Data Quality',
    'how-to-prevent-ghost-directories-and-keep-provider-networks-alive': 'Data Quality',
    'your-network-is-already-a-marketplace': 'Marketplace',
    'three-sided-marketplace': 'Marketplace',
    'white-label-provider-marketplaces': 'White Label',
    'multi-agency-listing': 'Agency Growth',
    'multi-agency-provider-listing-the-network-effect-for-providers': 'Agency Growth',
    'managing-clients-across-platforms': 'Agency Growth',
  };

  const fifth = clusterMap[slug] || (article.primaryKeyword || 'Platform Strategy');
  tags.push(fifth);

  return tags;
}

function buildHtml(article) {
  const slug = article.slug;
  const publishedUrl = `${SITE_URL}/resources/${slug}`;
  const title = article.metaTitle || article.title;
  const published = article.publishedAt
    ? new Date(article.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : 'Draft';

  const bodyHtml = portableTextToHtml(article.body, slug);
  const backlinkHtml = buildBacklinkParagraphs(slug);
  const mediumTags = buildMediumTags(slug, article);

  const imageDownloadUrl = article.imageUrl
    ? `${article.imageUrl}?dl=${slug}.jpg`
    : null;

  const imageHtml = article.imageUrl
    ? `<p><img src="${article.imageUrl}?w=800&fit=max" width="600" /></p>
       <p style="font-size: 9pt; color: #888;">Download image: <a href="${imageDownloadUrl}">${imageDownloadUrl}</a></p>`
    : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body>
  <p style="background-color: #f0f4ff; padding: 10px; border-radius: 4px; font-size: 10pt;"><strong>Medium Topics:</strong> ${mediumTags.join(' · ')}</p>

  ${imageHtml}

  <h1>${escapeHtml(title)}</h1>
  <p style="color: #888; font-size: 10pt;">Published: ${published} | Canonical: <a href="${publishedUrl}">${publishedUrl}</a></p>

  ${bodyHtml}

  ${backlinkHtml}

  <hr>
  <p style="color: #999; font-size: 9pt; font-style: italic;">
    Import to Medium: Profile → Stories → Import a story → paste <a href="${publishedUrl}">${publishedUrl}</a>.
    Medium auto-sets the canonical tag. The backlinks above are already embedded — just copy-paste the entire doc.
  </p>
</body>
</html>`;
}

async function deleteExistingDocs(drive) {
  console.log('Deleting existing docs in folder...');
  const res = await drive.files.list({
    q: `'${DRIVE_FOLDER_ID}' in parents and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 100,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: 'allDrives',
  });

  for (const file of (res.data.files || [])) {
    await drive.files.delete({ fileId: file.id, supportsAllDrives: true });
    console.log(`  Deleted: ${file.name}`);
  }
}

async function createArticleDoc(drive, article) {
  const title = article.metaTitle || article.title;
  const html = buildHtml(article);

  const res = await drive.files.create({
    requestBody: {
      name: `${title} — Medium Cross-Post`,
      mimeType: 'application/vnd.google-apps.document',
      parents: [DRIVE_FOLDER_ID],
    },
    media: {
      mimeType: 'text/html',
      body: Readable.from([html]),
    },
    supportsAllDrives: true,
    fields: 'id, webViewLink',
  });

  const docUrl = res.data.webViewLink;
  console.log(`  ✓ ${title}`);
  console.log(`    ${docUrl}`);
  return { title, docUrl, docId: res.data.id };
}

async function run() {
  const daysArg = process.argv.find(a => a.startsWith('--days='));
  const days = daysArg ? parseInt(daysArg.split('=')[1], 10) : null;
  const shouldDelete = process.argv.includes('--delete-existing');

  console.log('Authenticating with Google...');
  const auth = getAuth();
  const drive = google.drive({ version: 'v3', auth });

  if (shouldDelete) {
    await deleteExistingDocs(drive);
  }

  console.log(`Fetching articles from Sanity${days ? ` (last ${days} days)` : ' (all)'}...\n`);
  const articles = await fetchArticles(days);
  ALL_ARTICLES = articles;

  if (articles.length === 0) {
    console.log('No articles found. Nothing to create.');
    return;
  }

  console.log(`Creating ${articles.length} Google Docs in Medium folder...\n`);
  const results = [];

  for (const article of articles) {
    try {
      const result = await createArticleDoc(drive, article);
      results.push(result);
    } catch (err) {
      console.log(`  ✗ ${article.title}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`\n=== DONE: ${results.length}/${articles.length} docs created ===`);
  console.log(`Folder: https://drive.google.com/drive/folders/${DRIVE_FOLDER_ID}`);

  // Send Slack notification via Huck bot
  if (results.length > 0) {
    try {
      const { sendSlackAlert } = await import('../utils/slack.js');
      const links = results.map(r => `• ${r.title}\n  ${r.docUrl}`).join('\n');
      const text = `*Medium Cross-Post Docs Ready* (${results.length} article${results.length > 1 ? 's' : ''})\n\nNew docs in <https://drive.google.com/drive/folders/${DRIVE_FOLDER_ID}|Medium Cross-Posts folder>:\n${links}`;
      await sendSlackAlert(text);
      console.log('Slack notification sent.');
    } catch (err) {
      console.error('Slack notification failed:', err.message);
    }
  }
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
