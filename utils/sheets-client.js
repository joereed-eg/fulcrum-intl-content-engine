import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import config from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function getAuthClient(scopes) {
  let keyFile;

  // If GOOGLE_SERVICE_ACCOUNT_JSON env var is set (GitHub Actions), write to temp file
  if (config.google.serviceAccountJson) {
    keyFile = join(tmpdir(), 'gcp-sa-key.json');
    if (!existsSync(keyFile)) {
      writeFileSync(keyFile, config.google.serviceAccountJson);
    }
  } else {
    const saPath = config.google.serviceAccountPath;
    if (!saPath) throw new Error('No Google service account configured. Set GOOGLE_SERVICE_ACCOUNT_JSON env var or google.serviceAccountPath in credentials.json');
    keyFile = saPath.startsWith('.') ? join(__dirname, '..', saPath) : saPath;
  }

  const auth = new google.auth.GoogleAuth({ keyFile, scopes });
  return auth.getClient();
}

export async function getSheetsClient() {
  const authClient = await getAuthClient(['https://www.googleapis.com/auth/spreadsheets']);
  return google.sheets({ version: 'v4', auth: authClient });
}

export function getSheetConfig() {
  return {
    spreadsheetId: config.google.sheetsSpreadsheetId,
    tab: config.google.sheetsTab,
  };
}

export async function readSheetRange(tab, range) {
  const sheets = await getSheetsClient();
  const conf = getSheetConfig();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: conf.spreadsheetId,
    range: `'${tab}'!${range}`,
  });
  return res.data.values || [];
}

export async function appendSheetRows(tab, values) {
  const sheets = await getSheetsClient();
  const conf = getSheetConfig();
  await sheets.spreadsheets.values.append({
    spreadsheetId: conf.spreadsheetId,
    range: `'${tab}'!A:Z`,
    valueInputOption: 'RAW',
    requestBody: { values },
  });
}

export async function writeSheetRange(tab, range, values) {
  const sheets = await getSheetsClient();
  const conf = getSheetConfig();
  await sheets.spreadsheets.values.update({
    spreadsheetId: conf.spreadsheetId,
    range: `'${tab}'!${range}`,
    valueInputOption: 'RAW',
    requestBody: { values },
  });
}
