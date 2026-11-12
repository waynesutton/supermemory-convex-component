/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    documents: {
      add: FunctionReference<
        "mutation",
        "internal",
        {
          content: string;
          maxStatusChecks?: number;
          metadata?: Record<string, string | number | boolean | Array<string>>;
          namespace: string;
          requestId?: string;
          title?: string;
        },
        { deduplicated: boolean; documentId: string },
        Name
      >;
      count: FunctionReference<
        "query",
        "internal",
        { max?: number; namespace: string },
        number,
        Name
      >;
      get: FunctionReference<
        "query",
        "internal",
        { documentId: string; namespace: string },
        null | {
          content: string;
          createdAt: number;
          error?: string;
          id: string;
          metadata?: Record<string, string | number | boolean | Array<string>>;
          namespace: string;
          requestId?: string;
          status:
            | "pending"
            | "queued"
            | "extracting"
            | "chunking"
            | "embedding"
            | "indexing"
            | "done"
            | "failed"
            | "deleting";
          summary?: string;
          title?: string;
          updatedAt: number;
        },
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        { limit?: number; namespace: string },
        Array<{
          content: string;
          createdAt: number;
          error?: string;
          id: string;
          metadata?: Record<string, string | number | boolean | Array<string>>;
          namespace: string;
          requestId?: string;
          status:
            | "pending"
            | "queued"
            | "extracting"
            | "chunking"
            | "embedding"
            | "indexing"
            | "done"
            | "failed"
            | "deleting";
          summary?: string;
          title?: string;
          updatedAt: number;
        }>,
        Name
      >;
      pendingRemoteDeletes: FunctionReference<
        "query",
        "internal",
        { namespace: string },
        Array<{ attempts: number; error?: string; remoteId: string }>,
        Name
      >;
      refreshStatus: FunctionReference<
        "mutation",
        "internal",
        { documentId: string; namespace: string },
        boolean,
        Name
      >;
      remove: FunctionReference<
        "mutation",
        "internal",
        { documentId: string; namespace: string },
        boolean,
        Name
      >;
      retryRemoteDeletes: FunctionReference<
        "mutation",
        "internal",
        { limit?: number; namespace?: string },
        number,
        Name
      >;
    };
    memory: {
      profile: FunctionReference<
        "action",
        "internal",
        { buckets?: Array<string>; namespace: string },
        {
          buckets: Record<string, Array<{ id: string; memory: string }>>;
          dynamic: Array<{ id: string; memory: string }>;
          static: Array<{ id: string; memory: string }>;
        },
        Name
      >;
      search: FunctionReference<
        "action",
        "internal",
        {
          limit?: number;
          namespace: string;
          query: string;
          rerank?: "none" | "order" | "aggregate";
          rewriteQuery?: boolean;
          searchMode?: "hybrid" | "memories" | "chunks";
          threshold?: number;
        },
        {
          results: Array<{
            chunk?: string;
            id: string;
            isInference: boolean;
            memory?: string;
            metadata: any;
            similarity: number;
          }>;
          searchTime: number;
        },
        Name
      >;
    };
    namespaces: {
      deleteNamespace: FunctionReference<
        "mutation",
        "internal",
        { namespace: string },
        null,
        Name
      >;
      deletionStatus: FunctionReference<
        "query",
        "internal",
        { namespace: string },
        null | {
          attempts: number;
          completedAt?: number;
          error?: string;
          requestedAt: number;
          status: "pending" | "deleted" | "failed";
        },
        Name
      >;
      listFailedDeletions: FunctionReference<
        "query",
        "internal",
        { limit?: number },
        Array<{ attempts: number; error?: string; namespace: string }>,
        Name
      >;
      retryFailedDeletions: FunctionReference<
        "mutation",
        "internal",
        { limit?: number },
        number,
        Name
      >;
    };
  };
