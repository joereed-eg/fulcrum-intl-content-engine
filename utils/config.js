import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CREDS_FILE = join(__dirname, '..', 'config', 'credentials.json');

let _fileConfig = null;

function loadFileConfig() {
  if (_fileConfig) return _fileConfig;
  if (existsSync(CREDS_FILE)) {
    _fileConfig = JSON.parse(readFileSync(CREDS_FILE, 'utf-8'));
  } else {
    _fileConfig = {};
  }
  return _fileConfig;
}

// Sentinel values that indicate a placeholder, not a real secret
const SENTINEL_VALUES = ['SET_VIA_GITHUB_SECRET', 'CHANGE_ME', 'YOUR_KEY_HERE', ''];

// Resolve a value: env var takes priority, falls back to credentials.json
function get(envKey, jsonPath) {
  const envVal = process.env[envKey];
  if (envVal && !SENTINEL_VALUES.includes(envVal)) return envVal;
  if (!jsonPath) return null;
  const file = loadFileConfig();
  const parts = jsonPath.split('.');
  let val = file;
  for (const p of parts) {
    val = val?.[p];
  }
  if (typeof val === 'string' && SENTINEL_VALUES.includes(val)) return null;
  return val ?? null;
}

export const SITE_URL = get('SITE_URL', null) || 'https://www.fulcruminternational.org';
export const RESOURCES_URL = `${SITE_URL}/resources`;

export default {
  sanity: {
    get projectId() { return get('SANITY_PROJECT_ID', 'sanity.projectId'); },
    get dataset() { return get('SANITY_DATASET', 'sanity.dataset'); },
    get token() { return get('SANITY_TOKEN', 'sanity.token'); },
    get apiVersion() { return get('SANITY_API_VERSION', 'sanity.apiVersion') || '2024-01-01'; },
    get organizationId() { return get('SANITY_ORG_ID', 'sanity.organizationId'); },
  },
  perplexity: {
    get apiKey() { return get('PERPLEXITY_API_KEY', 'perplexity.apiKey'); },
  },
  anthropic: {
    get apiKey() { return get('ANTHROPIC_API_KEY', 'anthropic.apiKey'); },
  },
  google: {
    get serviceAccountJson() { return get('GOOGLE_SERVICE_ACCOUNT_JSON', null); },
    get serviceAccountPath() { return get('GOOGLE_SA_PATH', 'google.serviceAccountPath'); },
    get sheetsSpreadsheetId() { return get('GOOGLE_SHEETS_ID', 'google.sheetsSpreadsheetId'); },
    get sheetsTab() { return get('GOOGLE_SHEETS_TAB', 'google.sheetsTab') || 'Content Calendar v2'; },
    get indexingEnabled() { return get('GOOGLE_INDEXING_ENABLED', 'google.indexingEnabled') !== 'false'; },
  },
  openai: {
    get apiKey() { return get('OPENAI_API_KEY', 'openai.apiKey'); },
  },
  slack: {
    get webhookUrl() { return get('SLACK_WEBHOOK_URL', 'slack.webhookUrl'); },
    get alertUserId() { return get('SLACK_ALERT_USER_ID', 'slack.alertUserId') || 'U0A7J1JELE7'; },
  },
  revalidationSecret: get('REVALIDATION_SECRET', null),
  competitors: ['bridgespan.org', 'taproot.org', 'compasspoint.org', 'nonprofithub.org', 'boardsource.org', 'ssir.org', 'philanthropy.com', 'nonprofitquarterly.org'],
  devto: {
    get apiKey() { return get('DEVTO_API_KEY', 'devto.apiKey'); },
  },
  hashnode: {
    get apiKey() { return get('HASHNODE_API_KEY', 'hashnode.apiKey'); },
    get publicationId() { return get('HASHNODE_PUBLICATION_ID', 'hashnode.publicationId'); },
  },
  linkedin: {
    get clientId() { return get('LINKEDIN_CLIENT_ID', 'linkedin.clientId'); },
    get clientSecret() { return get('LINKEDIN_CLIENT_SECRET', 'linkedin.clientSecret'); },
    get redirectUri() { return get('LINKEDIN_REDIRECT_URI', 'linkedin.redirectUri'); },
    get accessToken() { return get('LINKEDIN_ACCESS_TOKEN', null); },
    get personUrn() { return get('LINKEDIN_PERSON_URN', null); },
  },
};
