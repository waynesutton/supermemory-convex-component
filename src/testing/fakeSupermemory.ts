// An in-memory stand-in for the Supermemory API, installed as global fetch.
// Only the endpoints the component uses are implemented.
import { vi } from "vitest";

type FakeDoc = {
  id: string;
  content: string;
  status: string;
  metadata: Record<string, unknown>;
};

export type FakeCall = { method: string; path: string; body?: any };

export function installFakeSupermemory() {
  const namespaces = new Map<string, Map<string, FakeDoc>>();
  const calls: FakeCall[] = [];
  // Queue of forced responses, consumed in order: e.g. [503, 503].
  const failures: number[] = [];
  // Status the next `add` reports, and what later `get`s report.
  const state = { addStatus: "queued", getStatus: "done" };

  const docsIn = (ns: string) => {
    let docs = namespaces.get(ns);
    if (!docs) {
      docs = new Map();
      namespaces.set(ns, docs);
    }
    return docs;
  };

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  const fetchMock = vi.fn(async (input: any, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = decodeURIComponent(url.pathname);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });

    const forced = failures.shift();
    if (forced !== undefined) return json(forced, { error: "forced" });

    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/ns\/([^/]+)\/document$/))) {
      const ns = m[1];
      if (method === "POST") {
        const docs = docsIn(ns);
        const prev = docs.get(body.id);
        docs.set(body.id, {
          id: body.id,
          content: prev ? `${prev.content}\n${body.content}` : body.content,
          status: state.addStatus,
          metadata: body.metadata ?? {},
        });
        return json(200, { id: body.id, status: state.addStatus });
      }
      if (method === "DELETE") {
        const docs = docsIn(ns);
        let count = 0;
        for (const id of body.ids) if (docs.delete(id)) count++;
        return json(200, { count, errors: [] });
      }
    }
    if (
      (m = path.match(/^\/ns\/([^/]+)\/document\/([^/]+)$/)) &&
      method === "GET"
    ) {
      const doc = namespaces.get(m[1])?.get(m[2]);
      if (!doc) return json(404, { error: "not found" });
      doc.status = state.getStatus;
      return json(200, {
        id: doc.id,
        title: "Fake title",
        type: "text",
        summary: "Fake summary",
        content: doc.content,
        metadata: doc.metadata,
        system: {
          status: doc.status,
          dreamingStatus: "done",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });
    }
    if ((m = path.match(/^\/ns\/([^/]+)$/)) && method === "DELETE") {
      if (!namespaces.delete(m[1])) return json(404, { error: "not found" });
      return json(200, { status: "deleted", namespace: m[1] });
    }
    if ((m = path.match(/^\/ns\/([^/]+)\/search$/)) && method === "POST") {
      const docs = [...(namespaces.get(m[1])?.values() ?? [])];
      const q = String(body.query).toLowerCase();
      const results = docs
        .filter((d) => d.content.toLowerCase().includes(q))
        .map((d) => ({
          id: `mem_${d.id}`,
          memory: d.content,
          metadata: d.metadata,
          similarity: 0.9,
          isLatest: true,
          isInference: false,
          system: {},
        }));
      return json(200, { results, searchTime: 12 });
    }
    if ((m = path.match(/^\/ns\/([^/]+)\/profile$/)) && method === "POST") {
      const docs = [...(namespaces.get(m[1])?.values() ?? [])];
      return json(200, {
        profile: {
          static: docs.map((d) => ({ id: `p_${d.id}`, memory: d.content })),
          dynamic: [],
          buckets: {},
        },
      });
    }
    return json(404, { error: `no fake for ${method} ${path}` });
  });

  vi.stubGlobal("fetch", fetchMock);
  return { namespaces, calls, failures, state, fetchMock };
}
