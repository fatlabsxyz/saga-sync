---
---

Migrate the test toolchain from Vitest 2 to Vitest 5 (dev-tooling only, no release).

- Bump `vitest` `^2.1.1` → `^5.0.0` and add `vite` `^8.2.2` (Vitest 5 no longer bundles Vite; it's now a required peer).
- Raise the workspace Node floor to `>=22.12` (Vitest 5's minimum) and bump `@types/node` to `^22`.
- Move CI/release workflows to Node 24 (Active LTS).
