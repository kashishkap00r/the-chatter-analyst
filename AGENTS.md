# Repository Guidelines

## Project Structure & Module Organization
- Root frontend entry is `index.tsx`, which mounts `App.tsx`.
- UI components live in `components/` (`QuoteCard.tsx`, `PointsCard.tsx`, `LoadingState.tsx`).
- Client API/PDF logic is in `services/geminiService.ts`.
- Cloudflare server routes are in `functions/api/chatter/analyze.ts` and `functions/api/points/analyze.ts`.
- Shared Gemini prompts/schemas/helpers are in `functions/_shared/gemini.ts`.
- Shared TypeScript contracts are in `types.ts`.
- Build/deploy config is in `vite.config.ts`, `index.html`, `tsconfig.json`, and `wrangler.jsonc`.

## Build, Test, and Development Commands
- `npm install` - install dependencies.
- `npm run dev` - start local Vite development server.
- `npm run build` - produce production assets in `dist/`.
- `npm run preview` - preview the production build locally.
- `npx wrangler pages deploy dist --project-name chatter-analyst --branch main` - deploy to Cloudflare Pages.

## Coding Style & Naming Conventions
- Stack: TypeScript + React function components.
- Use 2-space indentation, semicolons, and explicit typing at API boundaries.
- Naming conventions:
  - Components: `PascalCase.tsx`
  - Services/helpers/routes: `camelCase.ts`
  - Shared types: `types.ts`
- Keep Gemini prompt/schema updates centralized in `functions/_shared/gemini.ts`.

## Testing Guidelines
- No automated test suite is configured yet.
- Minimum manual checks per change:
  1. `npm run build` succeeds.
  2. Transcript mode works for pasted text, `.txt`, and `.pdf`.
  3. Presentation mode works for valid PDF and rejects invalid input.
  4. Error states render clearly for API failures.
- If you add tests, prefer Vitest + React Testing Library with `*.test.ts` / `*.test.tsx`.

## Commit & Pull Request Guidelines
- Current history follows Conventional Commit style (example: `feat: migrate chatter analyst to cloudflare functions backend`).
- Prefer `type(scope): summary` and keep commits focused to one logical change.
- PRs should include: problem statement, solution summary, impacted files/routes, manual test evidence, and screenshots for UI updates.

## Security & Configuration Tips
- Never hardcode API keys or commit secrets.
- Keep `GEMINI_API_KEY` in Cloudflare Pages secrets for production.
- Do not move Gemini calls back into browser code.
- Preserve request-size and validation checks in `functions/api/*` when modifying API routes.
