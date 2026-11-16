# Shelf

Shelf is a self-hosted reading archive for X, LinkedIn, YouTube and any web
page, running entirely on your own Cloudflare account. Paste or share a link and
it keeps the text, the quote, the full article, the images and the links, then
writes a plain-language summary and files it into a folder. One Worker, one
SQLite Durable Object, server-rendered HTML, no build step, no database to
manage. The free plan is enough for personal use.

It is open source under the MIT licence and built for one reader: one password,
one library, no accounts, no telemetry. Everything it keeps stays in your own
Cloudflare account; nothing is sent to a third-party service.

## Status

Shelf is actively developed. `main` is the default branch and stays deployable;
open pull requests against `main`.

## Install it with your AI

Nobody installs this by hand, so don't. Paste this into Claude Code, Codex,
Cursor, or any agent that can run commands:

```text
Set up Shelf for me: https://github.com/nuuritas/shelf

Read https://raw.githubusercontent.com/nuuritas/shelf/main/INSTALL.md
and follow it exactly.

Ask me two things first:
1. Which AI provider should write the summaries? Cloudflare needs no key and is
   fine to start with.
2. A custom domain, or the free workers.dev URL?

Never commit .dev.vars. If a step needs a paid plan, stop and ask me.

When the deployment is verified, tell me the app URL, the password, and where
the files are.
```

The agent clones the repo, installs with Bun, runs `bun run setup`, deploys into
your account, then saves one real post and checks that the summary actually
arrived before reporting back. Five minutes, free plan, nothing to configure by
hand.

Prefer to drive it yourself? [INSTALL.md](INSTALL.md) is the same checklist as
commands.

## What it does

- **Save** — paste an X, LinkedIn or YouTube link, use the Android share sheet
  or the PWA share target, or POST to the API.
- **Keep the post properly** — text, author, quoted post, full X articles,
  images, video links and transcripts, and metrics where the platform exposes
  them.
- **Read the links** — GitHub repos through the API, other pages through a
  readability extractor.
- **Summarize** — natural prose from Workers AI with no key, any
  OpenAI-compatible model, or Anthropic; articles and video transcripts are
  part of the input, and images are attached on the OpenAI-compatible and
  Anthropic paths (the keyless Workers AI path reads text only).
- **Organize itself** — topics induced from what you actually save, a library
  that still opens on every save, an optional folder view where each topic opens
  like a folder, per-topic syntheses, full-text search, a calendar, archive and
  restore.
- **Tag it yourself** — labels you type on a post (up to twelve), a filter row
  across the library, and `?label=reading` or `GET /api/labels` for scripts and
  the CLI. A label is not a folder: the same save can carry several, and the AI
  never writes one.
- **Tune it** — a Settings page (web and the Android app) for the summary
  prompt, the summary language, notifications, and the theme and text size of
  this browser; new summaries pick up the prompt and language without a
  redeploy.
- **Get notified** — a browser notification when a summary is ready, and a
  background check in the Android app that posts a system notification.
- **Reach it from AI tools** — a Bun CLI and a stdio MCP server, so Claude Code,
  Codex, or Cursor can search the vault themselves (by label too). `shelf add`
  lets an agent save a finished research note (markdown, or sandboxed HTML) next
  to your links, tagged with `--label`. The authoring contract is in
  [docs/AGENT-POSTS.md](docs/AGENT-POSTS.md), also available as `shelf guide` and
  the MCP `get_authoring_guide` tool.

## What it costs

Nothing, for a personal archive:

- Worker and Durable Object: comfortably inside the free plan.
- Summaries: 10,000 Workers AI neurons per day, no signup, about 15–20 complete
  bookmarks; reset at 00:00 UTC. Or bring a provider key.
- YouTube captions: free through public Piped instances, no key. Supadata's 100
  monthly credits are the optional fallback.
- Notifications: browser Web Push and the Android background check need no push
  account, no Firebase and no paid service.
- Posts: X links go through FxTwitter's public API with no X subscription;
  LinkedIn links are read from the public guest page, no login.

## Optional pieces

- **Mobile apps** — an Android share target that saves in the background and
  posts a notification when a summary is ready, and an iOS app with a share
  extension. Both are dual-mode: enter your Worker URL and password, or sign in
  to Shelf Cloud. They are published as a signed build, so there is nothing to
  compile here. The client source is **private** and lives with the hosted
  service; it is not published for reuse. The web app still works as a PWA on
  both platforms.
- **CLI and MCP** — `shelf search`, `shelf export`, `shelf mcp`.
- **Custom domain** — a workers.dev URL works; a domain is one key in
  `cloudflare.personal.json`.
- **Transcript services** — `SUPADATA_API_KEY`, `TRANSCRIPT_API_URL`, or your own
  Piped instance. Details in [INSTALL.md](INSTALL.md#transcripts-optional).

## Docs

- [INSTALL.md](INSTALL.md) — the install checklist, for humans and agents.
- [docs/PROGRESS.md](docs/PROGRESS.md) — architecture, API routes, measured
  usage, traps.
- [docs/DESIGN.md](docs/DESIGN.md) — the design system: tokens, type, mark, layout.
- [docs/AGENT-POSTS.md](docs/AGENT-POSTS.md) — the contract for agents that save
  notes.
- [AGENTS.md](AGENTS.md) — rules for coding agents changing the code.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers
local setup, the checks CI runs, and the code layout; [SECURITY.md](SECURITY.md)
says how to report a vulnerability privately. The repository stays actively
developed, and `main` is always the deployable branch.

There is no hosted demo: every deployment is password-gated, so a public URL
would only show a login page.

## License

MIT — see [LICENSE](LICENSE).
