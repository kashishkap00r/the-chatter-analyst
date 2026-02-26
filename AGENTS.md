# Repository Guidelines

## Project Structure & Module Organization
This is a Vite + React + TypeScript app with Cloudflare Pages Functions.
- App entry and orchestration: `index.tsx`, `App.tsx`
- UI components: `components/` (e.g., `QuoteCard.tsx`, `PointsCard.tsx`, `ThreadComposer.tsx`)
- Client services: `services/` (`geminiService.ts`, `sessionStore.ts`)
- Shared domain types: `types.ts`
- Server APIs: `functions/api/chatter/*`, `functions/api/points/*`, `functions/api/plotline/*`, `functions/api/health/gemini.ts`
- Prompt/schema core: `functions/_shared/gemini.ts`
- Export helpers: `utils/*CopyExport.ts`, `utils/threadImageExport.ts`
- Static assets: `public/`; generated build output: `dist/` (do not edit manually)

## Build, Test, and Development Commands
- `npm install`: install dependencies.
- `npm run dev`: start local development server.
- `npx tsc --noEmit`: run TypeScript checks.
- `npm run build`: produce production bundle in `dist/`.
- `npm run preview`: serve the production bundle locally.

Deployment flow is Git-driven: pushing to `main` triggers Cloudflare Pages deploy.

## Coding Style & Naming Conventions
- Use TypeScript and React function components.
- Follow existing style: 2-space indentation, semicolons, explicit typing at API boundaries.
- Naming: `PascalCase` for React components, `camelCase` for utilities/services, descriptive file names (e.g., `plotlineNarrativeFallback.ts`).
- Keep parsing/validation on server routes; keep prompt and schema updates centralized in `functions/_shared/gemini.ts`.

## Testing Guidelines
No formal test suite is configured yet. Minimum required checks before merge:
1. `npx tsc --noEmit`
2. `npm run build`
3. Manual QA for all active workflows: Chatter, Points & Figures, and Plotline (upload, progress, retries, copy/export).

If adding tests, prefer Vitest + React Testing Library; use `*.test.ts` / `*.test.tsx`.

## Commit & Pull Request Guidelines
- Keep commits single-purpose and easy to review.
- Commit style in this repo is mixed; preferred format is Conventional Commit (`feat:`, `fix:`, `chore:`), but concise imperative summaries are acceptable when clear.
- PRs should include: objective, key files changed, risk notes, manual test steps, and screenshots for UI-impacting changes.

## Security & Configuration Tips
- Never commit secrets or `.env` credentials.
- Configure provider keys in Cloudflare Pages environment variables (`GEMINI_API_KEY`, `VERTEX_API_KEY`, `OPENROUTER_API_KEY`).
- Do not move provider calls to client-side code.
