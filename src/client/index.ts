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
    },
  ) {
    return await ctx.runAction(this.component.memory.search, args);
  }

  async profile(
    ctx: ActionCtx,
    args: { namespace: string; buckets?: string[] },
  ) {
    return await ctx.runAction(this.component.memory.profile, args);
  }

  /** Remove everything in a namespace, locally and remotely, in the background. */
  async deleteNamespace(ctx: MutationCtx, args: { namespace: string }) {
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
