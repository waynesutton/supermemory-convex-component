# Demo app

The demo lives in `example/`. It's titled **Supermemory Convex component demo
app** and is meant to run in public without a sign-up form, so most of its code
is about keeping that safe and cheap.

## How a visit works

1. The visitor passes a Cloudflare Turnstile check and clicks **Try the demo**.
2. `convex/auth.ts` verifies the token with Cloudflare, then creates a Convex
   Auth anonymous account. It's the stock `Anonymous` provider code with the
   Turnstile check added, because `Anonymous`'s `profile` hook can't await.
3. Every function derives the namespace from the session:
   `smdemo_g{generation}_{userId}_e{epoch}`. The browser never sends one.
4. Notes go through `addNote`, which checks limits, reserves budget, and calls
   the component.

## Limits

All enforced on the server in mutations, so parallel requests can't slip past
them. Direct calls to the backend get the same checks as the UI.

| Protection               | Value                             | Where                             |
| ------------------------ | --------------------------------- | --------------------------------- |
| Notes kept at once       | 5 per visitor                     | `LIMITS.documentsPerVisitor`      |
| Note length              | 5,000 characters                  | `LIMITS.maxCharacters`            |
| Adds                     | 5 per visitor per hour            | rate limiter `add`                |
| Searches and profiles    | 20 per visitor per hour, combined | rate limiter `read`               |
| Deletes and clears       | 20 per visitor per hour           | rate limiter `remove`             |
| Notes processing at once | 1 per visitor                     | `addNote` in-flight check         |
| Supermemory calls        | 500 per UTC day across everyone   | `DEMO_DAILY_PROVIDER_CALLS`       |
| Emergency stop           | `DEMO_PAUSED=true`                | stops adds, searches and profiles |

Each add reserves its worst case up front: 5 calls for ingest retries plus 6
status checks, 11 in all. That's about 45 adds a day at the default budget,
before any searches. Raise `DEMO_DAILY_PROVIDER_CALLS` if you want more. The cap
counts calls, not dollars.

Deletes never draw on the daily budget, and they still work while paused.
Cleanup must always be able to run.

Anonymous visitors can start new sessions, so per-visitor limits alone don't
bound cost. The daily budget does. Turnstile makes each new session cost a human
check.

## Hourly reset

A Convex cron runs `demo.reset` at minute 0 of every UTC hour.

1. It bumps the generation. Every visitor's namespace changes, so their notes,
   search results and profile disappear from the page at once.
2. `cleanupBatch` asks the component to delete each old namespace, 20 at a time,
   10 seconds apart.
3. The component deletes local rows, then the Supermemory namespace, retrying up
   to 8 times.
4. `finalizeCleanup` drops bookkeeping once Supermemory confirms, and retries
   anything that ran out of attempts. It runs every hour.

Accounts, sessions, rate limits and the daily budget are untouched, so a reset
doesn't hand out fresh quota. A note still ingesting during the reset is caught
when its result lands and deleted.

Cleanup only touches namespaces in `demoNamespaces`, which the app writes before
its first add to each one. It can't delete anything else in the Supermemory
account.

The page shows the countdown and this notice: "Demo data resets every hour. A
scheduled cleanup removes it from Convex and Supermemory. Don't enter sensitive
information."

## Operator view

From the Convex dashboard, run `demo:cleanupReport` for namespaces awaiting
confirmation and any deletes that failed.

## Hosting

Live at https://whimsical-buzzard-500.convex.site, on the `supermemory-convex-component` project in Wayne's personal Convex team.

The frontend is served by [`@convex-dev/static-hosting`](https://www.npmjs.com/package/@convex-dev/static-hosting) from the same deployment. `example/convex/http.ts` registers the Convex Auth routes first and the static catch-all after, so auth URLs stay at the root.

```sh
npm run deploy:demo   # convex deploy, then build example/ and upload example/dist
```

The Turnstile site key is public and lives in `.env.production`. The secret is only on the deployment.

The package's own build also writes to `dist/`, so the demo always builds to `example/dist`.

## Production checklist

- [ ] Real Turnstile site key in `VITE_TURNSTILE_SITE_KEY` and secret in
      `TURNSTILE_SECRET_KEY`
- [x] `TURNSTILE_EXPECTED_HOSTNAME` set to the production hostname
- [x] `SITE_URL` set to the production URL
- [ ] Fresh `JWT_PRIVATE_KEY` and `JWKS` from
      `node scripts/generate-auth-keys.mjs`
- [ ] A Supermemory key used only for this demo, so cleanup and spend are
      isolated
- [ ] `DEMO_DAILY_PROVIDER_CALLS` matched to what you're willing to spend
- [ ] Watch `demo:cleanupReport` after the first few resets
