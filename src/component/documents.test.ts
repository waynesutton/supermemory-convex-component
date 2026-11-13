/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema.js";
import { api, internal } from "./_generated/api.js";
import { installFakeSupermemory } from "../testing/fakeSupermemory.js";

const modules = import.meta.glob("./**/*.*s");

function setup() {
  const t = convexTest(schema, modules);
  const fake = installFakeSupermemory();
  return { t, fake };
}

const drain = (t: ReturnType<typeof convexTest>) =>
  t.finishAllScheduledFunctions(vi.runAllTimers);

beforeEach(() => {
  vi.useFakeTimers();
  process.env.SUPERMEMORY_API_KEY = "sm_test_key";
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("documents", () => {
  test("add ingests, polls to done, and lists by namespace", async () => {
    const { t, fake } = setup();
    const { documentId } = await t.mutation(api.documents.add, {
      namespace: "user_a",
      content: "Alex likes morning meetings",
      metadata: { source: "test" },
      maxStatusChecks: 3,
    });
    await drain(t);

    const doc = await t.query(api.documents.get, {
      namespace: "user_a",
      documentId,
    });
    expect(doc?.status).toBe("done");
    expect(doc?.memoryStatus).toBe("done");
    expect(doc?.summary).toBe("Fake summary");
    expect(fake.namespaces.get("user_a")?.size).toBe(1);

    expect(
      await t.query(api.documents.list, { namespace: "user_a" }),
    ).toHaveLength(1);
    expect(
      await t.query(api.documents.list, { namespace: "user_b" }),
    ).toHaveLength(0);
  });

  test("reads are scoped to the namespace", async () => {
    const { t } = setup();
    const { documentId } = await t.mutation(api.documents.add, {
      namespace: "user_a",
      content: "private",
    });
    expect(
      await t.query(api.documents.get, { namespace: "user_b", documentId }),
    ).toBeNull();
    expect(
      await t.mutation(api.documents.remove, {
        namespace: "user_b",
        documentId,
      }),
    ).toBe(false);
  });

  test("requestId makes add idempotent", async () => {
    const { t } = setup();
    const first = await t.mutation(api.documents.add, {
      namespace: "user_a",
      content: "once",
      requestId: "req-1",
    });
    const second = await t.mutation(api.documents.add, {
      namespace: "user_a",
      content: "once",
      requestId: "req-1",
    });
    expect(second).toEqual({
      documentId: first.documentId,
      deduplicated: true,
    });
    expect(await t.query(api.documents.count, { namespace: "user_a" })).toBe(1);
  });

  test("rejects bad input", async () => {
    const { t } = setup();
    await expect(
      t.mutation(api.documents.add, { namespace: "bad ns!", content: "x" }),
    ).rejects.toThrow(/Invalid namespace/);
    await expect(
      t.mutation(api.documents.add, { namespace: "ok", content: "   " }),
    ).rejects.toThrow(/empty/);
    await expect(
      t.mutation(api.documents.add, {
        namespace: "ok",
        content: "x".repeat(100_001),
      }),
    ).rejects.toThrow(/over/);
  });

  test("a transient failure retries without duplicating content", async () => {
    const { t, fake } = setup();
    // First add fails, the retry's lookup 404s, then the add succeeds.
    fake.failures.push(503);
    const { documentId } = await t.mutation(api.documents.add, {
      namespace: "user_a",
      content: "retry me",
      maxStatusChecks: 1,
    });
    await drain(t);
    const doc = await t.query(api.documents.get, {
      namespace: "user_a",
      documentId,
    });
    expect(doc?.status).toBe("done");
    const stored = [...fake.namespaces.get("user_a")!.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0].content).toBe("retry me");
  });

  test("a request that landed before timing out is re-sent as the same snapshot", async () => {
    const { t, fake } = setup();
    const { documentId } = await t.mutation(api.documents.add, {
      namespace: "user_a",
      content: "landed",
      maxStatusChecks: 0,
    });
    // Simulate: the remote has the doc, but our first attempt reported failure.
    await t.run(async (ctx) => {
      const id = ctx.db.normalizeId("documents", documentId)!;
      await ctx.db.patch("documents", id, { ingestAttempts: 1 });
    });
    fake.namespaces.set(
      "user_a",
      new Map([
        [
          `cvx_${documentId}`,
          {
            id: `cvx_${documentId}`,
            content: "landed",
            status: "queued",
            metadata: {},
          },
        ],
      ]),
    );
    await drain(t);
    expect(fake.calls.filter((c) => c.method === "GET")).toHaveLength(0);
    expect(
      fake.namespaces.get("user_a")!.get(`cvx_${documentId}`)!.content,
    ).toBe("landed");
  });

  test("a permanent failure marks the document failed with a safe error", async () => {
    const { t, fake } = setup();
    fake.failures.push(401);
    const { documentId } = await t.mutation(api.documents.add, {
      namespace: "user_a",
      content: "nope",
    });
    await drain(t);
    const doc = await t.query(api.documents.get, {
      namespace: "user_a",
      documentId,
    });
    expect(doc?.status).toBe("failed");
    expect(doc?.error).toBe("Supermemory returned 401");
  });

  test("status polling stops at maxStatusChecks", async () => {
    const { t, fake } = setup();
    fake.state.getStatus = "embedding";
    const { documentId } = await t.mutation(api.documents.add, {
      namespace: "user_a",
      content: "slow",
      maxStatusChecks: 2,
    });
    await drain(t);
    const gets = fake.calls.filter((c) => c.method === "GET");
    expect(gets).toHaveLength(2);
    const doc = await t.query(api.documents.get, {
      namespace: "user_a",
      documentId,
    });
    expect(doc?.status).toBe("embedding");

    // One manual refresh buys exactly one more check.
    expect(
      await t.mutation(api.documents.refreshStatus, {
        namespace: "user_a",
        documentId,
      }),
    ).toBe(true);
    await drain(t);
    expect(fake.calls.filter((c) => c.method === "GET")).toHaveLength(3);
  });

  test("remove deletes locally and remotely", async () => {
    const { t, fake } = setup();
    const { documentId } = await t.mutation(api.documents.add, {
      namespace: "user_a",
      content: "delete me",
      maxStatusChecks: 1,
    });
    await drain(t);
    expect(fake.namespaces.get("user_a")?.size).toBe(1);
    await t.mutation(api.documents.remove, { namespace: "user_a", documentId });
    await drain(t);
    expect(fake.namespaces.get("user_a")?.size).toBe(0);
    expect(
      await t.query(api.documents.pendingRemoteDeletes, {
        namespace: "user_a",
      }),
    ).toEqual([]);
  });

  test("removing mid-ingest still cleans up the remote copy", async () => {
    const { t, fake } = setup();
    const { documentId } = await t.mutation(api.documents.add, {
      namespace: "user_a",
      content: "race",
      maxStatusChecks: 0,
    });
    // Delete before the scheduled ingest runs; ingest then sees no row.
    await t.mutation(api.documents.remove, { namespace: "user_a", documentId });
    await drain(t);
    expect(fake.namespaces.get("user_a")?.size ?? 0).toBe(0);
  });

  test("failed remote deletes are kept and can be retried", async () => {
    const { t, fake } = setup();
    const { documentId } = await t.mutation(api.documents.add, {
      namespace: "user_a",
      content: "sticky",
      maxStatusChecks: 0,
    });
    await drain(t);
    for (let i = 0; i < 8; i++) fake.failures.push(500);
    await t.mutation(api.documents.remove, { namespace: "user_a", documentId });
    await drain(t);
    const pending = await t.query(api.documents.pendingRemoteDeletes, {
      namespace: "user_a",
    });
    expect(pending).toHaveLength(1);
    expect(pending[0].error).toBe("Supermemory returned 500");

    expect(
      await t.mutation(api.documents.retryRemoteDeletes, {
        namespace: "user_a",
      }),
    ).toBe(1);
    await drain(t);
    expect(
      await t.query(api.documents.pendingRemoteDeletes, {
        namespace: "user_a",
      }),
    ).toEqual([]);
    expect(fake.namespaces.get("user_a")?.size).toBe(0);
  });
});

describe("namespaces", () => {
  test("deleteNamespace clears local and remote data", async () => {
    const { t, fake } = setup();
    for (const content of ["one", "two", "three"]) {
      await t.mutation(api.documents.add, {
        namespace: "user_a",
        content,
        maxStatusChecks: 0,
      });
    }
    await t.mutation(api.documents.add, {
      namespace: "user_b",
      content: "keep",
      maxStatusChecks: 0,
    });
    await drain(t);

    await t.mutation(api.namespaces.deleteNamespace, { namespace: "user_a" });
    await expect(
      t.mutation(api.documents.add, {
        namespace: "user_a",
        content: "blocked",
      }),
    ).rejects.toThrow(/being deleted/);
    await drain(t);

    expect(await t.query(api.documents.count, { namespace: "user_a" })).toBe(0);
    expect(fake.namespaces.get("user_a")?.size).toBe(0);
    expect(await t.query(api.documents.count, { namespace: "user_b" })).toBe(1);
    expect(fake.namespaces.get("user_b")?.size).toBe(1);
    const status = await t.query(api.namespaces.deletionStatus, {
      namespace: "user_a",
    });
    expect(status?.status).toBe("deleted");

    // Usable again once deleted.
    await t.mutation(api.documents.add, {
      namespace: "user_a",
      content: "fresh",
    });
  });

  test("an ingest that lands after the namespace delete is removed", async () => {
    const { t, fake } = setup();
    await t.mutation(api.documents.add, {
      namespace: "user_a",
      content: "late",
      maxStatusChecks: 0,
    });
    // The namespace delete is requested before the ingest action has run.
    await t.mutation(api.namespaces.deleteNamespace, { namespace: "user_a" });
    await drain(t);
    expect(fake.namespaces.get("user_a")?.size ?? 0).toBe(0);
  });

  test("remote failures retry, then surface as failed", async () => {
    const { t, fake } = setup();
    await t.mutation(api.documents.add, {
      namespace: "user_a",
      content: "x",
      maxStatusChecks: 0,
    });
    await drain(t);
    for (let i = 0; i < 8; i++) fake.failures.push(503);
    await t.mutation(api.namespaces.deleteNamespace, { namespace: "user_a" });
    await drain(t);
    const failed = await t.query(api.namespaces.listFailedDeletions, {});
    expect(failed).toEqual([
      { namespace: "user_a", attempts: 8, error: "Supermemory returned 503" },
    ]);
    expect(await t.mutation(api.namespaces.retryFailedDeletions, {})).toBe(1);
    await drain(t);
    expect(
      (await t.query(api.namespaces.deletionStatus, { namespace: "user_a" }))
        ?.status,
    ).toBe("deleted");
  });
});

describe("memory", () => {
  test("search and profile return normalized results", async () => {
    const { t } = setup();
    await t.mutation(api.documents.add, {
      namespace: "user_a",
      content: "Alex likes tea",
      maxStatusChecks: 0,
    });
    await drain(t);
    const found = await t.action(api.memory.search, {
      namespace: "user_a",
      query: "tea",
    });
    expect(found.results).toHaveLength(1);
    expect(found.results[0].memory).toBe("Alex likes tea");
    const none = await t.action(api.memory.search, {
      namespace: "user_b",
      query: "tea",
    });
    expect(none.results).toHaveLength(0);

    const profile = await t.action(api.memory.profile, { namespace: "user_a" });
    expect(profile.static[0].memory).toBe("Alex likes tea");
  });

  test("errors never include the API key", async () => {
    const { t, fake } = setup();
    fake.failures.push(500);
    const error = await t
      .action(api.memory.search, { namespace: "user_a", query: "x" })
      .catch((e: Error) => e);
    expect(String(error)).toContain("Supermemory returned 500");
    expect(String(error)).not.toContain("sm_test_key");
    const headers = new Headers(fake.fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer sm_test_key");
  });

  test("a missing key fails with a setup hint", async () => {
    const { t } = setup();
    delete process.env.SUPERMEMORY_API_KEY;
    await expect(
      t.action(api.memory.search, { namespace: "user_a", query: "x" }),
    ).rejects.toThrow(/SUPERMEMORY_API_KEY is not set/);
  });
});

describe("review fixes", () => {
  test("a timed-out ingest for a deleted document still deletes remotely", async () => {
    const { t, fake } = setup();
    const { documentId } = await t.mutation(api.documents.add, {
      namespace: "user_a",
      content: "orphan?",
      maxStatusChecks: 0,
    });
    await drain(t);
    // The row is gone (reset or remove) and the late add timed out.
    await t.run(async (ctx) => {
      const id = ctx.db.normalizeId("documents", documentId)!;
      await ctx.db.delete("documents", id);
    });
    const id = await t.run(async (ctx) =>
      ctx.db.normalizeId("documents", documentId)!,
    );
    await t.mutation(internal.documents.recordIngestFailure, {
      documentId: id,
      namespace: "user_a",
      remoteId: `cvx_${documentId}`,
      revision: 0,
      error: "Supermemory timed out",
      retryable: true,
    });
    await drain(t);
    expect(fake.namespaces.get("user_a")?.size).toBe(0);
  });

  test("a 4xx on delete is not retried", async () => {
    const { t, fake } = setup();
    const { documentId } = await t.mutation(api.documents.add, {
      namespace: "user_a",
      content: "x",
      maxStatusChecks: 0,
    });
    await drain(t);
    fake.failures.push(403);
    await t.mutation(api.documents.remove, { namespace: "user_a", documentId });
    await drain(t);
    const deletes = fake.calls.filter((c) => c.method === "DELETE");
    expect(deletes).toHaveLength(1);
    const pending = await t.query(api.documents.pendingRemoteDeletes, {
      namespace: "user_a",
    });
    expect(pending[0].error).toBe("Supermemory returned 403");
  });

  test("retry rounds are capped, and the global retry finds stuck deletes", async () => {
    const { t, fake } = setup();
    const { documentId } = await t.mutation(api.documents.add, {
      namespace: "user_a",
      content: "x",
      maxStatusChecks: 0,
    });
    await drain(t);
    fake.failures.push(403);
    await t.mutation(api.documents.remove, { namespace: "user_a", documentId });
    await drain(t);
    for (let round = 0; round < 3; round++) {
      fake.failures.push(403);
      expect(await t.mutation(api.documents.retryRemoteDeletes, {})).toBe(1);
      await drain(t);
    }
    expect(await t.mutation(api.documents.retryRemoteDeletes, {})).toBe(0);
  });

  test("a sweep after a namespace delete removes late arrivals", async () => {
    const { t, fake } = setup();
    await t.mutation(api.documents.add, {
      namespace: "user_a",
      content: "x",
      maxStatusChecks: 0,
    });
    await drain(t);
    await t.mutation(api.namespaces.deleteNamespace, {
      namespace: "user_a",
      remote: "namespace",
    });
    await drain(t);
    // Something lands remotely after the delete finished.
    fake.namespaces.set(
      "user_a",
      new Map([
        ["late", { id: "late", content: "late", status: "done", metadata: {} }],
      ]),
    );
    await t.action(internal.namespaces.sweep, { namespace: "user_a" });
    expect(fake.namespaces.has("user_a")).toBe(false);
  });
});

describe("caller ids, memory status and scoped deletes", () => {
  test("adds with the same id update one document", async () => {
    const { t, fake } = setup();
    const first = await t.mutation(api.documents.add, {
      namespace: "user_a",
      id: "thread_1",
      content: "user: hi",
      maxStatusChecks: 0,
    });
    await drain(t);
    const second = await t.mutation(api.documents.add, {
      namespace: "user_a",
      id: "thread_1",
      content: "user: hi\n\nassistant: hello",
      maxStatusChecks: 0,
    });
    await drain(t);
    expect(second.documentId).toBe(first.documentId);
    expect(await t.query(api.documents.count, { namespace: "user_a" })).toBe(1);
    const remote = fake.namespaces.get("user_a")!;
    expect(remote.size).toBe(1);
    expect(remote.get("thread_1")!.content).toBe(
      "user: hi\n\nassistant: hello",
    );
  });

  test("an update while an ingest is in flight sends the latest content after it", async () => {
    const { t, fake } = setup();
    const { documentId } = await t.mutation(api.documents.add, {
      namespace: "user_a",
      id: "thread_2",
      content: "one",
      maxStatusChecks: 0,
    });
    const id = await t.run(async (ctx) =>
      ctx.db.normalizeId("documents", documentId)!,
    );
    await t.mutation(internal.documents.beginIngest, { documentId: id });
    await t.mutation(api.documents.add, {
      namespace: "user_a",
      id: "thread_2",
      content: "one two",
      maxStatusChecks: 0,
    });
    await t.mutation(internal.documents.markSubmitted, {
      documentId: id,
      namespace: "user_a",
      remoteId: "thread_2",
      revision: 0,
      status: "queued",
    });
    await drain(t);
    const posts = fake.calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.body.content)).toEqual(["one two"]);
    const doc = await t.query(api.documents.get, {
      namespace: "user_a",
      documentId,
    });
    expect(doc?.status).toBe("queued");
  });

  test("rejects ids that collide with generated ones", async () => {
    const { t } = setup();
    await expect(
      t.mutation(api.documents.add, {
        namespace: "user_a",
        id: "cvx_abc",
        content: "x",
      }),
    ).rejects.toThrow(/cvx_/);
  });

  test("done content keeps polling until memories are ready", async () => {
    const { t, fake } = setup();
    fake.state.dreamingStatus = "dreaming";
    const { documentId } = await t.mutation(api.documents.add, {
      namespace: "user_a",
      content: "Alex prefers tea",
      maxStatusChecks: 2,
    });
    await drain(t);
    let doc = await t.query(api.documents.get, {
      namespace: "user_a",
      documentId,
    });
    expect(doc?.status).toBe("done");
    expect(doc?.memoryStatus).toBe("dreaming");

    fake.state.dreamingStatus = "done";
    expect(
      await t.mutation(api.documents.refreshStatus, {
        namespace: "user_a",
        documentId,
      }),
    ).toBe(true);
    await drain(t);
    doc = await t.query(api.documents.get, { namespace: "user_a", documentId });
    expect(doc?.memoryStatus).toBe("done");
  });

  test("add forwards dreaming and taskType", async () => {
    const { t, fake } = setup();
    await t.mutation(api.documents.add, {
      namespace: "user_a",
      content: "x",
      dreaming: "instant",
      taskType: "superrag",
      maxStatusChecks: 0,
    });
    await drain(t);
    const post = fake.calls.find((c) => c.method === "POST")!;
    expect(post.body.dreaming).toBe("instant");
    expect(post.body.taskType).toBe("superrag");
  });

  test("deleteNamespace leaves data written outside the component", async () => {
    const { t, fake } = setup();
    await t.mutation(api.documents.add, {
      namespace: "user_a",
      content: "ours",
      maxStatusChecks: 0,
    });
    await drain(t);
    fake.namespaces.get("user_a")!.set("connector_doc", {
      id: "connector_doc",
      content: "theirs",
      status: "done",
      metadata: {},
    });
    await t.mutation(api.namespaces.deleteNamespace, { namespace: "user_a" });
    await drain(t);
    expect([...fake.namespaces.get("user_a")!.keys()]).toEqual([
      "connector_doc",
    ]);
    expect(
      fake.calls.some((c) => c.method === "DELETE" && c.path === "/ns/user_a"),
    ).toBe(false);
    expect(
      (await t.query(api.namespaces.deletionStatus, { namespace: "user_a" }))
        ?.status,
    ).toBe("deleted");
  });

  test("remote: namespace wipes the whole remote namespace", async () => {
    const { t, fake } = setup();
    await t.mutation(api.documents.add, {
      namespace: "user_a",
      content: "ours",
      maxStatusChecks: 0,
    });
    await drain(t);
    await t.mutation(api.namespaces.deleteNamespace, {
      namespace: "user_a",
      remote: "namespace",
    });
    await drain(t);
    expect(fake.namespaces.has("user_a")).toBe(false);
  });
});
