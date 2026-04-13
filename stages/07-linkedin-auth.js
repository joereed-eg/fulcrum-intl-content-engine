import { createServer } from 'http';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from '../utils/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = join(__dirname, '..', 'config', 'linkedin-token.json');

const clientId = config.linkedin.clientId;
const clientSecret = config.linkedin.clientSecret;
const redirectUri = config.linkedin.redirectUri || 'http://localhost:3456/callback';

if (!clientId || clientId.startsWith('[')) {
  console.log('LinkedIn client ID not configured. Add to credentials.json first.');
  process.exit(1);
}

const scopes = 'openid profile w_member_social';
const authUrl = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}`;

console.log(`\n========================================`);
console.log(`LinkedIn OAuth Setup`);
console.log(`========================================\n`);
console.log(`Open this URL in your browser:\n`);
console.log(authUrl);
console.log(`\nWaiting for callback on port 3456...\n`);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:3456');
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end(`<h1>Error</h1><p>${error}: ${url.searchParams.get('error_description')}</p>`);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<p>Waiting for authorization...</p>');
    return;
  }

  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`<h1>Token exchange failed</h1><pre>${JSON.stringify(tokenData, null, 2)}</pre>`);
      server.close();
      process.exit(1);
    }

    // Get profile info
    const profileRes = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
    });
    const profile = await profileRes.json();

    const tokens = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || null,
      expiresAt: Date.now() + (tokenData.expires_in * 1000),
      personUrn: `urn:li:person:${profile.sub}`,
      name: profile.name,
    };

    writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <h1>LinkedIn Connected!</h1>
      <p>Authenticated as <strong>${profile.name}</strong></p>
      <p>Person URN: ${tokens.personUrn}</p>
      <p>Token expires: ${new Date(tokens.expiresAt).toLocaleString()}</p>
      <p>You can close this tab.</p>
    `);

    console.log(`\nAuthenticated as ${profile.name}`);
    console.log(`Person URN: ${tokens.personUrn}`);
    console.log(`Tokens saved to ${TOKEN_FILE}`);
    console.log(`\nNow run these to add to GitHub Secrets:`);
    console.log(`  gh secret set LINKEDIN_ACCESS_TOKEN --body "${tokens.accessToken}"`);
    console.log(`  gh secret set LINKEDIN_PERSON_URN --body "${tokens.personUrn}"`);

  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end(`<h1>Error</h1><pre>${err.message}</pre>`);
  }

  server.close();
});

server.listen(3456);
