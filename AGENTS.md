# Repository Guidelines

## Project Structure & Module Organization
`chatter-analyst` is a Vite + React + TypeScript app with Cloudflare Pages Functions.
- App shell and routing-by-mode: `App.tsx`, `index.tsx`
- Feature modules: `src/features/chatter/`, `src/features/points/`, `src/features/plotline/`
- Reusable UI: `components/` and `src/shared/ui/`
- Client services/state: `services/`, `src/shared/state/`, `src/shared/config/`
- Server APIs: `functions/api/**` with shared server utilities in `functions/_shared/`
- Static assets: `public/`; build output: `dist/` (generated, do not edit)

## Build, Test, and Development Commands
- `npm install`: install dependencies.
- `npm run dev`: run local Vite dev server.
- `npm run build`: production build to `dist/`.
- `npm run preview`: preview built app locally.
- `npm test`: run Vitest in watch mode.
- `npm run test:run`: run Vitest once (CI-style).
- `npx wrangler pages deploy dist`: deploy to Cloudflare Pages (after build).

## Coding Style & Naming Conventions
- Use TypeScript with React function components and hooks.
- Match existing style: 2-space indentation, semicolons, single quotes in TS/TSX.
- Naming: `PascalCase` for components (`PlotlineWorkspace.tsx`), `camelCase` for helpers (`plotlineFeature.tsx`), `*.test.ts(x)` for tests.
- Keep provider/API logic in `functions/api/**` and `functions/_shared/**`; avoid exposing keys/client-side inference calls.

## Testing Guidelines
- Framework: Vitest (`vitest.config.ts`).
- Existing tests live beside shared modules (for example `src/shared/config/modelOptions.test.ts`).
- Before opening a PR, run:
1. `npm run test:run`
2. `npm run build`
3. Manual smoke test for all three workflows: Chatter, Points & Figures, Plotline.

## Commit & Pull Request Guidelines
- Keep commits focused and atomic.
- Recent history uses mixed styles; prefer Conventional Commits (`feat:`, `fix:`, `refactor:`, `security:`) with imperative summaries.
- PRs should include scope, key files changed, risk/rollback notes, test evidence, and screenshots for UI changes.

## Release Checklist
- Confirm Tailwind picks up all UI files (`tailwind.config.cjs` includes `./src/**/*` and other code paths).
- Run `npm run test:run` and `npm run build`; resolve all failures before deploy.
- Verify Cloudflare auth with `npx wrangler whoami`.
- Deploy with `npx wrangler pages deploy dist`.
- Smoke-test production flows: Chatter analysis, Points PDF analysis, Plotline keyword run, and copy/export actions.
- If UI looks stale after deploy, hard refresh browser cache (`Ctrl/Cmd + Shift + R`).

## Security & Configuration Tips
- Never commit secrets (`.env*`, API tokens).
- Required runtime secrets are managed in Cloudflare Pages env vars (for example `GEMINI_API_KEY`, optional `VERTEX_API_KEY`, `OPENROUTER_API_KEY`).
- Validate request payloads on server routes and keep allowlists/retries in shared server utilities.
