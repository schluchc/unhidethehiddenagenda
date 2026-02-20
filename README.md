# Truth Check (v1)

URL-in, caveats-out web app for article author motivation checks.

## What this version does

- Accepts an article URL.
- Fetches the article HTML and extracts title, detected author, and text excerpt.
- Uses an LLM to generate:
  - author profile summary,
  - potential motivations/influences,
  - caveats tied to key claim sentences.
- Displays all output in a structured report.

## Local development

### 1) Frontend only quick preview (no API)

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000`.

This mode serves static files only. `Analyze` will fail unless you point the frontend to a live `/api/analyze` endpoint.

### 2) Full local stack (recommended)

Requirements:

- Node.js 18+
- Cloudflare Wrangler CLI (installed via `npm install` below)

Install and run:

```bash
npm install
npx wrangler pages dev . --compatibility-date=2025-01-15
```

Set local secret (Apertus via PublicAI):

```bash
npx wrangler pages secret put APERTUS_API_KEY
```

Optional model override:

```bash
npx wrangler pages secret put APERTUS_MODEL
```

Optional endpoint override (only if needed):

```bash
npx wrangler pages secret put APERTUS_API_BASE_URL
```

Open the local URL shown by Wrangler.

### 3) Full local stack without Cloudflare login

Run the built-in local server:

```bash
npm install
APERTUS_API_KEY=your_key_here npm run dev:local
```

Open `http://localhost:8788`.

Optional env vars:

```bash
APERTUS_MODEL=swiss-ai/apertus-8b-instruct
APERTUS_API_BASE_URL=https://api.publicai.co/v1/chat/completions
APERTUS_USER_AGENT=truth-check/0.1
DEBUG_ANALYZE=1
SUPPLEMENTAL_MAX_PAGES=5
SUPPLEMENTAL_TIMEOUT_MS=12000
PUBLISHER_SEARCH_MAX_PAGES=6
PUBLISHER_SEARCH_TIMEOUT_MS=10000
```

Debugging:

- End user progress is shown in the UI while analysis runs.
- Enable `Enable developer debug details` in the form to include server timing/events in the response.
- You can force debug on all requests by setting `DEBUG_ANALYZE=1`.

Expanded context retrieval:

- Before calling the model, the backend also fetches likely publisher context pages (`/about`, `/masthead`, `/staff`, etc.) and likely author profile pages on the same domain.
- This is used to improve checks for affiliation, country of residence, and publisher lead editor/redactor.
- If lead editor/redactor is still unclear, the backend runs an additional publisher-focused crawl (homepage + discovered editorial/team links) and adds that context to the model prompt.
- The analysis runs in two LLM steps: author-first, then publisher background (lead editor + funding/ownership signals), which are merged into the final report.
- If this causes latency, reduce `SUPPLEMENTAL_MAX_PAGES`, `SUPPLEMENTAL_TIMEOUT_MS`, `PUBLISHER_SEARCH_MAX_PAGES`, or `PUBLISHER_SEARCH_TIMEOUT_MS`.

## Deploy via GitHub to Cloudflare Pages

1. Push this repo to GitHub.
2. In Cloudflare Dashboard: `Workers & Pages` -> `Create` -> `Pages` -> `Connect to Git`.
3. Select the repository.
4. Build settings:
   - Build command: *(empty)*
   - Build output directory: `.`
5. Add environment variable in Pages project settings:
   - `APERTUS_API_KEY` (required)
   - `APERTUS_MODEL` (optional, default is `swiss-ai/apertus-8b-instruct`)
   - `APERTUS_API_BASE_URL` (optional, default is `https://api.publicai.co/v1/chat/completions`)
   - `APERTUS_USER_AGENT` (optional, otherwise `truth-check/0.1`)
6. Deploy.

Cloudflare will host static files and the `functions/api/analyze.js` endpoint.

## Provider env aliases

The function accepts these aliases for flexibility:

- API key: `APERTUS_API_KEY`, `AI_API_KEY`, `OPENAI_API_KEY`
- Base URL: `AI_API_BASE_URL`, `APERTUS_API_BASE_URL`
- Model: `AI_MODEL`, `APERTUS_MODEL`, `OPENAI_MODEL`
- User-Agent: `AI_USER_AGENT`, `APERTUS_USER_AGENT`

## Notes and caveats

- This v1 is a hypothesis generator, not a fact checker.
- Outputs are probabilistic and can be wrong.
- Treat all motivation links as leads requiring manual verification.
- Some websites block scraping or hide text behind paywalls; extraction can fail.

## Next improvements

- Add explicit citation links for each motivation claim.
- Add external source retrieval for affiliation/funding verification.
- Add user controls for strictness and evidence threshold.
- Add URL queueing and caching for repeated analysis.
