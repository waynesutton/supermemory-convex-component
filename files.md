# Files

## Component (`src/component/`)

| File | What it does |
| --- | --- |
| `convex.config.ts` | Defines the `supermemory` component and its `SUPERMEMORY_API_KEY` env var |
| `schema.ts` | `documents`, `remoteDeletes`, `namespaceDeletions` tables and their indexes |
| `documents.ts` | `add` (with optional caller `id`), `get`, `list`, `count`, `remove`, `refreshStatus`, plus the ingest, status and memory-status checks, and remote-delete jobs |
| `namespaces.ts` | `deleteNamespace` in two modes (this component's documents, or the whole remote namespace), with purge, drain check and retry |
| `memory.ts` | `search` and `profile` actions, with optional `filter` |
| `provider.ts` | SDK client, error mapping, backoff. No functions |
| `validators.ts`, `limits.ts` | Shared validators and constants, safe to import from app code |
| `documents.test.ts` | Component tests |

## Package

| File | What it does |
| --- | --- |
| `src/client/index.ts` | `Supermemory` class, `memoryContext` and `saveThread` agent helpers, re-exported validators |
| `src/client/index.test.ts` | Tests for the agent helpers through a small host app |
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
| `docs/diagrams/` | Architecture diagram as PNG, PDF and SVG. Not shown in the README |
| `docs/submission.md` | Directory listing copy and checklist |
| `plans/`, `prds/` | Approved plan and PRD |
