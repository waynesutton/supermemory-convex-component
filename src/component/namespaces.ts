// Apps call these as `components.supermemory.namespaces.<fn>`.
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import {
  MAX_DELETE_ATTEMPTS,
  MAX_RETRY_ROUNDS,
  assertNamespace,
  backoffMs,
  createClient,
  describeError,
  isRetryable,
  statusCodeOf,
} from "./provider.js";
import { queueRemoteDelete } from "./documents.js";

// Documents can be 50k characters; 25 keeps a batch far from read limits.
const PURGE_BATCH = 25;
// One more delete after the first succeeds, for ingests that land late.
const SWEEP_DELAY_MS = 10 * 60_000;
const DRAIN_CHECK_MS = 30_000;

const vRemoteScope = v.union(v.literal("documents"), v.literal("namespace"));

const vDeletionStatus = v.union(
  v.literal("pending"),
  v.literal("deleted"),
  v.literal("failed"),
);

/**
 * Deletes every document this component added to a namespace, here and in
 * Supermemory. Pass `remote: "namespace"` to wipe the whole remote namespace,
 * including data written outside this component.
 */
export const deleteNamespace = mutation({
  args: { namespace: v.string(), remote: v.optional(vRemoteScope) },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertNamespace(args.namespace);
    const existing = await ctx.db
      .query("namespaceDeletions")
      .withIndex("by_namespace", (q) => q.eq("namespace", args.namespace))
      .unique();
    if (existing?.status === "pending") return null;
    const fields = {
      status: "pending" as const,
      remote: args.remote ?? ("documents" as const),
      attempts: 0,
      rounds: 0,
      error: undefined,
      requestedAt: Date.now(),
      completedAt: undefined,
    };
    if (existing) {
      await ctx.db.patch("namespaceDeletions", existing._id, fields);
    } else {
      await ctx.db.insert("namespaceDeletions", {
        namespace: args.namespace,
        ...fields,
      });
    }
    await ctx.scheduler.runAfter(0, internal.namespaces.purgeLocal, {
      namespace: args.namespace,
    });
    return null;
  },
});

export const deletionStatus = query({
  args: { namespace: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      status: vDeletionStatus,
      attempts: v.number(),
      error: v.optional(v.string()),
      requestedAt: v.number(),
      completedAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("namespaceDeletions")
      .withIndex("by_namespace", (q) => q.eq("namespace", args.namespace))
      .unique();
    if (!row) return null;
    return {
      status: row.status,
      attempts: row.attempts,
      error: row.error,
      requestedAt: row.requestedAt,
      completedAt: row.completedAt,
    };
  },
});

export const listFailedDeletions = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      namespace: v.string(),
      attempts: v.number(),
      error: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 50), 1), 200);
    const rows = await ctx.db
      .query("namespaceDeletions")
      .withIndex("by_status", (q) => q.eq("status", "failed"))
      .take(limit);
    return rows.map((r) => ({
      namespace: r.namespace,
      attempts: r.attempts,
      error: r.error,
    }));
  },
});

export const retryFailedDeletions = mutation({
  args: { limit: v.optional(v.number()) },
  returns: v.number(),
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 25), 1), 100);
    // Read past rows that hit the round cap so they can't starve the rest.
    const rows = await ctx.db
      .query("namespaceDeletions")
      .withIndex("by_status", (q) => q.eq("status", "failed"))
      .take(200);
    let scheduled = 0;
    for (const row of rows) {
      if (scheduled >= limit) break;
      const rounds = (row.rounds ?? 0) + 1;
      // Past the cap, leave it failed for a person to look at.
      if (rounds > MAX_RETRY_ROUNDS) continue;
      if (row.remote === "documents") {
        const stuck = await ctx.db
          .query("remoteDeletes")
          .withIndex("by_namespace", (q) => q.eq("namespace", row.namespace))
          .take(100);
        for (const d of stuck) {
          if (d.attempts < MAX_DELETE_ATTEMPTS) continue;
          await ctx.db.patch("remoteDeletes", d._id, { attempts: 0 });
          await ctx.scheduler.runAfter(0, internal.documents.deleteRemote, {
            deleteId: d._id,
          });
        }
      }
      await ctx.db.patch("namespaceDeletions", row._id, {
        status: "pending",
        attempts: 0,
        rounds,
      });
      await ctx.scheduler.runAfter(0, internal.namespaces.purgeLocal, {
        namespace: row.namespace,
      });
      scheduled++;
    }
    return scheduled;
  },
});

export const purgeLocal = internalMutation({
  args: { namespace: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("namespaceDeletions")
      .withIndex("by_namespace", (q) => q.eq("namespace", args.namespace))
      .unique();
    const wholeNamespace = row?.remote !== "documents";
    const docs = await ctx.db
      .query("documents")
      .withIndex("by_namespace", (q) => q.eq("namespace", args.namespace))
      .take(PURGE_BATCH);
    for (const doc of docs) {
      await ctx.db.delete("documents", doc._id);
      if (!wholeNamespace) {
        await queueRemoteDelete(ctx, doc.namespace, doc.remoteId);
      }
    }

    // The namespace delete covers these documents too.
    const deletes = wholeNamespace
      ? await ctx.db
          .query("remoteDeletes")
          .withIndex("by_namespace", (q) => q.eq("namespace", args.namespace))
          .take(PURGE_BATCH)
      : [];
    for (const d of deletes) await ctx.db.delete("remoteDeletes", d._id);

    if (docs.length === PURGE_BATCH || deletes.length === PURGE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.namespaces.purgeLocal, args);
      return;
    }
    await ctx.scheduler.runAfter(
      0,
      wholeNamespace
        ? internal.namespaces.deleteRemote
        : internal.namespaces.checkDrained,
      args,
    );
  },
});

// Per-document deletes retry on their own; the namespace is done once none are left, or failed once all that are left are stuck.
export const checkDrained = internalMutation({
  args: { namespace: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("namespaceDeletions")
      .withIndex("by_namespace", (q) => q.eq("namespace", args.namespace))
      .unique();
    if (!row || row.status !== "pending") return;
    const owed = await ctx.db
      .query("remoteDeletes")
      .withIndex("by_namespace", (q) => q.eq("namespace", args.namespace))
      .take(100);
    if (owed.length === 0) {
      await ctx.db.patch("namespaceDeletions", row._id, {
        status: "deleted",
        error: undefined,
        completedAt: Date.now(),
      });
      return;
    }
    const stuck = owed.filter((d) => d.attempts >= MAX_DELETE_ATTEMPTS);
    if (stuck.length === owed.length) {
      await ctx.db.patch("namespaceDeletions", row._id, {
        status: "failed",
        attempts: stuck[0].attempts,
        error: stuck[0].error,
      });
      return;
    }
    await ctx.scheduler.runAfter(
      DRAIN_CHECK_MS,
      internal.namespaces.checkDrained,
      args,
    );
  },
});

export const deleteRemote = internalAction({
  args: { namespace: v.string() },
  handler: async (ctx, args) => {
    try {
      // "queued" means Supermemory accepted it and finishes on its side.
      await createClient().namespaces.delete(args.namespace);
      await ctx.runMutation(internal.namespaces.finishDeletion, args);
    } catch (error) {
      if (statusCodeOf(error) === 404) {
        await ctx.runMutation(internal.namespaces.finishDeletion, args);
        return;
      }
      await ctx.runMutation(internal.namespaces.recordDeletionFailure, {
        namespace: args.namespace,
        error: describeError(error),
        retryable: isRetryable(error),
      });
    }
  },
});

export const finishDeletion = internalMutation({
  args: { namespace: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("namespaceDeletions")
      .withIndex("by_namespace", (q) => q.eq("namespace", args.namespace))
      .unique();
    if (!row || row.status !== "pending") return;
    await ctx.db.patch("namespaceDeletions", row._id, {
      status: "deleted",
      error: undefined,
      completedAt: Date.now(),
    });
    // An ingest that was in flight can land after the delete. Sweep once more.
    await ctx.scheduler.runAfter(SWEEP_DELAY_MS, internal.namespaces.sweep, {
      namespace: args.namespace,
    });
  },
});

// Best effort, one call, no retries. Skipped if new data was added since,
// because then the namespace is in use again.
export const sweep = internalAction({
  args: { namespace: v.string() },
  handler: async (ctx, args) => {
    const inUse = await ctx.runQuery(internal.namespaces.hasDocuments, args);
    if (inUse) return;
    try {
      await createClient().namespaces.delete(args.namespace);
    } catch {
      // 404 is the expected outcome; anything else is left for next time.
    }
  },
});

export const hasDocuments = internalQuery({
  args: { namespace: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("documents")
      .withIndex("by_namespace", (q) => q.eq("namespace", args.namespace))
      .first();
    return doc !== null;
  },
});

export const recordDeletionFailure = internalMutation({
  args: { namespace: v.string(), error: v.string(), retryable: v.boolean() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("namespaceDeletions")
      .withIndex("by_namespace", (q) => q.eq("namespace", args.namespace))
      .unique();
    if (!row || row.status !== "pending") return;
    const attempts = args.retryable ? row.attempts + 1 : MAX_DELETE_ATTEMPTS;
    if (attempts >= MAX_DELETE_ATTEMPTS) {
      await ctx.db.patch("namespaceDeletions", row._id, {
        status: "failed",
        attempts,
        error: args.error,
      });
      return;
    }
    await ctx.db.patch("namespaceDeletions", row._id, {
      attempts,
      error: args.error,
    });
    await ctx.scheduler.runAfter(
      backoffMs(attempts, 5_000, 10 * 60_000),
      internal.namespaces.deleteRemote,
      { namespace: args.namespace },
    );
  },
});
