# X Bookmark Vault

A tiny Cloudflare-native app for saving X posts, their quoted posts, and their images — with an automatic AI summary.

No Docker, no Telegram bot, no tunnel, and no X API subscription. The app runs as a Worker with one SQLite-backed Durable Object.

Architecture, history, and known traps live in [docs/PROGRESS.md](docs/PROGRESS.md). Contributors and coding agents should start with [AGENTS.md](AGENTS.md).

## What it does

Paste an X link, or share one from Android:

1. The Worker reads the post through the public FxTwitter API (or the official X API if you add a bearer token).
2. It saves the text, author, quote, X Article content, images, video URLs, and metrics.
3. It reads the first external link(s) in the post: GitHub repos use the GitHub API + README; normal pages use a small readability extractor.
4. It sends the post, article, link text, and images to OpenCode Go for a natural-language explanation, then queues an English translation of that explanation.
5. It renders a private, mobile-friendly library.

The first summary is never overwritten. From any card you can ask for a new version with an optional direction ("explain the tradeoffs", "give the history"), and the result is stored beside the original as v2, v3, and so on.

When you are done with a post, **Archive** it. It leaves the Active list but stays in the archive with its summary, topics, and search text; switch to Archived to read it again or restore it. Nothing is deleted unless you press Remove.

Summaries live on two boards: **Türkçe** (primary) and **English** (translation). The switch at the top of the library re-renders the same page in either language. New summaries get an English version automatically; for older rows, the English board offers a button to queue the missing translations.

If no OpenCode key is configured, saving still works; the card simply says the summary is not configured.

## Knowledge layer

The vault is not a flat list. After a few saves it becomes a small, self-organizing archive:

- **Topics.** The AI induces 5-9 durable areas of interest from what you actually saved (not formats like "articles" or "videos"), and every new save is filed into 1-3 of them. Tabs at the top of the library are these topics.
- **Rolling syntheses.** Each topic page carries a 3-4 paragraph synthesis written from *all* the items in it, not from a single post. As new items arrive it is rewritten: recurring concerns, how later items sharpen or contradict earlier ones, and what is still open.
- **New topic creation.** If nothing existing is a reasonable home, the filing step may create one new topic — never a one-off or a format.

The engine runs in the background inside the same Durable Object. Each alarm pass does one unit of work, in order: summarize a new save, write a requested version or English translation, file the item into topics, then rewrite the one topic whose synthesis is stale. Nothing else is needed to keep the archive coherent.

`POST /api/reindex` re-induces the whole taxonomy from the archive (useful after a prompt change or a large import). It replaces existing topics and assignments, then the alarm rewrites every synthesis.

## Source

Private repository: <https://github.com/nuuritas/x-bookmark-vault>.

`.dev.vars`, the signing keystore, Wrangler state, and `public/BookmarkShare.apk` are gitignored: the APK embeds the add-only share token, so it is rebuilt with `android/build.sh` rather than committed.

## Deploy

Requirements: Node 20+ and a logged-in Wrangler.

```bash
wrangler whoami
wrangler deploy
```

Set the app password:

```bash
wrangler secret put APP_PASSWORD
```

Set the OpenCode key (optional, enables summaries):

```bash
wrangler secret put OPENCODE_API_KEY
```

Set the APK share token (only needed if you use the Android APK):

```bash
wrangler secret put SHARE_TOKEN
```

For higher GitHub API limits, optionally set a read-only GitHub token:

```bash
wrangler secret put GITHUB_TOKEN
```

The default AI settings are in `wrangler.jsonc`:

- Base URL: `https://opencode.ai/inference/go/openai/v1` (OpenCode Go)
- Model: `deepseek-v4.1-flash` (text + image input)

To use a different OpenAI-compatible endpoint or model, change `AI_BASE_URL` / `AI_MODEL` in `wrangler.jsonc`, or override them with Wrangler vars.

## Android: silent share APK (recommended)

Download and install:

```
https://bookmark.nuritas.tr/BookmarkShare.apk
```

Then in X: **Share → Bookmarks**. The APK has no visible UI: it posts the link in the background, shows a short “Saved to Bookmarks” toast, and closes. The library itself stays in the PWA/web app.

Android will ask you to allow installs from the browser the first time.

### Rebuilding the APK

The APK embeds an add-only `SHARE_TOKEN`. The token can add bookmarks but cannot read or delete them.

```bash
# SHARE_TOKEN and KEYSTORE_PASS are read from .dev.vars
./android/build.sh
```

Set the matching Worker secret:

```bash
wrangler secret put SHARE_TOKEN
```

### PWA option

The web app is also installable. Brave currently installs it as a shortcut, not a WebAPK, so it does **not** appear in Android’s share sheet. Install from Chrome if you want the PWA share target. The APK is the reliable option.

## Local development

```bash
cp .dev.vars.example .dev.vars
# edit .dev.vars
wrangler dev
```

Then open `http://localhost:8787`.

Run the unit tests:

```bash
node --test
```

## From your own AI tools (CLI + MCP)

The archive is readable from the terminal, so any saved post can be dropped into a chat or indexed locally. `cli/xbv.ts` is a dependency-free Bun script; the vault stays in the Worker, nothing is synced.

```bash
ln -sf "$PWD/cli/xbv.ts" ~/.local/bin/xbv
xbv config --password <APP_PASSWORD>     # writes ~/.config/xbv/config.json (mode 0600)
```

Every card in the library shows a short id like `#k7f3` next to the date. Click it to copy, then refer to that bookmark anywhere:

```bash
xbv show k7f3                            # short id from the card (also accepts tweet id or URL)
xbv search "claude code agents"          # text, AI summaries, authors, topic names
xbv show 1985100000000000000             # full markdown: summary, post, quote, links
xbv topics                               # topics + rolling syntheses
xbv topic ai-agents                      # one topic's synthesis and its items
xbv recent --limit 20
xbv export --dir ~/Documents/bookmarks   # one .md per bookmark + bookmarks.jsonl + INDEX.md
xbv stats
```

Configuration precedence: `XBV_URL` / `XBV_PASSWORD`, then `~/.config/xbv/config.json`, then `.dev.vars` when run inside the repo.

### MCP server

`xbv mcp` runs a stdio MCP server exposing `search_bookmarks`, `get_bookmark`, `list_topics`, and `get_topic`, so Claude Code/Desktop, Codex, or Cursor can search the vault themselves instead of you pasting text.

```bash
claude mcp add xbv -- xbv mcp
codex mcp add xbv -- xbv mcp
```

Then "what did I save about Postgres indexes?" is answered from the archive. Results are markdown tuned for an LLM: the AI summary first, then the original post, quoted post, article, and linked-page text.

## API

All API routes require the session cookie or `Authorization: Bearer <APP_PASSWORD>`. The APK uses a separate add-only `SHARE_TOKEN` for `POST /api/bookmarks`.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/bookmarks?q=&topic=&view=&limit=&offset=` | List bookmarks; `view=active|archived|all` (default active); `q` terms are ANDed and match text, author, both summaries, links, and topic names |
| `POST` | `/api/bookmarks` | Save `{ "url": "https://x.com/..." }` |
| `GET` | `/api/bookmarks/:id` | Get one bookmark by short id (e.g. `k7f3`) or tweet id |
| `DELETE` | `/api/bookmarks/:id` | Delete by short id or tweet id |
| `POST` | `/api/bookmarks/:id/archive` | `{ "archived": true }` archives; `false` restores |
| `POST` | `/api/bookmarks/:id/summarize` | Queue a summary; `{ "mode": "version", "instruction": "..." }` adds a version; `{ "mode": "translate" }` queues English |
| `POST` | `/api/translations/en` | Queue English for every finished summary that lacks it |
| `GET` | `/api/topics` | Topics with counts and syntheses |
| `POST` | `/api/reindex` | Rebuild the topic taxonomy from the archive |
| `GET` | `/api/stats` | Counts |
| `GET` | `/healthz` | Health check, no auth |

A bookmark contains `text`, `author`, `media`, `quote`, `article`, `metrics`, `summary`, `summaryEn`, `summaryStatus`, `archivedAt`, `topics`, and `versions` (v2 and later, each with the instruction that produced it). Images are returned as direct URLs; AI summaries receive the image bytes as base64 data URLs.

## Notes and limits

- FxTwitter is a public, unofficial reader. It works without a key, but has no SLA and can be rate-limited or broken by X changes. For a paid, official path, set `X_BEARER_TOKEN` and `X_PROVIDER=official` in Wrangler.
- Protected, deleted, age-restricted, or login-gated posts may not be readable.
- X native Articles (`x.com/i/article/...`) are read in full and included in the summary.
- External links are fetched, but JavaScript-heavy or paywalled sites may not expose readable text. GitHub repositories use the API and README.
- Images are downloaded and sent to the AI model as base64. Videos are saved as URLs/posters, but are not transcribed in this first version.
- Summaries are written as natural context-focused explanations, not a fixed sections template.
- Summaries are generated in Turkish by default (`SUMMARY_LANGUAGE=tr`). Set it to `en` for an English primary. With Turkish primary, an English translation is stored separately.
- Topic syntheses and summary versions stay in the primary language (Turkish); the English board translates bookmark summaries only.
- This is a single-user app: one password, one shared library.
