import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { defineTestApp } from "convex-test";
import { defineSchema } from "convex/server";
import { v } from "convex/values";
import componentTest from "../test.js";
import { Supermemory } from "./index.js";
import { installFakeSupermemory } from "../testing/fakeSupermemory.js";

// A small host app, so the client runs the way an installing app would use it.
const app = defineTestApp({
  schema: defineSchema({}),
  components: { supermemory: componentTest },
});
const supermemory = new Supermemory(app.components.supermemory, {
  maxStatusChecks: 0,
});
const vMessage = v.object({ role: v.string(), content: v.string() });

const { api, createTest } = app.defineModules({
  host: {
    saveThread: app.mutation({
      args: {
        namespace: v.string(),
        threadId: v.string(),
        messages: v.array(vMessage),
      },
      handler: async (ctx, args): Promise<string> => {
        const { documentId } = await supermemory.saveThread(ctx, args);
        return documentId;
      },
    }),
    count: app.query({
      args: { namespace: v.string() },
      handler: async (ctx, args): Promise<number> => {
        return await supermemory.count(ctx, args);
      },
    }),
    context: app.action({
      args: { namespace: v.string(), query: v.optional(v.string()) },
      handler: async (
        ctx,
        args,
      ): Promise<{ role: "system"; content: string } | null> => {
        return await supermemory.memoryContext(ctx, args);
      },
    }),
  },
});

beforeEach(() => {
  vi.useFakeTimers();
  process.env.SUPERMEMORY_API_KEY = "sm_test_key";
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("saveThread", () => {
  test("keeps one document per thread and replaces its content", async () => {
    const fake = installFakeSupermemory();
    const t = createTest();
    const first = await t.mutation(api.host.saveThread, {
      namespace: "user_a",
      threadId: "t1",
      messages: [{ role: "user", content: "I like tea" }],
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const second = await t.mutation(api.host.saveThread, {
      namespace: "user_a",
      threadId: "t1",
      messages: [
        { role: "user", content: "I like tea" },
        { role: "assistant", content: "  Noted.  " },
        { role: "user", content: "   " },
      ],
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(second).toBe(first);
    expect(await t.query(api.host.count, { namespace: "user_a" })).toBe(1);
    const remote = fake.namespaces.get("user_a")!;
    expect([...remote.keys()]).toEqual(["thread_t1"]);
    // Blank messages are dropped and the rest are trimmed.
    expect(remote.get("thread_t1")!.content).toBe(
      "user: I like tea\n\nassistant: Noted.",
    );
  });

  test("a thread with no text is rejected, not sent", async () => {
    const fake = installFakeSupermemory();
    const t = createTest();
    await expect(
      t.mutation(api.host.saveThread, {
        namespace: "user_a",
        threadId: "t1",
        messages: [{ role: "user", content: "  " }],
      }),
    ).rejects.toThrow(/empty/);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("memoryContext", () => {
  test("returns null when nothing is known", async () => {
    installFakeSupermemory();
    const t = createTest();
    expect(
      await t.action(api.host.context, { namespace: "user_a", query: "tea" }),
    ).toBeNull();
  });

  test("builds one system message, without repeating profile facts", async () => {
    const fake = installFakeSupermemory();
    const t = createTest();
    await t.mutation(api.host.saveThread, {
      namespace: "user_a",
      threadId: "t1",
      messages: [{ role: "user", content: "I like tea" }],
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const withQuery = await t.action(api.host.context, {
      namespace: "user_a",
      query: "tea",
    });
    expect(withQuery).toEqual({
      role: "system",
      content: "What you know about the user:\n- user: I like tea",
    });
    const search = fake.calls.find((c) => c.path.endsWith("/search"));
    expect(search?.body.searchMode).toBe("memories");

    // No query: profile only, no search call.
    const before = fake.calls.filter((c) => c.path.endsWith("/search")).length;
    await t.action(api.host.context, { namespace: "user_a" });
    expect(fake.calls.filter((c) => c.path.endsWith("/search"))).toHaveLength(
      before,
    );
  });
});
