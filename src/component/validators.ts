// Validators only, safe to import from app code.
import { v, type Infer } from "convex/values";

// Mirrors Supermemory's document lifecycle, plus local states for work that
// hasn't reached the API yet ("pending") or is being removed ("deleting").
export const documentStatus = v.union(
  v.literal("pending"),
  v.literal("queued"),
  v.literal("extracting"),
  v.literal("chunking"),
  v.literal("embedding"),
  v.literal("indexing"),
  v.literal("done"),
  v.literal("failed"),
  v.literal("deleting"),
);

export const metadataValue = v.union(
  v.string(),
  v.number(),
  v.boolean(),
  v.array(v.string()),
);

export const vDocument = v.object({
  id: v.string(),
  namespace: v.string(),
  requestId: v.optional(v.string()),
  content: v.string(),
  title: v.optional(v.string()),
  summary: v.optional(v.string()),
  metadata: v.optional(v.record(v.string(), metadataValue)),
  status: documentStatus,
  error: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
});
export type PublicDocument = Infer<typeof vDocument>;

export const vMemoryItem = v.object({ id: v.string(), memory: v.string() });

export const vSearchResult = v.object({
  id: v.string(),
  memory: v.optional(v.string()),
  chunk: v.optional(v.string()),
  similarity: v.number(),
  isInference: v.boolean(),
  metadata: v.any(),
});
