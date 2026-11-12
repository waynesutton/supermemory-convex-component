# Files

## Component (`src/component/`)

| File | What it does |
| --- | --- |
| `convex.config.ts` | Defines the `supermemory` component and its `SUPERMEMORY_API_KEY` env var |
| `schema.ts` | `documents`, `remoteDeletes`, `namespaceDeletions` tables |
| `documents.ts` | `add`, `get`, `list`, `count`, `remove`, `refreshStatus`, plus the ingest, status-check and remote-delete jobs |
| `namespaces.ts` | `deleteNamespace` and its local purge, remote delete and retry |
| `memory.ts` | `search` and `profile` actions |
| `provider.ts` | SDK client, error mapping, backoff. No functions |
| `validators.ts`, `limits.ts` | Shared validators and constants, safe to import from app code |
| `documents.test.ts` | Component tests |

## Package

| File | What it does |
| --- | --- |
| `src/client/index.ts` | `Supermemory` class and re-exported validators |
| `src/test.ts` | `register` helper for convex-test, exported as `/test` |
| `src/testing/fakeSupermemory.ts` | In-memory Supermemory API for tests. Not built |

## Demo (`example/`)

| File | What it does |
| --- | --- |
| `convex/convex.config.ts` | Installs the component and the rate limiter, passes the key by reference |
| `convex/auth.ts`, `turnstile.ts` | Anonymous sign-in gated by a server-side Turnstile check |
| `convex/demo.ts` | Limits, namespace derivation, notes, search, profile, reset and cleanup |
| `convex/crons.ts` | Hourly reset |
| `convex/http.ts` | Convex Auth routes, then the static hosting catch-all |
| `convex/demo.test.ts` | Demo tests |
| `src/App.tsx`, `src/index.css` | The UI |

## Other

| File | What it does |
| --- | --- |
| `scripts/generate-auth-keys.mjs` | Prints `JWT_PRIVATE_KEY` and `JWKS` for Convex Auth |
| `docs/demo.md` | Limits, reset and production checklist |
| `docs/diagrams/` | Architecture diagram as PNG, PDF and SVG. The README shows the PNG |
| `docs/submission.md` | Directory listing copy and checklist |
| `plans/`, `prds/` | Approved plan and PRD |
