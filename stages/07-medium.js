import logger from '../utils/logger.js';

const STAGE = 'medium';

/**
 * Medium no longer offers self-serve API tokens.
 * Instead, a weekly email digest is sent via scripts/medium-digest.js
 * with links for manual cross-posting using Medium's "Import a story" feature.
 */
export default async function mediumStub(job) {
  logger.info(STAGE, 'Medium handled via weekly email digest (scripts/medium-digest.js). Skipping inline.');
  return { status: 'weekly-digest', message: 'Medium posts sent via weekly email digest for manual import' };
}

if (process.argv[1] && process.argv[1].endsWith('07-medium.js')) {
  mediumStub({}).then(() => console.log('Done'));
}
