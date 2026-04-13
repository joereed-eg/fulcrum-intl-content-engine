/**
 * Stage 5: Cover Image Generator (Google Imagen 4)
 *
 * Generates a photorealistic cover image using Google's Imagen 4 API,
 * uploads it to Sanity as a regular image asset, and patches it onto the article.
 *
 * Replaces the Sanity Agent Actions approach — better photorealism,
 * no AI quota issues, real people in images.
 *
 * Required env: GOOGLE_AI_API_KEY, SANITY_TOKEN, SANITY_PROJECT_ID, SANITY_DATASET
 */

import { createClient } from '@sanity/client';
import config from '../utils/config.js';
import logger from '../utils/logger.js';

const STAGE = 'image';
const GOOGLE_AI_KEY = process.env.GOOGLE_AI_API_KEY || config.google?.aiApiKey || '';
const IMAGEN_MODEL = 'imagen-4.0-generate-001';

function getSanityClient() {
  return createClient({
    projectId: config.sanity.projectId,
    dataset: config.sanity.dataset,
    apiVersion: '2024-01-01',
    token: config.sanity.token,
    useCdn: false,
  });
}

/**
 * Build a photorealistic image prompt from article context.
 * Focus: real people, warm human moments that embody the content.
 */
function buildPrompt(job, article) {
  const excerpt = (article?.excerpt || job.brief || '').substring(0, 150);
  const tags = (article?.tags || []).slice(0, 4).join(', ');

  // Describe the SCENE, never the article title. Titles cause text rendering.
  return [
    'Photorealistic editorial photograph.',
    excerpt ? `Scene concept: ${excerpt}` : '',
    tags ? `Mood themes: ${tags}` : '',
    'Real people in authentic human moments: deep conversation, attentive listening, collaborative work, quiet reflection, community gathering.',
    'Warm natural lighting, earth tone palette (cream, sage, warm wood, soft gold, terracotta).',
    'Setting: sunlit room, quiet coffee shop, retreat center courtyard, or natural outdoor space.',
    'Shallow depth of field, eye-level camera, 16:9 landscape composition.',
    'Editorial magazine quality. Feels candid and unposed.',
    'ABSOLUTELY NO TEXT anywhere in the image. No words, no letters, no numbers, no signage, no logos, no watermarks, no captions, no overlays.',
    'No stock photo aesthetics. No corporate poses. No clinical settings. No screens or devices.',
    'Diverse subjects. Natural expressions. Real skin texture and lighting.',
  ].filter(Boolean).join(' ');
}

export default async function imageGenerator(job, docId, article = null) {
  if (!GOOGLE_AI_KEY) {
    logger.warn(STAGE, 'No GOOGLE_AI_API_KEY configured — skipping image generation');
    return { generated: false, reason: 'no-api-key' };
  }

  logger.info(STAGE, `Generating cover image for "${job.title}" via Google Imagen 4`);

  const prompt = buildPrompt(job, article);

  try {
    // Step 1: Generate image via Google Imagen 4 API
    const genUrl = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGEN_MODEL}:predict?key=${GOOGLE_AI_KEY}`;

    const genRes = await fetch(genUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: {
          sampleCount: 1,
          aspectRatio: '16:9',
          personGeneration: 'ALLOW_ALL',
          negativePrompt: 'text, words, letters, numbers, signage, logos, watermarks, captions, overlays, banners, headlines, typography, writing, labels, stamps, badges, icons with text, book covers with text, screens with text',
        },
      }),
    });

    let imageBytes;

    if (genRes.ok) {
      const genData = await genRes.json();
      const b64 = genData.predictions?.[0]?.bytesBase64Encoded;
      if (!b64) {
        logger.warn(STAGE, 'Imagen API returned no image data');
        return { generated: false, reason: 'no-image-data' };
      }
      imageBytes = Buffer.from(b64, 'base64');
    } else {
      // Fallback: try the genai SDK-style endpoint
      const fallbackUrl = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGEN_MODEL}:generateImages?key=${GOOGLE_AI_KEY}`;
      const fallbackRes = await fetch(fallbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          config: { numberOfImages: 1 },
        }),
      });

      if (!fallbackRes.ok) {
        const errText = await fallbackRes.text();
        logger.warn(STAGE, `Imagen API failed: ${fallbackRes.status} — ${errText.substring(0, 200)}`);
        return { generated: false, reason: `api-error-${fallbackRes.status}` };
      }

      const fallbackData = await fallbackRes.json();
      const b64 = fallbackData.generatedImages?.[0]?.image?.imageBytes;
      if (!b64) {
        logger.warn(STAGE, 'Imagen fallback returned no image data');
        return { generated: false, reason: 'no-image-data-fallback' };
      }
      imageBytes = Buffer.from(b64, 'base64');
    }

    logger.info(STAGE, `Image generated (${imageBytes.length} bytes). Uploading to Sanity...`);

    // Step 2: Upload image to Sanity as a regular asset
    const client = getSanityClient();
    const asset = await client.assets.upload('image', imageBytes, {
      filename: `cover-${docId}.png`,
      contentType: 'image/png',
    });

    logger.info(STAGE, `Image uploaded: ${asset._id}`);

    // Step 3: Patch the coverImage field on the article
    await client.patch(docId).set({
      coverImage: {
        _type: 'image',
        asset: {
          _type: 'reference',
          _ref: asset._id,
        },
        alt: `Cover image for ${job.title}`,
      },
    }).commit();

    logger.info(STAGE, `Cover image patched onto doc ${docId}`);
    return { generated: true, assetId: asset._id };

  } catch (err) {
    logger.warn(STAGE, `Image generation error: ${err.message}. Article published without cover image.`);
    return { generated: false, reason: err.message };
  }
}
