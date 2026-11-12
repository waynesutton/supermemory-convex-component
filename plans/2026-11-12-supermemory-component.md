# Plan: Build Supermemory Convex component and demo

2026-11-12 · supermemory-component · made in Threadbear's Plan mode

# Supermemory Convex component and demo app

## Summary

Build a reusable TypeScript Supermemory Convex component and a React/Vite playground titled **“Supermemory Convex component demo app.”**

Visitors try it without a login form using **Convex Auth v1 anonymous sessions**, protected by Turnstile and server-side limits. Demo content resets every hour.

The repository belongs on **Wayne Sutton’s GitHub**. Package metadata, app attribution, and submission materials identify Wayne as the author and maintainer of this community integration.

## Component and package

- Follow Convex’s official component template with component backend, typed server client, test helpers, and example app.
- Use the official Supermemory SDK with verified, pinned dependencies.
- Export typed `add`, `get`, `list`, `remove`, `search`, `profile`, and `refreshStatus` methods. Require a namespace; host applications enforce authorization.
- Support text and URL ingestion, metadata, processing status, hybrid search, document deletion, and profiles. Defer files, batch ingestion, connectors, and chat.
- Export the package root, component configuration, generated component types, and test utilities.
- Keep authentication, public-demo quotas, and hourly reset policy in the example app so developers can use the component with their own policies.

**Proposed schema:** component-owned documents and operations tables, indexed by namespace and document/request identifier. Track source content, remote identifiers, processing status, timestamps, and sanitized errors.

Queue ingestion through mutations and scheduled actions. Suppress duplicate submissions using stable request identifiers. Reconcile ambiguous remote timeouts before retrying because repeated ingestion can append content. Use bounded status checks and retain failed deletions for retry.

## Demo experience and protection

- Show the exact app title, Wayne Sutton attribution, and a link to Wayne’s repository once its actual URL is established.
- Use text-only ingestion in the public demo; retain URL support in the component.
- Provide an input panel, reactive document list, search results, generated profile, individual deletion, and “clear my demo data.”
- Use a responsive neutral design with accessible controls, application dialogs, and real loading, empty, processing, and failure states.
- Verify Turnstile server-side before creating anonymous access. Derive every namespace from the authenticated user and current reset generation. Never trust a browser-supplied namespace.
- Keep provider credentials backend-only, validate all inputs and outputs, render content as text, and exclude sensitive content and tokens from logs.

Enforce these defaults server-side using transactional reservations:

| Protection | Default |
|---|---|
| Documents | 5 per anonymous user |
| Input size | 5,000 characters |
| Ingestion | 5 additions per user per hour |
| Search and profile | 20 requests combined per user per hour |
| Concurrent ingestion | 1 per user |
| Global interactive provider calls | 500 per UTC day, including polling and retries |
| Emergency control | Backend switch to pause interactive provider calls |

Cleanup has a separate bounded queue and concurrency limit so exhausted interactive quotas cannot prevent deletion. Quotas limit usage, not exact dollar spend. Anonymous users can create new identities, so the global cap remains essential.

## Hourly reset

- Schedule a Convex cron at minute zero of every UTC hour.
- Publish the next reset time from the backend and display a countdown with this notice: **“Demo data resets every hour. A scheduled cleanup removes it from Convex and Supermemory. Don’t enter sensitive information.”**
- Rotate the active demo generation atomically. Clear visible documents, search results, and profiles, and use fresh namespaces for new activity.
- Delete retired Supermemory namespaces and associated Convex content in bounded batches. Retain minimal cleanup records until remote deletion succeeds; retry failures and expose cleanup status to the operator.
- Tag jobs with their generation. Ignore stale results after reset and reconcile remote writes that finish during cleanup so old data cannot reappear.
- Preserve anonymous accounts, auth sessions, rate-limit counters, and daily budgets. The reset clears demo content without granting fresh quotas.
- Keep namespaces restricted to this deployment’s registered demo namespaces. Never delete unrelated Supermemory data.

## Validation and delivery

- Test isolation between users, rejected namespace spoofing, expired sessions, Turnstile failure, malformed input, duplicate submissions, provider failures, and deletion retries.
- Test concurrent quota enforcement and confirm that direct backend calls receive the same protections as UI actions.
- Test reset boundaries, repeated cron runs, in-flight ingestion, stale responses, remote cleanup failure, and quotas surviving resets.
- Verify countdown updates and automatic clearing in open browser tabs.
- Run lint, type checks, component tests, package build, archive inspection, and a live ingestion/search/profile/deletion smoke test with configured credentials.
- Create a timestamped PRD before implementation. Maintain `task.md`, `files.md`, and `changelog.md`; write installation and API documentation under `docs/`.
- Prepare directory copy, screenshots, and a submission checklist. Working package name: `convex-supermemory`, subject to availability; default license: MIT.
- Stop at locally validated code and prepared materials. GitHub publication, npm publication, hosting, and directory submission are separate release actions under Wayne’s ownership.

Sources: [Convex component authoring](https://docs.convex.dev/components/authoring), [anonymous authentication](https://labs.convex.dev/auth/config/anonymous), [rate limiting](https://www.convex.dev/components/rate-limiter), [Supermemory API](https://supermemory.ai/docs/v5/api-reference/overview), [directory requirements](https://www.convex.dev/component-authoring).
