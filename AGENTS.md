# Repository Guidelines

## Project Structure & Module Organization
- App entry is `index.tsx`, which mounts `App.tsx`; global styles and local fonts are in `styles.css` and `public/fonts/`.
- UI components live in `components/` (for example `QuoteCard.tsx`, `PointsCard.tsx`, `AnalysisProgressPanel.tsx`).
- Client parsing and API calls are in `services/geminiService.ts`.
- Server endpoints (Cloudflare Pages Functions) are in `functions/api/chatter/analyze.ts`, `functions/api/points/analyze.ts`, and `functions/api/health/gemini.ts`.
- Shared LLM schemas/prompts/helpers are in `functions/_shared/gemini.ts`.
- Shared types are in `types.ts`; export formatters are in `utils/`.
- Build output is generated to `dist/` (do not edit manually).

## Build, Test, and Development Commands
- `npm install` installs dependencies.
- `npm run dev` starts the Vite dev server.
- `npx tsc --noEmit` runs type-checking without emitting files.
- `npm run build` produces production assets in `dist/`.
- `npm run preview` serves the production build locally.
- `npx wrangler pages deploy dist --project-name chatter-analyst --branch main` deploys manually when needed.

## Coding Style & Naming Conventions
- Stack: TypeScript + React functional components.
- Use 2-space indentation, semicolons, and explicit typing at API boundaries.
- Naming: components use `PascalCase.tsx`; helpers/services/routes use `camelCase.ts`.
- Keep Tailwind tokens in `tailwind.config.cjs` and global styles in `styles.css`.
- Keep prompt/schema updates centralized in `functions/_shared/gemini.ts`.

## Testing Guidelines
- No formal automated suite is configured yet.
- Minimum manual QA before merge:
1. `npx tsc --noEmit` and `npm run build` pass.
2. Chatter works for pasted text and uploaded `.txt`/`.pdf`.
3. Points mode accepts valid decks and surfaces clear chunk/retry errors.
4. Copy/export actions and tab switching preserve expected UI state.
- If adding tests, use Vitest + React Testing Library with `*.test.ts` / `*.test.tsx`.

## Commit & Pull Request Guidelines
- Follow Conventional Commits (for example, `feat: add openrouter provider toggle`).
- Keep commits focused to one logical change; avoid mixing UI + backend refactors unless necessary.
- PRs should include: problem statement, solution summary, changed paths, manual QA evidence, and screenshots for UI changes.

## Security & Configuration Tips
- Never commit secrets or API keys.
- Store runtime keys in Cloudflare Pages secrets (for example `GEMINI_API_KEY`, `OPENROUTER_API_KEY`).
- Keep model calls server-side in `functions/api/*`; never expose provider keys to browser code.
- Preserve server-side request limits, schema validation, and retry guards when editing API handlers.
