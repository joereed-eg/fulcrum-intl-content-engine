import { JWT } from 'google-auth-library';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from '../utils/config.js';
import logger from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STAGE = 'indexing';

function getCredentials() {
  if (config.google?.serviceAccountJson) return JSON.parse(config.google.serviceAccountJson);
  const saPath = config.google?.serviceAccountPath || join(__dirname, '..', 'config', 'google-service-account.json');
  const fullPath = saPath.startsWith('.') ? join(__dirname, '..', saPath) : saPath;
  if (!existsSync(fullPath)) throw new Error('No Google service account configured');
  return JSON.parse(readFileSync(fullPath, 'utf-8'));
}

export default async function googleIndexing(url) {
  logger.info(STAGE, `Submitting ${url} for indexing...`);

  try {
    const creds = getCredentials();
    const jwt = new JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ['https://www.googleapis.com/auth/indexing'],
    });
    await jwt.authorize();

    const res = await fetch('https://indexing.googleapis.com/v3/urlNotifications:publish', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwt.credentials.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        type: 'URL_UPDATED',
      }),
    });

    if (res.ok) {
      const data = await res.json();
      logger.info(STAGE, `Indexing request accepted: ${JSON.stringify(data)}`);
    } else {
      const text = await res.text();
      logger.warn(STAGE, `Indexing API returned ${res.status}: ${text}`);
    }
  } catch (err) {
    logger.warn(STAGE, `Indexing API failed: ${err.message}. This is best-effort, continuing.`);
  }

  // Also ping sitemap
  try {
    const sitemapRes = await fetch('https://www.google.com/ping?sitemap=https://www.fulcruminternational.org/sitemap.xml');
    logger.info(STAGE, `Sitemap ping: ${sitemapRes.status}`);
  } catch (err) {
    logger.warn(STAGE, `Sitemap ping failed: ${err.message}`);
  }
}

// Standalone
if (process.argv[1] && process.argv[1].endsWith('06b-indexing.js')) {
  const url = process.argv[2] || 'https://www.fulcruminternational.org/resources/test-article';
  googleIndexing(url)
    .then(() => console.log('Done'))
    .catch(err => { console.error(err); process.exit(1); });
}
