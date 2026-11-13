// The public demo's backend. Every function derives the namespace from the
// signed-in visitor; the browser never names one.
import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  Supermemory,
  maxProviderCallsForAdd,
  vDocument,
  vMemoryItem,
  vSearchResult,
} from "@waynesutton/convex-supermemory";
import {
  DAY,
  HOUR,
  RateLimiter,
  calculateRateLimit,
} from "@convex-dev/rate-limiter";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";

export const LIMITS = {
  documentsPerVisitor: 5,
  maxCharacters: 5_000,
  addsPerHour: 5,
  readsPerHour: 20,
  deletesPerHour: 20,
  statusChecksPerDocument: 6,
};
const IN_FLIGHT_WINDOW_MS = 3 * 60_000;
const CLEANUP_BATCH = 20;

const supermemory = new Supermemory(components.supermemory, {
  maxStatusChecks: LIMITS.statusChecksPerDocument,
});

export const rateLimiter = new RateLimiter(components.rateLimiter, {
  // Across everyone. Each new session costs a Turnstile solve; this caps how
  // many anyone can turn into fresh quota in an hour.
  signup: { kind: "fixed window", rate: 120, period: HOUR },
  // Windows start on the UTC hour, the same moment as the reset, so "per
  // hour" means the same thing everywhere on the page.
  add: {
    kind: "fixed window",
    rate: LIMITS.addsPerHour,
    period: HOUR,
    start: 0,
  },
  read: {
    kind: "fixed window",
    rate: LIMITS.readsPerHour,
    period: HOUR,
    start: 0,
  },
  remove: {
    kind: "fixed window",
    rate: LIMITS.deletesPerHour,
    period: HOUR,
    start: 0,
  },
});

// Read at call time so the budget can change from the dashboard.
function dailyBudget() {
  const n = Number(process.env.DEMO_DAILY_PROVIDER_CALLS ?? "500");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 500;
}
const budgetConfig = () => ({
  kind: "fixed window" as const,
  rate: dailyBudget(),
  period: DAY,
  start: 0, // windows line up with UTC midnight
});

function isPaused() {
  return process.env.DEMO_PAUSED === "true";
}

function namespacePrefix() {
  const prefix = process.env.DEMO_NAMESPACE_PREFIX ?? "smdemo";
  if (!/^[a-z0-9]{1,20}$/.test(prefix)) {
    throw new Error(
      "DEMO_NAMESPACE_PREFIX must be 1 to 20 lowercase letters or digits.",
    );
  }
  return prefix;
}

function nextTopOfHour(now: number) {
  return (Math.floor(now / HOUR) + 1) * HOUR;
}

function fail(code: string, message: string, retryAfter?: number): never {
  throw new ConvexError({ code, message, retryAfter });
}

async function getSettings(ctx: QueryCtx) {
  const row = await ctx.db.query("demoSettings").first();
  const now = Date.now();
  return (
    row ?? { generation: 0, lastResetAt: 0, nextResetAt: nextTopOfHour(now) }
  );
}

async function getVisitor(ctx: QueryCtx, userId: Id<"users">) {
  return await ctx.db
    .query("demoVisitors")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
}

function namespaceFor(userId: Id<"users">, generation: number, epoch: number) {
  return `${namespacePrefix()}_g${generation}_${userId}_e${epoch}`;
}

async function currentNamespace(ctx: QueryCtx, userId: Id<"users">) {
  const settings = await getSettings(ctx);
  const visitor = await getVisitor(ctx, userId);
  return namespaceFor(userId, settings.generation, visitor?.epoch ?? 0);
}

async function requireVisitor(ctx: QueryCtx) {
  const userId = await getAuthUserId(ctx);
  if (!userId) fail("unauthenticated", "Start the demo first.");
  return userId;
}

// Records the namespace before anything is written to it, so cleanup knows
// it exists even if the write is still in flight when the hour turns.
async function registerNamespace(
  ctx: MutationCtx,
  userId: Id<"users">,
  namespace: string,
) {
  const existing = await ctx.db
    .query("demoNamespaces")
    .withIndex("by_namespace", (q) => q.eq("namespace", namespace))
    .unique();
  if (existing) return;
  const settings = await getSettings(ctx);
  await ctx.db.insert("demoNamespaces", {
    namespace,
    userId,
    generation: settings.generation,
    cleanup: "active",
  });
}

async function consume(
  ctx: MutationCtx,
  name: "add" | "read" | "remove",
  userId: Id<"users">,
  message: string,
) {
  const status = await rateLimiter.limit(ctx, name, { key: userId });
  if (!status.ok) fail("rate_limited", message, status.retryAfter);
}

async function consumeBudget(ctx: MutationCtx, count: number) {
  const config = budgetConfig();
  // The limiter throws its own error when one request is bigger than the
  // whole window, so treat that as the budget being spent.
  const status =
    count > config.rate
      ? { ok: false, retryAfter: undefined }
      : await rateLimiter.limit(ctx, "providerBudget", { config, count });
  if (!status.ok) {
    fail(
      "budget_exhausted",
      "The demo has used today's Supermemory allowance. It refills at midnight UTC.",
      status.retryAfter,
    );
  }
}

// ---------------------------------------------------------------------------
// Queries

export const status = query({
  args: {},
  returns: v.object({
    signedIn: v.boolean(),
    paused: v.boolean(),
    generation: v.number(),
    nextResetAt: v.number(),
    lastResetAt: v.number(),
    limits: v.object({
      documentsPerVisitor: v.number(),
      maxCharacters: v.number(),
      addsPerHour: v.number(),
      readsPerHour: v.number(),
    }),
    remaining: v.union(
      v.null(),
      v.object({ adds: v.number(), reads: v.number() }),
    ),
  }),
  handler: async (ctx) => {
    const settings = await getSettings(ctx);
    const userId = await getAuthUserId(ctx);
    let remaining = null;
    if (userId) {
      // Stored values are as of the last write; project them to now so a
      // window that has rolled over shows as refilled.
      const now = Date.now();
      const left = async (name: "add" | "read") => {
        const stored = await rateLimiter.getValue(ctx, name, { key: userId });
        const { value } = calculateRateLimit(stored, stored.config, now);
        return Math.max(0, Math.floor(value));
      };
      remaining = { adds: await left("add"), reads: await left("read") };
    }
    return {
      signedIn: userId !== null,
      paused: isPaused(),
      generation: settings.generation,
      nextResetAt: settings.nextResetAt,
      lastResetAt: settings.lastResetAt,
      limits: {
        documentsPerVisitor: LIMITS.documentsPerVisitor,
        maxCharacters: LIMITS.maxCharacters,
        addsPerHour: LIMITS.addsPerHour,
        readsPerHour: LIMITS.readsPerHour,
      },
      remaining,
    };
  },
});

export const myDocuments = query({
  args: {},
  returns: v.array(vDocument),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const namespace = await currentNamespace(ctx, userId);
    return await supermemory.list(ctx, {
      namespace,
      limit: LIMITS.documentsPerVisitor,
    });
  },
});

// ---------------------------------------------------------------------------
// Writes

export const addNote = mutation({
  args: { content: v.string(), requestId: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    const userId = await requireVisitor(ctx);
    if (isPaused()) fail("paused", "The demo is paused. Try again later.");

    const content = args.content.trim();
    if (content.length === 0) fail("invalid", "Write something first.");
    if (content.length > LIMITS.maxCharacters) {
      fail(
        "invalid",
        `Notes are limited to ${LIMITS.maxCharacters} characters.`,
      );
    }
    if (args.requestId.length > 100) fail("invalid", "Bad request id.");

    const namespace = await currentNamespace(ctx, userId);
    const docs = await supermemory.list(ctx, { namespace, limit: 50 });
    // A retry of the same click returns the same document.
    const repeat = docs.find((d) => d.requestId === args.requestId);
    if (repeat) return repeat.id;
    if (docs.length >= LIMITS.documentsPerVisitor) {
      fail(
        "limit",
        `You can keep ${LIMITS.documentsPerVisitor} notes at a time. Delete one first.`,
      );
    }
    const now = Date.now();
    const inFlight = docs.some(
      (d) =>
        d.status !== "done" &&
        d.status !== "failed" &&
        now - d.createdAt < IN_FLIGHT_WINDOW_MS,
    );
    if (inFlight) {
      fail("busy", "Your last note is still processing. Give it a moment.");
    }

    await consume(
      ctx,
      "add",
      userId,
      "That's 5 notes this hour. Try again later.",
    );
    // Reserve the worst case up front: ingest retries plus every status check.
    await consumeBudget(
      ctx,
      maxProviderCallsForAdd(LIMITS.statusChecksPerDocument),
    );

    await registerNamespace(ctx, userId, namespace);
    const { documentId } = await supermemory.add(ctx, {
      namespace,
      content,
      requestId: args.requestId,
      metadata: { source: "demo" },
      dreaming: "instant",
    });
    return documentId;
  },
});

export const removeNote = mutation({
  args: { documentId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const userId = await requireVisitor(ctx);
    await consume(ctx, "remove", userId, "Too many deletes this hour.");
    const namespace = await currentNamespace(ctx, userId);
    // Deletes don't draw on the daily budget, so cleanup always works.
    return await supermemory.remove(ctx, {
      namespace,
      documentId: args.documentId,
    });
  },
});

export const clearMyData = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const userId = await requireVisitor(ctx);
    await consume(ctx, "remove", userId, "Too many deletes this hour.");
    const namespace = await currentNamespace(ctx, userId);
    const row = await ctx.db
      .query("demoNamespaces")
      .withIndex("by_namespace", (q) => q.eq("namespace", namespace))
      .unique();
    if (row) {
      await supermemory.deleteNamespace(ctx, {
        namespace,
        remote: "namespace",
      });
      await ctx.db.patch("demoNamespaces", row._id, { cleanup: "requested" });
    }
    // Move to a fresh namespace. Quotas stay as they are.
    const visitor = await getVisitor(ctx, userId);
    if (visitor) {
      await ctx.db.patch("demoVisitors", visitor._id, {
        epoch: visitor.epoch + 1,
      });
    } else {
      await ctx.db.insert("demoVisitors", { userId, epoch: 1 });
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// Reads that hit Supermemory. The quota is taken in a mutation first, so
// parallel calls can't slip past it.

export const reserveRead = internalMutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    const userId = await requireVisitor(ctx);
    if (isPaused()) fail("paused", "The demo is paused. Try again later.");
    await consume(
      ctx,
      "read",
      userId,
      "That's 20 searches this hour. Try again later.",
    );
    await consumeBudget(ctx, 1);
    return await currentNamespace(ctx, userId);
  },
});

export const search = action({
  args: { query: v.string() },
  returns: v.object({
    results: v.array(vSearchResult),
    searchTime: v.number(),
  }),
  handler: async (ctx, args) => {
    const query = args.query.trim();
    if (query.length === 0 || query.length > 500) {
      fail("invalid", "Searches are 1 to 500 characters.");
    }
    const namespace: string = await ctx.runMutation(
      internal.demo.reserveRead,
      {},
    );
    return await supermemory.search(ctx, { namespace, query, limit: 8 });
  },
});

export const profile = action({
  args: {},
  returns: v.object({
    static: v.array(vMemoryItem),
    dynamic: v.array(vMemoryItem),
    buckets: v.record(v.string(), v.array(vMemoryItem)),
  }),
  handler: async (ctx) => {
    const namespace: string = await ctx.runMutation(
      internal.demo.reserveRead,
      {},
    );
    return await supermemory.profile(ctx, { namespace });
  },
});

// ---------------------------------------------------------------------------
// Hourly reset

export const reset = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const row = await ctx.db.query("demoSettings").first();
    const next = {
      generation: (row?.generation ?? 0) + 1,
      lastResetAt: now,
      nextResetAt: nextTopOfHour(now),
    };
    if (row) await ctx.db.patch("demoSettings", row._id, next);
    else await ctx.db.insert("demoSettings", next);

    // Accounts, sessions, rate limits and the daily budget are left alone:
    // the reset clears content, it doesn't hand out fresh quotas.
    await ctx.scheduler.runAfter(0, internal.demo.cleanupBatch, {
      belowGeneration: next.generation,
    });
    await ctx.scheduler.runAfter(0, internal.demo.finalizeCleanup, {});
    return null;
  },
});

export const cleanupBatch = internalMutation({
  args: { belowGeneration: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("demoNamespaces")
      .withIndex("by_cleanup_and_generation", (q) =>
        q.eq("cleanup", "active").lt("generation", args.belowGeneration),
      )
      .take(CLEANUP_BATCH);
    for (const row of rows) {
      await supermemory.deleteNamespace(ctx, {
        namespace: row.namespace,
        remote: "namespace",
      });
      await ctx.db.patch("demoNamespaces", row._id, { cleanup: "requested" });
    }
    // Spread big resets out so Supermemory sees a steady trickle.
    if (rows.length === CLEANUP_BATCH) {
      await ctx.scheduler.runAfter(10_000, internal.demo.cleanupBatch, args);
    }
    return null;
  },
});

// Drops bookkeeping once Supermemory confirms a delete, and retries any the
// component gave up on. Runs every hour with the reset.
export const finalizeCleanup = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const requested: Doc<"demoNamespaces">[] = await ctx.db
      .query("demoNamespaces")
      .withIndex("by_cleanup_and_generation", (q) =>
        q.eq("cleanup", "requested"),
      )
      .take(200);
    for (const row of requested) {
      const s = await supermemory.deletionStatus(ctx, {
        namespace: row.namespace,
      });
      if (s?.status === "deleted")
        await ctx.db.delete("demoNamespaces", row._id);
    }
    await supermemory.retryFailedDeletions(ctx, { limit: 25 });
    await supermemory.retryRemoteDeletes(ctx, { limit: 25 });
    return null;
  },
});

// For the operator, from the dashboard: what cleanup is still owed.
export const cleanupReport = internalQuery({
  args: {},
  returns: v.object({
    awaitingConfirmation: v.number(),
    failed: v.array(
      v.object({
        namespace: v.string(),
        attempts: v.number(),
        error: v.optional(v.string()),
      }),
    ),
  }),
  handler: async (ctx) => {
    const requested = await ctx.db
      .query("demoNamespaces")
      .withIndex("by_cleanup_and_generation", (q) =>
        q.eq("cleanup", "requested"),
      )
      .take(500);
    const failed = await supermemory.listFailedDeletions(ctx, { limit: 50 });
    return { awaitingConfirmation: requested.length, failed };
  },
});
