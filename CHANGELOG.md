# Changelog

## 0.1.0 (2026-11-12)

- Supermemory component with `add`, `get`, `list`, `count`, `remove`, `refreshStatus`, `search`, `profile` and namespace deletion.
- Background ingestion with retries that check for an earlier landed attempt before resending.
- Bounded status polling and durable remote deletes with visible failures.
- API key held in the component's own env var.
- Demo app: Convex Auth anonymous sessions behind Turnstile, per-visitor quotas, a daily provider budget, a pause switch, and an hourly reset that clears Convex and Supermemory.
