import { getSheetsClient, getSheetConfig } from '../utils/sheets-client.js';
import logger from '../utils/logger.js';

const STAGE = 'sheet-reader';

// Column mapping (0-indexed)
const COL = {
  stage: 0, publishDate: 1, contentLayer: 2, cluster: 3, title: 4,
  audience: 5, wordCountTarget: 6, primaryKeyword: 7, secondaryKeywords: 8,
  primaryPillarUrl: 9, subPillarUrl: 10, internalLink1: 11, internalLink2: 12,
  internalLink3: 13, externalLink1: 14, externalLink2: 15, ctaPrimary: 16,
  ctaSecondary: 17, brief: 18, categories: 19, notes: 20,
};

function parseDate(val) {
  if (!val) return null;
  if (typeof val === 'number') {
    const epoch = new Date(1899, 11, 30);
    epoch.setDate(epoch.getDate() + val);
    return epoch;
  }
  return new Date(val);
}

export default async function sheetReader() {
  logger.info(STAGE, 'Reading content calendar...');

  const sheets = await getSheetsClient();
  const config = getSheetConfig();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range: `'${config.tab}'!A:U`,
  });

  const rows = res.data.values;
  if (!rows || rows.length < 2) {
    logger.info(STAGE, 'No rows found in sheet');
    return [];
  }

  const today = new Date();
  today.setHours(23, 59, 59, 999);

  const jobs = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const stage = (row[COL.stage] || '').trim();
    const pubDate = parseDate(row[COL.publishDate]);

    if (stage === 'Planned' && pubDate && pubDate <= today) {
      const rowNumber = i + 1; // 1-indexed for Sheets API

      // Lock the row immediately
      await sheets.spreadsheets.values.update({
        spreadsheetId: config.spreadsheetId,
        range: `'${config.tab}'!A${rowNumber}`,
        valueInputOption: 'RAW',
        requestBody: { values: [['In Progress']] },
      });

      const job = {
        rowIndex: rowNumber,
        title: row[COL.title] || '',
        audience: row[COL.audience] || '',
        wordCountTarget: parseInt(row[COL.wordCountTarget]) || 1500,
        primaryKeyword: row[COL.primaryKeyword] || '',
        secondaryKeywords: row[COL.secondaryKeywords] || '',
        primaryPillarUrl: row[COL.primaryPillarUrl] || '',
        subPillarUrl: row[COL.subPillarUrl] || '',
        internalLink1: row[COL.internalLink1] || '',
        internalLink2: row[COL.internalLink2] || '',
        internalLink3: row[COL.internalLink3] || '',
        externalLink1: row[COL.externalLink1] || '',
        externalLink2: row[COL.externalLink2] || '',
        ctaPrimary: row[COL.ctaPrimary] || '',
        ctaSecondary: row[COL.ctaSecondary] || '',
        brief: row[COL.brief] || '',
        categories: row[COL.categories] || '',
        contentLayer: row[COL.contentLayer] || '',
        cluster: row[COL.cluster] || '',
        publishDate: row[COL.publishDate] || new Date().toISOString().split('T')[0],
        notes: row[COL.notes] || '',
      };

      jobs.push(job);
      logger.info(STAGE, `Locked row ${rowNumber}: "${job.title}" (${job.publishDate})`);
    }
  }

  if (jobs.length === 0) {
    logger.info(STAGE, 'Nothing to publish today');
  } else {
    logger.info(STAGE, `${jobs.length} article(s) due for publishing`);
  }

  return jobs;
}

// Standalone execution
if (process.argv[1] && process.argv[1].endsWith('01-sheet-reader.js')) {
  sheetReader()
    .then(jobs => {
      if (jobs.length) {
        jobs.forEach(j => console.log(`- ${j.title} (${j.publishDate})`));
      } else {
        console.log('No qualifying rows found.');
      }
    })
    .catch(err => { console.error(err); process.exit(1); });
}
