import logger from '../utils/logger.js';

export default async function substackStub(job) {
  logger.info('substack', 'Substack uses RSS auto-import, no action needed. Ensure RSS feed is configured in Substack dashboard.');
  return { status: 'rss-auto-import', message: 'Substack imports via RSS — no API action required' };
}

if (process.argv[1] && process.argv[1].endsWith('07-substack.js')) {
  substackStub({}).then(() => console.log('Done'));
}
