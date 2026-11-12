# Convex components directory submission

Draft materials. Nothing here has been submitted.

## Listing

- **Name:** Supermemory
- **Package:** `@waynesutton/convex-supermemory`
- **Repo:** https://github.com/waynesutton/supermemory-convex-component 
- **Author:** Wayne Sutton (community component)
- **License:** MIT
- **Category:** AI

**One line:** Long-term memory for AI apps. Add from a mutation, track
processing reactively, search and read profiles from actions.

**Short description:**

Supermemory turns notes, chats and URLs into memories you can search. This
component wraps it for Convex. `add` runs in a mutation and a scheduled action
does the HTTP call, so writes commit with your transaction. Status lands in a
component table, so your UI updates as Supermemory processes. Retries check
whether the last attempt already landed before resending, and deletes keep a
record until Supermemory confirms them.

## Checklist

- [x] Built from the official component template
- [x] `convex.config.js`, `_generated/component.js` and `test` entry points
      exported
- [x] Component and demo tests pass (`npm test`)
- [x] Typecheck and lint clean
- [x] README section between the directory include markers
- [x] Example app that installs the bundled package
- [x] Live smoke test against Supermemory (add, process, search, delete, hourly reset)
- [x] Repo created on Wayne's GitHub and pushed
- [ ] Published to npm
- [x] Demo hosted at https://whimsical-buzzard-500.convex.site
- [ ] Production Turnstile keys set
- [ ] Screenshots from the hosted demo
- [ ] Submitted at https://www.convex.dev/components

## Launch post draft

> Built a Supermemory component for Convex.
>
> Add memories from a mutation. Watch them process in a reactive query. Search
> from an action.
>
> Retries check before they resend, deletes retry until Supermemory confirms,
> and the demo resets every hour.
>
> npm i @waynesutton/convex-supermemory
