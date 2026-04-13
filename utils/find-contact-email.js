// utils/find-contact-email.js — Free 3-layer contact email discovery

const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const CONTACT_PATHS = ['/contact', '/about', '/write-for-us', '/contribute', '/guest-post', '/submissions', '/contact-us'];
const STANDARD_PREFIXES = ['info', 'editor', 'hello', 'contact', 'submissions', 'guest', 'partnerships'];

export async function findContactEmail(domain, { perplexityApiKey = null, brandName = 'LinkChecker' } = {}) {
  // Layer 1: direct HTML scrape
  for (const path of CONTACT_PATHS) {
    try {
      const res = await fetch(`https://${domain}${path}`, {
        headers: { 'User-Agent': `${brandName}/1.0` },
        signal: AbortSignal.timeout(7000),
      });
      if (!res.ok) continue;
      const html = await res.text();
      const normalized = html
        .replace(/\[at\]/gi, '@')
        .replace(/\s*\(at\)\s*/gi, '@')
        .replace(/\[dot\]/gi, '.')
        .replace(/\s*\(dot\)\s*/gi, '.');
      const matches = normalized.match(EMAIL_REGEX) || [];
      const real = matches.filter(e =>
        !e.match(/\.(png|jpg|gif|svg|css|js)$/i) &&
        !e.startsWith('noreply@') &&
        !e.startsWith('no-reply@') &&
        !e.includes('example.com') &&
        !e.includes('sentry.io') &&
        !e.includes('wix.com')
      );
      if (real.length > 0) return { email: real[0], source: 'scrape', path };
    } catch { /* continue */ }
  }

  // Layer 2: Perplexity lookup
  if (perplexityApiKey) {
    try {
      const res = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${perplexityApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'sonar',
          messages: [{
            role: 'user',
            content: `What is the contact email address or guest post submission email for ${domain}? Check their contact page, about page, write-for-us page, and any contributor guidelines. Return ONLY the email address if found (format: name@domain.com), or return the exact text "NOT_FOUND" if no email is publicly listed. Do not guess or make up an email address.`,
          }],
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content?.trim() || '';
        const match = text.match(EMAIL_REGEX);
        if (match && !text.includes('NOT_FOUND')) {
          return { email: match[0], source: 'perplexity' };
        }
      }
    } catch { /* continue */ }
  }

  // Layer 3: pattern candidates
  const candidates = STANDARD_PREFIXES.map(p => `${p}@${domain}`);
  return { email: null, candidates, source: 'guesses' };
}
