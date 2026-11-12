import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { documentStatus, metadataValue } from "./validators.js";

export default defineSchema({
  documents: defineTable({
    namespace: v.string(),
    // Caller-supplied key that makes `add` safe to retry.
    requestId: v.optional(v.string()),
    content: v.string(),
    title: v.optional(v.string()),
    summary: v.optional(v.string()),
    metadata: v.optional(v.record(v.string(), metadataValue)),
    // The id sent to Supermemory. We pick it, so a timed-out request can be
    // looked up before retrying instead of appending the content twice.
    remoteId: v.string(),
    status: documentStatus,
    error: v.optional(v.string()),
    ingestAttempts: v.number(),
    statusChecks: v.number(),
    maxStatusChecks: v.number(),
    updatedAt: v.number(),
  })
    // Kept for newest-first listing, which the compound index can't give.
    // eslint-disable-next-line @convex-dev/no-duplicate-indexes
    .index("by_namespace", ["namespace"])
    .index("by_namespace_and_request", ["namespace", "requestId"])
    .index("by_remote_id", ["remoteId"]),

  // Remote deletes that still have to reach Supermemory. A row stays until the
  // delete succeeds, so a failure is retried rather than forgotten.
  remoteDeletes: defineTable({
    namespace: v.string(),
    remoteId: v.string(),
    attempts: v.number(),
    // Bumped when the delete is queued again while one is running, so the
    // running one knows its result is stale and goes again.
    version: v.number(),
    // Retry rounds after running out of attempts, capped so a delete that
    // can never succeed stops costing calls.
    rounds: v.optional(v.number()),
    error: v.optional(v.string()),
  })
    .index("by_namespace", ["namespace"])
    .index("by_remote_id", ["remoteId"])
    .index("by_attempts", ["attempts"]),

  // A namespace that has been cleared. Late ingestion results check this so
  // deleted data can't come back.
  namespaceDeletions: defineTable({
    namespace: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("deleted"),
      v.literal("failed"),
    ),
    attempts: v.number(),
    rounds: v.optional(v.number()),
    error: v.optional(v.string()),
    requestedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_namespace", ["namespace"])
    .index("by_status", ["status"]),
});
