# Contributing

Small, readable changes are easier to review than large ones. If you are unsure
whether something is in scope, open an issue first.

## Setup

```bash
bun install
cp .dev.vars.example .dev.vars     # set APP_PASSWORD
bunx wrangler dev                  # http://localhost:8787
```

AI features need an OpenAI-compatible key in `AI_API_KEY`; without it the app
still saves and renders bookmarks.

## Before you open a pull request

```bash
bun run typecheck
node --test
```

Both must pass. CI runs the same commands plus a `wrangler deploy --dry-run`, so
a red check usually means one of those three failed locally too.

If you changed markup or CSS, load a page with a session cookie and look at it.
There is no build step and no framework: HTML is a template string in
`src/render.ts`.

## How the code fits together

`src/worker.ts` handles routing, auth, and responses. `src/bookmarks-do.ts` owns
the SQLite schema, queries, and the background alarm queue. Read
[AGENTS.md](AGENTS.md) before touching the Durable Object or the AI layer — it
lists the traps that have already cost time (duplicate storage types hanging
`tsc`, the CSS version bump, idempotent schema changes).

## Pull requests

- One concern per PR, with a short description of the behaviour change and how
  you verified it.
- Imperative commit subjects, for example `Fix calendar day links`.
- Do not commit `.dev.vars`, `.wrangler/`, or `out/`. The mobile apps and their
  signing material live in `nuuritas/shelf-cloud/apps`, not here.
- New behaviour that a user can see should come with a test where the code is
  testable outside the Worker, or a clear manual check in the PR body.

## Adding an AI provider

The code only needs `POST /chat/completions`. Set `AI_BASE_URL` and `AI_MODEL`
in `wrangler.jsonc` (or as Wrangler vars) and the API key as `AI_API_KEY`. The
model should accept image parts if you want summaries that understand images.

## Reporting bugs

Include the Worker log line when you can (`bunx wrangler tail`), the URL shape
that triggered it, and what you expected. For X reading failures, note whether
the post is protected, deleted, or an article — those have different paths.
