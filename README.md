# Fulcrum International Content Engine

Autonomous content publishing pipeline for [fulcruminternational.org](https://fulcruminternational.org). Scaffolded from the proven Hunhu pipeline. Reads a Google Sheets content calendar, researches and writes articles in the Fulcrum brand voice, quality-checks against the Bearing Framework positioning, publishes to Sanity CMS (project: `tur3pati`), submits for Google indexing, and monitors SEO performance.

## What this engine produces

Articles map to the five Bearing Framework stages (CLARITY, LEVERAGE, DIRECTION, EXECUTION, MOMENTUM) and the four forces shaping the organization (Ecosystem, Organization, Leader, Vision). Voice: dinner-table direct, name the pattern, no consultant jargon, no em dashes. Audience: nonprofit executive directors, chiefs of staff, and senior program leaders running $1M to $20M organizations.

See `config/brand-voice.md` for the full voice guide and `pillar-pages.json` for seeded pillar URLs (Bearing Approach + the five stage pillars).

## Repo layout

```
.github/workflows/    # 10 cron-driven GitHub Actions
config/
  brand-voice.md      # Fulcrum International voice rules
pillar-pages.json     # Seeded pillar URLs for cluster planning
stages/               # Numbered pipeline stages (00 -> 21)
utils/                # Shared infrastructure (Sanity, Slack, logger, sheets)
pipeline.js           # Daily orchestrator
monitor.js            # Weekly SEO monitor
outreach.js           # Monthly outreach orchestrator
daily-assignments.js  # Daily Slack assignment poster
```

## Required GitHub Secrets

Add these in **GitHub repo settings > Secrets and variables > Actions**:

| Secret | Purpose |
|--------|---------|
| `SANITY_PROJECT_ID` | `tur3pati` (Fulcrum Intl Sanity project) |
| `SANITY_DATASET` | `production` (or your dataset name) |
| `SANITY_TOKEN` | Sanity write token with editor permissions |
| `SANITY_ORG_ID` | Sanity organization ID (for image agent) |
| `ANTHROPIC_API_KEY` | Claude API key (Sonnet 4.6 used by writer/QC) |
| `PERPLEXITY_API_KEY` | Perplexity API key (used by researcher + scouts) |
| `GOOGLE_AI_API_KEY` | Google Generative AI key (optional, image fallback) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full service account JSON (Sheets + Indexing + Drive) |
| `GOOGLE_SHEETS_ID` | Spreadsheet ID for the content calendar |
| `GOOGLE_SHEETS_TAB` | Tab name (default: `Content Calendar v2`) |
| `SLACK_WEBHOOK_URL` | Webhook for fallback alerts |
| `SLACK_BOT_TOKEN` | Huck bot token (for posting as Huck) |
| `SLACK_CHANNEL_ID` | Channel ID for `#fulcrum-international` (or equivalent) |
| `SLACK_ALERT_USER_ID` | Joe's Slack user ID for `@mention` alerts |
| `LINKEDIN_ACCESS_TOKEN` | Optional, for LinkedIn auto-post syndication |
| `LINKEDIN_PERSON_URN` | Optional |
| `DEVTO_API_KEY` | Optional, dev.to syndication |
| `HASHNODE_API_KEY` | Optional, Hashnode syndication |
| `HASHNODE_PUBLICATION_ID` | Optional |
| `REVALIDATION_SECRET` | Next.js ISR revalidation secret on the website |
| `GH_PAT` | Personal access token to clone the private `joereed-eg/humanizer` repo at v1.0.0 |
| `GMAIL_USER_EMAIL` | Optional, for HARO inbox monitor |

Until these are configured the workflows will fail at the first stage that needs them. The repo and workflow files will exist on GitHub, they just will not run successfully.

## Sanity setup

Project ID is `tur3pati`. The website at `~/Documents/GitHub/fulcrum-international` already publishes against this project. Confirm a `resource` document type exists in the schema. The pipeline writes documents of type `resource` with fields: title, slug, body (Portable Text), excerpt, metaTitle, metaDescription, tags, cluster, faqs, publishedAt, primaryKeyword, isPillar.

## Workflows shipped

| Workflow | Cron | Purpose |
|----------|------|---------|
| `daily-pipeline.yml` | Mon-Fri 7am UTC | Read sheet, research, write, QC, humanize, publish, syndicate |
| `weekly-seo-monitor.yml` | Sun 6am UTC | Search Console scan, trend radar, refresh queue |
| `monthly-internal-link-audit.yml` | 1st 7am UTC | Audit internal link graph, suggest fixes |
| `monthly-outreach.yml` | 1st 8am UTC | Podcast and guest post pitches |
| `monthly-calendar.yml` | 1st 8am UTC | Generate next month of calendar entries |
| `weekly-medium-digest.yml` | Mon 6am UTC | Compile last week's articles into Google Docs for Medium cross-post |
| `weekly-impact-and-suggestions.yml` | Sun 7am UTC | Impact tracker + user suggestions sweep |
| `community-scout.yml` | Tue/Thu 2pm UTC | Reddit value-first comment opportunities |
| `daily-va-assignments.yml` | Mon-Fri 12pm UTC | Daily Slack post with engagement assignments |
| `haro-monitor.yml` | Disabled until Source-of-Sources or Qwoted is wired | Journalist query auto-responses |

## Local testing

```bash
npm install
node pipeline.js --dry-run     # Full pipeline, no publish
node monitor.js                 # Weekly SEO monitor
node stages/01-sheet-reader.js  # Test sheet read
```

## Content Calendar columns (Google Sheets)

| Col | Field | Notes |
|-----|-------|-------|
| A | Stage | Planned -> In Progress -> Published / Error / Needs Review |
| B | Publish Date | Pipeline picks up rows where date <= today |
| C | Content Layer | Pillar / Sub-Pillar / Blog |
| D | Cluster | Bearing stage (clarity / leverage / direction / execution / momentum) |
| E | Title | Article title |
| F | Audience | Target audience |
| G | Word Count Target | Target word count |
| H | Primary Keyword | Main SEO keyword |
| I | Secondary Keywords | Comma-separated |
| J | Primary Pillar URL | Auto-filled after publish |
| K-N | Internal Links | For natural in-content linking |
| O-P | External Links | Authority sources (BoardSource, SSIR, Chronicle of Philanthropy, etc.) |
| Q-R | CTAs | Primary (mid-article) and secondary (end) CTAs |
| S | Brief / Agent Prompt | Writing instructions |
| T | Categories | Tags for Sanity |
| U | Notes | Any additional notes |

## Pipeline stages

1. **SERP gate (00)** - Validates keyword feasibility before research/writing
2. **Sheet reader (01)** - Reads due rows from the calendar
3. **Researcher (02)** - Perplexity queries: competitors, data, ICP language
4. **Writer (03)** - Claude Sonnet 4.6 writes full Portable Text article
5. **QC (04)** - Claude scores against 12-point rubric, retries up to 4x
6. **Humanizer (04b)** - External humanizer audit gate (requires `joereed-eg/humanizer` repo cloned at runtime, see daily workflow)
7. **Image (05)** - Cover image via Sanity Agent Actions
8. **Sanity publish (06)** - Document write + publish
9. **Indexing (06b)** - Google Indexing API ping
10. **Interlinker (06c)** - Cross-link with existing articles
11. **Syndication (07)** - LinkedIn, dev.to, Hashnode, Reddit scout, Medium/Substack stubs
12. **Post-publish check (11)** - Index verification, CTR monitoring, intent drift

## Brand voice contract

- No em dashes. Ever.
- Public-facing stage names: CLARITY, LEVERAGE, DIRECTION, EXECUTION, MOMENTUM. Internal terms (FOG, ELEVATION, MAP, ITERATION) only in PDF deliverables.
- Framework name on the site: "The Fulcrum Approach" (not "Bearing Flywheel").
- "Find their bearing" beats "close the gap." "What you can't see" beats "where the leverage is." "Mission-driven leaders" beats "stakeholders."
- The leader is the hero. Fulcrum is the guide. Never start a sentence with "Fulcrum is..."
- Articles are about the reader's PATTERNS, not Fulcrum's SERVICES.

## Things to do after the secrets are configured

1. Create a Google Sheet from the Hunhu calendar template, share with the service account.
2. Confirm `SANITY_TOKEN` has write permission to the Fulcrum Intl Sanity project.
3. Add Huck bot to the `#fulcrum-international` Slack channel and capture its channel ID.
4. Replace the placeholder LinkedIn endorsement targets in `daily-assignments.js` with Fulcrum Intl ICP voices.
5. Seed the first 5 to 10 calendar rows with CLARITY-stage articles (highest search volume + emotional urgency).
6. Trigger `daily-pipeline.yml` manually via workflow_dispatch to validate end-to-end.

## Alerts

Slack alerts fire only when human intervention is needed: QC failure after retries, humanizer fail after retry, pipeline stage errors, SEO position drops, CTR below threshold on mature URLs. Run logs are written to `runs/YYYY-MM-DD-HH-mm.json` and uploaded as GitHub Actions artifacts (30 day retention).
