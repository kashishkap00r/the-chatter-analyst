# Chatter Analyst

`Chatter Analyst` analyzes:
- Earnings call transcripts (`The Chatter`)
- Investor presentation PDFs (`Points & Figures`)

The frontend is a Vite + React app. Gemini calls are made server-side from Cloudflare Pages Functions so API keys are not exposed in the browser.

## Run Locally

Prerequisites:
- Node.js 20+

Commands:
1. `npm install`
2. `npm run dev`

## Build

1. `npm run build`
2. `npm run preview`

## Cloudflare Pages Deployment

1. Push this repo to GitHub as `chatter-analyst`.
2. In Cloudflare Dashboard, create a Pages project and connect the repo.
3. Build settings:
   - Build command: `npm run build`
   - Build output directory: `dist`
4. Set secret environment variable in Pages:
   - `GEMINI_API_KEY`
   - Optional fallback key: `VERTEX_API_KEY`
   - Optional provider mode: `GEMINI_PROVIDER` (`auto`, `ai_studio`, `vertex_express`; default `auto`)

If AI Studio returns `User location is not supported for the API use.`, keep `GEMINI_PROVIDER=auto` and add
`VERTEX_API_KEY` so backend requests can automatically fall back to Vertex Express.

Health check endpoint:
- `POST /api/health/gemini`
- reports provider/model reachability and whether fallback is active.

API routes are implemented in:
- `functions/api/chatter/analyze.ts`
- `functions/api/points/analyze.ts`
