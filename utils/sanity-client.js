import { createClient } from '@sanity/client';
import config from './config.js';

let _client = null;

export default function getSanityClient() {
  if (_client) return _client;
  _client = createClient({
    projectId: config.sanity.projectId,
    dataset: config.sanity.dataset,
    apiVersion: config.sanity.apiVersion,
    token: config.sanity.token,
    useCdn: false,
  });
  return _client;
}
