# Repository Guidelines

## Project Structure & Module Organization
- `index.tsx` mounts `App.tsx` (main UI flow for Chatter and Points & Figures).
- UI components live in `components/` (for example `QuoteCard.tsx`, `PointsCard.tsx`).
- Client-side parsing/API orchestration is in `services/geminiService.ts`.
- Cloudflare Pages Functions endpoints are in `functions/api/chatter/analyze.ts` and `functions/api/points/analyze.ts`.
- Shared Gemini prompts, schemas, and API helper logic live in `functions/_shared/gemini.ts`.
- Shared app contracts are in `types.ts`; export utilities are in `utils/`.

## Build, Test, and Development Commands
- `npm install`: install dependencies.
- `npm run dev`: run Vite locally.
- `npm run build`: create production bundle in `dist/`.
- `npm run preview`: preview the production bundle.
- `npx wrangler pages deploy dist --project-name chatter-analyst --branch main`: deploy to Cloudflare Pages.

## Coding Style & Naming Conventions
- Language stack: TypeScript + React functional components.
- Use 2-space indentation, semicolons, and explicit types at API boundaries.
- File naming: components use `PascalCase.tsx`; services/helpers/routes use `camelCase.ts`.
- Keep prompt/schema changes centralized in `functions/_shared/gemini.ts`.

## Testing Guidelines
- No formal automated suite is configured yet.
- Minimum manual QA before merge:
1. `npm run build` passes with no errors.
2. Chatter works for pasted text and uploaded `.txt`/`.pdf`.
3. Points mode accepts valid PDF decks and handles oversized/invalid input cleanly.
4. Error states show actionable messages (rate limit, timeout, validation).
- If adding tests, use Vitest + React Testing Library with `*.test.ts` / `*.test.tsx`.

## Commit & Pull Request Guidelines
- Follow Conventional Commits (example: `fix: stabilize points chunk retries`).
- Keep commits scoped to one logical change.
- PRs should include purpose, impacted files, QA evidence, and screenshots for UI updates.

## Security & Configuration Tips
- Never commit secrets or API keys.
- Store `GEMINI_API_KEY` in Cloudflare Pages secrets for production.
- Keep Gemini calls server-side in `functions/api/*`; do not call Gemini directly from browser code.
- Preserve server request limits and validation guards when editing API handlers.
