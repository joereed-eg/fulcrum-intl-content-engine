#!/usr/bin/env node

/**
 * Monthly outreach orchestrator.
 * Runs podcast prospector and guest post pitcher.
 * Separate from monitor.js because these run monthly, not weekly.
 */

import podcastProspector from './stages/16-podcast-prospector.js';
import guestPostPitcher from './stages/17-guest-post-pitcher.js';
import logger from './utils/logger.js';
import { sendSlackAlert } from './utils/slack.js';

async function runStage(name, fn) {
  try {
    const result = await fn();
    logger.info('outreach', `${name}: OK`);
    return result;
  } catch (err) {
    logger.error('outreach', `${name} failed: ${err.message}`);
    await sendSlackAlert(`${name} failed: ${err.message}`, { severity: 'error' });
    return null;
  }
}

async function run() {
  logger.info('outreach', 'Starting monthly outreach batch...');

  await runStage('Podcast Prospector', podcastProspector);
  await runStage('Guest Post Pitcher', guestPostPitcher);

  logger.save();
}

run().catch(err => {
  console.error('Fatal outreach error:', err);
  process.exit(1);
});
