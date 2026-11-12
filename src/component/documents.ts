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
import type { Doc, Id } from "./_generated/dataModel.js";
import { metadataValue, vDocument, type PublicDocument } from "./validators.js";
import {
  DEFAULT_MAX_STATUS_CHECKS,
  MAX_CONTENT_LENGTH,
  MAX_DELETE_ATTEMPTS,
  MAX_INGEST_ATTEMPTS,
  MAX_LIST_LIMIT,
  MAX_RETRY_ROUNDS,
  TERMINAL_STATUSES,
  assertNamespace,
  backoffMs,
  createClient,
  describeError,
  isRetryable,
  statusCodeOf,
} from "./provider.js";

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
    error: doc.error,
    createdAt: doc._creationTime,
    updatedAt: doc.updatedAt,
  };
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

    const documentId = await ctx.db.insert("documents", {
      namespace: args.namespace,
      requestId: args.requestId,
      content,
      title: args.title,
      metadata: args.metadata,
      remoteId: "",
      status: "pending",
      ingestAttempts: 0,
      statusChecks: 0,
      maxStatusChecks,
      updatedAt: Date.now(),
    });
    await ctx.db.patch("documents", documentId, {
      remoteId: `cvx_${documentId}`,
    });
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
    if (doc.status === "pending" || TERMINAL_STATUSES.has(doc.status)) {
      return false;
    }
    // Allow exactly one more check than the budget already spent.
    await ctx.db.patch("documents", id, {
      maxStatusChecks: Math.max(doc.maxStatusChecks, doc.statusChecks + 1),
    });
    await ctx.scheduler.runAfter(0, internal.documents.checkStatus, {
      documentId: id,
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
    if (!doc || doc.status !== "pending") return null;
    await ctx.db.patch("documents", doc._id, {
      ingestAttempts: doc.ingestAttempts + 1,
      updatedAt: Date.now(),
    });
    return {
      namespace: doc.namespace,
      remoteId: doc.remoteId,
      content: doc.content,
      metadata: doc.metadata,
      previousAttempts: doc.ingestAttempts,
    };
  },
});

export const ingest = internalAction({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const job = await ctx.runMutation(internal.documents.beginIngest, args);
    if (!job) return;
    try {
      const client = createClient();
      let status: string | undefined;
      if (job.previousAttempts > 0) {
        // The last attempt may have reached Supermemory before failing. Adding
        // to an existing id appends, so look first.
        try {
          const existing = await client.documents.get(
            job.namespace,
            job.remoteId,
          );
          status = existing.system.status;
        } catch (error) {
          if (statusCodeOf(error) !== 404) throw error;
        }
      }
      if (status === undefined) {
        const response = await client.add(job.namespace, {
          content: job.content,
          id: job.remoteId,
          metadata: job.metadata,
        });
        status = response.status;
      }
      await ctx.runMutation(internal.documents.markSubmitted, {
        documentId: args.documentId,
        namespace: job.namespace,
        remoteId: job.remoteId,
        status: normalizeStatus(status),
      });
    } catch (error) {
      await ctx.runMutation(internal.documents.recordIngestFailure, {
        documentId: args.documentId,
        namespace: job.namespace,
        remoteId: job.remoteId,
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
    await ctx.db.patch("documents", doc._id, {
      status: args.status,
      error: undefined,
      updatedAt: Date.now(),
    });
    await scheduleNextCheck(ctx, doc._id, args.status, 0, doc.maxStatusChecks);
  },
});

export const recordIngestFailure = internalMutation({
  args: {
    documentId: v.id("documents"),
    namespace: v.string(),
    remoteId: v.string(),
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

async function scheduleNextCheck(
  ctx: MutationCtx,
  documentId: Id<"documents">,
  status: string,
  checksSoFar: number,
  maxChecks: number,
) {
  if (TERMINAL_STATUSES.has(status) || checksSoFar >= maxChecks) return;
  await ctx.scheduler.runAfter(
    backoffMs(checksSoFar),
    internal.documents.checkStatus,
    { documentId },
  );
}

export const checkStatus = internalAction({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const doc = await ctx.runQuery(internal.documents.loadForIngest, args);
    if (!doc || doc.status === "pending" || TERMINAL_STATUSES.has(doc.status)) {
      return;
    }
    if (doc.statusChecks >= doc.maxStatusChecks) return;
    try {
      const remote = await createClient().documents.get(
        doc.namespace,
        doc.remoteId,
      );
      await ctx.runMutation(internal.documents.applyStatus, {
        documentId: args.documentId,
        status: normalizeStatus(remote.system.status),
        title: remote.title ?? undefined,
        summary: remote.summary ?? undefined,
      });
    } catch (error) {
      await ctx.runMutation(internal.documents.applyStatus, {
        documentId: args.documentId,
        error: describeError(error),
      });
    }
  },
});

export const applyStatus = internalMutation({
  args: {
    documentId: v.id("documents"),
    status: v.optional(remoteStatus),
    title: v.optional(v.string()),
    summary: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get("documents", args.documentId);
    if (!doc || doc.status === "pending" || TERMINAL_STATUSES.has(doc.status)) {
      return;
    }
    const statusChecks = doc.statusChecks + 1;
    const status = args.status ?? doc.status;
    await ctx.db.patch("documents", doc._id, {
      status,
      statusChecks,
      title: doc.title ?? args.title,
      summary: args.summary ?? doc.summary,
      error: args.error,
      updatedAt: Date.now(),
    });
    await scheduleNextCheck(
      ctx,
      doc._id,
      status,
      statusChecks,
      doc.maxStatusChecks,
    );
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
