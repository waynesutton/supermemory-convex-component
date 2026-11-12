import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";

export default defineSchema({
  ...authTables,

  // One row. The generation changes every hour; namespaces include it, so a
  // reset hides old data at once while cleanup runs in the background.
  demoSettings: defineTable({
    generation: v.number(),
    lastResetAt: v.number(),
    nextResetAt: v.number(),
  }),

  // Per visitor. "Clear my data" bumps the epoch for a fresh namespace.
  demoVisitors: defineTable({
    userId: v.id("users"),
    epoch: v.number(),
  }).index("by_user", ["userId"]),

  // Every namespace this deployment has written to. Cleanup only ever
  // deletes namespaces listed here, never anything else in the account.
  demoNamespaces: defineTable({
    namespace: v.string(),
    userId: v.id("users"),
    generation: v.number(),
    cleanup: v.union(v.literal("active"), v.literal("requested")),
  })
    .index("by_namespace", ["namespace"])
    .index("by_cleanup_and_generation", ["cleanup", "generation"]),
});
