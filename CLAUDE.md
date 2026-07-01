# CLAUDE.md

Project-specific guidance for working in this repo. See `ARCHITECTURE.md` for the
full module/package layout.

## Commits

- **The user makes all commits, not Claude.** Don't run `git commit` (or `git
  add`/push). When a unit of work is done, give the user a **short commit message**
  (conventional-commits style, e.g. `feat(cdn): …`) to paste — they handle staging
  and committing themselves.

## Build & deploy

- This is a **pnpm workspace** (`saga-sync`) with three packages under
  `packages/` — `@saga-sync/core`, `@saga-sync/client`, `@saga-sync/producer`.
  Install with `pnpm install`; build everything with `pnpm build` (`tsc -b`,
  project references); test with `pnpm test` (`vitest run`). pnpm is pinned via
  the root `package.json` `packageManager` field (use corepack).
- **Always run the Docker image build locally** before relying on it
  (`docker build -t saga-sync-job .` from the repo root). The deploy can build via
  Cloud Build, but the local build is the convention here — verify it locally
  rather than deferring image breakage to a deploy. If Docker isn't running, ask
  to start it rather than skipping the build.
