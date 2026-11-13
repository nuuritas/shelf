# Shelf

Your own private reading archive for X, LinkedIn, YouTube and any web page, on
your own Cloudflare account. Paste or share a link and it keeps the text, the
quote, the full article, the images and the links, then writes a plain-language
summary and files it into a folder. One Worker, one SQLite Durable Object, server-rendered
HTML, no build step, no database to manage. The free plan is enough for personal
use.

## Install it with your AI

Nobody installs this by hand, so don't. Paste this into Claude Code, Codex,
Cursor, or any agent that can run commands:

```text
Set up Shelf for me: https://github.com/nuuritas/shelf

Read https://raw.githubusercontent.com/nuuritas/shelf/main/INSTALL.md
and follow it exactly.

Ask me three things first:
1. Which AI provider should write the summaries? Cloudflare needs no key and is
   fine to start with.
2. A custom domain, or the free workers.dev URL?
3. Build the Android share APK too?

Never commit .dev.vars, the keystore, or the APK. If a step needs a paid plan,
stop and ask me.

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
  OpenAI-compatible model, or Anthropic; images, articles and video transcripts
  are part of the input.
- **Organize itself** — topics induced from what you actually save, a library
  that still opens on every save, an optional folder view where each topic opens
  like a folder, per-topic syntheses, full-text search, a calendar, archive and
  restore.
- **Tune it** — a Settings page (web and the Android app) for the summary
  prompt, language and notifications; new summaries pick up the change without
  a redeploy.
- **Get notified** — a browser notification when a summary is ready, and a
  background check in the Android app that posts a system notification.
- **Reach it from AI tools** — a Bun CLI and a stdio MCP server, so Claude Code,
  Codex, or Cursor can search the vault themselves, and `shelf add` lets an agent
  save a finished research note (markdown, or sandboxed HTML) next to your links.

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

- **Android share APK** — a share target that saves in the background, a
  launcher icon that opens the library in the app, and a background check that
  posts a notification when a summary is ready. Built without Gradle. No iOS
  app yet; iOS is planned, and the web app works as a PWA on iPhone until then.
- **CLI and MCP** — `shelf search`, `shelf export`, `shelf mcp`.
- **Custom domain** — a workers.dev URL works; a domain is three lines in
  `wrangler.jsonc`.
- **Transcript services** — `SUPADATA_API_KEY`, `TRANSCRIPT_API_URL`, or your own
  Piped instance. Details in [INSTALL.md](INSTALL.md#transcripts-optional).

## Docs

- [INSTALL.md](INSTALL.md) — the install checklist, for humans and agents.
- [docs/PROGRESS.md](docs/PROGRESS.md) — architecture, API routes, measured
  usage, traps.
- [AGENTS.md](AGENTS.md) — rules for coding agents changing the code.
- [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md).

There is no hosted demo: every deployment is password-gated, so a public URL
would only show a login page.

## License

MIT — see [LICENSE](LICENSE).
