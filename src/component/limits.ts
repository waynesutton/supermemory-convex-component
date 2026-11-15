// Plain constants, safe to import from app code.
export const NAMESPACE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
// Keeps a full page of documents well under Convex's per-call read limits.
export const MAX_CONTENT_LENGTH = 50_000;
export const MAX_QUERY_LENGTH = 1_000;
export const MAX_INGEST_ATTEMPTS = 3;
export const MAX_DELETE_ATTEMPTS = 8;
export const DEFAULT_MAX_STATUS_CHECKS = 10;
export const MEMORY_POLL_MS = 150_000;
export const MAX_DOCUMENT_ID_LENGTH = 200;
// Manual or scheduled retry rounds after a delete runs out of attempts.
export const MAX_RETRY_ROUNDS = 3;
export const MAX_LIST_LIMIT = 100;

// Worst case provider calls for one `add`: every ingest attempt plus every status check.
export function maxProviderCallsForAdd(maxStatusChecks: number) {
  return MAX_INGEST_ATTEMPTS + maxStatusChecks;
}
