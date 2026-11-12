# PRD: Supermemory Convex component and demo app

2026-11-12. Approved plan: `plans/2026-11-12-supermemory-component.md`.

## Problem

Supermemory's Convex guide shows app-level helpers that call the SDK from actions. That leaves every app to build its own status tracking, retries, delete bookkeeping and cost controls. A component can own that state and ship it once.

## Scope

- Component: text and URL ingestion, metadata, processing status, hybrid search, profiles, document and namespace deletion.
- Deferred: file uploads, batch ingest, connectors, chat.
- Demo: anonymous Convex Auth v1 sessions behind Turnstile, per-visitor and global limits, a pause switch, an hourly reset of all content.
- Ownership: Wayne Sutton's GitHub and npm scope, MIT.

## Decisions

| Decision | Why |
| --- | --- |
| Key in the component's env var | Keeps it out of scheduled function args, which are stored and visible |
| Package `@waynesutton/convex-supermemory` | `convex-supermemory` on npm belongs to another author since Sept 2026 |
| Remote id `cvx_{documentId}` set by us | Lets a retry look the document up before resending, since re-adding appends |
| Budget reserved at worst case per add | Calls are made later by scheduled jobs, so they can't be checked one by one |
| Turnstile in a custom `ConvexCredentials` provider | `Anonymous`'s `profile` hook is synchronous |
| Hourly reset bumps a generation | Old data disappears from the UI instantly; remote cleanup runs behind it |
| Cron at minute 0 | Visitors can predict the reset; the lint rule against it is disabled with a reason |

## Success

- Tests cover isolation, spoofed ids, limits under concurrency, budget, pause, reset, late ingest, and failed cleanup.
- A live run against Supermemory adds, processes, searches, profiles and deletes.
