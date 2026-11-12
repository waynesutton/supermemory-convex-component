// Shared helpers for talking to Supermemory. No Convex functions live here.
import {
  Supermemory,
  SupermemoryError,
  SupermemoryTimeoutError,
} from "supermemory";
import { env } from "./_generated/server.js";
import {
  NAMESPACE_PATTERN,
  MAX_CONTENT_LENGTH,
  MAX_QUERY_LENGTH,
  MAX_INGEST_ATTEMPTS,
  MAX_DELETE_ATTEMPTS,
  DEFAULT_MAX_STATUS_CHECKS,
  MAX_RETRY_ROUNDS,
  MAX_LIST_LIMIT,
} from "./limits.js";

export {
  NAMESPACE_PATTERN,
  MAX_CONTENT_LENGTH,
  MAX_QUERY_LENGTH,
  MAX_INGEST_ATTEMPTS,
  MAX_DELETE_ATTEMPTS,
  DEFAULT_MAX_STATUS_CHECKS,
  MAX_RETRY_ROUNDS,
  MAX_LIST_LIMIT,
};

export function assertNamespace(namespace: string) {
  if (!NAMESPACE_PATTERN.test(namespace)) {
    throw new Error(
      "Invalid namespace: use 1 to 128 letters, numbers, underscores or hyphens.",
    );
  }
}

export function createClient() {
  // Read inside handlers: component env vars don't exist at module scope.
  const apiKey = env.SUPERMEMORY_API_KEY;
  if (!apiKey) {
    throw new Error(
      "SUPERMEMORY_API_KEY is not set. Pass it to the component in convex.config.ts.",
    );
  }
  // Retries are handled by the scheduler so each one is visible and bounded.
  return new Supermemory({ apiKey, maxRetries: 0, timeoutInSeconds: 30 });
}

export function statusCodeOf(error: unknown): number | undefined {
  return error instanceof SupermemoryError ? error.statusCode : undefined;
}

export function isRetryable(error: unknown) {
  if (error instanceof SupermemoryTimeoutError) return true;
  if (!(error instanceof SupermemoryError)) return false;
  const status = error.statusCode;
  return (
    status === undefined || status === 408 || status === 429 || status >= 500
  );
}

// Error text that is safe to store and show: no bodies, no headers, no keys.
export function describeError(error: unknown) {
  if (error instanceof SupermemoryTimeoutError) return "Supermemory timed out";
  if (error instanceof SupermemoryError) {
    return error.statusCode
      ? `Supermemory returned ${error.statusCode}`
      : "Could not reach Supermemory";
  }
  if (
    error instanceof Error &&
    error.message.startsWith("SUPERMEMORY_API_KEY")
  ) {
    return error.message;
  }
  return "Unexpected error";
}

export function backoffMs(attempt: number, baseMs = 2_000, maxMs = 60_000) {
  return Math.min(maxMs, baseMs * 2 ** attempt);
}

export const TERMINAL_STATUSES = new Set(["done", "failed"]);
