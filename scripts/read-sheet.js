#!/usr/bin/env node
import { google } from 'googleapis';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SA_PATH = join(__dirname, '..', 'config', 'google-service-account.json');
const SHEET_ID = '1blInhKVyDMNF90XaOKgba4hK7ADhUDyIZ40r6po5vLw';
const TAB = 'Content Calendar v2';

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: SA_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${TAB}'!A:U`,
  });

  const rows = res.data.values || [];
  console.log(`Total rows: ${rows.length}`);
  rows.forEach((row, i) => {
    const title = row[4] || '';
    const status = row[0] || '';
    const date = row[1] || '';
    console.log(`Row ${i}: [${status}] ${date} | ${title}`);
  });
}

main().catch(err => { console.error(err); process.exit(1); });
