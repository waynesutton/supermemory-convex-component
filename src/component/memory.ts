// Read-side calls: `components.supermemory.memory.search` and `.profile`.
// These go straight to Supermemory, so the app should rate limit them.
import { v } from "convex/values";
import { action } from "./_generated/server.js";
import {
  MAX_QUERY_LENGTH,
  assertNamespace,
  createClient,
  describeError,
} from "./provider.js";
import { vMemoryItem, vSearchResult } from "./validators.js";

export const search = action({
  args: {
    namespace: v.string(),
    query: v.string(),
    limit: v.optional(v.number()),
    searchMode: v.optional(
      v.union(v.literal("hybrid"), v.literal("memories"), v.literal("chunks")),
    ),
    threshold: v.optional(v.number()),
    rerank: v.optional(
      v.union(v.literal("none"), v.literal("order"), v.literal("aggregate")),
    ),
    rewriteQuery: v.optional(v.boolean()),
    filter: v.optional(v.any()),
  },
  returns: v.object({
    results: v.array(vSearchResult),
    searchTime: v.number(),
  }),
  handler: async (_ctx, args) => {
    assertNamespace(args.namespace);
    const query = args.query.trim();
    if (query.length === 0) throw new Error("Query is empty.");
    if (query.length > MAX_QUERY_LENGTH) {
      throw new Error(`Query is over ${MAX_QUERY_LENGTH} characters.`);
    }
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 10), 1), 50);
    try {
      const response = await createClient().search(args.namespace, {
        query,
        limit,
        searchMode: args.searchMode ?? "hybrid",
        threshold: args.threshold,
        rerank: args.rerank,
        rewriteQuery: args.rewriteQuery,
        filter: args.filter,
      });
      return {
        searchTime: response.searchTime,
        results: response.results.map((r) => ({
          id: r.id,
          memory: r.memory,
          chunk: r.chunk,
          similarity: r.similarity,
          isInference: r.isInference,
          metadata: r.metadata ?? {},
        })),
      };
    } catch (error) {
      throw new Error(describeError(error));
    }
  },
});

export const profile = action({
  args: {
    namespace: v.string(),
    buckets: v.optional(v.array(v.string())),
    filter: v.optional(v.any()),
  },
  returns: v.object({
    static: v.array(vMemoryItem),
    dynamic: v.array(vMemoryItem),
    buckets: v.record(v.string(), v.array(vMemoryItem)),
  }),
  handler: async (_ctx, args) => {
    assertNamespace(args.namespace);
    try {
      const { profile } = await createClient().profile(args.namespace, {
        buckets: args.buckets,
        filter: args.filter,
      });
      const pick = (items: { id: string; memory: string }[] | undefined) =>
        (items ?? []).map((i) => ({ id: i.id, memory: i.memory }));
      const buckets: Record<string, { id: string; memory: string }[]> = {};
      for (const [name, items] of Object.entries(profile.buckets ?? {})) {
        buckets[name] = pick(items);
      }
      return {
        static: pick(profile.static),
        dynamic: pick(profile.dynamic),
        buckets,
      };
    } catch (error) {
      throw new Error(describeError(error));
    }
  },
});
