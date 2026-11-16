# Changelog

## 0.2.1 (2026-11-16)

- README: removed the architecture diagram image. No code changes.

## 0.2.0 (2026-11-15)

- `add` takes an optional `id`. A repeated `id` updates one document with the
  new full content, sent in order after any in-flight attempt.
- `memoryStatus` tracks memory generation separately from content status.
  Polling continues, more slowly, until memories are ready.
- `deleteNamespace` deletes only this component's documents by default.
  `remote: "namespace"` keeps the old whole-namespace delete.
- `memoryContext` and `saveThread` client helpers for the Convex Agent
  component.
- `add` forwards `dreaming` and `taskType`; `search` and `profile` forward
  `filter`.
- Retries re-send the same snapshot instead of looking the document up first.
  Default `maxStatusChecks` is 10.
- Demo: notes use instant dreaming and show "Building memories" until memories
  are ready.
- Fixed: deleting a document no longer gets skipped when another namespace has
  a pending delete for the same caller-supplied `id`.

## 0.1.2 (2026-11-15)

- README: architecture diagram, plus links to the Supermemory site, docs and quickstart. No code changes.

## 0.1.1 (2026-11-12)

- Listed in the Convex components directory. README now shows the directory
  badge, so the npm page picks it up.
- `package.json` repository field in the object form npm expects.

## 0.1.0 (2026-11-12)

- Supermemory component with `add`, `get`, `list`, `count`, `remove`,
  `refreshStatus`, `search`, `profile` and namespace deletion.
- Background ingestion with retries that check for an earlier landed attempt
  before resending.
- Bounded status polling and durable remote deletes with visible failures.
- API key held in the component's own env var.
- Demo app: Convex Auth anonymous sessions behind Turnstile, per-visitor quotas,
  a daily provider budget, a pause switch, and an hourly reset that clears
  Convex and Supermemory.
