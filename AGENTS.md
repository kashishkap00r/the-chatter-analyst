# Repository Guidelines

## Project Structure & Module Organization
- Active runtime files are at the repository root: `index.tsx` mounts `App.tsx`.
- Core AI/business logic lives in `services/geminiService.ts`.
- Shared contracts are in `types.ts`.
- Reusable UI components are in `components/` (`QuoteCard.tsx`, `PointsCard.tsx`, `LoadingState.tsx`).
- `src/` exists as a legacy/alternate copy; prefer root files unless doing a deliberate migration.
- Config and entry files: `vite.config.ts`, `tsconfig.json`, `index.html`, `.env.local`.

## Build, Test, and Development Commands
- `npm install` - install dependencies.
- `npm run dev` - start Vite dev server (configured for port `3000`).
- `npm run build` - create a production build.
- `npm run preview` - preview the built app locally.
- Entry-point note: keep `index.html` script references aligned with actual entry files before release builds.

## Coding Style & Naming Conventions
- Stack: TypeScript + React function components.
- Follow existing style: 2-space indentation, semicolons, and explicit typing for API-facing objects.
- Naming:
  - Components: `PascalCase.tsx`
  - Services/helpers: `camelCase.ts`
  - Shared models: `types.ts`
- Keep prompt and response-schema updates in `services/geminiService.ts`; update corresponding UI/types in the same change.

## Testing Guidelines
- No automated test framework is currently configured.
- Minimum manual validation for each functional change:
  1. Run `npm run dev`.
  2. Test transcript mode with `.txt` and `.pdf`.
  3. Test presentation mode with `.pdf`.
  4. Verify loading, success rendering, and error states.
- If adding tests, prefer Vitest + React Testing Library and name files `*.test.ts` / `*.test.tsx`.

## Commit & Pull Request Guidelines
- This directory currently has no local `.git` history, so no commit pattern can be inferred from logs.
- Recommended commit format: `type(scope): summary` (example: `fix(points): handle invalid slide index`).
- PRs should include:
  - problem and solution summary
  - screenshots/GIFs for UI changes
  - manual test steps and results
  - full prompt/schema diffs when AI contract changes

## Security & Configuration Tips
- Keep secrets in `.env.local` (`GEMINI_API_KEY`); never hardcode API keys.
- Treat prompt text and JSON schemas as strict contracts between service, types, and UI.
