import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAction, useConvexAuth, useMutation, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { ConvexError } from "convex/values";
import { api } from "../convex/_generated/api";

const REPO_URL = "https://github.com/waynesutton/convex-supermemory";
const NPM_URL = "https://www.npmjs.com/package/@waynesutton/convex-supermemory";

type Status = NonNullable<ReturnType<typeof useStatus>>;
const useStatus = () => useQuery(api.demo.status, {});

function errorMessage(error: unknown) {
  if (error instanceof ConvexError) {
    const data = error.data as { message?: string } | string;
    return typeof data === "string"
      ? data
      : (data.message ?? "Something went wrong.");
  }
  return "Something went wrong. Try again.";
}

export default function App() {
  const status = useStatus();
  const { isAuthenticated, isLoading } = useConvexAuth();

  return (
    <div className="page">
      <Header />
      <ResetNotice status={status} />
      <main>
        {isLoading || status === undefined ? (
          <p className="muted" role="status">
            Loading…
          </p>
        ) : isAuthenticated ? (
          <Workspace status={status} />
        ) : (
          <StartCard />
        )}
      </main>
      <HowItWorks />
      <Footer />
    </div>
  );
}

function Header() {
  return (
    <header className="header">
      <p className="eyebrow">Community Convex component</p>
      <h1>Supermemory Convex component demo app</h1>
      <p className="lede">
        Add a note. Watch Supermemory process it. Then search it and see the
        profile it builds, all through a Convex component.
      </p>
      <p className="byline">
        Built by Wayne Sutton.{" "}
        <a href={REPO_URL} target="_blank" rel="noreferrer">
          Source on GitHub
        </a>
        {" · "}
        <a href={NPM_URL} target="_blank" rel="noreferrer">
          npm package
        </a>
        {" · "}
        <a href="https://supermemory.ai" target="_blank" rel="noreferrer">
          Supermemory
        </a>
        {" · "}
        <a
          href="https://www.convex.dev/components"
          target="_blank"
          rel="noreferrer"
        >
          Convex components
        </a>
      </p>
    </header>
  );
}

function useCountdown(target: number | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!target) return null;
  const left = Math.max(0, target - now);
  const m = Math.floor(left / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function ResetNotice({ status }: { status: Status | undefined }) {
  const countdown = useCountdown(status?.nextResetAt);
  return (
    <section className="notice" aria-label="Data reset notice">
      <p>
        <strong>Demo data resets every hour.</strong> A scheduled cleanup
        removes it from Convex and Supermemory. Don&rsquo;t enter sensitive
        information.
      </p>
      {countdown && (
        <p className="countdown" aria-live="off">
          Next reset in <span className="mono">{countdown}</span>
        </p>
      )}
      {status?.paused && (
        <p className="warn" role="status">
          The demo is paused right now. You can still delete your notes.
        </p>
      )}
    </section>
  );
}

declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement,
        opts: {
          sitekey: string;
          callback: (token: string) => void;
          "expired-callback"?: () => void;
          "error-callback"?: () => void;
        },
      ) => string;
      reset: (id?: string) => void;
      remove: (id: string) => void;
    };
  }
}

function StartCard() {
  const { signIn } = useAuthActions();
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;

  useEffect(() => {
    if (!siteKey) return;
    // The script loads async; poll briefly until it's there.
    const timer = setInterval(() => {
      if (!window.turnstile || !box.current || widget.current) return;
      widget.current = window.turnstile.render(box.current, {
        sitekey: siteKey,
        callback: (t) => setToken(t),
        "expired-callback": () => setToken(null),
        "error-callback": () =>
          setError("The human check didn't load. Refresh to retry."),
      });
      clearInterval(timer);
    }, 200);
    return () => {
      clearInterval(timer);
      if (widget.current) window.turnstile?.remove(widget.current);
      widget.current = null;
    };
  }, [siteKey]);

  async function start() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await signIn("anonymous", { turnstileToken: token });
    } catch {
      setError("Couldn't start the demo. Complete the check again.");
      setToken(null);
      if (widget.current) window.turnstile?.reset(widget.current);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card start">
      <h2>Try it without an account</h2>
      <p>
        You get a private, anonymous session. No email, no password. Pass the
        quick human check and you&rsquo;re in.
      </p>
      {siteKey ? (
        <div ref={box} className="turnstile" />
      ) : (
        <p className="warn">VITE_TURNSTILE_SITE_KEY is not set.</p>
      )}
      <button className="primary" onClick={start} disabled={!token || busy}>
        {busy ? "Starting…" : "Try the demo"}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function Workspace({ status }: { status: Status }) {
  const { signOut } = useAuthActions();
  return (
    <>
      <div className="quota" role="status">
        {status.remaining && (
          <span>
            {status.remaining.adds} of {status.limits.addsPerHour} adds and{" "}
            {status.remaining.reads} of {status.limits.readsPerHour} searches
            left this hour
          </span>
        )}
        <button className="link" onClick={() => void signOut()}>
          End session
        </button>
      </div>
      <div className="grid">
        <AddNote status={status} />
        <Notes status={status} />
        {/* Keyed on the generation so results vanish when the hour resets. */}
        <SearchPanel key={`s${status.generation}`} paused={status.paused} />
        <ProfilePanel key={`p${status.generation}`} paused={status.paused} />
      </div>
    </>
  );
}

function AddNote({ status }: { status: Status }) {
  const addNote = useMutation(api.demo.addNote);
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const max = status.limits.maxCharacters;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await addNote({ content, requestId: crypto.randomUUID() });
      setContent("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Add a note</h2>
      <form onSubmit={submit}>
        <label htmlFor="note" className="sr-only">
          Note
        </label>
        <textarea
          id="note"
          value={content}
          maxLength={max}
          rows={5}
          placeholder="I'm building a habit tracker in React. I prefer short meetings before 10am."
          onChange={(e) => setContent(e.target.value)}
        />
        <div className="row">
          <span className="muted small">
            {content.length} / {max}
          </span>
          <button
            className="primary"
            type="submit"
            disabled={busy || status.paused || content.trim().length === 0}
          >
            {busy ? "Adding…" : "Add note"}
          </button>
        </div>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

const STATUS_LABEL: Record<string, string> = {
  pending: "Sending",
  queued: "Queued",
  extracting: "Extracting",
  chunking: "Chunking",
  embedding: "Embedding",
  indexing: "Indexing",
  done: "Ready",
  failed: "Failed",
  deleting: "Deleting",
};

function Notes({ status }: { status: Status }) {
  const docs = useQuery(api.demo.myDocuments, {});
  const removeNote = useMutation(api.demo.removeNote);
  const clearMyData = useMutation(api.demo.clearMyData);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <section className="card">
      <div className="row">
        <h2>
          Your notes{" "}
          <span className="muted small">
            {docs?.length ?? 0} / {status.limits.documentsPerVisitor}
          </span>
        </h2>
        {docs && docs.length > 0 && !confirming && (
          <button className="link danger" onClick={() => setConfirming(true)}>
            Clear my data
          </button>
        )}
      </div>
      {confirming && (
        <div
          className="confirm"
          role="alertdialog"
          aria-label="Confirm clearing data"
        >
          <p>Delete all your notes from Convex and Supermemory?</p>
          <div className="row">
            <button className="link" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button
              className="danger-btn"
              onClick={() =>
                void run(clearMyData).then(() => setConfirming(false))
              }
            >
              Delete everything
            </button>
          </div>
        </div>
      )}
      {docs === undefined ? (
        <p className="muted">Loading…</p>
      ) : docs.length === 0 ? (
        <p className="muted">
          No notes yet. Add one to see it move through processing.
        </p>
      ) : (
        <ul className="notes">
          {docs.map((doc) => (
            <li key={doc.id}>
              <div className="row">
                <span className={`pill ${doc.status}`}>
                  {STATUS_LABEL[doc.status]}
                </span>
                <button
                  className="link danger"
                  aria-label="Delete note"
                  onClick={() =>
                    void run(() => removeNote({ documentId: doc.id }))
                  }
                >
                  Delete
                </button>
              </div>
              {doc.title && <p className="note-title">{doc.title}</p>}
              <p className="note-body">{doc.content}</p>
              {doc.error && <p className="error small">{doc.error}</p>}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

type SearchResult = Awaited<
  ReturnType<ReturnType<typeof useAction<typeof api.demo.search>>>
>;

function SearchPanel({ paused }: { paused: boolean }) {
  const search = useAction(api.demo.search);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResult(await search({ query }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Search your memory</h2>
      <form onSubmit={submit} className="row">
        <label htmlFor="q" className="sr-only">
          Search
        </label>
        <input
          id="q"
          value={query}
          maxLength={500}
          placeholder="When do I like meetings?"
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="primary" disabled={busy || paused || !query.trim()}>
          {busy ? "Searching…" : "Search"}
        </button>
      </form>
      {result &&
        (result.results.length === 0 ? (
          <p className="muted">
            Nothing yet. Notes are searchable once they show Ready.
          </p>
        ) : (
          <ul className="results">
            {result.results.map((r) => (
              <li key={r.id}>
                <p>{r.memory ?? r.chunk}</p>
                <p className="muted small">
                  {r.memory ? "Memory" : "Source chunk"} · match{" "}
                  {Math.round(r.similarity * 100)}%
                </p>
              </li>
            ))}
            <li className="muted small">
              Took {Math.round(result.searchTime)} ms
            </li>
          </ul>
        ))}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

type Profile = Awaited<
  ReturnType<ReturnType<typeof useAction<typeof api.demo.profile>>>
>;

function ProfilePanel({ paused }: { paused: boolean }) {
  const getProfile = useAction(api.demo.profile);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      setProfile(await getProfile({}));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const empty =
    profile && profile.static.length === 0 && profile.dynamic.length === 0;

  return (
    <section className="card">
      <div className="row">
        <h2>Your profile</h2>
        <button
          className="secondary"
          onClick={() => void load()}
          disabled={busy || paused}
        >
          {busy ? "Loading…" : profile ? "Refresh" : "Build profile"}
        </button>
      </div>
      <p className="muted small">
        Supermemory keeps a running summary of what it has learned. Counts
        toward your search quota.
      </p>
      {empty && (
        <p className="muted">
          Nothing learned yet. Memories can take a minute or two after a note
          shows Ready.
        </p>
      )}
      {profile && !empty && (
        <div className="profile">
          <ProfileList title="Stable facts" items={profile.static} />
          <ProfileList title="Recent context" items={profile.dynamic} />
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function ProfileList({
  title,
  items,
}: {
  title: string;
  items: { id: string; memory: string }[];
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <h3>{title}</h3>
      <ul>
        {items.map((i) => (
          <li key={i.id}>{i.memory}</li>
        ))}
      </ul>
    </div>
  );
}

function HowItWorks() {
  return (
    <section className="how" aria-label="How this demo works">
      <h2>How it works</h2>
      <ol>
        <li>
          <strong>Add.</strong> A Convex mutation checks your quota, then the
          component queues the note and sends it to Supermemory in a scheduled
          action.
        </li>
        <li>
          <strong>Track.</strong> The component polls Supermemory with backoff
          and writes each status change to its own table. This page updates
          reactively.
        </li>
        <li>
          <strong>Recall.</strong> Search and profile calls go through the
          component to Supermemory, scoped to a namespace the server derives
          from your session.
        </li>
        <li>
          <strong>Reset.</strong> A Convex cron runs at the top of every hour.
          It moves everyone to fresh namespaces and deletes the old ones from
          both systems, retrying until Supermemory confirms.
        </li>
      </ol>
      <pre className="code">
        <code>{`const supermemory = new Supermemory(components.supermemory);

await supermemory.add(ctx, { namespace, content });
const { results } = await supermemory.search(ctx, { namespace, query });`}</code>
      </pre>
    </section>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <p>
        Supermemory Convex component demo app. A community project by Wayne
        Sutton, not an official Convex or Supermemory product.{" "}
        <a href={REPO_URL} target="_blank" rel="noreferrer">
          MIT licensed on GitHub
        </a>
        .
      </p>
    </footer>
  );
}
