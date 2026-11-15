import type {
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";

// Re-exported so apps can reuse the component's own validators in their
// `returns` without redeclaring the shapes.
export {
  vDocument,
  vSearchResult,
  vMemoryItem,
  documentStatus as vDocumentStatus,
  type PublicDocument,
} from "../component/validators.js";
export {
  maxProviderCallsForAdd,
  MAX_LIST_LIMIT,
  MAX_CONTENT_LENGTH,
  MAX_QUERY_LENGTH,
  NAMESPACE_PATTERN,
  DEFAULT_MAX_STATUS_CHECKS,
} from "../component/limits.js";
import { MAX_QUERY_LENGTH } from "../component/limits.js";

type QueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
type MutationCtx = Pick<
  GenericMutationCtx<GenericDataModel>,
  "runQuery" | "runMutation"
>;
type ActionCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  "runQuery" | "runMutation" | "runAction"
>;

export type MetadataValue = string | number | boolean | string[];
export type Filter = Record<string, unknown>;
export type ThreadMessage = { role: string; content: string };

export type SupermemoryOptions = {
  /** Status checks per document before polling stops. Defaults to 8. */
  maxStatusChecks?: number;
};

/**
 * Typed wrapper around the Supermemory component.
 *
 * Every method takes a `namespace`. The component trusts it, so derive it from
 * the authenticated user on the server. Never take it from the browser.
 */
export class Supermemory {
  constructor(
    public component: ComponentApi,
    public options: SupermemoryOptions = {},
  ) {}

  /** Queue content for ingestion. Returns at once; status updates reactively. */
  async add(
    ctx: MutationCtx,
    args: {
      namespace: string;
      content: string;
      requestId?: string;
      title?: string;
      metadata?: Record<string, MetadataValue>;
      maxStatusChecks?: number;
      id?: string;
      dreaming?: "dynamic" | "instant";
      taskType?: "memory" | "superrag";
    },
  ) {
    return await ctx.runMutation(this.component.documents.add, {
      ...args,
      maxStatusChecks: args.maxStatusChecks ?? this.options.maxStatusChecks,
    });
  }

  async get(ctx: QueryCtx, args: { namespace: string; documentId: string }) {
    return await ctx.runQuery(this.component.documents.get, args);
  }

  async list(ctx: QueryCtx, args: { namespace: string; limit?: number }) {
    return await ctx.runQuery(this.component.documents.list, args);
  }

  async count(ctx: QueryCtx, args: { namespace: string; max?: number }) {
    return await ctx.runQuery(this.component.documents.count, args);
  }

  /** Delete one document here and in Supermemory. Remote failures retry. */
  async remove(
    ctx: MutationCtx,
    args: { namespace: string; documentId: string },
  ) {
    return await ctx.runMutation(this.component.documents.remove, args);
  }

  /** Ask for one more status check on a document still processing. */
  async refreshStatus(
    ctx: MutationCtx,
    args: { namespace: string; documentId: string },
  ) {
    return await ctx.runMutation(this.component.documents.refreshStatus, args);
  }

  /** Remote document deletes still owed to Supermemory, with their last error. */
  async pendingRemoteDeletes(ctx: QueryCtx, args: { namespace: string }) {
    return await ctx.runQuery(
      this.component.documents.pendingRemoteDeletes,
      args,
    );
  }

  /** Re-queue remote deletes that ran out of attempts. Omit `namespace` for all. */
  async retryRemoteDeletes(
    ctx: MutationCtx,
    args: { namespace?: string; limit?: number } = {},
  ) {
    return await ctx.runMutation(
      this.component.documents.retryRemoteDeletes,
      args,
    );
  }

  async search(
    ctx: ActionCtx,
    args: {
      namespace: string;
      query: string;
      limit?: number;
      searchMode?: "hybrid" | "memories" | "chunks";
      threshold?: number;
      rerank?: "none" | "order" | "aggregate";
      rewriteQuery?: boolean;
      filter?: Filter;
    },
  ) {
    return await ctx.runAction(this.component.memory.search, args);
  }

  async profile(
    ctx: ActionCtx,
    args: { namespace: string; buckets?: string[]; filter?: Filter },
  ) {
    return await ctx.runAction(this.component.memory.profile, args);
  }

  /** One system message for an Agent `contextHandler`, or null. */
  async memoryContext(
    ctx: ActionCtx,
    args: {
      namespace: string;
      query?: string;
      limit?: number;
      filter?: Filter;
    },
  ) {
    const query = args.query?.trim().slice(0, MAX_QUERY_LENGTH);
    const [profile, search] = await Promise.all([
      this.profile(ctx, { namespace: args.namespace, filter: args.filter }),
      query
        ? this.search(ctx, {
            namespace: args.namespace,
            query,
            limit: args.limit ?? 5,
            searchMode: "memories",
            filter: args.filter,
          })
        : null,
    ]);
    const facts = [...profile.static, ...profile.dynamic].map((i) => i.memory);
    const relevant = (search?.results ?? [])
      .map((r) => r.memory ?? r.chunk ?? "")
      .filter((m) => m && !facts.includes(m));
    if (facts.length === 0 && relevant.length === 0) return null;
    const sections = [
      facts.length > 0 &&
        `What you know about the user:\n${facts.map((f) => `- ${f}`).join("\n")}`,
      relevant.length > 0 &&
        `Relevant memories:\n${relevant.map((m) => `- ${m}`).join("\n")}`,
    ].filter(Boolean);
    return { role: "system" as const, content: sections.join("\n\n") };
  }

  /** One Supermemory document per thread. */
  async saveThread(
    ctx: MutationCtx,
    args: {
      namespace: string;
      threadId: string;
      messages: ThreadMessage[];
      metadata?: Record<string, MetadataValue>;
      dreaming?: "dynamic" | "instant";
    },
  ) {
    const content = args.messages
      .filter((m) => m.content.trim().length > 0)
      .map((m) => `${m.role}: ${m.content.trim()}`)
      .join("\n\n");
    return await this.add(ctx, {
      namespace: args.namespace,
      id: `thread_${args.threadId}`,
      content,
      metadata: args.metadata,
      dreaming: args.dreaming,
    });
  }

  /** Removes this component's documents; `remote: "namespace"` wipes the whole namespace. */
  async deleteNamespace(
    ctx: MutationCtx,
    args: { namespace: string; remote?: "documents" | "namespace" },
  ) {
    return await ctx.runMutation(
      this.component.namespaces.deleteNamespace,
      args,
    );
  }

  async deletionStatus(ctx: QueryCtx, args: { namespace: string }) {
    return await ctx.runQuery(this.component.namespaces.deletionStatus, args);
  }

  async listFailedDeletions(ctx: QueryCtx, args: { limit?: number } = {}) {
    return await ctx.runQuery(
      this.component.namespaces.listFailedDeletions,
      args,
    );
  }

  async retryFailedDeletions(ctx: MutationCtx, args: { limit?: number } = {}) {
    return await ctx.runMutation(
      this.component.namespaces.retryFailedDeletions,
      args,
    );
  }
}

export default Supermemory;
