# Repository Guidelines

## Project Structure & Module Organization
This is a Vite + React + TypeScript app with Cloudflare Pages Functions.
- App shell: `index.tsx` -> `App.tsx`
- UI components: `components/` (for example `QuoteCard.tsx`, `PointsCard.tsx`)
- Client logic: `services/` (`geminiService.ts`, `sessionStore.ts`)
- API routes: `functions/api/chatter/analyze.ts`, `functions/api/points/analyze.ts`, `functions/api/health/gemini.ts`
- Shared prompt/schema logic: `functions/_shared/gemini.ts`
- Export helpers: `utils/chatterCopyExport.ts`, `utils/pointsCopyExport.ts`
- Static assets: `public/` (fonts, favicon)
- Build output: `dist/` (generated, do not edit)

## Build, Test, and Development Commands
- `npm install`: install dependencies.
- `npm run dev`: start local dev server.
- `npx tsc --noEmit`: run TypeScript checks.
- `npm run build`: create production build in `dist/`.
- `npm run preview`: serve built output locally.

Cloudflare Pages is connected to GitHub, so pushing to `main` triggers deployment automatically.

## Coding Style & Naming Conventions
- Use TypeScript with React function components.
- Indentation: 2 spaces; keep semicolons consistent with existing files.
- `PascalCase.tsx` for components, `camelCase.ts` for services/utils.
- Keep API contracts and schema validation explicit at route boundaries.
- Centralize model prompts and schema changes in `functions/_shared/gemini.ts`.

## Testing Guidelines
No dedicated automated test suite is configured yet. Minimum pre-merge checks:
1. Run `npx tsc --noEmit`.
2. Run `npm run build`.
3. Verify Chatter flow (`.pdf`/`.txt` or pasted text) and Points flow (PDF upload, chunk progress, copy/export).
4. Confirm tab switching and session resume behavior still work.

If you add tests, prefer Vitest + React Testing Library and name files `*.test.ts` or `*.test.tsx`.

## Commit & Pull Request Guidelines
- Prefer Conventional Commit prefixes: `feat:`, `fix:`, `chore:`.
- Keep each commit scoped to one logical change.
- PRs should include: what changed, why, files touched, manual QA steps, and screenshots for UI changes.

## Security & Configuration Tips
- Never commit keys or secrets.
- Store provider keys only in Cloudflare Pages environment variables (for example `GEMINI_API_KEY`, `VERTEX_API_KEY`, `OPENROUTER_API_KEY`).
- Keep provider calls server-side in `functions/api/*`; do not expose secrets in client code.
