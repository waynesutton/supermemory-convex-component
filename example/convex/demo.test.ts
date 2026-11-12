/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import supermemoryTest from "@waynesutton/convex-supermemory/test";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { installFakeSupermemory } from "../../src/testing/fakeSupermemory";

const modules = import.meta.glob("./**/*.*s");

function setup() {
  const t = convexTest(schema, modules);
  supermemoryTest.register(t, "supermemory");
  rateLimiterTest.register(t, "rateLimiter");
  const fake = installFakeSupermemory();
  return { t, fake };
}

type T = ReturnType<typeof setup>["t"];

async function visitor(t: T) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { isAnonymous: true }),
  );
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 3_600_000,
    }),
  );
  return { userId, as: t.withIdentity({ subject: `${userId}|${sessionId}` }) };
}

const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);
let n = 0;
const note = (as: Awaited<ReturnType<typeof visitor>>["as"], content: string) =>
  as.mutation(api.demo.addNote, { content, requestId: `r${n++}` });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-12T10:15:00Z"));
  process.env.SUPERMEMORY_API_KEY = "sm_test_key";
  process.env.DEMO_DAILY_PROVIDER_CALLS = "500";
  delete process.env.DEMO_PAUSED;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("demo access", () => {
  test("signed-out callers are rejected", async () => {
    const { t } = setup();
    await expect(
      t.mutation(api.demo.addNote, { content: "hi", requestId: "x" }),
    ).rejects.toThrow(/Start the demo/);
    await expect(t.action(api.demo.search, { query: "hi" })).rejects.toThrow(
      /Start the demo/,
    );
    expect(await t.query(api.demo.myDocuments, {})).toEqual([]);
  });

  test("visitors only see their own notes and search results", async () => {
    const { t } = setup();
    const a = await visitor(t);
    const b = await visitor(t);
    await note(a.as, "Alice likes green tea");
    await drain(t);
    expect(await a.as.query(api.demo.myDocuments, {})).toHaveLength(1);
    expect(await b.as.query(api.demo.myDocuments, {})).toHaveLength(0);
    expect(
      (await a.as.action(api.demo.search, { query: "tea" })).results,
    ).toHaveLength(1);
    expect(
      (await b.as.action(api.demo.search, { query: "tea" })).results,
    ).toHaveLength(0);
  });

  test("a document id from another visitor can't be deleted", async () => {
    const { t, fake } = setup();
    const a = await visitor(t);
    const b = await visitor(t);
    const id = await note(a.as, "mine");
    await drain(t);
    expect(await b.as.mutation(api.demo.removeNote, { documentId: id })).toBe(
      false,
    );
    expect(await a.as.query(api.demo.myDocuments, {})).toHaveLength(1);
    expect([...fake.namespaces.values()].reduce((s, m) => s + m.size, 0)).toBe(
      1,
    );
  });
});

describe("demo limits", () => {
  test("note length and empty notes", async () => {
    const { t } = setup();
    const a = await visitor(t);
    await expect(note(a.as, "   ")).rejects.toThrow(/Write something/);
    await expect(note(a.as, "x".repeat(5_001))).rejects.toThrow(
      /5000 characters/,
    );
  });

  test("one note in flight at a time, and a repeat click is deduplicated", async () => {
    const { t } = setup();
    const a = await visitor(t);
    const first = await a.as.mutation(api.demo.addNote, {
      content: "one",
      requestId: "same",
    });
    const again = await a.as.mutation(api.demo.addNote, {
      content: "one",
      requestId: "same",
    });
    expect(again).toBe(first);
    await expect(note(a.as, "two")).rejects.toThrow(/still processing/);
  });

  test("five notes kept at a time", async () => {
    const { t } = setup();
    const a = await visitor(t);
    for (let i = 0; i < 5; i++) {
      await note(a.as, `note ${i}`);
      await drain(t);
    }
    await expect(note(a.as, "sixth")).rejects.toThrow(/5 notes at a time/);
  });

  test("five adds per hour survive deleting notes", async () => {
    const { t } = setup();
    const a = await visitor(t);
    for (let i = 0; i < 5; i++) {
      const id = await note(a.as, `note ${i}`);
      await drain(t);
      await a.as.mutation(api.demo.removeNote, { documentId: id });
      await drain(t);
    }
    await expect(note(a.as, "sixth")).rejects.toThrow(/5 notes this hour/);
  });

  test("twenty searches and profiles per hour, combined", async () => {
    const { t } = setup();
    const a = await visitor(t);
    for (let i = 0; i < 10; i++)
      await a.as.action(api.demo.search, { query: "x" });
    for (let i = 0; i < 10; i++) await a.as.action(api.demo.profile, {});
    await expect(a.as.action(api.demo.search, { query: "x" })).rejects.toThrow(
      /20 searches/,
    );
  });

  test("parallel searches can't exceed the quota", async () => {
    const { t, fake } = setup();
    const a = await visitor(t);
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, () =>
        a.as.action(api.demo.search, { query: "x" }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(20);
    expect(fake.calls.filter((c) => c.path.endsWith("/search"))).toHaveLength(
      20,
    );
  });

  test("the global daily budget stops every visitor", async () => {
    const { t } = setup();
    process.env.DEMO_DAILY_PROVIDER_CALLS = "3";
    const a = await visitor(t);
    const b = await visitor(t);
    await a.as.action(api.demo.search, { query: "x" });
    await b.as.action(api.demo.search, { query: "x" });
    await a.as.action(api.demo.search, { query: "x" });
    await expect(b.as.action(api.demo.search, { query: "x" })).rejects.toThrow(
      /allowance/,
    );
    // An add reserves its worst case, so it can't fit either.
    await expect(note(b.as, "hi")).rejects.toThrow(/allowance/);
  });

  test("the pause switch stops paid calls but not deletes", async () => {
    const { t } = setup();
    const a = await visitor(t);
    const id = await note(a.as, "before pause");
    await drain(t);
    process.env.DEMO_PAUSED = "true";
    await expect(note(a.as, "x")).rejects.toThrow(/paused/);
    await expect(a.as.action(api.demo.search, { query: "x" })).rejects.toThrow(
      /paused/,
    );
    expect(await a.as.mutation(api.demo.removeNote, { documentId: id })).toBe(
      true,
    );
    expect((await t.query(api.demo.status, {})).paused).toBe(true);
  });
});

describe("hourly reset", () => {
  test("clears content here and in Supermemory, keeps quotas", async () => {
    const { t, fake } = setup();
    const a = await visitor(t);
    for (let i = 0; i < 3; i++) {
      await note(a.as, `note ${i}`);
      await drain(t);
    }
    expect(fake.namespaces.size).toBe(1);
    const before = await a.as.query(api.demo.status, {});
    expect(before.remaining?.adds).toBe(2);
    expect(before.nextResetAt).toBe(Date.parse("2026-11-12T11:00:00Z"));

    await t.mutation(internal.demo.reset, {});
    // Old notes vanish from the UI the moment the generation changes.
    expect(await a.as.query(api.demo.myDocuments, {})).toEqual([]);
    // Checked before draining: draining advances fake time, and the hourly
    // window may legitimately refill.
    const after = await a.as.query(api.demo.status, {});
    expect(after.generation).toBe(before.generation + 1);
    expect(after.remaining?.adds).toBe(2);

    await drain(t);
    expect(fake.namespaces.size).toBe(0);

    // Bookkeeping goes once Supermemory has confirmed.
    await t.mutation(internal.demo.finalizeCleanup, {});
    const left = await t.run((ctx) => ctx.db.query("demoNamespaces").collect());
    expect(left).toEqual([]);
  });

  test("running the reset twice is harmless", async () => {
    const { t, fake } = setup();
    const a = await visitor(t);
    await note(a.as, "x");
    await drain(t);
    await t.mutation(internal.demo.reset, {});
    await t.mutation(internal.demo.reset, {});
    await drain(t);
    expect(fake.namespaces.size).toBe(0);
  });

  test("a note still ingesting at reset time doesn't come back", async () => {
    const { t, fake } = setup();
    const a = await visitor(t);
    await note(a.as, "in flight");
    // Reset before the scheduled ingest has run.
    await t.mutation(internal.demo.reset, {});
    await drain(t);
    const remaining = [...fake.namespaces.values()].reduce(
      (s, m) => s + m.size,
      0,
    );
    expect(remaining).toBe(0);
  });

  test("failed remote cleanup is kept and retried", async () => {
    const { t, fake } = setup();
    const a = await visitor(t);
    await note(a.as, "sticky");
    await drain(t);
    for (let i = 0; i < 8; i++) fake.failures.push(503);
    await t.mutation(internal.demo.reset, {});
    await drain(t);
    const report = await t.query(internal.demo.cleanupReport, {});
    expect(report.failed).toHaveLength(1);
    expect(report.awaitingConfirmation).toBe(1);

    // Next hour's run retries it.
    await t.mutation(internal.demo.finalizeCleanup, {});
    await drain(t);
    await t.mutation(internal.demo.finalizeCleanup, {});
    expect(fake.namespaces.size).toBe(0);
    expect(
      (await t.query(internal.demo.cleanupReport, {})).awaitingConfirmation,
    ).toBe(0);
  });

  test("clear my data empties the namespace without refunding adds", async () => {
    const { t, fake } = setup();
    const a = await visitor(t);
    await note(a.as, "one");
    await drain(t);
    await a.as.mutation(api.demo.clearMyData, {});
    expect(await a.as.query(api.demo.myDocuments, {})).toEqual([]);
    await drain(t);
    expect(fake.namespaces.size).toBe(0);
    expect((await a.as.query(api.demo.status, {})).remaining?.adds).toBe(4);
    await note(a.as, "fresh start");
  });
});
