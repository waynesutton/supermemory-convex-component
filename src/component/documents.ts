// Apps call these as `components.supermemory.documents.<fn>`.
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import {
  dreamingMode,
  memoryStatus,
  metadataValue,
  taskType,
  vDocument,
  type PublicDocument,
} from "./validators.js";
import {
  DEFAULT_MAX_STATUS_CHECKS,
  MAX_CONTENT_LENGTH,
  MAX_DELETE_ATTEMPTS,
  MAX_INGEST_ATTEMPTS,
  MAX_LIST_LIMIT,
  MAX_DOCUMENT_ID_LENGTH,
  MAX_RETRY_ROUNDS,
  MEMORY_POLL_MS,
  assertNamespace,
  backoffMs,
  createClient,
  describeError,
  isRetryable,
  isSettled,
  statusCodeOf,
} from "./provider.js";

const INGEST_STALE_MS = 2 * 60_000;

function toPublic(doc: Doc<"documents">): PublicDocument {
  return {
    id: doc._id,
    namespace: doc.namespace,
    requestId: doc.requestId,
    content: doc.content,
    title: doc.title,
    summary: doc.summary,
    metadata: doc.metadata,
    status: doc.status,
    memoryStatus: doc.memoryStatus,
    error: doc.error,
    createdAt: doc._creationTime,
    updatedAt: doc.updatedAt,
  };
}

// An attempt older than the SDK timeout plus margin is treated as crashed, so a newer revision isn't blocked forever.
function isIngesting(doc: Doc<"documents">) {
  return (
    doc.ingestStartedAt !== undefined &&
    Date.now() - doc.ingestStartedAt < INGEST_STALE_MS
  );
}

async function namespaceIsDeleting(ctx: MutationCtx, namespace: string) {
  const deletion = await ctx.db
    .query("namespaceDeletions")
    .withIndex("by_namespace", (q) => q.eq("namespace", namespace))
    .unique();
  return deletion?.status === "pending";
}

export const add = mutation({
  args: {
    namespace: v.string(),
    content: v.string(),
    requestId: v.optional(v.string()),
    title: v.optional(v.string()),
    metadata: v.optional(v.record(v.string(), metadataValue)),
    maxStatusChecks: v.optional(v.number()),
    id: v.optional(v.string()),
    dreaming: v.optional(dreamingMode),
    taskType: v.optional(taskType),
  },
  returns: v.object({ documentId: v.string(), deduplicated: v.boolean() }),
  handler: async (ctx, args) => {
    assertNamespace(args.namespace);
    const content = args.content.trim();
    if (content.length === 0) throw new Error("Content is empty.");
    if (content.length > MAX_CONTENT_LENGTH) {
      throw new Error(`Content is over ${MAX_CONTENT_LENGTH} characters.`);
    }
    if (args.requestId !== undefined && args.requestId.length > 200) {
      throw new Error("requestId is over 200 characters.");
    }
    const maxStatusChecks = Math.floor(
      args.maxStatusChecks ?? DEFAULT_MAX_STATUS_CHECKS,
    );
    if (maxStatusChecks < 0 || maxStatusChecks > 30) {
      throw new Error("maxStatusChecks must be between 0 and 30.");
    }
    if (
      args.id !== undefined &&
      (args.id.length === 0 ||
        args.id.length > MAX_DOCUMENT_ID_LENGTH ||
        args.id.startsWith("cvx_"))
    ) {
      throw new Error(
        `id must be 1 to ${MAX_DOCUMENT_ID_LENGTH} characters and not start with "cvx_".`,
      );
    }

    if (args.requestId !== undefined) {
      const existing = await ctx.db
        .query("documents")
        .withIndex("by_namespace_and_request", (q) =>
          q.eq("namespace", args.namespace).eq("requestId", args.requestId),
        )
        .unique();
      if (existing) return { documentId: existing._id, deduplicated: true };
    }

    // A namespace delete in flight would wipe this document remotely after
    // it lands, leaving a local row that points at nothing.
    if (await namespaceIsDeleting(ctx, args.namespace)) {
      throw new Error("This namespace is being deleted. Try again shortly.");
    }

    const fields = {
      requestId: args.requestId,
      content,
      title: args.title,
      metadata: args.metadata,
      dreaming: args.dreaming,
      taskType: args.taskType,
      status: "pending" as const,
      memoryStatus: "pending" as const,
      ingestAttempts: 0,
      statusChecks: 0,
      maxStatusChecks,
      updatedAt: Date.now(),
    };

    if (args.id !== undefined) {
      const id = args.id;
      const deleting = await ctx.db
        .query("remoteDeletes")
        .withIndex("by_remote_id", (q) => q.eq("remoteId", id))
        .first();
      if (deleting?.namespace === args.namespace) {
        throw new Error("This id is being deleted. Try again shortly.");
      }
      const existing = await ctx.db
        .query("documents")
        .withIndex("by_namespace_and_remote_id", (q) =>
          q.eq("namespace", args.namespace).eq("remoteId", id),
        )
        .unique();
      if (existing) {
        await ctx.db.patch("documents", existing._id, {
          ...fields,
          error: undefined,
          title: args.title ?? existing.title,
          revision: (existing.revision ?? 0) + 1,
        });
        if (!isIngesting(existing)) {
          await ctx.scheduler.runAfter(0, internal.documents.ingest, {
            documentId: existing._id,
          });
        }
        return { documentId: existing._id, deduplicated: false };
      }
    }

    const documentId = await ctx.db.insert("documents", {
      namespace: args.namespace,
      ...fields,
      remoteId: args.id ?? "",
      revision: 0,
    });
    if (args.id === undefined) {
      await ctx.db.patch("documents", documentId, {
        remoteId: `cvx_${documentId}`,
      });
    }
    await ctx.scheduler.runAfter(0, internal.documents.ingest, { documentId });
    return { documentId, deduplicated: false };
  },
});

export const get = query({
  args: { namespace: v.string(), documentId: v.string() },
  returns: v.union(v.null(), vDocument),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("documents", args.documentId);
    if (!id) return null;
    const doc = await ctx.db.get("documents", id);
    // Scope every read to the namespace so ids from elsewhere return nothing.
    if (!doc || doc.namespace !== args.namespace) return null;
    return toPublic(doc);
  },
});

export const list = query({
  args: { namespace: v.string(), limit: v.optional(v.number()) },
  returns: v.array(vDocument),
  handler: async (ctx, args) => {
    const limit = Math.min(
      Math.max(Math.floor(args.limit ?? 50), 1),
      MAX_LIST_LIMIT,
    );
    const docs = await ctx.db
      .query("documents")
      .withIndex("by_namespace", (q) => q.eq("namespace", args.namespace))
      .order("desc")
      .take(limit);
    return docs.map(toPublic);
  },
});

export const count = query({
  args: { namespace: v.string(), max: v.optional(v.number()) },
  returns: v.number(),
  handler: async (ctx, args) => {
    const max = Math.min(
      Math.max(Math.floor(args.max ?? MAX_LIST_LIMIT), 1),
      MAX_LIST_LIMIT,
    );
    const docs = await ctx.db
      .query("documents")
      .withIndex("by_namespace", (q) => q.eq("namespace", args.namespace))
      .take(max);
    return docs.length;
  },
});

export const remove = mutation({
  args: { namespace: v.string(), documentId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("documents", args.documentId);
    if (!id) return false;
    const doc = await ctx.db.get("documents", id);
    if (!doc || doc.namespace !== args.namespace) return false;
    await ctx.db.delete("documents", id);
    // Always queue the remote delete. If ingestion is mid-flight, the 404 now
    // is harmless and `markSubmitted` queues another once it lands.
    await queueRemoteDelete(ctx, doc.namespace, doc.remoteId);
    return true;
  },
});

export const refreshStatus = mutation({
  args: { namespace: v.string(), documentId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("documents", args.documentId);
    if (!id) return false;
    const doc = await ctx.db.get("documents", id);
    if (!doc || doc.namespace !== args.namespace) return false;
    if (doc.status === "pending" || isSettled(doc)) return false;
    // Allow exactly one more check than the budget already spent.
    await ctx.db.patch("documents", id, {
      maxStatusChecks: Math.max(doc.maxStatusChecks, doc.statusChecks + 1),
    });
    await ctx.scheduler.runAfter(0, internal.documents.checkStatus, {
      documentId: id,
      revision: doc.revision ?? 0,
    });
    return true;
  },
});

export const pendingRemoteDeletes = query({
  args: { namespace: v.string() },
  returns: v.array(
    v.object({
      remoteId: v.string(),
      attempts: v.number(),
      error: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("remoteDeletes")
      .withIndex("by_namespace", (q) => q.eq("namespace", args.namespace))
      .take(100);
    return rows.map((r) => ({
      remoteId: r.remoteId,
      attempts: r.attempts,
      error: r.error,
    }));
  },
});

export const retryRemoteDeletes = mutation({
  // Without a namespace, retries stuck deletes across every namespace.
  args: { namespace: v.optional(v.string()), limit: v.optional(v.number()) },
  returns: v.number(),
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 25), 1), 100);
    const namespace = args.namespace;
    const rows =
      namespace === undefined
        ? await ctx.db
            .query("remoteDeletes")
            .withIndex("by_attempts", (q) =>
              q.gte("attempts", MAX_DELETE_ATTEMPTS),
            )
            .take(200)
        : await ctx.db
            .query("remoteDeletes")
            .withIndex("by_namespace", (q) => q.eq("namespace", namespace))
            .take(200);
    let scheduled = 0;
    for (const row of rows) {
      if (scheduled >= limit) break;
      if (row.attempts < MAX_DELETE_ATTEMPTS) continue;
      const rounds = (row.rounds ?? 0) + 1;
      if (rounds > MAX_RETRY_ROUNDS) continue;
      await ctx.db.patch("remoteDeletes", row._id, { attempts: 0, rounds });
      await ctx.scheduler.runAfter(0, internal.documents.deleteRemote, {
        deleteId: row._id,
      });
      scheduled++;
    }
    return scheduled;
  },
});

// ---------------------------------------------------------------------------
// Internal pipeline: ingest -> status checks, and remote deletes.

export async function queueRemoteDelete(
  ctx: MutationCtx,
  namespace: string,
  remoteId: string,
) {
  const existing = await ctx.db
    .query("remoteDeletes")
    .withIndex("by_remote_id", (q) => q.eq("remoteId", remoteId))
    .first();
  if (existing) {
    await ctx.db.patch("remoteDeletes", existing._id, {
      version: existing.version + 1,
      attempts: 0,
    });
    await ctx.scheduler.runAfter(0, internal.documents.deleteRemote, {
      deleteId: existing._id,
    });
    return;
  }
  const deleteId = await ctx.db.insert("remoteDeletes", {
    namespace,
    remoteId,
    attempts: 0,
    version: 0,
  });
  await ctx.scheduler.runAfter(0, internal.documents.deleteRemote, {
    deleteId,
  });
}

export const loadForIngest = internalQuery({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    return await ctx.db.get("documents", args.documentId);
  },
});

export const beginIngest = internalMutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get("documents", args.documentId);
    if (!doc || doc.status !== "pending" || isIngesting(doc)) return null;
    await ctx.db.patch("documents", doc._id, {
      ingestAttempts: doc.ingestAttempts + 1,
      ingestStartedAt: Date.now(),
      updatedAt: Date.now(),
    });
    return {
      namespace: doc.namespace,
      remoteId: doc.remoteId,
      content: doc.content,
      metadata: doc.metadata,
      dreaming: doc.dreaming,
      taskType: doc.taskType,
      revision: doc.revision ?? 0,
    };
  },
});

// Content is always the full document, so a retry after a lost response re-sends a snapshot Supermemory treats as unchanged.
export const ingest = internalAction({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const job = await ctx.runMutation(internal.documents.beginIngest, args);
    if (!job) return;
    try {
      const response = await createClient().add(job.namespace, {
        content: job.content,
        id: job.remoteId,
        metadata: job.metadata,
        dreaming: job.dreaming,
        taskType: job.taskType,
      });
      await ctx.runMutation(internal.documents.markSubmitted, {
        documentId: args.documentId,
        namespace: job.namespace,
        remoteId: job.remoteId,
        revision: job.revision,
        status: normalizeStatus(response.status),
      });
    } catch (error) {
      await ctx.runMutation(internal.documents.recordIngestFailure, {
        documentId: args.documentId,
        namespace: job.namespace,
        remoteId: job.remoteId,
        revision: job.revision,
        error: describeError(error),
        retryable: isRetryable(error),
      });
    }
  },
});

function normalizeStatus(status: string) {
  switch (status) {
    case "queued":
    case "extracting":
    case "chunking":
    case "embedding":
    case "indexing":
    case "done":
    case "failed":
      return status;
    default:
      return "queued" as const;
  }
}

const remoteStatus = v.union(
  v.literal("queued"),
  v.literal("extracting"),
  v.literal("chunking"),
  v.literal("embedding"),
  v.literal("indexing"),
  v.literal("done"),
  v.literal("failed"),
);

export const markSubmitted = internalMutation({
  args: {
    documentId: v.id("documents"),
    namespace: v.string(),
    remoteId: v.string(),
    revision: v.number(),
    status: remoteStatus,
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get("documents", args.documentId);
    if (!doc) {
      // Deleted while the request was in flight. The content now exists
      // remotely, so remove it again.
      await queueRemoteDelete(ctx, args.namespace, args.remoteId);
      return;
    }
    if ((doc.revision ?? 0) !== args.revision) {
      await ctx.db.patch("documents", doc._id, { ingestStartedAt: undefined });
      await ctx.scheduler.runAfter(0, internal.documents.ingest, {
        documentId: doc._id,
      });
      return;
    }
    const next = { ...doc, status: args.status };
    await ctx.db.patch("documents", doc._id, {
      status: args.status,
      ingestStartedAt: undefined,
      error: undefined,
      updatedAt: Date.now(),
    });
    await scheduleNextCheck(ctx, next, 0);
  },
});

export const recordIngestFailure = internalMutation({
  args: {
    documentId: v.id("documents"),
    namespace: v.string(),
    remoteId: v.string(),
    revision: v.number(),
    error: v.string(),
    retryable: v.boolean(),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get("documents", args.documentId);
    if (!doc) {
      // Deleted mid-request. A timeout doesn't mean the add didn't land, so
      // delete remotely to be sure.
      if (args.retryable) {
        await queueRemoteDelete(ctx, args.namespace, args.remoteId);
      }
      return;
    }
    await ctx.db.patch("documents", doc._id, { ingestStartedAt: undefined });
    if ((doc.revision ?? 0) !== args.revision) {
      await ctx.scheduler.runAfter(0, internal.documents.ingest, {
        documentId: doc._id,
      });
      return;
    }
    if (doc.status !== "pending") return;
    if (args.retryable && doc.ingestAttempts < MAX_INGEST_ATTEMPTS) {
      await ctx.db.patch("documents", doc._id, {
        error: args.error,
        updatedAt: Date.now(),
      });
      await ctx.scheduler.runAfter(
        backoffMs(doc.ingestAttempts),
        internal.documents.ingest,
        { documentId: doc._id },
      );
      return;
    }
    await ctx.db.patch("documents", doc._id, {
      status: "failed",
      error: args.error,
      updatedAt: Date.now(),
    });
  },
});

// Once content is done, memories form on Supermemory's batching schedule, so polling slows down to match.
async function scheduleNextCheck(
  ctx: MutationCtx,
  doc: Doc<"documents">,
  checksSoFar: number,
) {
  if (isSettled(doc) || checksSoFar >= doc.maxStatusChecks) return;
  const delay =
    doc.status === "done"
      ? Math.max(backoffMs(checksSoFar), MEMORY_POLL_MS)
      : backoffMs(checksSoFar);
  await ctx.scheduler.runAfter(delay, internal.documents.checkStatus, {
    documentId: doc._id,
    revision: doc.revision ?? 0,
  });
}

export const checkStatus = internalAction({
  args: { documentId: v.id("documents"), revision: v.number() },
  handler: async (ctx, args) => {
    const doc = await ctx.runQuery(internal.documents.loadForIngest, {
      documentId: args.documentId,
    });
    if (!doc || doc.status === "pending" || isSettled(doc)) return;
    if ((doc.revision ?? 0) !== args.revision) return;
    if (doc.statusChecks >= doc.maxStatusChecks) return;
    try {
      const remote = await createClient().documents.get(
        doc.namespace,
        doc.remoteId,
      );
      await ctx.runMutation(internal.documents.applyStatus, {
        documentId: args.documentId,
        revision: args.revision,
        status: normalizeStatus(remote.system.status),
        memoryStatus:
          remote.system.dreamingStatus === "done" ? "done" : "dreaming",
        title: remote.title ?? undefined,
        summary: remote.summary ?? undefined,
      });
    } catch (error) {
      await ctx.runMutation(internal.documents.applyStatus, {
        documentId: args.documentId,
        revision: args.revision,
        error: describeError(error),
      });
    }
  },
});

export const applyStatus = internalMutation({
  args: {
    documentId: v.id("documents"),
    revision: v.number(),
    status: v.optional(remoteStatus),
    memoryStatus: v.optional(memoryStatus),
    title: v.optional(v.string()),
    summary: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get("documents", args.documentId);
    if (!doc || doc.status === "pending" || isSettled(doc)) return;
    if ((doc.revision ?? 0) !== args.revision) return;
    const patch = {
      status: args.status ?? doc.status,
      memoryStatus: args.memoryStatus ?? doc.memoryStatus,
      statusChecks: doc.statusChecks + 1,
      title: doc.title ?? args.title,
      summary: args.summary ?? doc.summary,
      error: args.error,
      updatedAt: Date.now(),
    };
    await ctx.db.patch("documents", doc._id, patch);
    await scheduleNextCheck(ctx, { ...doc, ...patch }, patch.statusChecks);
  },
});

export const loadRemoteDelete = internalQuery({
  args: { deleteId: v.id("remoteDeletes") },
  handler: async (ctx, args) => {
    return await ctx.db.get("remoteDeletes", args.deleteId);
  },
});

export const deleteRemote = internalAction({
  args: { deleteId: v.id("remoteDeletes") },
  handler: async (ctx, args) => {
    const row = await ctx.runQuery(internal.documents.loadRemoteDelete, args);
    if (!row) return;
    try {
      await createClient().documents.delete(row.namespace, {
        ids: [row.remoteId],
      });
      await ctx.runMutation(internal.documents.finishRemoteDelete, {
        deleteId: args.deleteId,
        version: row.version,
      });
    } catch (error) {
      if (statusCodeOf(error) === 404) {
        await ctx.runMutation(internal.documents.finishRemoteDelete, {
          deleteId: args.deleteId,
          version: row.version,
        });
        return;
      }
      await ctx.runMutation(internal.documents.recordRemoteDeleteFailure, {
        deleteId: args.deleteId,
        error: describeError(error),
        retryable: isRetryable(error),
      });
    }
  },
});

export const finishRemoteDelete = internalMutation({
  args: { deleteId: v.id("remoteDeletes"), version: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get("remoteDeletes", args.deleteId);
    if (!row) return;
    // Queued again mid-flight: the newer run, already scheduled, owns the row.
    if (row.version !== args.version) return;
    await ctx.db.delete("remoteDeletes", row._id);
  },
});

export const recordRemoteDeleteFailure = internalMutation({
  args: {
    deleteId: v.id("remoteDeletes"),
    error: v.string(),
    retryable: v.boolean(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get("remoteDeletes", args.deleteId);
    if (!row) return;
    // A 4xx won't fix itself by waiting, so skip straight to "stuck".
    const attempts = args.retryable ? row.attempts + 1 : MAX_DELETE_ATTEMPTS;
    await ctx.db.patch("remoteDeletes", row._id, {
      attempts,
      error: args.error,
    });
    // After the last attempt the row stays put, visible through
    // `pendingRemoteDeletes`, until `retryRemoteDeletes` runs.
    if (attempts < MAX_DELETE_ATTEMPTS) {
      await ctx.scheduler.runAfter(
        backoffMs(attempts, 5_000, 10 * 60_000),
        internal.documents.deleteRemote,
        { deleteId: row._id },
      );
    }
  },
});
