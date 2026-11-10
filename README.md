# X Bookmark Vault

A tiny, self-hosted reader for your X (Twitter) bookmarks: paste or share a post, and it saves the text, quoted post, article, images, and links, then writes a natural-language explanation of what it says and why it might matter.

Runs entirely on Cloudflare — one Worker, one SQLite-backed Durable Object, server-rendered HTML, no build step, no Docker, no X API subscription. It costs nothing on the free plan for personal use.

Live example: <https://bookmark.nuritas.tr>

## What it does

- **Save** by pasting a link, using the Android share sheet, or calling the API.
- **Read the post properly**: text, author, quoted post, full X Articles, images, video URLs, and metrics.
- **Read the links** in the post: GitHub repos through the API and README, other pages through a readability extractor.
- **Summarize** with any OpenAI-compatible model. Summaries are prose, not a template.
- **Use it as an archive**: topics induced from what you actually save, rolling syntheses per topic, full-text search, a calendar, and archive/restore.
- **Reach it from AI tools**: a Bun CLI and a stdio MCP server, so Claude Code, Codex, or Cursor can search the vault themselves.

## Deploy your own

You need a Cloudflare account and [Bun](https://bun.sh). Nothing else is required — the app runs on the free plan.

### Option A: one command

```bash
git clone https://github.com/nuuritas/x-bookmark-vault.git
cd x-bookmark-vault
bun install
bun run setup
```

`bun run setup` generates a `.dev.vars` with fresh random secrets, uploads them to your Worker, and deploys. It prints the `https://<your-worker>.workers.dev` URL when it finishes. Open it and log in with the `APP_PASSWORD` from `.dev.vars`.

Re-running it is safe: it keeps values that already exist.

If Wrangler is not logged in yet, run `bunx wrangler login` first.

### Option B: manual

```bash
bun install
cp .dev.vars.example .dev.vars     # edit APP_PASSWORD
bunx wrangler secret put APP_PASSWORD
bunx wrangler deploy
```

Then set the optional secrets you want with `secret put`, or in the dashboard under **Settings → Variables and Secrets**.

### Optional: your own domain

A `workers.dev` URL works fine. For a custom domain, add it to `wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "bookmarks.example.com", "custom_domain": true }]
```

The domain must be on the same Cloudflare account. To keep your domain out of git, copy `wrangler.personal.example.jsonc` to `wrangler.personal.jsonc` (gitignored), edit it, and deploy with `bun run deploy:personal`.

## Configuration

Everything is optional except the password.

| Name | Kind | Default | Purpose |
| --- | --- | --- | --- |
| `APP_PASSWORD` | secret | — | **Required.** The single password for the web app and API. |
| `APP_SECRET` | secret | `APP_PASSWORD` | Signs the session cookie. Set it so rotating the password does not invalidate sessions awkwardly. |
| `AI_API_KEY` | secret | — | Key for the OpenAI-compatible endpoint. Without it, saving works and summaries are skipped. |
| `AI_BASE_URL` | var | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint. |
| `AI_MODEL` | var | `gpt-4.1-mini` | Model name at that endpoint. Vision support is needed for image-aware summaries. |
| `SUMMARY_LANGUAGE` | var | `en` | `en` or `tr`. With `tr`, an English translation is also stored per bookmark. |
| `SUPADATA_API_KEY` | secret | — | Enables YouTube captions inside the Worker. |
| `GITHUB_TOKEN` | secret | — | Read-only token; raises GitHub API limits when reading repo links. |
| `X_BEARER_TOKEN` + `X_PROVIDER=official` | secret + var | — | Use the official X API instead of the public FxTwitter reader. |
| `SHARE_TOKEN` | secret | — | Add-only token embedded in the Android share APK. |

`AI_BASE_URL` and `AI_MODEL` live in `wrangler.jsonc`; edit them or override with Wrangler vars. Any endpoint that speaks `POST /chat/completions` works — OpenAI, OpenRouter, a local gateway, or OpenCode Go:

```jsonc
"vars": {
  "AI_BASE_URL": "https://openrouter.ai/api/v1",
  "AI_MODEL": "google/gemini-2.5-flash",
  "SUMMARY_LANGUAGE": "en"
}
```

## Optional pieces

### Android share APK

A share-sheet target that saves the current post in the background and shows a toast. There is no iOS equivalent.

Building it needs the Android SDK build tools (`aapt2`, `d8`, `apksigner`), not Android Studio. Add three values to `.dev.vars`, then build:

```bash
SHARE_TOKEN=<long random value>                       # same value as the Worker secret
SHARE_ENDPOINT=https://<your-worker>.workers.dev/api/bookmarks
KEYSTORE_PASS=<password for the local signing key>
```

```bash
./android/build.sh        # writes public/BookmarkShare.apk
```

A keystore is generated on first build and gitignored. The APK embeds `SHARE_TOKEN`, so build it locally and never commit it.

The web app is also a PWA with a share target, but browsers differ: Chrome installs it as a share target, Brave installs a shortcut that does not appear in the share sheet. The APK is the reliable path.

### CLI and MCP server

`cli/xbv.ts` is dependency-free and talks to the same JSON API:

```bash
ln -sf "$PWD/cli/xbv.ts" ~/.local/bin/xbv
xbv config --url https://<your-worker>.workers.dev --password '<APP_PASSWORD>'
xbv search "postgres indexes"
xbv show k7f3                    # short id printed on every card
xbv export --dir ~/Documents/bookmarks
xbv mcp                          # stdio MCP server for Claude/Codex/Cursor
```

### YouTube transcripts

YouTube refuses caption requests from Cloudflare's IP range, so YouTube is the only part that cannot run in the Worker.

- Free path: `xbv youtube` runs a local extractor on your residential connection, posts the transcript back, and re-queues the summary. Manual or scheduled; nothing else in the app depends on it.
- Managed path: set `SUPADATA_API_KEY` and the Worker fetches native captions itself.

Either way, a missing transcript never blocks saving or summarizing.

## Local development

```bash
cp .dev.vars.example .dev.vars   # set APP_PASSWORD
bunx wrangler dev                # http://localhost:8787
bun run typecheck
node --test
```

## How it works

One Durable Object named `library` holds the SQLite database. `fetch` in the Worker authenticates and routes; background work runs through the DO alarm queue, one unit per pass: summary → new version → English translation → topic bootstrap → filing → stale synthesis. Nothing else needs to run — no cron, no queue, no separate worker.

Longer notes on architecture, API routes, measured usage, and known traps are in [docs/PROGRESS.md](docs/PROGRESS.md). If you are an AI agent working in this repo, read [AGENTS.md](AGENTS.md).

## Know before you deploy

- **Single user.** One password, one library. There are no accounts and no login rate limiting — put Cloudflare Access in front if you want more than a password.
- **`POST /api/reindex` is destructive**: it replaces the topic taxonomy and assignments, then rewrites syntheses.
- **Free-tier CPU** is 10 ms per request. Normal pages are far under it, but very large libraries can approach the cap.
- **Data stays in your account**: the Durable Object, plus whatever your AI provider receives (post text, links, image bytes).
- **FxTwitter is unofficial**: no SLA, and X can break or rate-limit it. `X_BEARER_TOKEN` + `X_PROVIDER=official` is the paid alternative.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
